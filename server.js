/* ═══════════════════════════════════════════════════════════════
   🖥️  SERVEUR CENTRAL KLEAN — Côte d'Ivoire
   ----------------------------------------------------------------
   Node.js pur (aucune dépendance). Rôles :
   1) Sert l'application (index.html, net.js) sur le port 8000
   2) API REST  : agents, missions, acceptation, statuts
   3) WebSocket : temps réel — les agents en ligne reçoivent les
      demandes instantanément ; le client suit sa mission en direct
   4) Calcul de la commission plateforme (25% par défaut)
   ----------------------------------------------------------------
   Données persistées dans db.json (remplacer par PostgreSQL/Redis
   en production).
   ═══════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let APP_VERSION = 'v7.10';
try { APP_VERSION = 'v' + require('./package.json').version; } catch (e) { }
let webpush = null; try { webpush = require('web-push'); } catch (e) { console.log('ℹ️  web-push non installé — alertes poche désactivées (npm install web-push)'); }

const PORT = process.env.PORT || 8000;
const PLATFORM_FEE = 0.25;            // taux par défaut si le PDG n'a rien réglé
const feePct = () => { const c = db.config && db.config.commission; return ((typeof c === 'number' && isFinite(c) && c >= 0 && c <= 50) ? c : 25) / 100; };
const loginTries = new Map();          // anti force-brute connexion HQ (mémoire, par IP)
function auditLog(kind, data) { try { (db.audit = db.audit || []).push({ at: nowISO(), kind, ...(data || {}) }); if (db.audit.length > 800) db.audit = db.audit.slice(-800); } catch (e) { } }            // ← COMMISSION PLATEFORME (25%)
const DB_FILE = path.join(__dirname, 'db.json');

/* ───────── Sécurité HQ : mot de passe robuste créé par le propriétaire ─────────
   Stocké hashé + salé (SHA-256) dans db.json. Jamais en clair.
   Option : pré-initialiser via la variable d'environnement ADMIN_PIN au 1er démarrage. */
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function adminToken() { return db.admin ? sha256(db.admin.passHash + '::klean-hq') : 'aucun-mot-de-passe'; }
function validPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Au moins 8 caractères requis';
  if (!/[A-Za-z]/.test(pw)) return 'Ajoutez au moins une lettre';
  if (!/[0-9]/.test(pw)) return 'Ajoutez au moins un chiffre';
  if (!/[^A-Za-z0-9\s]/.test(pw)) return 'Ajoutez au moins un symbole (! @ # $ % …)';
  return null; // OK
}
function hashPassword(salt, pw) { return sha256(salt + '::' + pw); }

/* Comptes clients : jeton de session dérivé du hash du mot de passe */
function clientToken(passHash) { return sha256(passHash + '::klean-client'); }
function findClientByToken(req) {
  const tk = req.headers['x-client-token'];
  if (!tk || !db.clients) return null;
  return db.clients.find(cl => clientToken(cl.passHash) === tk) || null;
}

/* Accès HQ : cookie = jeton dérivé du hash du mot de passe */
function isAdminReq(req) {
  const c = req.headers.cookie || '';
  return !!hqIdentity(req);
}

/* 👑 Hiérarchie : PDG (jeton inchangé) + gestionnaires (comptes créés depuis le HQ) */
function normIdent(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }
function gestTokenOf(ad) { return sha256(ad.passHash + '::klean-hq:' + ad.id); }
function hqIdentity(req) {
  const c = req.headers.cookie || '';
  for (const part of c.split(';')) {
    const t = part.trim();
    if (!t.startsWith('klean_hq=')) continue;
    const tok = t.slice(9);
    try {
      if (tok === adminToken()) return { role: 'pdg', nom: 'PDG' };
      const ad = (db.admins || []).find(a => !a.blocked && gestTokenOf(a) === tok);
      if (ad) return { role: 'gest', nom: ad.nom, id: ad.id };
    } catch (e) { }
  }
  return null;
}
function writesFrozen() { return !!(db.config && db.config.gestFrozen); }
function pdgOnly(req, res) { const id = hqIdentity(req); if (!id || id.role !== 'pdg') { sendJson(res, 403, { error: 'Réservé au PDG' }); return false; } return true; }
function fieldTokenOf(f) { return sha256(f.passHash + '::klean-field:' + f.id); }
function fieldIdentity(req) {
  const c = req.headers.cookie || '';
  for (const part of c.split(';')) {
    const t = part.trim();
    if (!t.startsWith('klean_field=')) continue;
    const tok = t.slice(12);
    const f = (db.fieldAgents || []).find(x => !x.blocked && fieldTokenOf(x) === tok);
    if (f) return { role: 'field', nom: f.nom, id: f.id, gestId: f.createdById || null };
  }
  return null;
}
function act(req) { const id = hqIdentity(req) || fieldIdentity(req); return (id && id.nom) || 'PDG'; }
function actorId(req) { const id = hqIdentity(req); return id ? (id.role === 'pdg' ? 'pdg' : id.id) : null; }
function isPdg(req) { const id = hqIdentity(req); return id && id.role === 'pdg'; }
function ownsRecord(req, rec) {
  if (isPdg(req)) return true;
  const hq = hqIdentity(req);
  if (hq && hq.role === 'gest') return rec && (rec.createdById === hq.id || rec.createdByGestId === hq.id);
  const f = fieldIdentity(req);
  if (f) return rec && rec.createdById === f.id;
  const id = actorId(req);
  return rec && rec.createdById === id;
}
function trashPush(kind, rec) {
  db.trash = db.trash || [];
  db.trash.unshift({ id: uid('TR'), kind, data: rec, at: nowISO() });
  if (db.trash.length > 400) db.trash = db.trash.slice(0, 400);
}

/* ───────── Stockage : fichier local  OU  Postgres (Neon gratuit) si DATABASE_URL ─────────
   Sur Render (hébergement gratuit), le disque est effacé à chaque redémarrage :
   → mettez DATABASE_URL (Neon, gratuit sans CB) dans Render ≥ Environment,
     et les comptes/missions survivront à tous les redémarrages. */
let db = { agents: [], missions: [], clients: [] };
let pgClient = null;
let storageReady = false;
function hqCookie(token) {
  return 'klean_hq=' + token + '; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000';
}
async function pgQuery(sql, params) { const r = await pgClient.query(sql, params); return r; }
async function initStorage() {
  if (process.env.DATABASE_URL) {
    try {
      const { Client } = require('pg');
      pgClient = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
      await pgClient.connect();
      await pgClient.query('CREATE TABLE IF NOT EXISTS klean_state (id smallint PRIMARY KEY, data jsonb NOT NULL, updated timestamptz NOT NULL DEFAULT now())');
      const r = await pgClient.query('SELECT data FROM klean_state WHERE id=1');
      if (r.rows.length) {
        const incoming = r.rows[0].data || {};
        const nIn = (incoming.agents||[]).length + (incoming.clients||[]).length + (incoming.missions||[]).length;
        const nMem = (db.agents||[]).length + (db.clients||[]).length + (db.missions||[]).length;
        if (nIn === 0 && nMem > 0) {
          console.log('  🛡️  Neon vide — on garde les dossiers déjà en mémoire (pas d’écrasement)');
        } else {
          db = incoming;
        }
      }
      else {
        /* 📦 Première connexion Neon : on TRANSPLANTE les comptes actuels (db.json) — rien n'est perdu */
        try {
          db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
          console.log('  📦 Migration automatique db.json → Postgres : vos comptes existants suivent ✓');
        } catch (e) { /* départ neuf */ }
        await pgClient.query('INSERT INTO klean_state (id, data) VALUES (1, $1)', [JSON.stringify(db)]);
      }
      console.log('  💾 Stockage : Postgres (Neon) — données persistantes ✓');
    } catch (e) {
      pgClient = null;
      console.log('  ⚠️  DATABASE_URL injoignable (' + e.message + ') → bascule fichier local');
    }
  }
  if (!pgClient) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
    console.log('  💾 Stockage : fichier db.json (local)');
  }
  db.agents = db.agents || []; db.missions = db.missions || []; db.clients = db.clients || [];
  if (!db.config || typeof db.config.commission !== 'number') db.config = { commission: 25, updatedAt: null };
  db.config.payDest = db.config.payDest || { wave: ['0100277521', '0709076130'], om: '0709076130', moov: '0100277521', hide: false };
  if (!db.audit) db.audit = [];
  db.supportMsgs = db.supportMsgs || [];
  db.admins = db.admins || [];
  db.trash = db.trash || [];
  db.promos = db.promos || [];
  db.partners = db.partners || [];
  db.hqChat = db.hqChat || [];
  db.accountRequests = db.accountRequests || [];
  db.mutedChats = db.mutedChats || [];
  db.fieldAgents = db.fieldAgents || [];
  db.fieldChat = db.fieldChat || [];
  db.cities = db.cities || [];
  db.catalog = db.catalog || [];
  /* Pré-initialisation optionnelle du mot de passe via ADMIN_PIN (1er démarrage seulement) */
  if (!db.admin && process.env.ADMIN_PIN) {
    const salt = crypto.randomBytes(12).toString('hex');
    db.admin = { salt, passHash: hashPassword(salt, process.env.ADMIN_PIN) };
    saveDb();
  }
  storageReady = true;
}
function saveDbNow() {
  if (!storageReady) return;
  const n = (db.agents||[]).length + (db.clients||[]).length + (db.missions||[]).length + ((db.admin) ? 1 : 0);
  const snap = JSON.stringify(db, null, 1);
  try { fs.writeFileSync(DB_FILE + '.tmp', snap); fs.renameSync(DB_FILE + '.tmp', DB_FILE); } catch (e) {}
  if (pgClient) {
    pgClient.query('SELECT jsonb_array_length(COALESCE(data->\'agents\', \'[]\'::jsonb)) + jsonb_array_length(COALESCE(data->\'clients\', \'[]\'::jsonb)) AS n FROM klean_state WHERE id=1')
      .then(r => {
        const oldN = r.rows[0] ? Number(r.rows[0].n) : 0;
        if (oldN > 0 && n === 0) { console.log('  🛡️  sauvegarde refusée : base mémoire vide, Neon a encore ' + oldN + ' dossier(s)'); return; }
        return pgClient.query('UPDATE klean_state SET data=$1, updated=now() WHERE id=1', [JSON.parse(snap)]);
      })
      .catch(e => console.log('  ⚠️  sauvegarde Postgres : ' + e.message));
  }
}
let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDbNow, 150);
}
const uid = p => p + '-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
const nowISO = () => new Date().toISOString();

/* ───────── WebSocket minimal (RFC 6455) ───────── */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const sockets = new Set();           // tous les sockets connectés
const supRateMap = new Map();      // 🛡️ digestif anti-spam du support
const presence = new Map();        // who -> { at, screen, role, nom }
function prunePresence() {
  const cut = Date.now() - 45000;
  for (const [k, v] of presence) if (!v || v.at < cut) presence.delete(k);
}
function liveHome() {
  prunePresence();
  const rows = [...presence.values()];
  return {
    home: rows.filter(x => x.screen === 'home').length,
    n: rows.length,
    clients: rows.filter(x => x.role === 'client').length,
    agents: rows.filter(x => x.role === 'agent').length
  };
}
function wsSend(sock, obj) {
  if (sock.destroyed) return;
  const data = Buffer.from(JSON.stringify(obj));
  const len = data.length;
  let header;
  if (len < 126) { header = Buffer.from([0x81, len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  try { sock.write(Buffer.concat([header, data])); } catch (e) {}
}
function broadcast(list, obj) { list.forEach(s => wsSend(s, obj)); }
function handleWsData(sock) {
  let buf = Buffer.alloc(0);
  return chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = (buf[1] & 0x80) !== 0;
      const maskOff = off; if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.slice(off, off + len);
      if (masked) { const m = buf.slice(maskOff, maskOff + 4); payload = Buffer.from(payload.map((b, i) => b ^ m[i % 4])); }
      buf = buf.slice(off + len);
      if (opcode === 0x8) { sock.end(); return; }
      if (opcode === 0x9) { const pong = Buffer.from([0x8a, 0]); try { sock.write(pong); } catch (e) {} continue; }
      if (opcode === 0x1) { try { routeWsMessage(sock, JSON.parse(payload.toString('utf8'))); } catch (e) {} }
    }
  };
}

/* ───────── Annuaires temps réel ───────── */
// sock.meta = {role:'agent'|'client', agentId?, deviceId?, missions:Set}
/* 🔔 VAPID : identité du serveur pour les notifications web (auto-générée 1×, gardée en base) */
function vapidKeys() {
  if (!webpush) return null;
  db.settings = db.settings || {};
  if (!db.settings.vapid) {
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    db.settings.vapid = {
      publicKey: ecdh.getPublicKey(null, 'uncompressed').toString('base64url'),
      privateKey: ecdh.getPrivateKey().toString('base64url')
    };
    saveDb(); console.log('🔑 Clés VAPID générées (persistance base)');
  }
  try { webpush.setVapidDetails('mailto:contact@klean.ci', db.settings.vapid.publicKey, db.settings.vapid.privateKey); }
  catch (e) { console.log('⚠️ VAPID invalide :', e.message); return null; }
  return db.settings.vapid;
}
/* Envoie la notification « poche » à tous les agents validés ayant activé les alertes.
   Le web push arrive MÊME application fermée / écran éteint (Android) — c'est là sa force. */
async function pushNewMissionToAgents(m, svcNom) {
  if (!webpush || !vapidKeys()) return;
  const payload = JSON.stringify({ title: '🔔 Nouvelle demande KLEAN', body: svcNom + ' · ' + (m.quartier || '') + ' · ' + (m.prixTotal || 0).toLocaleString('fr-FR') + ' F — touchez pour accepter', url: '/?mode=agent', missionId: m.id });
  const targets = db.agents.filter(ag => (ag.status || 'approved') === 'approved' && !ag.blocked && (ag.stayOnline || ag.online) && Array.isArray(ag.pushSubs) && ag.pushSubs.length && (!m.service || agentHasService(ag, m.service)));
  let dirty = false;
  for (const ag of targets) {
    for (const sub of [...ag.pushSubs]) {
      try { await webpush.sendNotification(sub, payload, { TTL: 120, urgency: 'high' }); }
      catch (e) { const c = e && (e.statusCode || e.status); if (c === 404 || c === 410) { ag.pushSubs = ag.pushSubs.filter(s => s.endpoint !== sub.endpoint); dirty = true; } }
    }
  }
  if (targets.length) console.log('📲 Notification poche envoyée à ' + targets.length + ' agent(s) abonné(s)');
  if (dirty) saveDb();
}

function onlineAgents() { return [...sockets].filter(s => s.meta && s.meta.role === 'agent' && s.meta.online); }
function onlineAgentIds() { return new Set(onlineAgents().map(s => s.meta && s.meta.agentId).filter(Boolean)); }
function lastSeenFresh(iso) {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && (Date.now() - t) < 120000;
}
function presenceHits(cands, role) {
  prunePresence();
  const keys = new Set((cands || []).filter(Boolean).map(x => String(x)));
  for (const [k, v] of presence) {
    if (!v) continue;
    if (keys.has(String(k))) return true;
    if (v.id && keys.has(String(v.id))) return true;
    if (v.tel && keys.has(String(v.tel))) return true;
    if (role && v.role === role && v.nom && keys.has(String(v.nom))) return true;
  }
  return false;
}
function agentIsOnline(a) {
  if (!a || a.blocked) return false;
  if (onlineAgentIds().has(a.id)) return true;
  if ([...sockets].some(s => s.meta && s.meta.agentId === a.id)) return true;
  if (presenceHits([a.id, 'AG-' + a.id, a.tel, a.tel1, a.nom, 'AG-' + (a.tel || ''), 'AG-' + (a.nom || '')], 'agent')) return true;
  if ((a.online || a.stayOnline) && lastSeenFresh(a.lastSeen)) return true;
  return false;
}
function clientIsOnline(c) {
  if (!c || c.blocked) return false;
  if ([...sockets].some(s => s.meta && s.meta.clientId === c.id)) return true;
  if (presenceHits([c.id, 'CL-' + c.id, c.tel, c.nom, 'CL-' + (c.tel || ''), 'CL-' + (c.nom || '')], 'client')) return true;
  if (c.online && lastSeenFresh(c.lastSeen)) return true;
  return false;
}
function subsOf(missionId) { return [...sockets].filter(s => s.meta && s.meta.missions && s.meta.missions.has(missionId)); }
function adminSockets() { return [...sockets].filter(s => s.meta && s.meta.role === 'admin'); }
/* Envoie un événement au(x) tableau(x) de bord HQ en temps réel */
function emitAdmin(kind, text) { broadcast(adminSockets(), { type: 'admin_event', kind, text, at: nowISO() }); }

function routeWsMessage(sock, msg) {
  sock.meta = sock.meta || { missions: new Set() };
  if (writesFrozen() && msg.type !== 'ping') {
    wsSend(sock, { type: 'frozen', error: 'Écriture désactivée par le PDG' });
    return;
  }
  switch (msg.type) {
    case 'hello':
      sock.meta.role = msg.role === 'agent' ? 'agent' : (msg.role === 'admin' && sock.meta.hqAuthed ? 'admin' : 'client');
      sock.meta.deviceId = msg.deviceId || null;
      if (msg.role === 'client' && msg.clientId) {
        const cl = db.clients.find(c => c.id === msg.clientId && !c.blocked);
        if (cl) { cl.online = true; cl.lastSeen = nowISO(); sock.meta.clientId = cl.id; sock.meta.role = 'client'; }
      }
      break;
    case 'ping': break;
    case 'agent_online': {
      const ag = db.agents.find(a => a.id === (sock.meta.agentId || msg.agentId));
      if (!ag) { wsSend(sock, { type: 'agent_denied', reason: 'apply' }); break; }
      if (ag.status === 'pending') { wsSend(sock, { type: 'agent_pending' }); break; }
      if (ag.blocked) { wsSend(sock, { type: 'agent_denied', reason: 'blocked' }); break; }
      if (ag.status === 'rejected') { wsSend(sock, { type: 'agent_denied', reason: 'rejected' }); break; }
      ag.nom = msg.nom || ag.nom; ag.quartier = msg.quartier || ag.quartier; ag.tel = msg.tel || ag.tel;
      if (msg.ville) ag.ville = String(msg.ville).slice(0, 60);
      ag.mobile = true;
      ag.online = true; ag.stayOnline = true; ag.lastSeen = nowISO();
      sock.meta.role = 'agent'; sock.meta.online = true; sock.meta.agentId = ag.id;
      saveDb();
      wsSend(sock, { type: 'agent_registered', agentId: ag.id });
      console.log(`🟢 Agent en ligne : ${ag.nom} (${ag.quartier}) — ${onlineAgents().length} en ligne`);
      emitAdmin('agent', `🟢 ${ag.nom} en ligne (${ag.quartier}) — ${onlineAgents().length} agent(s) en ligne`);
      break;
    }
    case 'agent_offline': {
      const ag = db.agents.find(a => a.id === (sock.meta.agentId || msg.agentId));
      if (ag) { ag.online = false; ag.stayOnline = false; saveDb(); emitAdmin('agent', `⚪ ${ag.nom} est hors ligne`); }
      sock.meta.online = false;
      console.log('⚪ Agent hors ligne');
      break;
    }
    case 'subscribe_mission':
      sock.meta.missions.add(msg.missionId);
      break;
    case 'agent_pos': {   // 📡 position GPS — le pro reste actif partout où il va
      const ag = db.agents.find(a => a.id === (sock.meta.agentId || msg.agentId));
      if (ag && typeof msg.lat === 'number' && typeof msg.lng === 'number') {
        ag.pos = { lat: msg.lat, lng: msg.lng, at: nowISO() };
        ag.villeIci = nearestVille(msg.lat, msg.lng);
        ag.lastSeen = nowISO();
      }
      break;
    }
  }
}

/* ───────── Missions : diffusion & notifications ───────── */
function publicMissionForAgent(m) {
  // on ne diffuse PAS le téléphone du client avant acceptation
  const { tel, ...clientSafe } = m.client;
  return {
    id: m.id, service: m.service, pieces: m.pieces, depth: m.depth,
    quartier: m.quartier, time: m.time, date: m.date,
    dist: m.dist, prixTotal: m.prixTotal, quote: !!m.quote, quotedPrix: m.quotedPrix || 0,
    lat: m.lat, lng: m.lng,               // 📍 position GPS du client (pour l'agent)
    clientNom: m.client.nom,
    desc: m.desc || '',                   // 📝 description/matière précisée par le client
    photos: Array.isArray(m.photos) ? m.photos : [],
    budget: m.budget || 0
  };
}
function emitToMission(m, obj) {
  const list = subsOf(m.id);
  // inclure le socket de l'agent assigné
  if (m.agentId) { const a = [...sockets].find(s => s.meta && s.meta.agentId === m.agentId); if (a && !list.includes(a)) list.push(a); }
  broadcast(list, obj);
}
const SVC_NAMES = { maison:'Ménage maison', bureaux:'Bureaux', canapes:'Canapés & tapis', vitres:'Vitres', grand:'Grand ménage', plomberie:'Plomberie', electricite:'Électricité', clim:'Climatisation', serrurerie:'Serrurerie', electro:'Électroménager', jardinage:'Jardinage', lavageauto:'Lavage auto', bricolage:'Bricolage', demen:'Déménagement', cuisine:'Cuisinier à domicile', cours:'Cours ou formation à domicile', canal:'Canal+ à domicile', evenement:'Après événement', entretien:'Entretien régulier', placement:'Placement de personnel', custom:'Demande sur mesure' };
function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371, dLa = (bLat - aLat) * Math.PI / 180, dLo = (bLng - aLng) * Math.PI / 180;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
function normVille(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function villeOfAgent(ag) {
  return normVille(ag.villeIci || ag.villeService || ag.ville || '');
}
const CI_GPS = [
  ['Bouaké', 7.693, -5.030], ['Abidjan', 5.345, -4.024], ['Yamoussoukro', 6.821, -5.277],
  ['Touba', 8.283, -7.684], ['Kounahiri', 8.400, -5.950], ['Korhogo', 9.458, -5.630],
  ['Daloa', 6.890, -6.450], ['San-Pédro', 4.749, -6.636], ['Man', 7.412, -7.554],
  ['Gagnoa', 6.132, -5.951], ['Abengourou', 6.730, -3.496], ['Bondoukou', 8.040, -2.800],
  ['Divo', 5.837, -5.357], ['Grand-Bassam', 5.211, -3.738], ['Odienné', 9.500, -7.563],
  ['Séguéla', 7.961, -6.673], ['Katiola', 8.137, -5.101], ['Ferkessédougou', 9.593, -5.194],
  ['Bouaflé', 6.990, -5.746], ['Agboville', 5.928, -4.213]
];
function nearestVille(lat, lng) {
  let best = 'En déplacement', bd = 1e9;
  for (const row of CI_GPS) {
    const nom = row[0], la = row[1], lo = row[2];
    const d = haversineKm(lat, lng, la, lo);
    if (d < bd) { bd = d; best = nom; }
  }
  return bd < 90 ? best : 'En déplacement';
}
function agentHasService(ag, svc) {
  if (!svc) return true;
  const list = Array.isArray(ag.services) ? ag.services : [];
  if (!list.length) return true;
  return list.includes(svc);
}
function reachKm() {
  return (db.config && typeof db.config.reachKm === 'number') ? db.config.reachKm : 15;
}
function agentHasGps(ag) {
  return !!(ag && ag.pos && typeof ag.pos.lat === 'number' && typeof ag.pos.lng === 'number');
}
function rankPro(m, ag) {
  const same = !!(m.villeN && villeOfAgent(ag) && m.villeN === villeOfAgent(ag));
  const gps = agentHasGps(ag);
  let dist = null;
  if (gps && typeof m.lat === 'number' && typeof m.lng === 'number') {
    dist = Math.round(haversineKm(m.lat, m.lng, ag.pos.lat, ag.pos.lng) * 10) / 10;
  }
  const inReach = gps && dist != null && dist <= reachKm();
  let ring = 9;
  if (same && inReach) ring = 1;
  else if (same && gps) ring = 2;
  else if (same && !gps) ring = 3;
  else if (!same && inReach) ring = 4;
  else if (!same && gps) ring = 5;
  else ring = 6;
  return { same, gps, dist, inReach, ring, mode: gps ? 'gps' : 'appel' };
}
function missionTargets(m) {
  /* Partout en CI, métier uniquement. Classement : GPS proche → même ville → ailleurs. */
  const all = onlineAgents();
  const scored = [];
  for (const s of all) {
    const ag = db.agents.find(a => a.id === (s.meta && s.meta.agentId));
    if (!ag) continue;
    if (m.service && m.service !== 'custom' && !agentHasService(ag, m.service)) continue;
    const r = rankPro(m, ag);
    s._dist = r.dist; s._ring = r.ring; s._mode = r.mode;
    scored.push(s);
  }
  scored.sort((a, b) => (a._ring - b._ring) || ((a._dist || 99) - (b._dist || 99)));
  console.log('Moteur KLEAN : ' + scored.length + '/' + all.length + ' pro(s) métier=' + (m.service || '*') + ' · ' + (m.villeN || 'CI'));
  return scored;
}
function publicMatchCard(ag, m, online) {
  const r = rankPro(m, ag);
  const tel = String(ag.tel || ag.tel1 || '').replace(/\D/g, '');
  return {
    id: ag.id, nom: ag.nom, ville: ag.villeIci || ag.villeService || ag.ville || '',
    villeHome: ag.ville || '', quartier: ag.quartier || '',
    services: Array.isArray(ag.services) ? ag.services : [],
    online: !!online, hasGps: r.gps, distKm: r.dist, mode: r.mode, ring: r.ring, sameCity: r.same,
    tel,
    telAffiche: !r.gps || !online
  };
}
function broadcastNewMission(m) {
  const exc = m.exclAg || [];
  const base = publicMissionForAgent(m);
  const targets = missionTargets(m);
  let sent = 0;
  for (const s of targets) {
    if (exc.includes(s.meta && s.meta.agentId)) continue;
    wsSend(s, { type: 'mission_request', mission: Object.assign({}, base, { dist: (typeof s._dist === 'number' ? s._dist : base.dist) }) });
    sent++;
  }
  console.log('📢 Mission ' + m.id + ' (' + m.service + ' · ' + m.prixTotal + ' F) diffusée à ' + sent + ' agent(s)');
  emitAdmin('mission', '📥 Nouvelle demande ' + m.id + ' — ' + m.service + ' · ' + m.quartier + ' · ' + m.prixTotal.toLocaleString('fr-FR') + ' F (' + m.client.nom + ')');
  pushNewMissionToAgents(m, (SVC_NAMES[m.service] || m.service) || '').catch(()=>{});
  if (m.matchScope !== 'all') {
    setTimeout(() => {
      const live = db.missions.find(x => x.id === m.id);
      if (!live || live.status !== 'pending') return;
      live.matchScope = 'all';
      saveDb();
      broadcastNewMission(live);
      emitAdmin('mission', '🌍 ' + live.id + ' élargie à toutes les villes (aucun accepté dans la ville)');
    }, 25000);
  }
}

function agentCompletion(ag) {
  const F = ['photo', 'quartier', 'adresse', 'naissance', 'pieceType', 'pieceNum', 'urgenceNom', 'urgenceTel', 'ref1Nom', 'ref1Tel', 'niveau'];
  let done = F.filter(f => ag[f] && String(ag[f]).trim()).length;
  if (Array.isArray(ag.services) && ag.services.length) done++;
  return Math.round(done / (F.length + 1) * 100);
}

/* ───────── API REST ───────── */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/plain; charset=utf-8', '.ico': 'image/x-icon' };
function sendJson(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Klean-Shield': 'on'
  });
  res.end(b);
}
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  let ip = xf || (req.socket && req.socket.remoteAddress) || '?';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip.slice(0, 64);
}
const _hitMap = new Map();
const _SCAN = /(\.env|wp-admin|wp-login|phpmyadmin|xmlrpc|\.git|\/\.aws|\.htaccess|eval-stdin|phpunit|cgi-bin|actuator\/env|\/etc\/passwd)/i;
const _INJECT = /(\.\.\/|\.\.\\|%00|<script|javascript:|union\s+select|drop\s+table|or\s+1=1|\$\{jndi|;os\.system|`)/i;
function shieldEnsure() {
  db.shield = db.shield || { events: [], ips: {} };
  if (!Array.isArray(db.shield.events)) db.shield.events = [];
  if (!db.shield.ips) db.shield.ips = {};
}
function shieldLog(ip, kind, path, detail, score) {
  shieldEnsure();
  const rec = db.shield.ips[ip] || { score: 0, hits: 0, blocked: false, annihilated: false, last: nowISO(), kind };
  rec.hits += 1;
  rec.score += score;
  rec.last = nowISO();
  rec.kind = kind;
  let action = 'veille';
  if (rec.annihilated) action = 'aneanti';
  else if (rec.score >= 50) { rec.blocked = true; action = 'auto-recale'; }
  db.shield.ips[ip] = rec;
  db.shield.events.unshift({ id: uid('SH'), at: nowISO(), ip, kind, path: String(path || '').slice(0, 180), detail: String(detail || '').slice(0, 160), score: rec.score, action });
  if (db.shield.events.length > 250) db.shield.events = db.shield.events.slice(0, 250);
  if (action !== 'veille') try { saveDb(); } catch (e) {}
  return rec;
}
function viewsOrdered(map) {
  const rows = [];
  Object.keys(map || {}).forEach(who => {
    const v = map[who];
    const at = typeof v === 'string' ? v : (v && v.at);
    if (!at) return;
    let nom = (typeof v === 'object' && v.nom) ? v.nom : '';
    if (!nom) {
      const cl = (db.clients || []).find(c => ('CL-' + (c.id || c.tel)) === who || c.id === who);
      const ag = (db.agents || []).find(a => ('AG-' + (a.id || a.tel1 || a.tel)) === who || a.id === who);
      nom = (cl && cl.nom) || (ag && ag.nom) || who;
    }
    rows.push({ who, nom, at });
  });
  rows.sort((a, b) => new Date(a.at) - new Date(b.at));
  return rows.map((x, i) => Object.assign(x, { n: i + 1 }));
}
function shieldKickIp(ip) {
  for (const s of [...sockets]) {
    if (s.meta && s.meta.ip === ip) {
      try { s.end(); } catch (e) {}
    }
  }
}
function shieldGate(req, res, p) {
  const ip = clientIp(req);
  req._ip = ip;
  shieldEnsure();
  const rec = db.shield.ips[ip];
  const hq = (() => { try { return hqIdentity(req); } catch (e) { return null; } })();
  if (rec && rec.annihilated && !(hq && hq.role === 'pdg')) {
    sendJson(res, 403, { error: 'Accès anéanti par le PDG' });
    return true;
  }
  if (rec && rec.blocked && !(hq && hq.role === 'pdg')) {
    sendJson(res, 403, { error: 'IP recalée par le bouclier KLEAN' });
    return true;
  }
  if (_SCAN.test(p) || _SCAN.test(req.url || '')) {
    shieldLog(ip, 'scan', p, 'sonde (cms/env/git)', 28);
    sendJson(res, 404, { error: 'introuvable' });
    return true;
  }
  if (_INJECT.test(req.url || '')) {
    const r2 = shieldLog(ip, 'injection', p, 'charge dans l’URL', 22);
    if (r2.blocked && !(hq && hq.role === 'pdg')) {
      sendJson(res, 403, { error: 'IP recalée' });
      return true;
    }
  }
  const now = Date.now();
  const h = _hitMap.get(ip) || { t: now, n: 0 };
  if (now - h.t > 10000) { h.t = now; h.n = 0; }
  h.n += 1;
  _hitMap.set(ip, h);
  if (h.n > 160) {
    shieldLog(ip, 'flood', p, h.n + ' req / 10 s', 18);
    sendJson(res, 429, { error: 'Trop de requêtes' });
    return true;
  }
  return false;
}
function readBody(req) {
  return new Promise(r => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 8e6) req.destroy(); });
    req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch (e) { r({}); } });
  });
}
function agentStats(ag) {
  const done = db.missions.filter(x => x.agentId === ag.id && x.status === 'terminee');
  const gain = done.reduce((s, x) => s + Math.round(x.prixTotal * (1 - feePct())), 0);
  const comm = done.reduce((s, x) => s + Math.round(x.prixTotal * feePct()), 0);
  const notes = done.filter(x => x.note).map(x => x.note);
  return {
    missionsDone: done.length, gain, comm,
    rating: notes.length ? notes.reduce((s, n) => s + n, 0) / notes.length : 5.0,
    hist: done.slice(-30).reverse().map(x => ({ id: x.id, service: x.service, quartier: x.quartier, date: x.finishedAt && x.finishedAt.slice(5, 10), montant: x.prixTotal, gain: Math.round(x.prixTotal * (1 - feePct())), comm: Math.round(x.prixTotal * feePct()), note: x.note || 5 }))
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (shieldGate(req, res, p)) return;

  /* --- API --- */
  if (p === '/api/health') return sendJson(res, 200, { ok: true, storage: pgClient ? 'postgres' : 'fichier', agentsEnLigne: onlineAgents().length, agentsTotal: db.agents.length, clientsTotal: db.clients.length, missions: db.missions.length, writeFrozen: writesFrozen(), live: liveHome() });
  if (p === '/api/presence' && req.method === 'POST') {
    const b = await readBody(req);
    const who = String(b.who || b.accountId || ('anon-' + (req.socket.remoteAddress || ''))).slice(0, 80);
    presence.set(who, { at: Date.now(), screen: String(b.screen || 'home').slice(0, 20), role: String(b.role || 'client').slice(0, 12), nom: String(b.nom || '').slice(0, 40), id: String(b.id || '').slice(0, 80), tel: String(b.tel || '').slice(0, 20) });
    try {
      if (b.role === 'agent' && b.id) {
        const ag = db.agents.find(a => a.id === b.id);
        if (ag) { ag.lastSeen = nowISO(); if (!ag.blocked) ag.online = true; }
      }
      if (b.role === 'client' && b.id) {
        const cl = db.clients.find(x => x.id === b.id);
        if (cl) { cl.lastSeen = nowISO(); if (!cl.blocked) cl.online = true; }
      }
    } catch (e) {}
    return sendJson(res, 200, { ok: true, live: liveHome() });
  }

  const meth = (req.method || 'GET').toUpperCase();
  const freezeAllow = ['/api/admin/login', '/api/admin/setup', '/api/admin/logout', '/api/admin/password', '/api/admin/gest-freeze', '/api/presence', '/api/quiz/chat', '/api/annonce/react'];
  if (writesFrozen() && !['GET', 'HEAD', 'OPTIONS'].includes(meth) && !freezeAllow.includes(p)) {
    const id = hqIdentity(req);
    if (!(id && id.role === 'pdg' && p.startsWith('/api/admin')))
      return sendJson(res, 403, { error: 'Écriture désactivée par le PDG — comptes clients, pros et gestionnaires en lecture seule', frozen: true });
  }

  if (p === '/api/match' && req.method === 'GET') {
    const cli = findClientByToken(req);
    const ville = String(url.searchParams.get('ville') || (cli && cli.ville) || '').slice(0, 60);
    const mid = String(url.searchParams.get('missionId') || '');
    const mLive = mid ? db.missions.find(x => x.id === mid) : null;
    const m = mLive || {
      ville, villeN: normVille(ville),
      lat: parseFloat(url.searchParams.get('lat')), lng: parseFloat(url.searchParams.get('lng')),
      matchScope: url.searchParams.get('scope') || 'all'
    };
    if (typeof m.lat !== 'number' || isNaN(m.lat)) m.lat = null;
    if (typeof m.lng !== 'number' || isNaN(m.lng)) m.lng = null;
    const onIds = onlineAgentIds();
    const svc = String(url.searchParams.get('service') || (mLive && mLive.service) || '');
    const cards = (db.agents || []).filter(a => !a.blocked && (a.status || 'approved') === 'approved').map(a => publicMatchCard(a, m, agentIsOnline(a)));
    cards.sort((a, b) => (Number(!b.online) - Number(!a.online)) || (a.ring - b.ring) || ((a.distKm || 99) - (b.distKm || 99)));
    const same = cards.filter(x => x.sameCity);
    const other = cards.filter(x => !x.sameCity);
    return sendJson(res, 200, {
      ok: true, ville, scope: m.matchScope || 'city',
      nOnline: onIds.size, nSame: same.length, nOther: other.length,
      sameCity: same.slice(0, 40), otherCities: other.slice(0, 40), service: svc
    });
  }

  if (p === '/api/pros/peers' && req.method === 'GET') {
    const svc = String(url.searchParams.get('service') || '').trim();
    const self = String(url.searchParams.get('self') || '');
    const onIds = onlineAgentIds();
    const dummy = { villeN: '', lat: null, lng: null };
    const list = (db.agents || []).filter(a => !a.blocked && (a.status || 'approved') === 'approved' && a.id !== self && agentHasService(a, svc)).map(a => {
      const card = publicMatchCard(a, dummy, onIds.has(a.id));
      card.villeIci = a.villeIci || '';
      return card;
    });
    list.sort((a, b) => Number(!b.online) - Number(!a.online));
    return sendJson(res, 200, { ok: true, service: svc, n: list.length, peers: list.slice(0, 60) });
  }

  if (p === '/api/missions' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.nom || !b.service) return sendJson(res, 400, { error: 'données manquantes' });
    const m = {
      id: uid('KN'), service: b.service, pieces: b.pieces || 2, depth: b.depth || 'normal',
      extras: b.extras || {}, prixTotal: Math.round(b.prixTotal || 0), promo: b.promo || '',
      date: b.date || '', time: b.time || '', quartier: b.quartier || '', adresse: b.adresse || '',
      paiement: b.paiement || 'cash',
      desc: (typeof b.desc === 'string' ? b.desc : '').slice(0, 280),
      photos: Array.isArray(b.photos) ? b.photos.filter(x => typeof x === 'string' && x.length < 600000).slice(0, 3) : [],
      budget: Math.max(0, parseInt(b.budget) || 0),
      quote: !!(b.quote || b.service === 'custom'),
      lat: typeof b.lat === 'number' ? b.lat : null,
      lng: typeof b.lng === 'number' ? b.lng : null,
      ville: String(b.ville || b.cityNom || b.city || '').slice(0, 60),
      client: { nom: b.nom, tel: b.tel || '', deviceId: b.deviceId || '' },
      dist: Math.round((0.5 + Math.random() * 3.5) * 10) / 10,
      status: 'pending', agentId: null, createdAt: nowISO(), finishedAt: null, note: 0,
      matchScope: 'all'
    };
    const cli = findClientByToken(req);   // 👤 mission rattachée au compte client
    if (!cli) return sendJson(res, 401, { error: 'Inscription requise : créez votre compte client gratuit pour réserver' });
    if (cli.blocked) return sendJson(res, 403, { error: 'Compte bloqué par le gestionnaire — contactez le support' });
    m.clientId = cli.id;
    const actives = db.missions.filter(x => x.clientId === cli.id && !['terminee', 'annulee'].includes(x.status)).length;
    if (actives >= 3) return sendJson(res, 409, { error: 'Maximum 3 missions actives en même temps' });
    db.missions.push(m); saveDb();
    broadcastNewMission(m);
    return sendJson(res, 201, { id: m.id, dist: m.dist });
  }

  const mAccept = p.match(/^\/api\/missions\/(.+)\/accept$/);
  if (mAccept && req.method === 'POST') {
    const { agentId } = await readBody(req);
    const m = db.missions.find(x => x.id === mAccept[1]);
    const ag = db.agents.find(a => a.id === agentId);
    if (!m) return sendJson(res, 404, { error: 'mission introuvable' });
    if (!ag) return sendJson(res, 404, { error: 'agent inconnu' });
    if (m.status !== 'pending') return sendJson(res, 409, { error: 'déjà prise', status: m.status });
    if ((m.exclAg || []).includes(ag.id)) return sendJson(res, 409, { error: 'Cette mission vous a été retirée — le gestionnaire l’a réattribuée' });
    m.status = 'accepted'; m.agentId = ag.id; saveDb();
    // informer les autres agents que la mission est prise
    broadcast(onlineAgents().filter(s => s.meta.agentId !== ag.id), { type: 'mission_taken', missionId: m.id });
    emitToMission(m, { type: 'mission_update', status: 'accepted', missionId: m.id,
      agent: { nom: ag.nom, note: agentStats(ag).rating, missions: agentStats(ag).missionsDone, tel: ag.tel, photo: ag.photo || '' },
      dist: m.dist, agentPos: ag.pos || null, lat: m.lat, lng: m.lng });
    console.log(`✅ ${ag.nom} a accepté ${m.id}`);
    emitAdmin('accept', `✅ ${ag.nom} a accepté la mission ${m.id} (${m.prixTotal.toLocaleString('fr-FR')} F)`);
    return sendJson(res, 200, { ok: true, missionId: m.id, clientTel: m.client.tel });
  }

  const mStatus = p.match(/^\/api\/missions\/(.+)\/status$/);
  if (mStatus && req.method === 'POST') {
    const { agentId, status, note } = await readBody(req);
    const m = db.missions.find(x => x.id === mStatus[1]);
    if (!m || m.agentId !== agentId) return sendJson(res, 404, { error: 'mission introuvable' });
    m.status = status;
    if (status === 'terminee') { m.finishedAt = nowISO(); if (note) m.note = note; }
    saveDb();
    emitToMission(m, { type: 'mission_update', status, missionId: m.id });
    console.log('➡️  ' + m.id + ' : ' + status);
    const LBL = { enroute: 'en route', arrive: 'arrive', encours: 'en cours', terminee: 'terminee' };
    emitAdmin('status', (LBL[status] || status) + ' · ' + m.id);
    const ag = db.agents.find(a => a.id === agentId);
    const st = agentStats(ag);
    return sendJson(res, 200, { ok: true, gain: Math.round(m.prixTotal * (1 - feePct())), comm: Math.round(m.prixTotal * feePct()), stats: st });
  }

  const mCancel = p.match(/^\/api\/missions\/(.+)\/cancel$/);
  if (mCancel && req.method === 'POST') {
    const m = db.missions.find(x => x.id === mCancel[1]);
    if (!m) return sendJson(res, 404, {});
    if (['terminee', 'annulee'].includes(m.status)) return sendJson(res, 409, { error: 'trop tard' });
    m.status = 'annulee'; saveDb();
    emitToMission(m, { type: 'mission_update', status: 'annulee', missionId: m.id });
    broadcast(onlineAgents(), { type: 'mission_taken', missionId: m.id });
    emitAdmin('cancel', `✕ Mission ${m.id} annulée par le client`);
    return sendJson(res, 200, { ok: true });
  }

  const mGet = p.match(/^\/api\/missions\/(.+)$/);
  if (mGet && req.method === 'GET') {
    const m = db.missions.find(x => x.id === mGet[1]);
    if (!m) return sendJson(res, 404, {});
    const ag = m.agentId ? db.agents.find(a => a.id === m.agentId) : null;
    return sendJson(res, 200, { id: m.id, status: m.status, agentId: m.agentId,
      lat: m.lat, lng: m.lng, agentPos: (ag && ag.pos) || null });
  }

  const aSum = p.match(/^\/api\/agents\/(.+)\/summary$/);
  if (aSum && req.method === 'GET') {
    const ag = db.agents.find(a => a.id === aSum[1]);
    if (!ag) return sendJson(res, 404, {});
    return sendJson(res, 200, { id: ag.id, nom: ag.nom, quartier: ag.quartier, online: ag.online, stats: agentStats(ag) });
  }

  /* --- AUTH HQ (mot de passe robuste) --- */
  if (p === '/api/admin/status') return sendJson(res, 200, { setup: !!db.admin });

  /* --- RECUPERATION TEMPORAIRE DU MOT DE PASSE PROPRIETAIRE ---
     Double sécurité : (1) ne fait rien sauf si la variable ADMIN_RESET_CODE
     existe sur Render ET que ?code= correspond EXACTEMENT ;
     (2) à usage unique : le code est détruit en mémoire après utilisation. --- */
  if (p === '/api/admin/reset') {
    const code = url.searchParams.get('code') || '';
    if (!process.env.ADMIN_RESET_CODE || code !== process.env.ADMIN_RESET_CODE || !db.admin) {
      return sendJson(res, 403, { error: 'Réinitialisation non disponible' });
    }
    delete process.env.ADMIN_RESET_CODE; // usage unique
    db.admin = null;
    saveDbNow();
    console.log('🔑 Mot de passe propriétaire réinitialisé (code usage unique)');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<body style="font-family:system-ui;background:#08120c;color:#e8f5ee;display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0;text-align:center">'
      + '<div><div style="font-size:56px">✅</div><h1 style="color:#4ade80;margin:8px 0">Mot de passe effacé</h1>'
      + '<p style="max-width:340px;line-height:1.6">Ouvrez <a style="color:#22c55e;font-weight:700" href="/admin">votre page /admin</a> : elle vous proposera maintenant de <b>créer un nouveau mot de passe</b>. Faites-le tout de suite.</p></div></body>');
  }

  if ((p === '/api/admin/setup' || p === '/api/admin/login') && req.method === 'POST' && !storageReady) {
    return sendJson(res, 503, { error: 'Chargement des données — réessayez dans 3 secondes' });
  }
  if (p === '/api/admin/setup' && req.method === 'POST') {
    const { password } = await readBody(req);
    if (db.admin) return sendJson(res, 409, { error: 'Le mot de passe est déjà créé' });
    const perr = validPassword(password);
    if (perr) return sendJson(res, 400, { error: perr });
    const salt = crypto.randomBytes(12).toString('hex');
    db.admin = { salt, passHash: hashPassword(salt, password) };
    saveDb();
    console.log('🔑 Mot de passe HQ créé');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': hqCookie(adminToken()) });
    return res.end('{"ok":true}');
  }

  if (p === '/api/admin/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || '?';
    const rec = loginTries.get(ip) || { n: 0, t: 0 };
    if (rec.n >= 6 && Date.now() - rec.t < 600000) { auditLog('hq_login_bloque', { ip }); return sendJson(res, 429, { error: 'Trop de tentatives — réessayez dans 10 min' }); }
    const b = await readBody(req);
    const pw = b.password || b.pin || '';
    const ident = normIdent(b.ident || '');
    const expect = (b.expect === 'gest' || ident) ? 'gest' : 'pdg';
    let who = null;
    if (expect === 'pdg') {
      if (db.admin && hashPassword(db.admin.salt, pw) === db.admin.passHash)
        who = { t: adminToken(), qui: 'PDG', role: 'pdg', kind: 'hq_connexion' };
    } else {
      const ad = (db.admins || []).find(a => normIdent(a.ident) === ident || normIdent(a.nom) === ident);
      if (ad && !ad.blocked && hashPassword(ad.salt, pw) === ad.passHash)
        who = { t: gestTokenOf(ad), qui: ad.nom, role: 'gest', kind: 'gest_connexion', ad };
    }
    if (who) {
      loginTries.delete(ip);
      if (who.ad) { who.ad.lastLogin = nowISO(); saveDb(); }
      auditLog(who.kind, { ip, qui: who.qui });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': hqCookie(who.t) });
      return res.end('{"ok":true,"role":"' + who.role + '"}');
    }
    loginTries.set(ip, { n: rec.n + 1, t: rec.t || Date.now() });
    auditLog('hq_login_echec', { ip });
    return sendJson(res, 401, { error: 'Mot de passe incorrect' });
  }

  if (p === '/api/admin/password' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const { current, next } = await readBody(req);
    if (!db.admin || hashPassword(db.admin.salt, current || '') !== db.admin.passHash)
      return sendJson(res, 401, { error: 'Mot de passe actuel incorrect' });
    const perr2 = validPassword(next);
    if (perr2) return sendJson(res, 400, { error: perr2 });
    const salt = crypto.randomBytes(12).toString('hex');
    db.admin = { salt, passHash: hashPassword(salt, next) };   // nouveau hash → nouvelles sessions, anciennes invalidées
    saveDb();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': hqCookie(adminToken()) });
    return res.end('{"ok":true}');
  }
  if (p === '/api/admin/logout') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'klean_hq=; Path=/; Max-Age=0' });
    return res.end('{"ok":true}');
  }
  if (p.startsWith('/api/admin') && !isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
  if (p.startsWith('/api/admin') && !['/api/admin/whoami', '/api/admin/logout', '/api/admin/gest-freeze'].includes(p)) {
    const id = hqIdentity(req);
    if (id && id.role === 'gest' && db.config && db.config.gestFrozen)
      return sendJson(res, 403, { error: 'Activités gestionnaire désactivées par le PDG', frozen: true });
  }

  /* --- API CLIENTS (comptes sécurisés) --- */
  if (p === '/api/clients/register' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.nom || b.nom.trim().length < 2) return sendJson(res, 400, { error: 'Indiquez votre nom complet' });
    const tel = String(b.tel || '').replace(/\D/g, '');
    if (tel.length < 8) return sendJson(res, 400, { error: 'Numéro de téléphone invalide' });
    const perr = validPassword(b.password);
    if (perr) return sendJson(res, 400, { error: perr });
    if (db.clients.find(cl => cl.tel === tel)) return sendJson(res, 409, { error: 'Ce numéro a déjà un compte — connectez-vous' });
    const salt = crypto.randomBytes(12).toString('hex');
    const cl = { id: uid('CL'), nom: b.nom.trim(), tel, quartier: String(b.quartier || '').slice(0, 60), ville: String(b.ville || '').slice(0, 60), mail: String(b.mail || '').slice(0, 80), salt, passHash: hashPassword(salt, b.password), createdAt: nowISO() };
    db.clients.push(cl); saveDb();
    console.log(`👤 Nouveau compte client : ${cl.nom} (${tel})`);
    return sendJson(res, 201, { ok: true, clientId: cl.id, token: clientToken(cl.passHash), nom: cl.nom });
  }

  if (p === '/api/clients/login' && req.method === 'POST') {
    const b = await readBody(req);
    const tel = String(b.tel || '').replace(/\D/g, '');
    const cl = db.clients.find(x => x.tel === tel);
    if (!cl || hashPassword(cl.salt, b.password || '') !== cl.passHash)
      return sendJson(res, 401, { error: 'Téléphone ou mot de passe incorrect' });
    if (cl.blocked) return sendJson(res, 403, { error: 'Compte bloqué par le gestionnaire — contactez le support' });
    return sendJson(res, 200, { ok: true, clientId: cl.id, token: clientToken(cl.passHash), nom: cl.nom, quartier: cl.quartier, ville: cl.ville || '', mail: cl.mail || '', photo: cl.photo || '' });
  }

  /* ✏️ Compléter sa fiche (quartier, nom) — PUT /api/clients/me (jeton) */
  if (p === '/api/clients/me' && req.method === 'PUT') {
    const b = await readBody(req);
    const cli = findClientByToken(req);
    if (!cli) return sendJson(res, 401, {});
    if (b.nom !== undefined && String(b.nom).trim().length >= 2) cli.nom = String(b.nom).trim().slice(0, 80);
    if (b.quartier !== undefined) cli.quartier = String(b.quartier).slice(0, 60);
    if (b.ville !== undefined) cli.ville = String(b.ville).slice(0, 60);
    if (b.mail !== undefined) cli.mail = String(b.mail).slice(0, 80);
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  /* 📷 Photo de profil client — PUT /api/clients/me/photo */
  if (p === '/api/clients/me/photo' && req.method === 'PUT') {
    const b = await readBody(req);
    const cl = db.clients.find(x => x.id === b.clientId);
    if (!cl || findClientByToken(req) !== cl) return sendJson(res, 401, { error: 'Session invalide' });
    if (typeof b.photo !== 'string' || b.photo.length > 600000) return sendJson(res, 400, { error: 'Photo trop lourde' });
    cl.photo = b.photo; saveDb();
    console.log('📷 Photo de profil mise à jour : ' + cl.nom);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/clients/password' && req.method === 'POST') {
    const b = await readBody(req);
    const headers = { ...req.headers, 'x-client-token': req.headers['x-client-token'] };
    const cl = db.clients.find(x => x.id === b.clientId);
    if (!cl || findClientByToken({ headers }) !== cl) return sendJson(res, 401, { error: 'Session invalide' });
    if (hashPassword(cl.salt, b.current || '') !== cl.passHash) return sendJson(res, 401, { error: 'Mot de passe actuel incorrect' });
    const perr = validPassword(b.next);
    if (perr) return sendJson(res, 400, { error: perr });
    const salt = crypto.randomBytes(12).toString('hex');
    cl.salt = salt; cl.passHash = hashPassword(salt, b.next); saveDb();
    return sendJson(res, 200, { ok: true, token: clientToken(cl.passHash) });
  }

  const cMis = p.match(/^\/api\/clients\/(.+)\/missions$/);
  if (cMis && req.method === 'GET') {
    const cl = findClientByToken(req);
    if (!cl || cl.id !== cMis[1]) return sendJson(res, 401, {});
    return sendJson(res, 200, db.missions.filter(m => m.clientId === cl.id).slice(-30).reverse()
      .map(m => ({ id: m.id, service: m.service, quartier: m.quartier, time: m.time, date: m.date, status: m.status, prixTotal: m.prixTotal, note: m.note, at: m.createdAt })));
  }

  /* --- DOSSIERS AGENTS (candidature vérifiée par le propriétaire) --- */
  if (p === '/api/agents/apply' && req.method === 'POST') {
    const b = await readBody(req);
    const need = ['nom', 'prenom', 'naissance', 'tel1', 'quartier', 'adresse', 'pieceType', 'pieceNum', 'urgenceNom', 'urgenceTel', 'ref1Nom', 'ref1Tel'];
    for (const k of need) if (!b[k] || String(b[k]).trim() === '') return sendJson(res, 400, { error: 'Champ manquant : ' + k });
    if (Array.isArray(b.services) && b.services.includes('cours') && !(b.niveau && String(b.niveau).trim())) return sendJson(res, 400, { error: 'Niveau d\'étude requis pour les Cours ou formation à domicile' });
    const tel1 = String(b.tel1).replace(/\D/g, '');
    if (tel1.length < 8) return sendJson(res, 400, { error: 'Téléphone principal invalide' });
    let ag = db.agents.find(a => a.tel === tel1 && a.status !== 'rejected' && a.status !== 'moreinfo');
    if (ag) return sendJson(res, 409, { error: 'Un dossier existe déjà pour ce numéro', agentId: ag.id, status: ag.status });
    const reApply = db.agents.find(a => a.tel === tel1 && a.status === 'moreinfo');
    ag = {
      id: uid('AG'), createdAt: nowISO(), status: 'pending',
      // identité
      nom: (b.prenom.trim() + ' ' + b.nom.trim()).trim(), nomFamille: b.nom.trim(), prenom: b.prenom.trim(),
      naissance: b.naissance, tel: tel1, tel1, tel2: String(b.tel2 || '').replace(/\D/g, ''),
      quartier: b.quartier, adresse: b.adresse,
      ville: String(b.ville || '').slice(0, 60), mail: String(b.mail || '').slice(0, 80),
      pieceType: b.pieceType, pieceNum: b.pieceNum,
      piecePhoto: typeof b.piecePhoto === 'string' && b.piecePhoto.length < 900000 ? b.piecePhoto : '',
      urgenceNom: b.urgenceNom.trim(), urgenceTel: String(b.urgenceTel).replace(/\D/g, ''),
      experience: Math.min(30, Math.max(0, parseInt(b.experience) || 0)),
      niveau: String(b.niveau || '').trim().slice(0, 60),
      ref1Nom: b.ref1Nom.trim(), ref1Tel: String(b.ref1Tel).replace(/\D/g, ''),
      ref2Nom: String(b.ref2Nom || '').trim(), ref2Tel: String(b.ref2Tel || '').replace(/\D/g, ''),
      photo: typeof b.photo === 'string' ? b.photo.slice(0, 600000) : '',
      services: Array.isArray(b.services) ? b.services.slice(0, 10) : [],
      subs: (b.subs && typeof b.subs === 'object' && !Array.isArray(b.subs)) ? Object.fromEntries(Object.entries(b.subs).slice(0, 10).map(([k, ar]) => [String(k).slice(0, 20), (Array.isArray(ar) ? ar : []).slice(0, 12).map(x => String(x).slice(0, 24))])) : {},
      subsNoms: (b.subsNoms && typeof b.subsNoms === 'object' && !Array.isArray(b.subsNoms)) ? Object.fromEntries(Object.entries(b.subsNoms).slice(0, 10).map(([k, ar]) => [String(k).slice(0, 20), (Array.isArray(ar) ? ar : []).slice(0, 12).map(x => String(x).slice(0, 80))])) : {},
      online: false
    };
    if (b.password) {
      const perr = validPassword(b.password);
      if (perr) return sendJson(res, 400, { error: perr });
      const salt = crypto.randomBytes(12).toString('hex');
      ag.salt = salt; ag.passHash = hashPassword(salt, b.password);
    }
    ag.history = [{ at: nowISO(), by: 'agent', action: 'dossier envoye' }];
    if (reApply) {
      ag.history = (reApply.history || []).concat([{ at: nowISO(), by: 'agent', action: 'dossier renvoye apres infos demandees' }]);
      db.agents = db.agents.filter(a => a.id !== reApply.id);
      auditLog('agent_recandidature', { agent: ag.nom, tel: tel1 });
    }
    db.agents.push(ag); saveDb();
    emitAdmin('cand', `📋 Nouvelle candidature professionnel : ${ag.nom} (${ag.quartier}) — dossier à vérifier`);
    console.log(`📋 Candidature agent : ${ag.nom} — ${ag.pieceType} ${ag.pieceNum}`);
    return sendJson(res, 201, { ok: true, agentId: ag.id, status: 'pending' });
  }

  /* 📊 Niveau de remplissage du profil pro : 100 % = il inspire confiance */
  const aStatus = p.match(/^\/api\/agents\/(.+)\/status$/);
  if (aStatus && req.method === 'GET') {
    const ag = db.agents.find(a => a.id === aStatus[1]);
    if (!ag) return sendJson(res, 404, {});
    return sendJson(res, 200, { id: ag.id, nom: ag.nom, status: ag.status || 'approved', rejectReason: ag.rejectReason || '', blocked: !!ag.blocked,
      completion: agentCompletion(ag), quartier: ag.quartier || '', tel: ag.tel1 || '', photo: ag.photo || '' });
  }

  if (p.match(/^\/api\/agents\/(.+)\/profile$/) && req.method === 'PUT') {
    const b = await readBody(req);
    const id = p.match(/^\/api\/agents\/(.+)\/profile$/)[1];
    const ag = db.agents.find(a => a.id === id);
    if (!ag || (ag.status || 'approved') !== 'approved') return sendJson(res, 404, { error: 'compte introuvable' });
    const W = ['quartier', 'adresse', 'naissance', 'pieceType', 'pieceNum', 'urgenceNom', 'urgenceTel', 'ref1Nom', 'ref1Tel', 'niveau', 'tel2', 'experience'];
    let touched = 0;
    for (const f of W) {
      if (b[f] !== undefined && String(b[f]).trim() !== String(ag[f] || '')) { ag[f] = String(b[f]).slice(0, 160); touched++; }
    }
    if (typeof b.photo === 'string' && b.photo.length > 100 && b.photo.length < 600000) { ag.photo = b.photo; touched++; }
    const comp = agentCompletion(ag); saveDb();
    auditLog('pro_profil_maj', { pro: ag.nom, champs: touched, completion: comp });
    return sendJson(res, 200, { ok: true, completion: comp });
  }

  /* --- 🔔 Web Push : sonnerie agents même app fermée --- */
  if (p === '/api/push/key' && req.method === 'GET') {
    const k = vapidKeys();
    if (!k) return sendJson(res, 503, { error: 'push indisponible' });
    return sendJson(res, 200, { publicKey: k.publicKey });
  }
  if (p === '/api/push/subscribe' && req.method === 'POST') {
    const b = await readBody(req);
    const ag = db.agents.find(a => a.id === b.agentId);
    if (!ag) return sendJson(res, 404, { error: 'agent introuvable' });
    const sub = b.sub;
    if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || !sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return sendJson(res, 400, { error: 'abonnement invalide' });
    ag.pushSubs = (ag.pushSubs || []).filter(s => s.endpoint !== sub.endpoint);
    ag.pushSubs.push({ endpoint: sub.endpoint.slice(0, 500), keys: { p256dh: String(sub.keys.p256dh).slice(0, 200), auth: String(sub.keys.auth).slice(0, 60) } });
    ag.pushSubs = ag.pushSubs.slice(-3);
    saveDb();
    console.log('🔔 ' + ag.nom + ' a activé la sonnerie poche');
    return sendJson(res, 201, { ok: true });
  }
  if (p === '/api/push/unsubscribe' && req.method === 'POST') {
    const b = await readBody(req);
    const ag = db.agents.find(a => a.id === b.agentId);
    if (!ag) return sendJson(res, 404, {});
    ag.pushSubs = (ag.pushSubs || []).filter(s => s.endpoint !== (b.endpoint || ''));
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  /* --- API ADMIN (HQ) --- */
  if (p === '/api/admin/overview') {
    const MS = db.missions;
    const todayK = nowISO().slice(0, 10);
    const done = MS.filter(m => m.status === 'terminee');
    const caSum = arr => arr.reduce((s, m) => s + (m.prixTotal || 0), 0);
    const today = MS.filter(m => (m.createdAt || '').slice(0, 10) === todayK);
    const doneToday = done.filter(m => (m.finishedAt || '').slice(0, 10) === todayK);
    const active = MS.filter(m => ['accepted', 'enroute', 'arrive', 'encours'].includes(m.status)).length;
    const ca7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000), k = d.toISOString().slice(0, 10);
      const dd = done.filter(m => (m.finishedAt || '').slice(0, 10) === k);
      ca7.push({ day: d.toLocaleDateString('fr-FR', { weekday: 'short' }), ca: caSum(dd), n: dd.length });
    }
    const notes = done.filter(m => m.note).map(m => m.note);
    const OV = {
      agentsEnLigne: onlineAgents().length, agentsTotal: db.agents.length,
      clientsTotal: db.clients.length,
      candsPending: db.agents.filter(a => a.status === 'pending').length,
      missionsToday: today.length, missionsActive: active,
      missionsTotal: MS.length, missionsDone: done.length,
      caToday: caSum(doneToday), caTotal: caSum(done),
      commToday: Math.round(caSum(doneToday) * feePct()),
      commTotal: Math.round(caSum(done) * feePct()),
      gainAgentsTotal: caSum(done) - Math.round(caSum(done) * feePct()),
      noteMoyenne: notes.length ? Math.round(notes.reduce((s, n) => s + n, 0) / notes.length * 10) / 10 : 5,
      ca7
    };
    /* 🛡️ Matrice des rôles : le gestionnaire ne reçoit JAMAIS les chiffres financiers (cahier §A.1) */
    if ((hqIdentity(req) || {}).role !== 'pdg') {
      OV.caToday = null; OV.caTotal = null; OV.commToday = null; OV.commTotal = null;
      OV.gainAgentsTotal = null; OV.ca7 = [];
    }
    return sendJson(res, 200, OV);
  }

  if (p === '/api/admin/missions') {
    return sendJson(res, 200, db.missions.slice(-60).reverse().map(m => ({
      id: m.id, service: m.service, quartier: m.quartier, time: m.time, date: m.date,
      pieces: m.pieces, prixTotal: m.prixTotal, comm: Math.round((m.prixTotal || 0) * feePct()),
      status: m.status, client: m.client && m.client.nom,
      agent: m.agentId ? ((db.agents.find(a => a.id === m.agentId) || {}).nom || '—') : null,
      paiement: m.paiement, gps: !!(m.lat && m.lng),
      at: m.createdAt
    })));
  }

  if (p === '/api/admin/quotes' && req.method === 'GET') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const list = (db.missions || []).filter(m => m.service === 'custom' || m.quote).slice(-80).reverse().map((m, i, arr) => ({
      n: arr.length - i,
      id: m.id, status: m.status, desc: m.desc || '', photos: m.photos || [],
      budget: m.budget || 0, prixTotal: m.prixTotal || 0, quotedPrix: m.quotedPrix || 0,
      ville: m.ville || '', quartier: m.quartier || '', adresse: m.adresse || '',
      client: m.client && m.client.nom, tel: m.client && m.client.tel,
      agentId: m.agentId || '',
      agent: m.agentId ? ((db.agents.find(a => a.id === m.agentId) || {}).nom || '') : '',
      at: m.createdAt
    }));
    const open = list.filter(x => ['pending', 'quoted', 'recherche'].includes(x.status)).length;
    return sendJson(res, 200, { ok: true, n: list.length, open, list });
  }
  if (p === '/api/admin/quotes/assign' && req.method === 'POST') {
    if (!isAdminReq(req)) return sendJson(res, 401, {});
    const b = await readBody(req);
    const m = db.missions.find(x => x.id === b.id);
    const ag = db.agents.find(a => a.id === b.agentId && !a.blocked);
    if (!m || !ag) return sendJson(res, 404, { error: 'Mission ou pro introuvable' });
    m.agentId = ag.id; m.status = 'accepted'; m.assignedBy = act(req); m.assignedAt = nowISO();
    if (b.prix) { m.prixTotal = Math.round(Number(b.prix) || m.prixTotal || 0); m.quote = false; }
    saveDb();
    emitToMission(m, { type: 'mission_update', status: 'accepted', missionId: m.id,
      agent: { nom: ag.nom, note: agentStats(ag).rating, missions: agentStats(ag).missionsDone, tel: ag.tel1 || ag.tel, photo: ag.photo || '' },
      dist: m.dist });
    const sock = [...sockets].find(s => s.meta && s.meta.agentId === ag.id);
    if (sock) wsSend(sock, { type: 'mission_request', mission: publicMissionForAgent(m) });
    emitAdmin('mission', '👑 ' + act(req) + ' a attribué ' + m.id + ' à ' + ag.nom);
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/admin/quotes/price' && req.method === 'POST') {
    if (!isAdminReq(req)) return sendJson(res, 401, {});
    const b = await readBody(req);
    const m = db.missions.find(x => x.id === b.id);
    if (!m) return sendJson(res, 404, { error: 'Mission introuvable' });
    const prix = Math.max(500, Math.round(Number(b.prix) || 0));
    m.quotedPrix = prix; m.status = 'quoted'; m.quoteBy = act(req);
    saveDb();
    emitToMission(m, { type: 'quote_offer', missionId: m.id, prix, par: act(req) });
    emitAdmin('mission', '💰 Prix proposé ' + prix.toLocaleString('fr-FR') + ' F pour ' + m.id);
    return sendJson(res, 200, { ok: true, prix });
  }
  if (p === '/api/missions/quote-reply' && req.method === 'POST') {
    const b = await readBody(req);
    const cli = findClientByToken(req);
    if (!cli) return sendJson(res, 401, { error: 'Connectez-vous' });
    const m = db.missions.find(x => x.id === b.id && x.clientId === cli.id);
    if (!m) return sendJson(res, 404, { error: 'Demande introuvable' });
    if (b.accept) {
      m.prixTotal = m.quotedPrix || m.prixTotal;
      m.quote = false; m.status = 'pending';
      saveDb();
      broadcastNewMission(m);
      emitToMission(m, { type: 'mission_update', status: 'pending', missionId: m.id, prixTotal: m.prixTotal });
      return sendJson(res, 200, { ok: true, prixTotal: m.prixTotal });
    }
    m.status = 'annulee'; saveDb();
    emitToMission(m, { type: 'mission_update', status: 'annulee', missionId: m.id });
    return sendJson(res, 200, { ok: true, refused: true });
  }

  if (p === '/api/admin/agents') {
    const onA = onlineAgentIds();
    return sendJson(res, 200, db.agents.map(a => ({ id: a.id, nom: a.nom, quartier: a.quartier, ville: a.ville || '', mail: a.mail || '', online: agentIsOnline(a), status: a.status || 'approved', blocked: !!a.blocked, ...agentStats(a) })));
  }

  if (p === '/api/admin/inscrits') {
    const mine = x => isPdg(req) || ownsRecord(req, x) || true;
    const clients = db.clients.filter(mine).map(c => {
      const ms = db.missions.filter(m => m.clientId === c.id);
      const depense = ms.filter(m => m.status === 'terminee').reduce((s, m) => s + (m.prixTotal || 0), 0);
      const paiements = ms.filter(m => m.status === 'terminee').map(m => ({ id: m.id, montant: m.prixTotal, at: m.finishedAt || m.createdAt, service: m.service }));
      return { id: c.id, nom: c.nom, tel: c.tel, quartier: c.quartier || '', ville: c.ville || '', createdAt: c.createdAt, photo: !!c.photo, missions: ms.length, depense, blocked: !!c.blocked, createdBy: c.createdBy || '', createdById: c.createdById || '', online: clientIsOnline(c), paiements };
    });
    const agents = db.agents.filter(mine).map(a => ({ id: a.id, nom: a.nom, tel: a.tel || a.tel1 || '', quartier: a.quartier || '', ville: a.ville || '', villeService: a.villeService || a.ville || '', mail: a.mail || '', status: a.status || 'approved', online: agentIsOnline(a), niveau: a.niveau || '', services: a.services || [], kind: a.kind || 'pro', createdAt: a.createdAt, photo: !!a.photo, blocked: !!a.blocked, createdBy: a.createdBy || '', createdById: a.createdById || '', ...agentStats(a) }));
    return sendJson(res, 200, { clients: clients.slice().reverse(), agents: agents.slice().reverse(), canModerate: isPdg(req) });
  }

  /* --- Admin : dossiers de candidature --- */
  if (p === '/api/config') return sendJson(res, 200, {
    commission: (db.config && db.config.commission) || 25,
    reachKm: (db.config && typeof db.config.reachKm === 'number') ? db.config.reachKm : 15,
    payDest: (db.config && db.config.hide) ? { hide: true } : ((db.config && db.config.payDest) || {}),
    hidePay: !!(db.config && db.config.payDest && db.config.payDest.hide),
    cities: db.cities || [],
    services: db.catalog || [],
    supportChat: db.config && db.config.supportChat === false ? false : true
  });
  if (p === '/api/cities' && req.method === 'GET') return sendJson(res, 200, { ok: true, cities: db.cities || [] });
  if (p === '/api/admin/cities' && req.method === 'POST') {
    const b = await readBody(req);
    const nom = String(b.nom || '').trim().slice(0, 40);
    if (nom.length < 2) return sendJson(res, 400, { error: 'Nom de ville requis' });
    db.cities = db.cities || [];
    const id = nom.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || ('ville-' + Date.now());
    if (db.cities.some(x => x.id === id || String(x.nom).toLowerCase() === nom.toLowerCase()))
      return sendJson(res, 409, { error: 'Cette ville existe déjà' });
    const quartiers = String(b.quartiers || '').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean).slice(0, 40);
    const city = { id, nom, actif: true, quartiers: quartiers.length ? quartiers : [nom + '-Centre', 'Marché', 'Gare'], at: nowISO(), par: act(req) };
    db.cities.push(city); saveDb();
    auditLog('ville_ajoutee', { nom, par: act(req) });
    emitAdmin('admin', '🏙️ Nouvelle ville : ' + nom);
    return sendJson(res, 201, { ok: true, city });
  }
  if (p === '/api/admin/cities' && req.method === 'GET') return sendJson(res, 200, { cities: db.cities || [] });
  if (p === '/api/services' && req.method === 'GET') return sendJson(res, 200, { ok: true, services: db.catalog || [] });
  if (p === '/api/admin/services' && req.method === 'POST') {
    const b = await readBody(req);
    const nom = String(b.nom || '').trim().slice(0, 60);
    if (nom.length < 2) return sendJson(res, 400, { error: 'Nom du service requis' });
    const id = String(b.id || nom).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    db.catalog = db.catalog || [];
    if (db.catalog.some(s => s.id === id)) return sendJson(res, 409, { error: 'Ce service existe déjà' });
    const opts = Array.isArray(b.opts) ? b.opts.map(o => ({
      id: String(o.id || o.nom || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').slice(0, 30),
      nom: String(o.nom || '').slice(0, 60),
      prix: Math.max(0, parseInt(o.prix, 10) || 0)
    })).filter(o => o.nom) : [];
    const svc = { id, ic: String(b.ic || '🛠️').slice(0, 4), nom, desc: String(b.desc || '').slice(0, 80), base: Math.max(0, parseInt(b.base, 10) || 5000), cat: String(b.cat || 'home').slice(0, 12), opts, at: nowISO(), par: act(req) };
    db.catalog.push(svc); saveDb();
    auditLog('service_ajoute', { nom, par: act(req) });
    emitAdmin('admin', '🛠️ Service créé : ' + nom);
    return sendJson(res, 201, { ok: true, service: svc });
  }
  if (p === '/api/admin/services' && req.method === 'GET') return sendJson(res, 200, { services: db.catalog || [] });
  if (p === '/api/admin/services/pros' && req.method === 'GET') {
    const sid = String(url.searchParams.get('id') || '').trim();
    const onIds = onlineAgentIds();
    const list = (db.agents || []).filter(a => !a.blocked && (a.status || 'approved') === 'approved' && (!sid || agentHasService(a, sid))).map(a => ({
      id: a.id, nom: a.nom, tel: a.tel || a.tel1 || '', ville: a.villeIci || a.ville || '', quartier: a.quartier || '',
      online: agentIsOnline(a), services: a.services || []
    }));
    return sendJson(res, 200, { ok: true, id: sid, n: list.length, pros: list });
  }
  if (p === '/api/annonce') {
    if (typeof quizRevealIfDue === 'function') try { quizRevealIfDue(); } catch (e) {}
    const screen = String(url.searchParams.get('screen') || '').toLowerCase();
    const a0 = db.annonce || null;
    if (a0 && ((screen === 'client' && a0.hideClient) || (screen === 'agent' && a0.hideAgent)))
      return sendJson(res, 200, { ok: true, version: APP_VERSION, annonce: null, now: Date.now() });
    const an = db.annonce || null;
    const reacts = (an && an.reacts) || {};
    let likes = 0, unlikes = 0;
    Object.values(reacts).forEach(v => { if (v === 1) likes++; else if (v === -1) unlikes++; });
    const whoV = String(url.searchParams.get('who') || '').slice(0, 80);
    const nomV = String(url.searchParams.get('nom') || '').slice(0, 40);
    if (an && whoV && (an.type === 'info' || an.type === 'alerte' || an.type === 'maj' || an.type === 'quiz')) {
      an.views = an.views || {};
      if (!an.views[whoV]) { an.views[whoV] = { at: nowISO(), nom: nomV || whoV }; saveDb(); }
    }
    const nViews = an && an.views ? Object.keys(an.views).length : 0;
    const pub = an ? Object.assign({}, an) : null;
    if (pub) { delete pub.views; delete pub.pendingWinners; delete pub.winnerWho; }
    return sendJson(res, 200, {
      ok: true, version: APP_VERSION, annonce: pub, now: Date.now(),
      live: liveHome(), likes, unlikes, views: nViews
    });
  }
  if (p === '/api/annonce/react' && req.method === 'POST') {
    const b = await readBody(req);
    if (!db.annonce) return sendJson(res, 400, { error: 'Aucune affiche' });
    const who = String(b.who || b.accountId || ('anon-' + (req.socket.remoteAddress || ''))).slice(0, 80);
    let vote = parseInt(b.vote, 10);
    if (vote !== 1 && vote !== -1) vote = 0;
    db.annonce.reacts = db.annonce.reacts || {};
    if (db.annonce.reacts[who] === vote || vote === 0) delete db.annonce.reacts[who];
    else db.annonce.reacts[who] = vote;
    saveDb();
    const reacts = db.annonce.reacts;
    let likes = 0, unlikes = 0;
    Object.values(reacts).forEach(v => { if (v === 1) likes++; else if (v === -1) unlikes++; });
    return sendJson(res, 200, { ok: true, mine: db.annonce.reacts[who] || 0, likes, unlikes });
  }

  /* --- 🤝 Liaison d'un compte pro créé à la main par l'équipe (code à usage unique) --- */
  if (p === '/api/agents/claim' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || '?';
    const rc = loginTries.get(ip + '|claim') || { n: 0, t: 0 };
    if (rc.n >= 6 && Date.now() - rc.t < 600000) return sendJson(res, 429, { error: 'Trop d’essais — patientez 10 minutes' });
    const b = await readBody(req);
    const tel = String(b.tel || '').replace(/\D/g, '');
    const pin = String(b.pin || '').trim();
    const ag = db.agents.find(a => String(a.tel1 || '').replace(/\D/g, '') === tel && a.claimPin && a.claimPin === pin && (a.status || 'approved') === 'approved');
    if (!ag) {
      loginTries.set(ip + '|claim', { n: rc.n + 1, t: rc.t || Date.now() });
      return sendJson(res, 401, { error: 'Numéro ou code incorrect — vérifiez avec le gestionnaire' });
    }
    loginTries.delete(ip + '|claim');
    delete ag.claimPin; // 🔒 usage unique
    ag.claimedAt = nowISO();
    (ag.hist = ag.hist || []).push({ at: Date.now(), by: ag.nom, ev: '📱 Compte lié au téléphone du professionnel' });
    saveDb();
    auditLog('pro_lie', { pro: ag.nom, tel });
    return sendJson(res, 200, { ok: true, agentId: ag.id, nom: ag.nom });
  }
  if (p === '/api/agents/login' && req.method === 'POST') {
    const b = await readBody(req);
    const tel = String(b.tel || '').replace(/\D/g, '');
    const ag = db.agents.find(a => String(a.tel1 || a.tel || '').replace(/\D/g, '') === tel && (a.status || 'approved') === 'approved' && !a.blocked);
    if (!ag || !ag.passHash || hashPassword(ag.salt || '', b.password || '') !== ag.passHash)
      return sendJson(res, 401, { error: 'Téléphone ou mot de passe incorrect' });
    return sendJson(res, 200, { ok: true, agentId: ag.id, nom: ag.nom });
  }

  /* --- 💬 Support interne : utilisateur (client OU pro) ↔ équipe KLEAN --- */
  function supportIdent(req, b) {
    const tk = req.headers['x-client-token'] || '';
    if (tk) { const cl = db.clients.find(c => !c.blocked && clientToken(c.passHash) === tk); if (cl) return { role: 'client', id: cl.id, nom: cl.nom }; }
    const aid = (b && b.agentId) || url.searchParams.get('agentId') || '';
    if (aid) { const ag = db.agents.find(a => a.id === aid && (a.status || 'approved') === 'approved'); if (ag) return { role: 'pro', id: ag.id, nom: ag.nom }; }
    return null;
  }
  if (p === '/api/admin/support-chat' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    db.config = db.config || {};
    db.config.supportChat = b.on !== false;
    saveDb();
    auditLog('support_chat_toggle', { on: db.config.supportChat, par: 'PDG' });
    return sendJson(res, 200, { ok: true, on: db.config.supportChat });
  }
  if (p === '/api/support/send' && req.method === 'POST') {
    if (db.config && db.config.supportChat === false)
      return sendJson(res, 403, { error: 'Messages de la bulle désactivés par le PDG' });
    const b = await readBody(req);
    const who = supportIdent(req, b);
    if (!who) return sendJson(res, 401, { error: 'Identifiez-vous d’abord (inscription ou connexion)' });
    const text = String(b.text || '').trim().slice(0, 400);
    if (text.length < 2) return sendJson(res, 400, { error: 'Message vide' });
    const rk = who.role + ':' + who.id, t = Date.now();
    // limite douce : ~6 messages / minute / utilisateur
    const rec = supRateMap.get(rk);
    if (rec && t - rec.at < 60000 && rec.n >= 6) return sendJson(res, 429, { error: 'Trop de messages — patientez une minute' });
    supRateMap.set(rk, rec && t - rec.at < 60000 ? { n: rec.n + 1, at: rec.at } : { n: 1, at: t });
    db.supportMsgs.push({ id: uid('SR'), role: who.role, uid: who.id, nom: who.nom, from: 'user', text, at: nowISO(), readHQ: false, readUser: true });
    if (db.supportMsgs.length > 4000) db.supportMsgs = db.supportMsgs.slice(-2000);
    saveDb();
    broadcast(adminSockets(), { type: 'support_new', role: who.role, uid: who.id });
    emitAdmin('support', '💬 Message support (' + who.nom + ') : « ' + text.slice(0, 60) + (text.length > 60 ? '…' : '') + ' »');
    auditLog('support_message', { role: who.role, de: who.nom });
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/support/mine' && req.method === 'GET') {
    const who = supportIdent(req, null);
    if (!who) return sendJson(res, 401, { error: 'Identifiez-vous d’abord' });
    const peek = url.searchParams.get('peek') === '1';
    const convo = db.supportMsgs.filter(s => s.role === who.role && s.uid === who.id);
    const unread = convo.filter(s => s.from === 'hq' && !s.readUser).length;
    if (!peek && unread) { convo.forEach(s => { if (s.from === 'hq') s.readUser = true; }); saveDb(); }
    return sendJson(res, 200, { ok: true, unread, messages: convo.slice(-60) });
  }

  if (p === '/api/admin/config' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b2 = await readBody(req);
    const cc = parseFloat(b2.commission);
    if (isNaN(cc) || cc < 0 || cc > 50) return sendJson(res, 400, { error: 'Taux de commission entre 0 et 50 %' });
    db.config = db.config || {}; db.config.commission = Math.round(cc * 10) / 10; db.config.updatedAt = nowISO();
    if (b2.reachKm !== undefined && !isNaN(parseFloat(b2.reachKm))) {
      db.config.reachKm = Math.max(1, Math.min(80, Math.round(parseFloat(b2.reachKm))));
      auditLog('rayon_regle', { nouveau: db.config.reachKm, par: act(req) });
    }
    auditLog('commission_modifiee', { nouveau: db.config.commission, par: act(req) });
    saveDb();
    emitAdmin('admin', `⚙️ Commission plateforme réglée à ${db.config.commission} %`);
    return sendJson(res, 200, { ok: true, commission: db.config.commission });
  }

  /* --- 🔒 Pouvoirs du PDG : bloquer / débloquer / supprimer un professionnel --- */
  const kickOut = id => { for (const s of [...sockets].filter(x => x.meta && x.meta.agentId === id)) { try { wsSend(s, { type: 'agent_denied', reason: 'blocked' }); } catch (e) {} try { s.end(); } catch (e) {} } };
  const aBlock = p.match(/^\/api\/admin\/agents\/(.+)\/block$/);
  if (aBlock && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const ag = db.agents.find(a => a.id === aBlock[1]); if (!ag) return sendJson(res, 404, {});
    ag.blocked = true; ag.blockedAt = nowISO(); ag.online = false; saveDb(); kickOut(ag.id);
    (ag.history = ag.history || []).push({ at: nowISO(), by: act(req), action: 'bloque' });
    auditLog('pro_bloque', { pro: ag.nom, id: ag.id });
    emitAdmin('admin', `🔒 ${ag.nom} bloqué — hors ligne, ne reçoit plus aucune demande`);
    console.log(`🔒 Professionnel bloqué : ${ag.nom}`);
    return sendJson(res, 200, { ok: true });
  }
  const aUnblock = p.match(/^\/api\/admin\/agents\/(.+)\/unblock$/);
  if (aUnblock && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const ag = db.agents.find(a => a.id === aUnblock[1]); if (!ag) return sendJson(res, 404, {});
    ag.blocked = false; delete ag.blockedAt; saveDb();
    (ag.history = ag.history || []).push({ at: nowISO(), by: act(req), action: 'debloque' });
    auditLog('pro_debloque', { pro: ag.nom, id: ag.id });
    emitAdmin('admin', `✅ ${ag.nom} débloqué — à nouveau éligible`);
    return sendJson(res, 200, { ok: true });
  }
  const aDel = p.match(/^\/api\/admin\/agents\/(.+)$/);
  if (aDel && req.method === 'DELETE') {
    if (!pdgOnly(req, res)) return;
    const ag = db.agents.find(a => a.id === aDel[1]); if (!ag) return sendJson(res, 404, {});
    const busy = db.missions.some(m => m.agentId === ag.id && ['accepted', 'enroute', 'arrive', 'encours'].includes(m.status));
    if (busy) return sendJson(res, 409, { error: 'Mission en cours : bloquez ce professionnel puis supprimez-le une fois la mission terminée' });
    kickOut(ag.id);
    trashPush('agent', ag);
    db.agents = db.agents.filter(a => a.id !== ag.id); saveDb();
    auditLog('pro_supprime', { pro: ag.nom, id: aDel[1] });
    emitAdmin('admin', `🗑️ ${ag.nom} supprimé définitivement`);
    console.log(`🗑️ Professionnel supprimé : ${ag.nom}`);
    return sendJson(res, 200, { ok: true });
  }
  /* --- 🔒 Mêmes pouvoirs sur un client --- */
  const cBlock = p.match(/^\/api\/admin\/clients\/(.+)\/block$/);
  if (cBlock && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const cl = db.clients.find(c => c.id === cBlock[1]); if (!cl) return sendJson(res, 404, {});
    cl.blocked = true; cl.blockedAt = nowISO(); saveDb();
    auditLog('client_bloque', { client: cl.nom, id: cl.id });
    emitAdmin('admin', `🔒 Client ${cl.nom} bloqué — ne peut plus passer de demandes`);
    return sendJson(res, 200, { ok: true });
  }
  const cUnblock = p.match(/^\/api\/admin\/clients\/(.+)\/unblock$/);
  if (cUnblock && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const cl = db.clients.find(c => c.id === cUnblock[1]); if (!cl) return sendJson(res, 404, {});
    cl.blocked = false; delete cl.blockedAt; saveDb();
    auditLog('client_debloque', { client: cl.nom, id: cl.id });
    emitAdmin('admin', `✅ Client ${cl.nom} débloqué`);
    return sendJson(res, 200, { ok: true });
  }
  const cDel = p.match(/^\/api\/admin\/clients\/(.+)$/);
  if (cDel && req.method === 'DELETE') {
    const cl = db.clients.find(c => c.id === cDel[1]); if (!cl) return sendJson(res, 404, {});
    const busy = db.missions.some(m => m.clientId === cl.id && ['accepted', 'enroute', 'arrive', 'encours'].includes(m.status));
    if (busy) return sendJson(res, 409, { error: 'Mission en cours pour ce client : bloquez-le d’abord, supprimez-le après la fin' });
    db.missions.forEach(m => { if (m.clientId === cl.id && m.status === 'pending') { m.status = 'annulee'; m.cancelReason = 'compte supprime'; } });
    trashPush('client', cl);
    db.clients = db.clients.filter(c => c.id !== cl.id); saveDb();
    auditLog('client_supprime', { client: cl.nom, id: cDel[1] });
    emitAdmin('admin', `🗑️ Client ${cl.nom} supprimé définitivement`);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/admin/annonce' && req.method === 'POST') {
    const b = await readBody(req);
    const msg = String(b.message || '').trim().slice(0, 240);
    if (msg.length < 4) return sendJson(res, 400, { error: 'Message trop court' });
    const type = ['maj', 'info', 'alerte', 'quiz'].includes(b.type) ? b.type : 'info';
    const choices = Array.isArray(b.choices) ? b.choices.map(x => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 4) : [];
    if (type === 'quiz' && choices.length < 2) return sendJson(res, 400, { error: 'Quiz : au moins 2 choix' });
    if (type === 'quiz' && db.annonce && db.annonce.type === 'quiz') {
      db.quizSeries = db.quizSeries || [];
      db.quizSeries.push({
        question: db.annonce.question || db.annonce.message,
        goods: (db.quizAnswers || []).filter(x => x.ok).map(x => x.nom),
        at: nowISO()
      });
    }
    const answerSeconds = type === 'quiz' ? Math.max(0, Math.min(7200, parseInt(b.answerSeconds, 10) || 0)) : 0;
    const quizWho = type === 'quiz' ? {
      clients: ['all', 'done', 'none'].includes(b.clients) ? b.clients : 'done',
      pros: ['all', 'done', 'none'].includes(b.pros) ? b.pros : 'done'
    } : null;
    db.annonce = { id: uid('AN'), message: msg, type, at: nowISO(), par: act(req),
      question: type === 'quiz' ? (String(b.question || '').trim().slice(0, 180) || msg) : '',
      choices: type === 'quiz' ? choices : [],
      good: type === 'quiz' ? Math.max(0, Math.min(3, parseInt(b.good, 10) || 0)) : 0,
      closed: false, winners: [],
      answerSeconds,
      answerEndsAt: answerSeconds ? new Date(Date.now() + answerSeconds * 1000).toISOString() : null,
      quizWho };
    db.quizAnswers = [];
    if (type === 'quiz') db.lastQuiz = { message: msg, question: db.annonce.question, choices: db.annonce.choices, good: db.annonce.good, answerSeconds, quizWho: db.annonce.quizWho };
    saveDb();
    auditLog('annonce_publiee', { type, par: act(req) });
    emitAdmin('annonce', '📣 Affiche publiée pour tous les utilisateurs');
    return sendJson(res, 200, { ok: true });
  }
  if ((p === '/api/admin/annonce' && req.method === 'DELETE') || (p === '/api/admin/annonce/retirer' && req.method === 'POST')) {
    if (!pdgOnly(req, res)) return;
    const b = req.method === 'POST' ? await readBody(req) : {};
    const scope = String(b.scope || 'all');
    if (scope === 'client') {
      if (db.annonce) db.annonce.hideClient = true;
      auditLog('annonce_retiree', { par: act(req), scope: 'client' });
    } else if (scope === 'agent') {
      if (db.annonce) db.annonce.hideAgent = true;
      auditLog('annonce_retiree', { par: act(req), scope: 'agent' });
    } else if (scope === 'series') {
      db.annonce = null; db.quizSeries = []; db.quizAnswers = [];
      auditLog('annonce_retiree', { par: act(req), scope: 'series' });
    } else {
      db.annonce = null;
      auditLog('annonce_retiree', { par: act(req), scope: 'all' });
    }
    if (db.annonce && db.annonce.hideClient && db.annonce.hideAgent) db.annonce = null;
    saveDb();
    emitAdmin('annonce', '📣 Affiche / quiz retiré (' + scope + ')');
    return sendJson(res, 200, { ok: true, scope });
  }
  if (p === '/api/ads' && req.method === 'GET') {
    const screen = String(url.searchParams.get('screen') || '').toLowerCase();
    const ad = db.ad || null;
    if (!ad || !ad.active) return sendJson(res, 200, { ad: null });
    if (screen === 'client' && ad.hideClient) return sendJson(res, 200, { ad: null });
    if (screen === 'agent' && ad.hideAgent) return sendJson(res, 200, { ad: null });
    const whoV = String(url.searchParams.get('who') || '').slice(0, 80);
    const nomV = String(url.searchParams.get('nom') || '').slice(0, 40);
    if (whoV) {
      ad.views = ad.views || {};
      if (!ad.views[whoV]) { ad.views[whoV] = { at: nowISO(), nom: nomV || whoV }; saveDb(); }
    }
    const adPub = Object.assign({}, ad);
    delete adPub.views;
    return sendJson(res, 200, { ad: adPub, views: Object.keys(ad.views || {}).length });
  }
  if (p === '/api/admin/ads' && req.method === 'GET') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const adA = db.ad || null;
    return sendJson(res, 200, { ad: adA ? Object.assign({}, adA, { views: undefined }) : null, views: adA && adA.views ? Object.keys(adA.views).length : 0 });
  }
  if (p === '/api/admin/ads' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const kind = ['produit', 'promo', 'lancement', 'stock'].includes(b.kind) ? b.kind : 'produit';
    const firm = String(b.firm || b.nom || '').trim().slice(0, 60);
    const prod = String(b.prod || b.title || '').trim().slice(0, 80);
    if (firm.length < 2) return sendJson(res, 400, { error: 'Nom de l’entreprise requis' });
    if (prod.length < 2) return sendJson(res, 400, { error: 'Nom du produit requis' });
    db.ad = {
      active: true, kind, firm, prod,
      cat: String(b.cat || 'autre').slice(0, 20),
      text: String(b.text || '').trim().slice(0, 140),
      prix: String(b.prix || '').trim().slice(0, 40),
      old: String(b.old || '').trim().slice(0, 40),
      off: String(b.off || '').trim().slice(0, 40),
      tel: String(b.tel || '').replace(/\D/g, '').slice(0, 15),
      hideClient: !b.clients, hideAgent: !b.pros,
      at: nowISO(), par: act(req)
    };
    saveDb();
    return sendJson(res, 200, { ok: true, ad: db.ad });
  }
  if (p === '/api/admin/ads' && req.method === 'DELETE') {
    if (!pdgOnly(req, res)) return;
    db.ad = null; saveDb();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/admin/vues' && req.method === 'GET') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const kind = String(url.searchParams.get('kind') || 'annonce');
    if (kind === 'ad') {
      const ad = db.ad || null;
      const list = viewsOrdered(ad && ad.views);
      return sendJson(res, 200, { ok: true, kind: 'ad', titre: ad ? ((ad.firm || '') + ' — ' + (ad.prod || '')) : 'Pub', list });
    }
    const an = db.annonce || null;
    const list = viewsOrdered(an && an.views);
    return sendJson(res, 200, { ok: true, kind: 'annonce', titre: an ? (an.message || an.type) : 'Affiche', type: an && an.type, list });
  }
  if (p === '/api/admin/whoami' && req.method === 'GET') {
    const id = hqIdentity(req);
    return sendJson(res, 200, { role: id.role, nom: id.nom, gestFrozen: !!(db.config && db.config.gestFrozen) });
  }
  if (p === '/api/admin/gest-freeze' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    if (!db.admin || hashPassword(db.admin.salt, b.password || '') !== db.admin.passHash)
      return sendJson(res, 401, { error: 'Mot de passe PDG incorrect' });
    db.config = db.config || {};
    db.config.gestFrozen = !!b.frozen;
    saveDb();
    auditLog(db.config.gestFrozen ? 'ecriture_gel' : 'ecriture_degel', { par: 'PDG' });
    emitAdmin('admin', db.config.gestFrozen ? '⛔ Écriture coupée (gestionnaires, clients, pros)' : '✅ Écriture réactivée');
    if (db.config.gestFrozen) {
      for (const s of [...sockets]) {
        try { wsSend(s, { type: 'frozen', error: 'Écriture désactivée par le PDG' }); } catch (e) {}
      }
    }
    return sendJson(res, 200, { ok: true, gestFrozen: db.config.gestFrozen });
  }
  if (p === '/api/admin/search' && req.method === 'GET') {
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const hit = (...xs) => xs.some(s => String(s == null ? '' : (typeof s === 'object' ? JSON.stringify(s) : s)).toLowerCase().includes(q));
    const take = (arr, n) => (arr || []).slice(0, n);
    if (q.length < 1) return sendJson(res, 200, { q, sections: [] });
    const sections = [];
    const add = (title, panel, items) => { if (items && items.length) sections.push({ title, panel, items }); };
    add('🧑‍💼 Pros', 'people', take((db.agents || []).filter(a => hit(a.nom, a.tel, a.tel1, a.mail, a.ville, a.quartier, a.id, a.services, a.status)).map(a => ({ t: a.nom, s: [a.tel || a.tel1, a.ville, a.status].filter(Boolean).join(' · ') })), 40));
    add('👤 Clients', 'people', take((db.clients || []).filter(c => hit(c.nom, c.tel, c.mail, c.ville, c.quartier, c.id)).map(c => ({ t: c.nom, s: [c.tel, c.ville].filter(Boolean).join(' · ') })), 40));
    add('🟢 Clients en ligne', 'panel-online-cli', take((db.clients || []).filter(c => clientIsOnline(c) && hit(c.nom, c.tel)).map(c => ({ t: c.nom, s: 'en ligne' })), 20));
    add('📋 Missions', 'panel-ca7', take((db.missions || []).filter(m => hit(m.id, m.service, m.quartier, m.adresse, m.status, m.paiement, (m.client || {}).nom, (m.client || {}).tel, m.agentId)).map(m => ({ t: m.id + ' · ' + (m.service || ''), s: [m.status, (m.client || {}).nom, m.quartier].filter(Boolean).join(' · ') })), 30));
    add('👑 Gestionnaires', 'panel-team', take((db.admins || []).filter(a => hit(a.nom, a.ident, a.id)).map(a => ({ t: a.nom, s: a.ident || '' })), 20));
    add('🧭 Agents de terrain', 'panel-team', take((db.fieldAgents || []).filter(f => hit(f.nom, f.ident, f.tel, f.id)).map(f => ({ t: f.nom, s: f.ident || f.tel || '' })), 20));
    add('🛡️ Candidatures', 'panel-cands', take((db.agents || []).filter(a => (a.status || 'approved') !== 'approved' && hit(a.nom, a.tel, a.status, a.ville)).map(a => ({ t: a.nom, s: a.status })), 30));
    add('💬 Support', 'panel-support', take((db.support || []).filter(m => hit(m.nom, m.tel, m.text, m.body, m.msg, m.from)).map(m => ({ t: m.nom || m.from || 'msg', s: String(m.text || m.body || m.msg || '').slice(0, 80) })), 30));
    add('🟠 Fil PDG', 'panel-hqchat', take((db.hqChat || []).filter(m => hit(m.nom, m.text, m.body, m.from)).map(m => ({ t: m.nom || m.from || 'fil', s: String(m.text || m.body || '').slice(0, 80) })), 30));
    add('📜 Audit', 'panel-audit', take((db.audit || []).filter(a => hit(a.kind, a.action, a.qui, JSON.stringify(a))).reverse().map(a => ({ t: a.kind || a.action || 'audit', s: a.qui || '' })), 40));
    add('🏙️ Villes', 'panel-villes', take((db.cities || []).filter(c => hit(c.nom, c.quartiers)).map(c => ({ t: c.nom, s: Array.isArray(c.quartiers) ? c.quartiers.join(', ') : '' })), 40));
    add('🛠️ Services', 'panel-svc-browse', take((db.catalog || []).filter(s => hit(s.nom, s.id, s.desc, s.opts)).map(s => ({ t: (s.ic || '') + ' ' + (s.nom || s.id), s: s.desc || '' })), 40));
    add('🎟️ Promos', 'panel-promo', take((db.promos || []).filter(p => hit(p.code, p.nom, p.note)).map(p => ({ t: p.code || p.nom, s: String(p.note || '') })), 20));
    add('🤝 Partenaires', 'panel-promo', take((db.partners || []).filter(p => hit(p.nom, p.tel, p.note)).map(p => ({ t: p.nom, s: p.tel || '' })), 20));
    add('💳 Paiement', 'panel-paydest', hit(db.config && db.config.payDest) ? [{ t: 'Numéros de paiement', s: JSON.stringify((db.config && db.config.payDest) || {}).slice(0, 80) }] : []);
    add('♻️ Corbeille', 'panel-trash', take((db.trash || []).filter(t => hit(t.kind, t.id, t.data)).map(t => ({ t: t.kind + ' ' + t.id, s: (t.data && t.data.nom) || '' })), 20));
    add('📣 Affiche', 'panel-ann', (db.annonce && hit(db.annonce, db.annonce.text, db.annonce.title)) ? [{ t: 'Affiche', s: String(db.annonce.text || db.annonce.title || db.annonce.type || '') }] : []);
    add('⚙️ Réglages', 'panel-cfg', hit(db.config) ? [{ t: 'Config plateforme', s: '' }] : []);
    add('📝 Demandes de compte', 'panel-team', take((db.accountRequests || []).filter(r => hit(r.nom, r.tel, r.ident)).map(r => ({ t: r.nom, s: r.tel || r.ident || '' })), 20));
    add('❓ Quiz', 'panel-ann', take((db.quizAnswers || []).filter(a => hit(a.nom, a.answer, a.tel)).map(a => ({ t: a.nom || 'réponse', s: String(a.answer || '').slice(0, 60) })), 20));
    return sendJson(res, 200, { q, sections });
  }

  /* --- 🔁 Réattribution manuelle d'urgence d'une mission (gestionnaire autorisé) --- */
  /* --- 🏗️ Création guidée de comptes par l'équipe (client ou professionnel) --- */
  if (p === '/api/admin/clients/create' && req.method === 'POST') {
    const b = await readBody(req);
    const nom = String(b.nom || '').trim();
    if (nom.length < 2) return sendJson(res, 400, { error: 'Nom du client trop court' });
    const tel = String(b.tel || '').replace(/\D/g, '');
    if (tel.length < 8) return sendJson(res, 400, { error: 'Numéro de téléphone invalide' });
    if (db.clients.find(cl => cl.tel === tel)) return sendJson(res, 409, { error: 'Ce numéro a déjà un compte client' });
    let pw = String(b.password || ''), gen = false;
    if (!pw) { pw = 'Klean-' + Math.floor(1000 + Math.random() * 9000) + '!'; gen = true; }
    const perr = validPassword(pw);
    if (perr) return sendJson(res, 400, { error: 'Mot de passe faible : ' + perr });
    const salt = crypto.randomBytes(12).toString('hex');
    const fid = fieldIdentity(req);
    const cl = { id: uid('CL'), nom, tel, quartier: String(b.quartier || '').trim(), ville: String(b.ville || '').trim().slice(0, 60), mail: String(b.mail || '').trim().slice(0, 80), salt, passHash: hashPassword(salt, pw), createdAt: nowISO(), createdBy: act(req), createdById: actorId(req) || (fid && fid.id), createdByGestId: fid ? fid.gestId : (hqIdentity(req) && hqIdentity(req).role === 'gest' ? hqIdentity(req).id : null) };
    db.clients.push(cl); saveDb();
    auditLog('client_cree_hq', { nom, tel, par: act(req) });
    emitAdmin('client', '👤 Compte client créé par ' + act(req) + ' : ' + nom + ' (' + tel + ')');
    return sendJson(res, 201, { ok: true, id: cl.id, nom, tel, password: pw, passwordGenere: gen });
  }
  if (p === '/api/admin/agents/create' && req.method === 'POST') {
    const b = await readBody(req);
    const nom = String(b.nom || '').trim(), prenom = String(b.prenom || '').trim();
    if (nom.length < 2 || prenom.length < 2) return sendJson(res, 400, { error: 'Nom et prénom requis' });
    const tel1 = String(b.tel || '').replace(/\D/g, '');
    if (tel1.length < 8) return sendJson(res, 400, { error: 'Numéro de téléphone invalide' });
    if (db.agents.find(a => String(a.tel1 || '').replace(/\D/g, '') === tel1)) return sendJson(res, 409, { error: 'Ce numéro est déjà inscrit chez les professionnels' });
    const pin = String(b.pin || '').replace(/\D/g, '').slice(0, 8) || String(Math.floor(100000 + Math.random() * 900000));
    const pw = String(b.password || '') || ('Klean-' + Math.floor(1000 + Math.random() * 9000) + '!');
    const salt = crypto.randomBytes(12).toString('hex');
    const services = Array.isArray(b.services) && b.services.length ? b.services : [b.service || 'maison'];
    const na = { id: uid('AG'), nom: (prenom + ' ' + nom).trim(), prenom, tel1, tel: tel1, salt, passHash: hashPassword(salt, pw), quartier: String(b.quartier || '').trim(), ville: String(b.ville || '').trim().slice(0, 60), mail: String(b.mail || '').trim().slice(0, 80), adresse: String(b.adresse || '').trim(),
      naissance: '', experience: b.experience || 0, pieceType: '', pieceNum: '', tel2: '', urgenceNom: '', urgenceTel: '', ref1Nom: '', ref1Tel: '',
      services, niveau: '', photo: '', pushSubs: [], hist: [{ at: Date.now(), by: act(req), ev: '🏗️ Compte créé à la main par l’équipe — vérification immédiate' }],
      status: 'approved', approvedAt: nowISO(), createdAt: nowISO(), createdBy: act(req), createdById: actorId(req), createdByGestId: fieldIdentity(req) ? fieldIdentity(req).gestId : ((hqIdentity(req)||{}).role==='gest' ? hqIdentity(req).id : null), claimPin: pin, online: false, pos: null, kind: 'pro' };
    db.agents.push(na); saveDb();
    auditLog('pro_cree_hq', { pro: na.nom, tel: tel1, par: act(req) });
    emitAdmin('agent', '🏗️ ' + act(req) + ' a créé le professionnel ' + na.nom + ' — code de liaison remis en main');
    return sendJson(res, 201, { ok: true, id: na.id, nom: na.nom, tel: tel1, pin, password: pw });
  }

  const mRea = p.match(/^\/api\/admin\/missions\/(.+)\/reassign$/);
  if (mRea && req.method === 'POST') {
    const b = await readBody(req);
    const m = db.missions.find(x => x.id === mRea[1]);
    if (!m) return sendJson(res, 404, { error: 'mission introuvable' });
    if (!['accepted', 'enroute'].includes(m.status)) return sendJson(res, 409, { error: 'Seules les missions « acceptée » ou « en route » peuvent être réattribuées d’urgence' });
    const oldAg = db.agents.find(a => a.id === m.agentId);
    const oldId = m.agentId;
    m.exclAg = [...new Set([...(m.exclAg || []), oldId].filter(Boolean))];
    m.hist = m.hist || [];
    m.hist.push({ at: Date.now(), by: act(req), ev: '⤴ Réattribution d’urgence (ancien : ' + (oldAg ? oldAg.nom : oldId) + ') — ' + String(b.reason || 'motif non précisé').slice(0, 120) });
    m.agentId = null; m.status = 'pending'; delete m.acceptedAt;
    saveDb();
    // nouvelle diffusion (sauf à l'ancien)
    const t2 = missionTargets(m).filter(s => !(m.exclAg || []).includes(s.meta && s.meta.agentId));
    broadcast(t2, { type: 'mission_request', mission: publicMissionForAgent(m) });
    pushNewMissionToAgents(m, (SVC_NAMES[m.service] || m.service) || '').catch(() => {});
    // informer l'ancien + les écrans abonnés
    const oldSock = [...sockets].find(s => s.meta && s.meta.agentId === oldId);
    if (oldSock) wsSend(oldSock, { type: 'mission_reassigned', missionId: m.id, reason: (b.reason || '').slice(0, 120) });
    emitToMission(m, { type: 'mission_update', status: 'pending', missionId: m.id, agent: null });
    auditLog('mission_reattribuee', { mission: m.id, ancien: oldAg ? oldAg.nom : '?', par: act(req) });
    emitAdmin('mission', '⤴ Mission ' + m.id + ' retirée à ' + (oldAg ? oldAg.nom : '?') + ' par ' + act(req) + ' — réattribuée');
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/admin/support' && req.method === 'GET') {
    const open = url.searchParams.get('open') || '';
    let messages = null;
    if (open) {
      const [r0, u0] = open.split('|');
      messages = db.supportMsgs.filter(s => s.role === r0 && s.uid === u0).slice(-80);
      if (messages.some(s => s.from === 'user' && !s.readHQ)) { messages.forEach(s => { if (s.from === 'user') s.readHQ = true; }); saveDb(); }
    }
    const convs = {};
    for (const s of db.supportMsgs) {
      const k = s.role + ':' + s.uid;
      if (!convs[k]) convs[k] = { role: s.role, uid: s.uid, nom: s.nom, last: null, unreadHQ: 0 };
      convs[k].last = { text: s.text, at: s.at, from: s.from };
      if (s.from === 'user' && !s.readHQ) convs[k].unreadHQ++;
    }
    const list = Object.values(convs).sort((a, b) => String((b.last || {}).at).localeCompare(String((a.last || {}).at)));
    return sendJson(res, 200, { ok: true, conversations: list, messages });
  }
  if (p === '/api/admin/support' && req.method === 'POST') {
    const b = await readBody(req);
    const text = String(b.text || '').trim().slice(0, 400);
    if (text.length < 2) return sendJson(res, 400, { error: 'Message vide' });
    if (!['client', 'pro'].includes(b.role) || !b.uid) return sendJson(res, 400, { error: 'destinataire inconnu' });
    const cible = b.role === 'client' ? db.clients.find(c => c.id === b.uid) : db.agents.find(a => a.id === b.uid);
    if (!cible) return sendJson(res, 404, { error: 'introuvable' });
    if (!ownsRecord(req, cible)) return sendJson(res, 403, { error: 'Ce compte n’est pas le vôtre' });
    const muteKey = b.role + ':' + b.uid;
    if ((db.mutedChats || []).some(m => m.key === muteKey)) return sendJson(res, 403, { error: 'Conversation interrompue par le PDG' });
    const sender = isPdg(req) ? 'PDG' : act(req);
    db.supportMsgs.push({ id: uid('SR'), role: b.role, uid: b.uid, nom: cible.nom, from: 'hq', par: sender, text, at: nowISO(), readHQ: true, readUser: false });
    saveDb();
    if (b.role === 'pro') {
      const sock = [...sockets].find(s => s.meta && s.meta.agentId === b.uid);
      if (sock) wsSend(sock, { type: 'support_msg', text, par: sender });
    }
    auditLog('support_reponse', { par: sender, a: cible.nom, role: b.role });
    return sendJson(res, 200, { ok: true });
  }

  /* --- 👑 Gestionnaires : créés par le PDG depuis son tableau de bord --- */
  if (p === '/api/admin/admins' && req.method === 'GET') {
    if (!pdgOnly(req, res)) return;
    return sendJson(res, 200, (db.admins || []).map(a => ({ id: a.id, nom: a.nom, ident: a.ident, blocked: !!a.blocked, createdAt: a.createdAt, lastLogin: a.lastLogin || null })));
  }
  if (p === '/api/admin/admins' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const nom = String(b.nom || '').trim();
    if (nom.length < 3) return sendJson(res, 400, { error: 'Nom du gestionnaire trop court' });
    const ident = normIdent(b.ident || nom.split(' ')[0]);
    if (ident.length < 3) return sendJson(res, 400, { error: 'Identifiant trop court (ex : awa.ckn)' });
    if (ident === 'pdg') return sendJson(res, 400, { error: 'Cet identifiant est réservé au PDG' });
    db.admins = db.admins || [];
    if (db.admins.some(a => normIdent(a.ident) === ident || normIdent(a.nom) === nom)) return sendJson(res, 409, { error: 'Nom ou identifiant déjà utilisé' });
    const bad = validPassword(b.password || '');
    if (bad) return sendJson(res, 400, { error: bad });
    const salt = crypto.randomBytes(16).toString('hex');
    const na = { id: uid('AD'), nom, ident, salt, passHash: hashPassword(salt, b.password), blocked: false, createdAt: nowISO(), lastLogin: null, by: act(req) };
    db.admins.push(na); saveDb();
    auditLog('admin_cree', { gestionnaire: nom, ident, par: act(req) });
    emitAdmin('admin', `👑 Gestionnaire créé : ${nom} (${ident})`);
    return sendJson(res, 201, { ok: true, id: na.id });
  }
  const adAct = p.match(/^\/api\/admin\/admins\/(.+)\/(block|unblock|password)$/);
  if (adAct && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const ad = (db.admins || []).find(a => a.id === adAct[1]);
    if (!ad) return sendJson(res, 404, {});
    if (adAct[2] === 'block') {
      ad.blocked = true; ad.blockedAt = nowISO();
      auditLog('admin_bloque', { gestionnaire: ad.nom, par: act(req) });
      emitAdmin('admin', `🔒 Gestionnaire ${ad.nom} bloqué — éjecté immédiatement`);
    } else if (adAct[2] === 'unblock') {
      ad.blocked = false; delete ad.blockedAt;
      auditLog('admin_debloque', { gestionnaire: ad.nom, par: act(req) });
      emitAdmin('admin', `✅ Gestionnaire ${ad.nom} débloqué`);
    } else {
      const b = await readBody(req);
      const bad = validPassword(b.password || '');
      if (bad) return sendJson(res, 400, { error: bad });
      ad.salt = crypto.randomBytes(16).toString('hex');
      ad.passHash = hashPassword(ad.salt, b.password);
      auditLog('admin_mdp_regenere', { gestionnaire: ad.nom, par: act(req) });
      emitAdmin('admin', `🔑 Nouveau mot de passe fixé pour ${ad.nom} (ancien jeton révoqué)`);
    }
    saveDb();
    return sendJson(res, 200, { ok: true });
  }
  const adDel = p.match(/^\/api\/admin\/admins\/(.+)$/);
  if (adDel && req.method === 'DELETE') {
    if (!pdgOnly(req, res)) return;
    const ad = (db.admins || []).find(a => a.id === adDel[1]);
    if (!ad) return sendJson(res, 404, {});
    db.admins = db.admins.filter(a => a.id !== ad.id);
    auditLog('admin_supprime', { gestionnaire: ad.nom, par: act(req) });
    emitAdmin('admin', `🗑️ Gestionnaire ${ad.nom} supprimé — accès révoqué`);
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/admin/audit') { if (!pdgOnly(req, res)) return; return sendJson(res, 200, (db.audit || []).slice(-200).reverse()); }

  if (p === '/api/admin/candidatures') {
    return sendJson(res, 200, db.agents
      .filter(a => a.status)
      .slice().reverse()
      .map(a => {
        const { piecePhoto, ...rest } = a;   // liste sans la photo (chargée au détail)
        return { ...rest, hasPhoto: !!piecePhoto };
      }));
  }

  const cOne = p.match(/^\/api\/admin\/candidatures\/(.+)$/);
  if (cOne && req.method === 'GET') {
    const ag = db.agents.find(a => a.id === cOne[1]);
    if (!ag) return sendJson(res, 404, {});
    return sendJson(res, 200, ag);
  }

  const aApprove = p.match(/^\/api\/admin\/agents\/(.+)\/approve$/);
  if (aApprove && req.method === 'POST') {
    const ag = db.agents.find(a => a.id === aApprove[1]);
    if (!ag) return sendJson(res, 404, {});
    ag.status = 'approved'; ag.approvedAt = nowISO(); saveDb();
    (ag.history = ag.history || []).push({ at: nowISO(), by: act(req), action: 'valide', from: 'pending', to: 'approved' });
    auditLog('agent_valide', { agent: ag.nom, id: ag.id, par: act(req) });
    emitAdmin('cand', `✅ ${ag.nom} validé — peut maintenant recevoir des missions`);
    const s = [...sockets].find(x => x.meta && x.meta.agentId === ag.id);
    if (s) wsSend(s, { type: 'agent_approved', nom: ag.nom });
    console.log(`✅ Agent validé : ${ag.nom}`);
    return sendJson(res, 200, { ok: true });
  }

  const aReject = p.match(/^\/api\/admin\/agents\/(.+)\/reject$/);
  if (aReject && req.method === 'POST') {
    const { reason } = await readBody(req);
    const ag = db.agents.find(a => a.id === aReject[1]);
    if (!ag) return sendJson(res, 404, {});
    ag.status = 'rejected'; ag.rejectReason = reason || 'Dossier incomplet'; ag.online = false; saveDb();
    (ag.history = ag.history || []).push({ at: nowISO(), by: act(req), action: 'rejete', motif: ag.rejectReason });
    auditLog('agent_rejete', { agent: ag.nom, id: ag.id, motif: ag.rejectReason });
    emitAdmin('cand', `❌ Candidature de ${ag.nom} rejetée (${ag.rejectReason})`);
    const s = [...sockets].find(x => x.meta && x.meta.agentId === ag.id);
    if (s) wsSend(s, { type: 'agent_rejected', reason: ag.rejectReason });
    return sendJson(res, 200, { ok: true });
  }

  const aMore = p.match(/^\/api\/admin\/agents\/(.+)\/moreinfo$/);
  if (aMore && req.method === 'POST') {
    const { motif } = await readBody(req);
    const ag = db.agents.find(a => a.id === aMore[1]);
    if (!ag) return sendJson(res, 404, {});
    ag.status = 'moreinfo'; ag.moreInfoReason = String(motif || 'Merci de compléter votre dossier').slice(0, 220); ag.online = false; saveDb();
    (ag.history = ag.history || []).push({ at: nowISO(), by: act(req), action: 'infos_demandees', motif: ag.moreInfoReason });
    auditLog('agent_infos_demandees', { agent: ag.nom, id: ag.id, motif: ag.moreInfoReason });
    emitAdmin('cand', `📝 ${ag.nom} : informations supplémentaires demandées (${ag.moreInfoReason})`);
    const s = [...sockets].find(x => x.meta && x.meta.agentId === ag.id);
    if (s) wsSend(s, { type: 'agent_moreinfo', reason: ag.moreInfoReason });
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/admin/nudge' && req.method === 'POST') {
    const b = await readBody(req);
    const rec = b.role === 'client' ? db.clients.find(c => c.id === b.id) : db.agents.find(a => a.id === b.id);
    if (!rec) return sendJson(res, 404, { error: 'introuvable' });
    if (!ownsRecord(req, rec) && !isPdg(req)) return sendJson(res, 403, { error: 'Pas votre compte' });
    const text = String(b.text || 'Vous n’êtes pas en ligne — vous pourriez perdre des clients. Ouvrez KLEAN et passez en ligne.').slice(0, 220);
    db.supportMsgs.push({ id: uid('SR'), role: b.role === 'client' ? 'client' : 'pro', uid: rec.id, nom: rec.nom, from: 'hq', par: act(req), text, at: nowISO(), readHQ: true, readUser: false });
    if (webpush && Array.isArray(rec.pushSubs)) {
      const payload = JSON.stringify({ title: '🔔 KLEAN-SERVICES CI', body: text, url: '/', vibrate: true });
      for (const sub of rec.pushSubs) { try { await webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'high' }); } catch (e) {} }
    }
    saveDb();
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/admin/field' && req.method === 'GET') {
    const list = (db.fieldAgents || []).filter(f => isPdg(req) || ownsRecord(req, f));
    return sendJson(res, 200, list.map(f => {
      const cls = (db.clients || []).filter(c => c.createdById === f.id);
      const pros = (db.agents || []).filter(a => a.createdById === f.id);
      const ca = cls.reduce((s, c) => s + (c.paiements || []).reduce((x, p) => x + (p.montant || 0), 0) + (db.missions || []).filter(m => m.client && (m.client.deviceId === c.deviceId || m.client.tel === c.tel) && m.status === 'terminee').reduce((x, m) => x + (m.prixTotal || 0), 0), 0);
      return { id: f.id, nom: f.nom, tel: f.tel, blocked: !!f.blocked, createdAt: f.createdAt, createdBy: f.createdBy, nClients: cls.length, nPros: pros.length, ca };
    }));
  }
  if (p === '/api/admin/field' && req.method === 'POST') {
    const b = await readBody(req);
    const nom = String(b.nom || '').trim();
    const tel = String(b.tel || '').replace(/\D/g, '');
    if (nom.length < 2 || tel.length < 8) return sendJson(res, 400, { error: 'Nom + téléphone requis' });
    db.fieldAgents = db.fieldAgents || [];
    if (db.fieldAgents.some(x => x.tel === tel)) return sendJson(res, 409, { error: 'Numéro déjà utilisé' });
    const pw = String(b.password || '') || ('Klean-' + Math.floor(1000 + Math.random() * 9000) + '!');
    const salt = crypto.randomBytes(12).toString('hex');
    const f = { id: uid('FD'), nom, tel, salt, passHash: hashPassword(salt, pw), createdAt: nowISO(), createdBy: act(req), createdById: actorId(req), blocked: false };
    db.fieldAgents.push(f); saveDb();
    return sendJson(res, 201, { ok: true, nom, tel, password: pw });
  }
  const fBlk = p.match(/^\/api\/admin\/field\/(.+)\/(block|unblock|delete)$/);
  if (fBlk && req.method === 'POST') {
    const f = (db.fieldAgents || []).find(x => x.id === fBlk[1]);
    if (!f) return sendJson(res, 404, {});
    if (!isPdg(req) && !ownsRecord(req, f)) return sendJson(res, 403, { error: 'Pas votre agent de terrain' });
    if (fBlk[2] === 'delete') { trashPush('field', f); db.fieldAgents = db.fieldAgents.filter(x => x.id !== f.id); }
    else if (fBlk[2] === 'block') f.blocked = true;
    else f.blocked = false;
    saveDb();
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/admin/field-chat/inbox' && req.method === 'GET') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const reads = db.hqFieldRead || {};
    const list = (db.fieldAgents || []).filter(f => isPdg(req) || ownsRecord(req, f)).map(f => {
      const msgs = (db.fieldChat || []).filter(m => m.fieldId === f.id);
      const last = msgs[msgs.length - 1] || null;
      const lastRead = reads[f.id] ? new Date(reads[f.id]).getTime() : 0;
      const unread = msgs.filter(m => m.from === 'field' && new Date(m.at).getTime() > lastRead).length;
      return { id: f.id, nom: f.nom, tel: f.tel, lastText: last ? last.text : '', lastAt: last ? last.at : '', lastFrom: last ? last.from : '', unread, n: msgs.length };
    });
    list.sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
    return sendJson(res, 200, { threads: list, unread: list.reduce((s, x) => s + (x.unread || 0), 0) });
  }
  if (p === '/api/admin/field-chat' && req.method === 'GET') {
    const fid = String(url.searchParams.get('id') || '');
    const f = (db.fieldAgents || []).find(x => x.id === fid);
    if (!f) return sendJson(res, 404, {});
    if (!isPdg(req) && !ownsRecord(req, f)) return sendJson(res, 403, {});
    const messages = (db.fieldChat || []).filter(m => m.fieldId === fid).slice(-200);
    return sendJson(res, 200, { messages, nom: f.nom });
  }
  if (p === '/api/admin/field-chat/read' && req.method === 'POST') {
    if (!isAdminReq(req)) return sendJson(res, 401, {});
    const b = await readBody(req);
    const fid = String(b.id || '');
    if (!fid) return sendJson(res, 400, {});
    db.hqFieldRead = db.hqFieldRead || {};
    db.hqFieldRead[fid] = nowISO();
    saveDb();
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/admin/field-chat' && req.method === 'POST') {
    const b = await readBody(req);
    const f = (db.fieldAgents || []).find(x => x.id === b.id);
    if (!f) return sendJson(res, 404, {});
    if (!isPdg(req) && !ownsRecord(req, f)) return sendJson(res, 403, {});
    const text = String(b.text || '').trim().slice(0, 500);
    if (!text) return sendJson(res, 400, { error: 'Message vide' });
    db.fieldChat = db.fieldChat || [];
    db.fieldChat.push({ id: uid('FC'), fieldId: f.id, from: 'hq', par: act(req), text, at: nowISO() });
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  function shuffleCopy(arr) {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = (crypto.randomInt ? crypto.randomInt(i + 1) : Math.floor(Math.random() * (i + 1)));
      const t = copy[i]; copy[i] = copy[j]; copy[j] = t;
    }
    return copy;
  }
  function quizRevealIfDue() {
    const a = db.annonce;
    if (!a || a.type !== 'quiz' || !a.countdownEndsAt || a.countdownRevealed) return a;
    if (Date.now() < new Date(a.countdownEndsAt).getTime()) return a;
    const n = Math.max(1, parseInt(a.pendingN, 10) || 1);
    const pool = (a.stagePool && a.stagePool.length) ? a.stagePool.slice() : (db.quizAnswers || []).filter(x => x.ok).map(x => x.nom);
    const winners = (a.pendingWinners && a.pendingWinners.length)
      ? a.pendingWinners.slice(0, n)
      : shuffleCopy(pool).slice(0, Math.min(n, pool.length));
    a.countdownRevealed = true;
    a.closed = true;
    a.winners = winners;
    a.rounds = a.rounds || [];
    a.rounds.push({ at: nowISO(), n, winners, seconds: a.countdownSeconds || 0 });
    a.stagePool = winners;
    a.pendingWinners = null;
    db.quizChat = db.quizChat || [];
    const nWin = (winners || []).length;
    db.quizChat.push({
      id: uid('QC'), from: 'pdg', nom: 'PDG', at: nowISO(),
      text: nWin <= 1 ? 'Félicitation ! Vous etes le gagnant. Ecrivez moi.' : 'Félicitation ! Vous etes un gagnant. Ecrivez moi.'
    });
    saveDb();
    return a;
  }
  function pruneWinShow() {
    if (db.winShow && db.winShow.until && Date.now() > new Date(db.winShow.until).getTime()) {
      db.winShow = null;
      saveDb();
    }
  }

  function missionDoneClient(id) {
    return (db.missions || []).some(m => m.clientId === id && m.status === 'terminee');
  }
  function missionDoneAgent(id) {
    return (db.missions || []).some(m => m.agentId === id && m.status === 'terminee');
  }
  function quizRuleOk(rule, hasDone) {
    const r = rule || 'done';
    if (r === 'all') return true;
    if (r === 'done') return !!hasDone;
    if (r === 'none') return !hasDone;
    return true;
  }
  function quizPlayerFrom(req, b) {
    const cli = findClientByToken(req);
    if (cli) return { role: 'client', id: cli.id, nom: cli.nom, done: missionDoneClient(cli.id) };
    const who = String((b && (b.accountId || b.who || b.deviceId)) || '').slice(0, 80);
    if (who.startsWith('CL-')) {
      const id = who.slice(3);
      const c = (db.clients || []).find(x => x.id === id);
      if (c) return { role: 'client', id: c.id, nom: c.nom, done: missionDoneClient(c.id) };
    }
    if (who.startsWith('AG-')) {
      const id = who.slice(3);
      const ag = (db.agents || []).find(x => x.id === id || x.tel === id || x.tel1 === id);
      if (ag) return { role: 'agent', id: ag.id, nom: ag.nom, done: missionDoneAgent(ag.id) };
    }
    const ag2 = (db.agents || []).find(x => x.id === who);
    if (ag2) return { role: 'agent', id: ag2.id, nom: ag2.nom, done: missionDoneAgent(ag2.id) };
    return { role: 'guest', id: who, nom: '', done: false };
  }
  function quizMayPlay(player, a) {
    const w = (a && a.quizWho) || { clients: 'done', pros: 'done' };
    if (player.role === 'client') return quizRuleOk(w.clients, player.done);
    if (player.role === 'agent') return quizRuleOk(w.pros, player.done);
    return quizRuleOk(w.clients, false);
  }

  if (p === '/api/quiz/eligible' && req.method === 'GET') {
    const a = db.annonce;
    if (!a || a.type !== 'quiz') return sendJson(res, 200, { ok: true, can: false, reason: 'Pas de quiz' });
    const player = quizPlayerFrom(req, { accountId: url.searchParams.get('who') || '' });
    const can = quizMayPlay(player, a);
    return sendJson(res, 200, { ok: true, can, role: player.role, done: player.done, quizWho: a.quizWho || { clients: 'done', pros: 'done' } });
  }

  if (p === '/api/quiz/answer' && req.method === 'POST') {
    const b = await readBody(req);
    const a = db.annonce;
    if (!a || a.type !== 'quiz') return sendJson(res, 400, { error: 'Pas de quiz en cours' });
    if (a.closed || a.countdownEndsAt) return sendJson(res, 409, { error: 'Quiz terminé — le décompte a commencé', winners: a.winners || [] });
    if (a.answerEndsAt && Date.now() > new Date(a.answerEndsAt).getTime())
      return sendJson(res, 409, { error: 'Temps de réponse écoulé' });
    const player = quizPlayerFrom(req, b);
    if (!quizMayPlay(player, a)) {
      const w = a.quizWho || { clients: 'done', pros: 'done' };
      const side = player.role === 'agent' ? 'professionnels' : 'clients';
      const need = (player.role === 'agent' ? w.pros : w.clients) === 'none'
        ? 'réservé à ceux qui n’ont pas encore de mission terminée'
        : 'réservé à ceux qui ont déjà une mission terminée (pas une mission en attente)';
      return sendJson(res, 403, { error: 'Quiz ' + need + ' (' + side + ')' });
    }
    const nom = String(b.nom || '').trim().slice(0, 40) || 'Anonyme';
    const who = String(b.accountId || b.deviceId || nom || ('anon-' + (req.socket.remoteAddress || ''))).slice(0, 80);
    db.quizAnswers = db.quizAnswers || [];
    const already = db.quizAnswers.find(x => x.who === who);
    if (already) return sendJson(res, 200, { ok: true, already: true, choice: already.choice, message: 'Réponse déjà enregistrée.' });
    const choice = parseInt(b.choice, 10);
    if (!(choice >= 0 && choice <= 3)) return sendJson(res, 400, { error: 'Choix invalide' });
    const ok = choice === a.good;
    db.quizAnswers.push({ at: nowISO(), nom, who, choice, ok });
    saveDb();
    return sendJson(res, 200, { ok: true, already: false, choice, message: 'Réponse enregistrée.' });
  }
  if (p === '/api/admin/quiz' && req.method === 'GET') {
    quizRevealIfDue();
    const a = db.annonce;
    const ans = db.quizAnswers || [];
    const goods = ans.filter(x => x.ok);
    const letters = ['A', 'B', 'C', 'D'];
    return sendJson(res, 200, {
      active: !!(a && a.type === 'quiz'), closed: !!(a && a.closed),
      question: a && a.question, nTotal: ans.length, nOk: goods.length,
      goods: goods.map(x => x.nom),
      clicks: ans.map(x => ({ nom: x.nom, who: x.who, choice: letters[x.choice] || '?', at: x.at, ok: !!x.ok })),
      live: liveHome(),
      winners: (a && a.winners) || [],
      countdownEndsAt: a && a.countdownEndsAt, countdownRevealed: !!(a && a.countdownRevealed),
      pendingN: a && a.pendingN, rounds: (a && a.rounds) || [], stagePool: (a && a.stagePool) || [],
      answerEndsAt: a && a.answerEndsAt, series: (db.quizSeries || []).length
    });
  }
  if (p === '/api/admin/quiz/relaunch' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const src = (db.annonce && db.annonce.type === 'quiz') ? db.annonce : db.lastQuiz;
    if (!src || !(src.choices || []).length) return sendJson(res, 400, { error: 'Aucun quiz à relancer — publiez-en un d’abord' });
    const b = await readBody(req).catch(() => ({}));
    if (db.annonce && db.annonce.type === 'quiz') {
      db.quizSeries = db.quizSeries || [];
      db.quizSeries.push({ question: db.annonce.question || db.annonce.message, goods: (db.quizAnswers || []).filter(x => x.ok).map(x => x.nom), at: nowISO() });
    }
    const answerSeconds = Math.max(0, Math.min(7200, parseInt(b.answerSeconds != null ? b.answerSeconds : src.answerSeconds, 10) || 0));
    const msg = src.message || src.question || 'Quiz';
    db.annonce = {
      id: uid('AN'), message: msg, type: 'quiz', at: nowISO(), par: act(req),
      question: src.question || msg,
      choices: (src.choices || []).slice(0, 4),
      good: src.good || 0,
      closed: false, winners: [], hideClient: false, hideAgent: false,
      answerSeconds,
      answerEndsAt: answerSeconds ? new Date(Date.now() + answerSeconds * 1000).toISOString() : null,
      quizWho: src.quizWho || { clients: 'done', pros: 'done' }
    };
    db.quizAnswers = [];
    db.quizChat = [];
    db.lastQuiz = { message: msg, question: db.annonce.question, choices: db.annonce.choices, good: db.annonce.good, answerSeconds };
    saveDb();
    auditLog('quiz_relance', { par: act(req) });
    emitAdmin('annonce', '🔁 Même quiz relancé');
    return sendJson(res, 200, { ok: true, question: db.annonce.question, live: liveHome() });
  }
  if (p === '/api/admin/quiz/stop' && req.method === 'POST') {
    if (!db.annonce || db.annonce.type !== 'quiz') return sendJson(res, 400, { error: 'Pas de quiz' });
    db.annonce.closed = true; saveDb();
    return sendJson(res, 200, { ok: true, nOk: (db.quizAnswers || []).filter(x => x.ok).length });
  }
  if (p === '/api/admin/quiz/countdown' && req.method === 'POST') {
    if (!db.annonce || db.annonce.type !== 'quiz') return sendJson(res, 400, { error: 'Pas de quiz' });
    const b = await readBody(req);
    const seconds = Math.max(5, Math.min(3600, parseInt(b.seconds, 10) || 30));
    const n = Math.max(1, Math.min(50, parseInt(b.n, 10) || 1));
    const a = db.annonce;
    const pool = (a.stagePool && a.stagePool.length && a.countdownRevealed)
      ? a.stagePool.slice()
      : (db.quizAnswers || []).filter(x => x.ok).map(x => x.nom);
    if (!pool.length) return sendJson(res, 400, { error: 'Aucune bonne réponse pour tirer' });
    if (n > pool.length) return sendJson(res, 400, { error: 'Demandez au plus ' + pool.length + ' gagnant(s)' });
    a.closed = true;
    a.countdownEndsAt = new Date(Date.now() + seconds * 1000).toISOString();
    a.countdownSeconds = seconds;
    a.countdownRevealed = false;
    a.pendingN = n;
    a.winners = [];
    a.stagePool = pool;
    saveDb();
    return sendJson(res, 200, { ok: true, countdownEndsAt: a.countdownEndsAt, seconds, n, pool: pool.length });
  }
  if (p === '/api/admin/quiz/reveal' && req.method === 'POST') {
    if (!db.annonce || db.annonce.type !== 'quiz') return sendJson(res, 400, { error: 'Pas de quiz' });
    db.annonce.countdownEndsAt = new Date().toISOString();
    quizRevealIfDue();
    return sendJson(res, 200, { ok: true, winners: db.annonce.winners || [] });
  }
  if (p === '/api/admin/quiz/draw' && req.method === 'POST') {
    if (!db.annonce || db.annonce.type !== 'quiz') return sendJson(res, 400, { error: 'Pas de quiz' });
    const b = await readBody(req);
    db.annonce.closed = true;
    db.annonce.countdownEndsAt = new Date().toISOString();
    db.annonce.pendingN = Math.max(1, Math.min(50, parseInt(b.n, 10) || 1));
    db.annonce.countdownRevealed = false;
    quizRevealIfDue();
    return sendJson(res, 200, { ok: true, winners: db.annonce.winners || [], nOk: (db.quizAnswers || []).filter(x => x.ok).length });
  }
  if (p === '/api/admin/quiz/pick' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    if (!db.annonce || db.annonce.type !== 'quiz') return sendJson(res, 400, { error: 'Pas de quiz' });
    const b = await readBody(req);
    const nom = String(b.nom || '').trim().slice(0, 60);
    if (nom.length < 2) return sendJson(res, 400, { error: 'Nom du gagnant requis' });
    const seconds = Math.max(0, Math.min(3600, parseInt(b.seconds, 10) || 0));
    db.annonce.closed = true;
    db.annonce.winnerWho = String(b.who || '').slice(0, 80);
    db.annonce.pickedByPdg = true;
    db.annonce.pendingN = 1;
    db.annonce.pendingWinners = [nom];
    db.annonce.countdownSeconds = seconds;
    if (seconds >= 5) {
      db.annonce.countdownEndsAt = new Date(Date.now() + seconds * 1000).toISOString();
      db.annonce.countdownRevealed = false;
      db.annonce.winners = [];
      saveDb();
      auditLog('quiz_gagnant_pdg', { nom, par: 'PDG', seconds });
      return sendJson(res, 200, { ok: true, pending: true, seconds, nom });
    }
    db.annonce.countdownEndsAt = new Date().toISOString();
    db.annonce.countdownRevealed = false;
    quizRevealIfDue();
    auditLog('quiz_gagnant_pdg', { nom, par: 'PDG' });
    return sendJson(res, 200, { ok: true, winners: db.annonce.winners || [nom] });
  }
  if (p === '/api/admin/quiz/final' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const n = Math.max(1, Math.min(50, parseInt(b.n, 10) || 1));
    const seconds = Math.max(5, Math.min(3600, parseInt(b.seconds, 10) || 30));
    const names = [];
    (db.quizSeries || []).forEach(q => (q.goods || []).forEach(g => names.push(g)));
    (db.quizAnswers || []).filter(x => x.ok).forEach(x => names.push(x.nom));
    const pool = [...new Set(names.filter(Boolean))];
    if (!pool.length) return sendJson(res, 400, { error: 'Aucune bonne réponse dans la série' });
    if (!db.annonce || db.annonce.type !== 'quiz') {
      db.annonce = { id: uid('AN'), type: 'quiz', message: 'Tirage final', question: 'Tirage final de la série', choices: [], good: 0, at: nowISO(), par: 'PDG' };
    }
    const a = db.annonce;
    a.closed = true;
    a.countdownEndsAt = new Date(Date.now() + seconds * 1000).toISOString();
    a.countdownSeconds = seconds;
    a.countdownRevealed = false;
    a.pendingN = Math.min(n, pool.length);
    a.winners = [];
    a.stagePool = pool;
    a.finalDraw = true;
    saveDb();
    return sendJson(res, 200, { ok: true, pool: pool.length, n: a.pendingN, seconds, countdownEndsAt: a.countdownEndsAt });
  }
  if (p === '/api/admin/live' && req.method === 'GET') {
    return sendJson(res, 200, liveHome());
  }
  if (p === '/api/quiz/chat' && req.method === 'GET') {
    const who = String(url.searchParams.get('who') || '').slice(0, 80);
    const a = db.annonce;
    const isWin = a && a.winners && a.winners.length && (a.winnerWho ? a.winnerWho === who : true);
    return sendJson(res, 200, {
      ok: true,
      winner: !!(a && a.winners && a.winners.length),
      winners: (a && a.winners) || [],
      you: isWin,
      bubble2: !!(db.winBubble2 && db.winBubble2.on),
      messages: (db.quizChat || []).slice(-80)
    });
  }
  if (p === '/api/quiz/chat' && req.method === 'POST') {
    const b = await readBody(req);
    const text = String(b.text || '').trim().slice(0, 400);
    if (text.length < 1) return sendJson(res, 400, { error: 'Message vide' });
    const nom = String(b.nom || 'Gagnant').slice(0, 40);
    const who = String(b.who || b.accountId || '').slice(0, 80);
    const a = db.annonce;
    if (!a || !a.winners || !a.winners.length) return sendJson(res, 403, { error: 'Pas de gagnant en cours' });
    db.quizChat = db.quizChat || [];
    db.quizChat.push({ id: uid('QC'), from: 'user', nom, who, text, at: nowISO() });
    saveDb();
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/admin/quiz/chat' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const text = String(b.text || '').trim().slice(0, 400);
    if (!text) return sendJson(res, 400, { error: 'Message vide' });
    db.quizChat = db.quizChat || [];
    db.quizChat.push({ id: uid('QC'), from: 'pdg', nom: 'PDG', text, at: nowISO() });
    saveDb();
    return sendJson(res, 200, { ok: true, messages: db.quizChat.slice(-80) });
  }
  if (p === '/api/admin/quiz/chat' && req.method === 'GET') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    return sendJson(res, 200, { messages: (db.quizChat || []).slice(-80), winners: (db.annonce && db.annonce.winners) || [], pendingPhoto: !!(db.winPhotoPending && db.winPhotoPending.photo), bubble2: !!(db.winBubble2 && db.winBubble2.on) });
  }
  if (p === '/api/quiz/win-photo' && req.method === 'POST') {
    const b = await readBody(req);
    const photo = typeof b.photo === 'string' ? b.photo.slice(0, 350000) : '';
    if (!photo.startsWith('data:image')) return sendJson(res, 400, { error: 'Photo invalide' });
    const who = String(b.who || '').slice(0, 80);
    const nom = String(b.nom || 'Gagnant').slice(0, 40);
    const a = db.annonce;
    if (!a || !a.winners || !a.winners.length) return sendJson(res, 403, { error: 'Pas de gagnant' });
    db.winPhotoPending = { photo, nom, who, at: nowISO() };
    saveDb();
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/win-show' && req.method === 'GET') {
    pruneWinShow();
    const s = db.winShow;
    if (!s) return sendJson(res, 200, { show: null, bubble2: !!(db.winBubble2 && db.winBubble2.on) });
    return sendJson(res, 200, { show: { nom: s.nom, photo: s.photo, until: s.until }, bubble2: !!(db.winBubble2 && db.winBubble2.on) });
  }
  if (p === '/api/admin/win-photo/publish' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const sec = Math.max(10, Math.min(86400, parseInt(b.seconds, 10) || 60));
    const pend = db.winPhotoPending;
    if (!pend || !pend.photo) return sendJson(res, 400, { error: 'Aucune photo envoyée par le gagnant' });
    db.winShow = { photo: pend.photo, nom: pend.nom, until: new Date(Date.now() + sec * 1000).toISOString() };
    db.winBubble2 = { on: true, at: nowISO() };
    db.winPhotoPending = { nom: pend.nom, who: pend.who, at: pend.at };
    saveDb();
    return sendJson(res, 200, { ok: true, until: db.winShow.until, seconds: sec });
  }
  if (p === '/api/admin/quiz/chat/clear' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    db.quizChat = [];
    db.winBubble2 = { on: false, at: nowISO() };
    saveDb();
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/admin/win-bubble2' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    db.winBubble2 = { on: !!b.on, at: nowISO() };
    if (!b.on) { db.winShow = null; }
    saveDb();
    return sendJson(res, 200, { ok: true, on: !!(db.winBubble2 && db.winBubble2.on) });
  }

  if (p === '/api/admin/shield' && req.method === 'GET') {
    if (!pdgOnly(req, res)) return;
    shieldEnsure();
    const ips = Object.keys(db.shield.ips).map(ip => Object.assign({ ip }, db.shield.ips[ip]));
    ips.sort((a, b) => (b.score || 0) - (a.score || 0));
    return sendJson(res, 200, {
      ok: true,
      events: db.shield.events.slice(0, 80),
      ips: ips.slice(0, 80),
      nBlocked: ips.filter(x => x.blocked && !x.annihilated).length,
      nAneanti: ips.filter(x => x.annihilated).length,
      nEvents: db.shield.events.length
    });
  }
  if (p === '/api/admin/shield/recaler' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const ip = String(b.ip || '').slice(0, 64);
    shieldEnsure();
    if (!ip || !db.shield.ips[ip]) return sendJson(res, 404, { error: 'IP inconnue' });
    db.shield.ips[ip].blocked = true;
    db.shield.ips[ip].annihilated = false;
    db.shield.ips[ip].last = nowISO();
    shieldLog(ip, 'pdg-recale', '/hq', 'PDG a recalé', 0);
    shieldKickIp(ip);
    saveDb();
    auditLog('shield_recale', { ip, par: 'PDG' });
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/admin/shield/aneantir' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const ip = String(b.ip || '').slice(0, 64);
    shieldEnsure();
    if (!ip) return sendJson(res, 400, { error: 'IP requise' });
    const prev = db.shield.ips[ip] || { score: 0, hits: 0 };
    db.shield.ips[ip] = Object.assign(prev, { blocked: true, annihilated: true, last: nowISO(), kind: 'pdg-aneanti' });
    shieldLog(ip, 'pdg-aneanti', '/hq', 'PDG a anéanti', 0);
    shieldKickIp(ip);
    saveDb();
    auditLog('shield_aneanti', { ip, par: 'PDG' });
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/admin/shield/pardon' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const ip = String(b.ip || '').slice(0, 64);
    shieldEnsure();
    if (!ip || !db.shield.ips[ip]) return sendJson(res, 404, { error: 'IP inconnue' });
    db.shield.ips[ip].blocked = false;
    db.shield.ips[ip].annihilated = false;
    db.shield.ips[ip].score = 0;
    db.shield.ips[ip].last = nowISO();
    shieldLog(ip, 'pdg-pardon', '/hq', 'PDG a gracié', 0);
    saveDb();
    auditLog('shield_pardon', { ip, par: 'PDG' });
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/field/login' && req.method === 'POST') {
    const b = await readBody(req);
    const tel = String(b.tel || '').replace(/\D/g, '');
    const f = (db.fieldAgents || []).find(x => x.tel === tel && !x.blocked);
    if (!f || hashPassword(f.salt, b.password || '') !== f.passHash) return sendJson(res, 401, { error: 'Téléphone ou mot de passe incorrect' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'klean_field=' + fieldTokenOf(f) + '; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000' });
    return res.end(JSON.stringify({ ok: true, nom: f.nom }));
  }
  if (p === '/api/field/clients' && req.method === 'POST') {
    const fid = fieldIdentity(req); if (!fid) return sendJson(res, 401, { error: 'Connectez-vous' });
    req._forceField = fid;
    const b = await readBody(req);
    const nom = String(b.nom || '').trim();
    const tel = String(b.tel || '').replace(/\D/g, '');
    if (nom.length < 2 || tel.length < 8) return sendJson(res, 400, { error: 'Nom + téléphone' });
    if (db.clients.find(c => c.tel === tel)) return sendJson(res, 409, { error: 'Numéro déjà client' });
    const pw = 'Klean-' + Math.floor(1000 + Math.random() * 9000) + '!';
    const salt = crypto.randomBytes(12).toString('hex');
    const cl = { id: uid('CL'), nom, tel, ville: String(b.ville || '').slice(0, 60), quartier: '', salt, passHash: hashPassword(salt, pw), createdAt: nowISO(), createdBy: fid.nom, createdById: fid.id, createdByGestId: fid.gestId || null };
    db.clients.push(cl); saveDb();
    return sendJson(res, 201, { ok: true, tel, password: pw });
  }
  if (p === '/api/field/agents' && req.method === 'POST') {
    const fid = fieldIdentity(req); if (!fid) return sendJson(res, 401, { error: 'Connectez-vous' });
    const b = await readBody(req);
    const prenom = String(b.prenom || '').trim(), nom = String(b.nom || '').trim();
    const tel1 = String(b.tel || b.tel1 || '').replace(/\D/g, '');
    if (prenom.length < 2 || nom.length < 2 || tel1.length < 8) return sendJson(res, 400, { error: 'Prénom, nom, téléphone' });
    if (db.agents.find(a => String(a.tel1 || a.tel || '').replace(/\D/g, '') === tel1 && a.status !== 'rejected')) return sendJson(res, 409, { error: 'Numéro déjà pro' });
    const pin = String(Math.floor(1000 + Math.random() * 9000));
    const na = { id: uid('AG'), nom: (prenom + ' ' + nom).trim(), prenom, tel: tel1, tel1, quartier: '', ville: String(b.ville || '').slice(0, 60), status: 'approved', approvedAt: nowISO(), createdAt: nowISO(), createdBy: fid.nom, createdById: fid.id, createdByGestId: fid.gestId || null, claimPin: pin, online: false, kind: 'pro', services: [], hist: [{ at: Date.now(), by: fid.nom, ev: 'Créé par agent de terrain' }] };
    db.agents.push(na); saveDb();
    return sendJson(res, 201, { ok: true, tel: tel1, pin });
  }
  if (p === '/api/field/chat' && req.method === 'GET') {
    const fid = fieldIdentity(req); if (!fid) return sendJson(res, 401, {});
    const messages = (db.fieldChat || []).filter(m => m.fieldId === fid.id).slice(-200);
    return sendJson(res, 200, { messages });
  }
  if (p === '/api/field/chat' && req.method === 'POST') {
    const fid = fieldIdentity(req); if (!fid) return sendJson(res, 401, {});
    const b = await readBody(req);
    const text = String(b.text || '').trim().slice(0, 500);
    if (!text) return sendJson(res, 400, { error: 'Message vide' });
    db.fieldChat = db.fieldChat || [];
    db.fieldChat.push({ id: uid('FC'), fieldId: fid.id, from: 'field', gestNom: fid.nom, text, at: nowISO() });
    saveDb();
    emitAdmin('admin', '🧭 ' + fid.nom + ' : ' + text.slice(0, 40));
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'klean_field=; Path=/; Max-Age=0' });
    return res.end('{"ok":true}');
  }

  /* ─── Requête gestionnaire → PDG (bloquer/supprimer un compte) ─── */
  if (p === '/api/admin/account-request' && req.method === 'POST') {
    const b = await readBody(req);
    if (!['block', 'delete'].includes(b.kind) || !['client', 'pro'].includes(b.role) || !b.id)
      return sendJson(res, 400, { error: 'Demande incomplète' });
    const rec = b.role === 'client' ? db.clients.find(c => c.id === b.id) : db.agents.find(a => a.id === b.id);
    if (!rec) return sendJson(res, 404, { error: 'Compte introuvable' });
    if (!ownsRecord(req, rec) && !isPdg(req)) return sendJson(res, 403, { error: 'Pas votre compte' });
    db.accountRequests.push({ id: uid('RQ'), kind: b.kind, role: b.role, targetId: rec.id, nom: rec.nom, motif: String(b.motif || '').slice(0, 240), by: act(req), byId: actorId(req), at: nowISO(), status: 'pending' });
    db.hqChat.push({ id: uid('HC'), from: 'gest', gestId: actorId(req), gestNom: act(req), text: '📋 Demande ' + (b.kind === 'block' ? 'blocage' : 'suppression') + ' de ' + rec.nom + (b.motif ? ' — ' + b.motif : ''), at: nowISO(), readPdg: false });
    saveDb();
    emitAdmin('admin', '🟠 Demande ' + act(req) + ' : ' + rec.nom);
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/admin/account-request' && req.method === 'GET') {
    if (!pdgOnly(req, res)) return;
    return sendJson(res, 200, (db.accountRequests || []).slice().reverse());
  }
  if (p === '/api/admin/account-request/decide' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const rq = (db.accountRequests || []).find(x => x.id === b.id);
    if (!rq) return sendJson(res, 404, {});
    rq.status = b.accept ? 'acceptee' : 'refusee'; rq.decidedAt = nowISO();
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  /* ─── Chat PDG ↔ gestionnaires ─── */
  if (p === '/api/admin/hq-chat' && req.method === 'GET') {
    const id = hqIdentity(req);
    let msgs = db.hqChat || [];
    if (id.role !== 'pdg') msgs = msgs.filter(m => m.gestId === id.id || m.toId === id.id || (m.from === 'pdg' && (!m.toId || m.toId === id.id)));
    if (id.role === 'pdg') msgs.forEach(m => { m.readPdg = true; });
    saveDb();
    const unread = (db.hqChat || []).filter(m => m.from === 'gest' && !m.readPdg).length;
    return sendJson(res, 200, { messages: msgs.slice(-200), unread });
  }
  if (p === '/api/admin/hq-chat' && req.method === 'POST') {
    const b = await readBody(req);
    const text = String(b.text || '').trim().slice(0, 500);
    if (text.length < 1) return sendJson(res, 400, { error: 'Message vide' });
    const id = hqIdentity(req);
    db.hqChat.push({ id: uid('HC'), from: id.role === 'pdg' ? 'pdg' : 'gest', gestId: id.role === 'gest' ? id.id : (b.toId || null), toId: id.role === 'pdg' ? (b.toId || null) : 'pdg', gestNom: act(req), text, at: nowISO(), readPdg: id.role === 'pdg' });
    saveDb();
    emitAdmin('admin', (id.role === 'pdg' ? '👑 PDG' : '🟠 ' + act(req)) + ' : ' + text.slice(0, 40));
    return sendJson(res, 200, { ok: true });
  }

  /* ─── Couper une conversation ─── */
  if (p === '/api/admin/mute-chat' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const key = String(b.key || '');
    if (!key) return sendJson(res, 400, {});
    db.mutedChats = db.mutedChats || [];
    if (b.off) db.mutedChats = db.mutedChats.filter(m => m.key !== key);
    else if (!db.mutedChats.some(m => m.key === key)) db.mutedChats.push({ key, at: nowISO(), by: act(req) });
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  /* ─── Codes promo ─── */
  if (p === '/api/admin/promos' && req.method === 'GET') {
    if (!pdgOnly(req, res)) return;
    return sendJson(res, 200, db.promos || []);
  }
  if (p === '/api/admin/promos' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const code = String(b.code || '').trim().toUpperCase().replace(/\s+/g, '');
    if (code.length < 3) return sendJson(res, 400, { error: 'Code trop court' });
    if ((db.promos || []).some(x => x.code === code && x.active)) return sendJson(res, 409, { error: 'Code déjà actif' });
    const days = Math.max(1, parseInt(b.days, 10) || 30);
    const unique = !!b.unique;
    const maxUses = unique ? 1 : Math.max(1, parseInt(b.maxUses, 10) || 10);
    const rec = { id: uid('PR'), code, unique, maxUses, uses: 0, days, until: new Date(Date.now() + days * 86400000).toISOString(), partnerId: b.partnerId || null, active: true, at: nowISO(), par: act(req) };
    db.promos.push(rec); saveDb();
    return sendJson(res, 201, rec);
  }
  if (p === '/api/admin/promos/cancel' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const pr = (db.promos || []).find(x => x.id === b.id || x.code === String(b.code || '').toUpperCase());
    if (!pr) return sendJson(res, 404, {});
    pr.active = false; pr.cancelledAt = nowISO(); saveDb();
    return sendJson(res, 200, { ok: true });
  }

  /* ─── Partenaires ─── */
  if (p === '/api/admin/partners' && req.method === 'GET') {
    if (!pdgOnly(req, res)) return;
    return sendJson(res, 200, db.partners || []);
  }
  if (p === '/api/admin/partners' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const nom = String(b.nom || '').trim();
    if (nom.length < 2) return sendJson(res, 400, { error: 'Nom requis' });
    const tel = String(b.tel || '').replace(/\D/g, '');
    const rec = { id: uid('PT'), nom, tel, note: String(b.note || '').slice(0, 200), createdAt: nowISO(), codes: [] };
    db.partners.push(rec); saveDb();
    return sendJson(res, 201, rec);
  }

  /* ─── Numéros de paiement ─── */
  if (p === '/api/admin/paydest' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    db.config.payDest = db.config.payDest || {};
    if (b.wave) db.config.payDest.wave = Array.isArray(b.wave) ? b.wave : [String(b.wave)];
    if (b.om) db.config.payDest.om = String(b.om);
    if (b.moov) db.config.payDest.moov = String(b.moov);
    if (b.hide != null) db.config.payDest.hide = !!b.hide;
    saveDb();
    return sendJson(res, 200, { ok: true, payDest: db.config.payDest });
  }

  /* ─── Corbeille / récupération ─── */
  if (p === '/api/admin/trash' && req.method === 'GET') {
    if (!pdgOnly(req, res)) return;
    return sendJson(res, 200, db.trash || []);
  }
  if (p === '/api/admin/trash/restore' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const t = (db.trash || []).find(x => x.id === b.id);
    if (!t) return sendJson(res, 404, {});
    if (t.kind === 'client') db.clients.push(t.data);
    else if (t.kind === 'agent') db.agents.push(t.data);
    db.trash = db.trash.filter(x => x.id !== t.id);
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/stats') {
    const villeN = String(url.searchParams.get('ville') || '').trim().toLowerCase();
    if (!villeN) return sendJson(res, 200, {
      agentsEnLigne: onlineAgents().length,
      agentsTotal: db.agents.length,
      missionsTotal: db.missions.length,
      missionsTerminees: db.missions.filter(m => m.status === 'terminee').length
    });
    /* vérité terrain : comptage sur les vraies inscriptions de la ville — jamais de chiffre inventé
       (un pro compte si sa ville d'inscription correspond, ou, sans ville, si son quartier appartient à la ville choisie) */
    const qList = String(url.searchParams.get('quartiers') || '').split(',').map(q => q.trim().toLowerCase()).filter(Boolean);
    const actifs = db.agents.filter(a =>
      (a.status || 'approved') === 'approved' &&
      (String(a.ville || '').trim().toLowerCase() === villeN ||
       (!String(a.ville || '').trim() && a.quartier && qList.includes(String(a.quartier).trim().toLowerCase())))
    );
    return sendJson(res, 200, {
      agentsEnLigne: actifs.filter(a => agentIsOnline(a)).length,
      agentsTotal: actifs.length,
      missionsTotal: db.missions.length,
      missionsTerminees: db.missions.filter(m => m.status === 'terminee').length
    });
  }

  /* --- Fichiers statiques --- */
  if (p === '/field' || p === '/field.html') {
    fs.readFile(path.join(__dirname, 'field.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }
  const sendPage = (file) => {
    fs.readFile(path.join(__dirname, file), (err, data) => {
      if (err) { res.writeHead(404); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  };
  if (p === '/pdg' || p === '/admin' || p === '/admin.html' || p === '/admin-login.html') {
    const id = hqIdentity(req);
    if (id && id.role === 'gest') { res.writeHead(302, { Location: '/gest' }); return res.end(); }
    sendPage((id && id.role === 'pdg') ? 'admin.html' : 'admin-login.html');
    return;
  }
  if (p === '/gest' || p === '/gest-login.html') {
    const id = hqIdentity(req);
    if (id && id.role === 'pdg') { res.writeHead(302, { Location: '/pdg' }); return res.end(); }
    sendPage((id && id.role === 'gest') ? 'admin.html' : 'gest-login.html');
    return;
  }
  let file = p === '/' ? '/index.html' : p;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const fp = path.join(__dirname, file);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

/* --- Upgrade WebSocket --- */
server.on('upgrade', (req, sock) => {
  if (!req.url.startsWith('/ws')) { sock.end(); return; }
  try {
    const ip0 = clientIp(req);
    const rec0 = db.shield && db.shield.ips && db.shield.ips[ip0];
    if (rec0 && (rec0.annihilated || rec0.blocked)) { sock.end(); return; }
  } catch (e) {}
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.meta = { missions: new Set(), ip: clientIp(req), hqAuthed: !!hqIdentity(req) };
  sockets.add(sock);
  sock.on('data', handleWsData(sock));
  const bye = () => {
    sockets.delete(sock);
    if (sock.meta && sock.meta.agentId) {
      const ag = db.agents.find(a => a.id === sock.meta.agentId);
      if (ag && ![...sockets].some(s => s.meta && s.meta.agentId === ag.id)) { if (!ag.stayOnline) { ag.online = false; saveDb(); } }
    }
    if (sock.meta && sock.meta.clientId) {
      const cl = db.clients.find(c => c.id === sock.meta.clientId);
      if (cl && ![...sockets].some(s => s.meta && s.meta.clientId === cl.id)) { cl.online = false; saveDb(); }
    }
  };
  sock.on('close', bye); sock.on('error', bye);
});

process.on('SIGTERM', () => { try { saveDbNow(); } catch (e) {} setTimeout(() => process.exit(0), 300); });
process.on('unhandledRejection', e => { console.log('⚠️  Promesse :', e && e.message); });

/* Render vérifie /api/health dès que le port écoute : on écoute D’ABORD, Neon ensuite */
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log("  ✨ SERVEUR CENTRAL KLEAN — Côte d'Ivoire 🇨🇮");
  console.log('  ────────────────────────────────────');
  console.log('  🌐 Application : http://localhost:' + PORT);
  console.log('  🎛️  Tableau HQ : http://localhost:' + PORT + '/admin');
  console.log('  📡 WebSocket   : ws://localhost:' + PORT + '/ws');
  console.log('  ────────────────────────────────────');
  console.log('');
  initStorage().then(() => {
    console.log('  🔑 Mot de passe HQ : ' + (db.admin ? 'déjà configuré ✓' : 'à créer à /admin'));
    console.log('  💰 Commission  : ' + (feePct() * 100) + '% par mission');
  }).catch(e => { console.error('Stockage :', e); });
});
