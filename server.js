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
  /* ═══ 🎮 FLIP FIZZ · KLEAN POINTS · RÉCOMPENSES · QUIZ · INFOS · URGENCE (lot 96) ═══
     ⚠️ Par défaut le jeu est DÉSACTIVÉ et INVISIBLE sur l'accueil : seul le PDG l'active. */
  db.flip = Object.assign({
    actif: false, accueil: false, titre: 'Flip Fizz', desc: 'Jouez et gagnez des Klean Points !',
    url: 'https://flip-fizz.netlify.app', mediaUrl: '', mediaType: '', videoUrl: '',
    partiesJour: 3, regles: '', pointsParPartie: 10, pointsBonus: 5, seuilBonus: 100,
    dureeMin: 20,                                /* durée mini d'une partie, mesurée par le SERVEUR */
    recompensesActives: true, at: null, par: null, majAt: null
  }, db.flip || {});
  db.kleanPts = db.kleanPts || {};          // { '<clientId>': { solde, hist:[{at,pts,motif,ref}] } }
  db.recompenses = db.recompenses || [];    // récompenses échangeables contre des points
  db.parties = db.parties || [];            // historique TECHNIQUE des parties (anti-fraude)
  db.flipSess = db.flipSess || [];          // sessions de jeu ouvertes (usage unique, expirantes)
  db.quizBank = db.quizBank || { categories: [], questions: [] };
  db.quizBank.categories = db.quizBank.categories || [];
  db.quizBank.questions = db.quizBank.questions || [];
  db.quizPlay = db.quizPlay || [];          // réponses durables au quiz permanent
  db.quizCfg = Object.assign({ defiActif: true, defiPoints: 10, seriePas: 5, serieBonus: 5 }, db.quizCfg || {});
  db.quizDefi = db.quizDefi || {};          // 🎯 défi du jour : { clientId: { jour, qid, reussi } }
  db.quizSerie = db.quizSerie || {};        // 🔥 séries : { clientId: { jour, dernierPalier } }
  db.infos = db.infos || [];                // rubrique INFORMATIONS (contenus du HQ)
  db.urgHist = db.urgHist || [];            // alertes / SOS enregistrés
  db.prefs = db.prefs || {};                // préférences client (rubrique OPTIONS)
  db.urgContacts = db.urgContacts || {};    // contacts d'urgence personnels { clientId: [...] }
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
function bcAll(obj) { for (const s of [...sockets]) { try { wsSend(s, obj); } catch (e) {} } }
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
async function pushNewMissionToAgents(m, svcNom, onlyIds) {
  if (!webpush || !vapidKeys()) return;
  const payload = JSON.stringify({ title: '🔔 Nouvelle demande KLEAN', body: svcNom + ' · ' + (m.quartier || '') + ' · ' + (m.prixTotal || 0).toLocaleString('fr-FR') + ' F — touchez pour accepter', url: '/?mode=agent', missionId: m.id });
  const only = Array.isArray(onlyIds) && onlyIds.length ? new Set(onlyIds) : null;
  const targets = db.agents.filter(ag => (ag.status || 'approved') === 'approved' && !ag.blocked && (ag.stayOnline || ag.online) && Array.isArray(ag.pushSubs) && ag.pushSubs.length && (!m.service || agentHasService(ag, m.service)) && (!only || only.has(ag.id)));
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
function lastSeenFresh(iso, ms) {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && (Date.now() - t) < (ms || 120000);
}
function presenceHits(ids) {
  prunePresence();
  const keys = new Set((ids || []).filter(Boolean).map(x => String(x)));
  if (!keys.size) return false;
  for (const [k, v] of presence) {
    if (keys.has(String(k))) return true;
    if (v && v.id && keys.has(String(v.id))) return true;
  }
  return false;
}
function agentIsOnline(a) {
  if (!a || a.blocked) return false;
  if (onlineAgentIds().has(a.id)) return true;
  if ([...sockets].some(s => s.meta && s.meta.role === 'agent' && s.meta.online && s.meta.agentId === a.id)) return true;
  if (presenceHits([a.id, 'AG-' + a.id])) return true;
  /* poche / écran éteint : le heartbeat + stayOnline gardent le pro visible ~30 min */
  if (a.stayOnline && lastSeenFresh(a.lastSeen, 30 * 60 * 1000)) return true;
  return false;
}
function clientIsOnline(c) {
  if (!c || c.blocked) return false;
  if ([...sockets].some(s => s.meta && s.meta.clientId === c.id)) return true;
  return presenceHits([c.id, 'CL-' + c.id]);
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
      /* 🔒 le compte doit prouver son jeton — sauf première fois (le serveur lui en donne un) */
      if (ag.jeton && String(msg.jeton || '') !== ag.jeton) {
        wsSend(sock, { type: 'agent_denied', reason: 'jeton' });
        console.log('⛔ Connexion pro refusée (jeton invalide) : ' + (ag.nom || ag.id));
        break;
      }
      if (ag.status === 'pending') { wsSend(sock, { type: 'agent_pending' }); break; }
      if (ag.blocked) { wsSend(sock, { type: 'agent_denied', reason: 'blocked' }); break; }
      if (ag.status === 'rejected') { wsSend(sock, { type: 'agent_denied', reason: 'rejected' }); break; }
      ag.nom = msg.nom || ag.nom; ag.quartier = msg.quartier || ag.quartier; ag.tel = msg.tel || ag.tel;
      if (msg.ville) ag.ville = String(msg.ville).slice(0, 60);
      if (msg.villeService) ag.villeService = String(msg.villeService).slice(0, 60);
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
      if (ag && ag.jeton && String(msg.jeton || '') !== ag.jeton) { ag.posRejets = (ag.posRejets || 0) + 1; break; }
      if (ag && typeof msg.lat === 'number' && typeof msg.lng === 'number') {
        /* 🔒 on n'accepte que des points plausibles en Côte d'Ivoire, et jamais un saut impossible (> 120 km/h) */
        if (posPlausible(ag, msg.lat, msg.lng)) {
          ag.pos = { lat: msg.lat, lng: msg.lng, at: Date.now(), src: 'ws', acc: typeof msg.acc === 'number' ? Math.round(msg.acc) : null };
          ag.villeIci = nearestVille(msg.lat, msg.lng);
          ag.lastSeen = nowISO();
          ag.posRejets = 0;
        } else {
          ag.posRejets = (ag.posRejets || 0) + 1;
          if (ag.posRejets === 5) console.log('⚠️ Positions GPS rejetées (impossibles) : ' + ag.nom);
        }
      }
      break;
    }
  }
}

/* ───────── Missions : diffusion & notifications ───────── */
function publicMissionForAgent(m) {
  // on ne diffuse PAS le téléphone du client avant acceptation
  const { tel, ...clientSafe } = m.client;
  const cibleChamp = { cible: m.cible || null };   // 🎯 demande adressée à UN pro précis
  return {
    id: m.id, service: m.service, pieces: m.pieces, depth: m.depth,
    quartier: m.quartier, time: m.time, date: m.date,
    dist: m.dist, prixTotal: m.prixTotal, quote: !!m.quote, quotedPrix: m.quotedPrix || 0,
    lat: m.lat, lng: m.lng,               // 📍 position GPS du client (pour l'agent)
    clientNom: m.client.nom,
    desc: m.desc || '',                   // 📝 description/matière précisée par le client
    photos: Array.isArray(m.photos) ? m.photos : [],
    budget: m.budget || 0,
    cible: m.cible || null,               // 🎯 le client a demandé CE pro précisément
    cibleNom: m.cibleNom || ''
  };
}
/* 🎯 Notifie UNIQUEMENT le pro visé : « le client vous a choisi » */
function broadcastMissionCiblee(m) {
  const sock = [...sockets].find(x => x.meta && x.meta.agentId === m.cible);
  const ag = db.agents.find(a => a.id === m.cible);
  if (sock) {
    wsSend(sock, { type: 'mission_request', mission: Object.assign(publicMissionForAgent(m), { pourVous: true }) });
    if (ag) { ag.demandes = (ag.demandes || 0) + 1; ag.lastDemandAt = nowISO(); }
    console.log('🎯 Demande ' + m.id + ' envoyée au pro choisi : ' + (ag ? ag.nom : m.cible));
  } else {
    console.log('🎯 Pro choisi hors ligne pour ' + m.id + ' — notification poche + élargissement');
  }
  if (ag && Array.isArray(ag.pushSubs) && ag.pushSubs.length) {
    pushNewMissionToAgents(m, (SVC_NAMES[m.service] || m.service) || '', [ag.id]).catch(() => {});
  }
  emitAdmin('mission', '🎯 ' + m.id + ' — ' + (m.client.nom || '') + ' a demandé directement ' + (ag ? ag.nom : (m.cibleNom || 'un pro'))
    + ' · ' + (SVC_NAMES[m.service] || m.service) + ' · ' + (m.prixTotal || 0).toLocaleString('fr-FR') + ' F');
}
function emitToMission(m, obj) {
  const list = subsOf(m.id);
  // inclure le socket de l'agent assigné
  if (m.agentId) { const a = [...sockets].find(s => s.meta && s.meta.agentId === m.agentId); if (a && !list.includes(a)) list.push(a); }
  broadcast(list, obj);
}
const SVC_NAMES = { maison:'Ménage maison', bureaux:'Bureaux', canapes:'Canapés & tapis', vitres:'Vitres', grand:'Grand ménage', plomberie:'Plomberie', electricite:'Électricité', clim:'Climatisation', serrurerie:'Serrurerie', electro:'Électroménager', jardinage:'Jardinage', lavageauto:'Lavage auto', bricolage:'Bricolage', demen:'Déménagement', cuisine:'Cuisinier à domicile', cours:'Cours ou formation à domicile', canal:'Canal+ à domicile', evenement:'Après événement', entretien:'Entretien régulier', placement:'Placement de personnel', custom:'Demande sur mesure' };
/* ═══════════ 📚 CATALOGUE DE RECHERCHE UNIFIÉ ═══════════
   Une seule porte d'entrée : le client écrit ce dont il a besoin en français
   (« cours à domicile », « fuite d'eau », « ménage »). Chaque métier porte ses
   mots-clés (synonymes, abréviations, fautes courantes) et son prix indicatif.
   C'est LE SERVEUR qui comprend et classe : le téléphone ne décide de rien. */
const SVC_CAT = [
  {id:'maison',       nom:'Nettoyage maison',            ic:'🏠', base:7000,  mots:'menage menagere menage a domicile nettoyage maison appartement villa studio chambre salon balayage serpilliere propre nettoyer repassage linge lessive'},
  {id:'bureaux',      nom:'Nettoyage bureaux',           ic:'🏢', base:15000, mots:'bureaux bureau commerce agence societe entreprise open space boutique magasin'},
  {id:'canapes',      nom:'Canapés & fauteuils',         ic:'🛋️', base:6000,  mots:'canape canapes fauteuil fauteuils tapis moquette salon injection extraction detachage tache'},
  {id:'vitres',       nom:'Vitres & baies',              ic:'🪟', base:4500,  mots:'vitre vitres baie baies fenetre fenetres carreaux vitrine glace'},
  {id:'demenagement', nom:'Après déménagement',          ic:'🧼', base:15000, mots:'apres demenagement emmenagement etat des lieux chantier fin de bail maison vide'},
  {id:'sdb',          nom:'Salles de bains',             ic:'🚿', base:5500,  mots:'salle de bain salle de bains sdb douche baignoire joints faillance faience tartre detartrage wc toilettes lavabo'},
  {id:'grand',        nom:'Grand ménage',                ic:'🧹', base:16000, mots:'grand menage menage complet fond en comble remise a neuf nettoyage complet grande maison'},
  {id:'plomberie',    nom:'Plomberie',                   ic:'🔧', base:6000,  mots:'plomberie plombier fuite fuites robinet robinets wc chasse canalisation bouchee debouchage deboucher chauffe eau chauffe-eau tuyau tuyaux evier lavabo pression eau'},
  {id:'electricite',  nom:'Électricité',                 ic:'💡', base:6000,  mots:'electricite electricien courant panne prise prises interrupteur interrupteurs tableau electrique disjoncteur plafonnier ventilateur plafond court circuit court-circuit cable cablage luminaire ampoule lumiere'},
  {id:'clim',         nom:'Climatisation',               ic:'❄️', base:10000, mots:'clim climatisation climatiseur climatiseurs split gaz recharge freon froid fraicheur froid installation climat entretien climat clim ne fait plus de froid'},
  {id:'serrurerie',   nom:'Serrurerie',                  ic:'🔑', base:5000,  mots:'serrurerie serrurier serrure portes cle cles cylindre verrou ouverture de porte cadenas porte fermee'},
  {id:'electro',      nom:'Électroménager',              ic:'🔌', base:5000,  mots:'electromenager frigo refrigerateur congelo congelateur machine a laver lave linge four cuisiniere micro ondes vaisselle lave vaisselle appareil menager'},
  {id:'jardinage',    nom:'Jardinage',                   ic:'🌿', base:7000,  mots:'jardinage jardin jardinier pelouse gazon tonte tondre haie haies taille desherbage arbre arbres plantes fleurs cour'},
  {id:'lavageauto',   nom:'Lavage auto à domicile',      ic:'🚗', base:4000,  mots:'lavage auto voiture vehicule vehicules car wash nettoyage voiture suv 4x4 moto cire'},
  {id:'bricolage',    nom:'Bricolage & montage',         ic:'🪛', base:6000,  mots:'bricolage bricoleur montage meuble meubles etagere etageres fixation tv tringle rideaux perceuse petits travaux vis'},
  {id:'demen',        nom:'Déménagement & portage',      ic:'📦', base:30000, mots:'demenagement demenageur portage porteur porteurs transport cartons emballage camion demenager chargement'},
  {id:'cuisine',      nom:'Cuisinier à domicile',        ic:'🍳', base:10000, mots:'cuisinier cuisiniere cuisine repas plats traiteur patisserie patissier dessert chef repas de fete'},
  {id:'evenement',    nom:'Après événement',             ic:'🎉', base:12000, mots:'evenement fete mariage reception ceremonie bapteme anniversaire apres fete salle de fete'},
  {id:'entretien',    nom:'Entretien régulier',          ic:'🗓️', base:6000,  mots:'entretien regulier abonnement chaque semaine mensuel periodique contrat menage recurrent tous les jours'},
  {id:'placement',    nom:'Placement de personnel',      ic:'👥', base:15000, mots:'placement personnel nounou garde enfant garde d enfant gardien vigile aide menagere employe recrutement domestique nourrice'},
  {id:'cours',        nom:'Cours ou formation à domicile', ic:'📚', base:15000, mots:'cours soutien scolaire formation professeur prof repetiteur eleve eleves mathematiques maths physique chimie svt francais anglais espagnol philosophie philo histoire geographie lecture ecriture primaire college lycee bac instituteur institutrice coach coaching informatique bureautique langue langues musique piano guitare devoirs'},
  {id:'canal',        nom:'Canal+ domicile',             ic:'📡', base:5000,  mots:'canal canal+ decodeur parabole satellite tv television antenne installation tv abonnement chaines'},
];
const SVC_MOTS_IDX = SVC_CAT.map(c => ({ id: c.id, set: new Set(c.mots.split(' ')) }));
function svcCat(id) { return SVC_CAT.find(x => x.id === id) || null; }
function svcNomP(id) { const c = svcCat(id); return c ? c.nom : (SVC_NAMES[id] || id); }
function svcBaseP(id) { const c = svcCat(id); return c ? c.base : null; }

/* 🔤 Normalisation française : accents, ponctuation, majuscules */
function normFr(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
/* 📍 LIEU DE PRESTATION — « le service se fait ici, pas forcément là où je suis ».
   Le client écrit « Yamoussoukro », « Koko, Bouaké » ou « Cocody » : on résout côté serveur
   sur les villes de Côte d'Ivoire et les quartiers connus (ceux du dashboard HQ). */
function villesConnues() {
  const out = CI_GPS.map(r => ({ nom: r[0], lat: r[1], lng: r[2], quartiers: [] }));
  for (const c of (db.cities || [])) {
    const nom = String((c && c.nom) || '').trim();
    if (!nom) continue;
    const qs = Array.isArray(c.quartiers) ? c.quartiers.map(x => String(x).trim()).filter(Boolean).slice(0, 80) : [];
    const ex = out.find(v => normVille(v.nom) === normVille(nom));
    if (ex) { if (qs.length) ex.quartiers = qs; continue; }
    const g = coordsOfVille(nom);
    if (g) out.push({ nom, lat: g.lat, lng: g.lng, quartiers: qs });
  }
  return out;
}
function resoudreLieu(txt, hintVille, hintQuartier) {
  const n = normVille(txt);
  const villes = villesConnues();
  const parVille = (v, q, precis) => ({ ok: true, ville: v.nom, quartier: q || '', lat: v.lat, lng: v.lng,
    precis: !!precis, texte: (q ? (q + ', ') : '') + v.nom });
  if (n) {
    /* 1) le texte EST une ville */
    for (const v of villes) if (normVille(v.nom) === n) return parVille(v, '', true);
    /* 2) le texte contient un quartier connu */
    const motsN = new Set(n.split(' ').filter(Boolean));
    for (const v of villes) {
      for (const q of (v.quartiers || [])) {
        const nq = normVille(q);
        if (!nq) continue;
        if (nq === n || motsN.has(nq) || (nq.indexOf(' ') > 0 && n.indexOf(nq) >= 0)) return parVille(v, q, false);
      }
    }
    /* 3) le texte ressemble à « quartier, ville » dont la ville est connue */
    for (const v of villes) if (n.indexOf(normVille(v.nom)) >= 0 && normVille(v.nom).length > 3)
      return parVille(v, String(txt).split(/[,;]/)[0].trim(), false);
  }
  /* 4) indice de ville fourni par le client (il a choisi dans la liste) */
  if (hintVille) {
    const v = villes.find(x => normVille(x.nom) === normVille(hintVille));
    if (v) return parVille(v, String(hintQuartier || '').trim(), false);
  }
  return { ok: false, texte: String(txt || '') };
}

/* 🎫 Un code pro s'écrit KP-123456, KP123456, kp 123 456… ou juste 123456 */
function codeKpDe(q) {
  const raw = String(q || '').toUpperCase().replace(/[\s._\-]/g, '');
  let m = raw.match(/^KP0*(\d{3,6})$/);
  if (m) return 'KP-' + String(parseInt(m[1], 10)).padStart(6, '0');
  if (/^\d{6}$/.test(raw)) return 'KP-' + raw;
  return '';
}
/* 📊 Spécificité des mots-clés : un mot présent dans beaucoup de métiers
   (« domicile », « maison ») pèse moins qu'un mot précis (« fuite », « parabole »). */
const SVC_MOT_NB = {};
for (const c of SVC_CAT) for (const kw of c.mots.split(' ')) SVC_MOT_NB[kw] = (SVC_MOT_NB[kw] || 0) + 1;
function poidsMot(kw) { return 3 / (SVC_MOT_NB[kw] || 1); }
/* Mots vides : ils ne disent rien du métier voulu */
const FR_VIDES = new Set(('je j ai mon ma mes ton ta tes son sa ses le la les un une des du de d au aux a et ou pour en sur dans avec '
  + 'chez moi toi nous vous ils elles il elle faire fait faire faire besoin veux voudrais voudrai souhaite cherche trouver trouver '
  + 'svp stp merci urgemment urgent vite aujourd hui demain soir matin semaine mois annonce puis aussi bien bon bien tres peu plus '
  + 'quelqu un quelque chose nouveau nouvelle svp aide aider aidez moi meme').split(' '));

/* 🧠 COMPRÉHENSION : « cours à domicile » → métier « cours ».
   Score = mots du NOM du métier retrouvés dans la demande (+ le nom entier = très fort)
         + mots-clés spécifiques. Union bornée à 3 métiers, avec un seuil de pertinence. */
function resoudreRecherche(q) {
  const brut = String(q || '').trim();
  const kp = codeKpDe(brut);
  if (kp) return { type: 'kp', code: kp, compris: 'Code professionnel ' + kp };
  const n = normFr(brut);
  if (!n) return { type: 'vide', ids: [], compris: '' };
  const mots = [...new Set(n.split(' ').filter(w => w.length > 2 && !FR_VIDES.has(w)))];
  if (!mots.length) return { type: 'inconnu', ids: [], compris: '', suggestions: [] };
  const notes = [];
  for (const c of SVC_CAT) {
    const idx = SVC_MOTS_IDX.find(x => x.id === c.id);
    const nomN = normFr(c.nom);
    const nomMots = new Set(nomN.split(' ').filter(w => w.length > 2 && !FR_VIDES.has(w)));
    let sc = 0, nbNom = 0;
    for (const w of mots) if (nomMots.has(w)) nbNom++;
    sc += nbNom * 2;
    if (nbNom >= 2) sc += 6;                                  // « cours » + « domicile » → très fort
    /* « dé-menage-ment » ne doit pas être pris pour « ménage » : on compare des mots entiers */
    if (n.length > 3) {
      try { if (new RegExp('(^| )' + n.split(' ').join(' +') + '( |$)').test(nomN)) sc += 8; } catch (e) {}
    }
    for (const w of mots) if (idx.set.has(w)) sc += poidsMot(w);   // mot-clé déclaré par le métier
    if (sc > 0.01) notes.push({ id: c.id, sc: Math.round(sc * 100) / 100 });
  }
  notes.sort((a, b) => b.sc - a.sc);
  if (!notes.length) return { type: 'inconnu', ids: [], compris: '', suggestions: [] };
  const top = notes[0].sc;
  /* un mot seul (« ménage ») est large par nature : on garde les 3 meilleurs ;
     une phrase précise est filtrée par un seuil de pertinence */
  const seuil = mots.length <= 1 ? 0.5 : Math.max(1, top * 0.5);
  const garde = notes.filter(x => x.sc >= seuil).slice(0, 3);
  if (!garde.length) return { type: 'inconnu', ids: [], compris: '', suggestions: notes.slice(0, 4).map(x => x.id) };
  const ids = garde.map(x => x.id);
  return {
    type: 'service', ids, principal: ids[0],
    compris: ids.map(i => svcNomP(i)).join(' · '),
    suggestions: notes.filter(x => !ids.includes(x.id)).slice(0, 4).map(x => x.id)
  };
}

/* 🧰 COMPÉTENCES déclarées par le pro : sous-services choisis + niveau + métiers.
   Elles sont confrontées aux mots de la demande (« maths », « vitres », « chaudière »…). */
function competencesPro(ag) {
  const out = [];
  const sn = (ag && ag.subsNoms) || {};
  for (const k in sn) {
    const arr = Array.isArray(sn[k]) ? sn[k] : [];
    for (const nom of arr) if (nom && !out.includes(nom)) out.push(String(nom).slice(0, 60));
  }
  if (ag && ag.niveau) out.unshift(String(ag.niveau).slice(0, 60));
  return out.slice(0, 10);
}
function pCompPro(ag, mots) {
  if (!mots || !mots.length) return 0;
  const texte = normFr([competencesPro(ag).join(' '), (ag.services || []).map(id => svcNomP(id)).join(' ')].join(' '));
  let n = 0;
  for (const w of mots) if (texte.indexOf(w) >= 0) n++;
  return Math.min(5, n * 2);                                  // 0 → 5 points bruts
}
/* ⏱️ Temps estimé pour rejoindre le lieu de prestation (moto/taxi urbain à Côte d'Ivoire) */
function etaMin(distKm) {
  if (distKm == null || !isFinite(distKm)) return null;
  return Math.max(5, 5 + Math.round(distKm * 3));              // 5 min de base + ~3 min par km (≈ 20 km/h)
}
function etaTxt(mn) { return mn == null ? '' : ('≈ ' + mn + ' min'); }
/* 🛡️ Score de vérification (0–100) : calculé sur des FAITS du dossier,
   jamais sur une déclaration. ≥85 → badge « Vérifié + ». */
function verifPro(ag) {
  let s = 40;                                                   // dossier validé par Klean (obligatoire ici)
  if (ag.piecePhoto || ag.pieceNum) s += 20;                    // pièce d'identité fournie
  if (ag.photo) s += 10;                                        // photo de profil
  if (ag.ref1Tel && ag.ref2Tel) s += 15; else if (ag.ref1Tel || ag.ref2Tel) s += 8;
  const xp = parseInt(ag.experience, 10) || 0;
  if (xp >= 3) s += 15; else if (xp >= 1) s += 8;
  return Math.min(100, s);
}
function verifTxt(sc) { return sc >= 85 ? '🛡️ Vérifié +' : (sc >= 70 ? '🛡️ Vérifié' : '✔ Compte validé'); }

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371, dLa = (bLat - aLat) * Math.PI / 180, dLo = (bLng - aLng) * Math.PI / 180;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
function normVille(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function villeOfAgent(ag) {
  return normVille(ag.villeService || ag.ville || ag.villeIci || '');
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
  const n = db.config && typeof db.config.reachKm === 'number' ? db.config.reachKm : 15;
  return Math.max(1, Math.min(800, n));
}
function gpsNationOn() {
  return !!(db.config && db.config.gpsNationOn);
}
function agentHasGps(ag) {
  return !!(ag && ag.pos && typeof ag.pos.lat === 'number' && typeof ag.pos.lng === 'number');
}
/* ───────── ⚙️ Réglages de la mise en relation (modifiables par le PDG) ───────── */
function matchCfg() {
  db.config = db.config || {};
  db.config.match = db.config.match || {};
  const m = db.config.match;
  if (typeof m.distTtlMin !== 'number') m.distTtlMin = 10;      // position « fraîche » → distance exacte
  if (typeof m.zoneTtlMin !== 'number') m.zoneTtlMin = 45;      // au-delà : on retombe sur la zone (ville/quartier)
  if (typeof m.maxRecherchesMin !== 'number') m.maxRecherchesMin = 20;
  if (typeof m.jitterM !== 'number') m.jitterM = 100;           // gigue anti-triangulation
  if (typeof m.rayonDefautKm !== 'number') m.rayonDefautKm = 15; // zone d'intervention par défaut
  if (typeof m.ficheOuverte !== 'boolean') m.ficheOuverte = true;
  /* ⚖️ Poids du classement (0 = critère ignoré, 2 = prioritaire) — réglables par le PDG */
  const PD = { distance: 1, dispo: 1, note: 1, missions: 1, verif: 1, prix: 0.5, zone: 1, competences: 1 };
  if (!m.poids || typeof m.poids !== 'object' || Array.isArray(m.poids)) m.poids = {};
  for (const k in PD) {
    const v = parseFloat(m.poids[k]);
    m.poids[k] = Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : PD[k];
  }
  return m;
}
/* 🔢 Horodatage d'une position : accepte nombre (ms) OU texte ISO (corrige l'anomalie A1) */
function posAtMs(pos) {
  if (!pos) return 0;
  const a = pos.at;
  if (typeof a === 'number' && isFinite(a)) return a;
  if (typeof a === 'string') { const t = Date.parse(a); if (Number.isFinite(t)) return t; }
  return 0;
}
function posAgeMin(ag) {
  const t = posAtMs(ag && ag.pos);
  return t ? (Date.now() - t) / 60000 : Infinity;
}
function posFreshGps(ag) { return agentHasGps(ag) && posAgeMin(ag) <= matchCfg().distTtlMin; }
function posUsable(ag) { return agentHasGps(ag) && posAgeMin(ag) <= matchCfg().zoneTtlMin; }
/* 🌍 la Côte d'Ivoire : on refuse tout point hors du pays (position falsifiée ou bug) */
function validCILatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat > 4.2 && lat < 10.9 && lng > -8.8 && lng < -2.3;
}
function coordsOfVille(nom) {
  const n = normVille(nom);
  if (!n) return null;
  for (const row of CI_GPS) if (normVille(row[0]) === n) return { lat: row[1], lng: row[2] };
  return null;
}
/* 📏 Format français demandé : « 500 m », « 1,2 km », « 12 km » */
function fmtDist(km) {
  if (km == null || !isFinite(km)) return '';
  if (km < 1) return Math.max(50, Math.round(km * 1000 / 50) * 50) + ' m';
  if (km < 10) return (Math.round(km * 10) / 10).toFixed(1).replace('.', ',') + ' km';
  return Math.round(km) + ' km';
}
/* 🔒 Anti-triangulation : gigue ±100 m puis arrondi par paliers (50 m / 100 m / 500 m) */
function distPalier(km) {
  const j = (matchCfg().jitterM || 0) / 1000;
  let d = km + (Math.random() * 2 - 1) * j;
  if (d < 0.05) d = 0.05;
  if (d < 1) d = Math.round(d * 1000 / 50) * 50 / 1000;
  else if (d < 5) d = Math.round(d * 1000 / 100) * 100 / 1000;
  else d = Math.round(d * 2) / 2;
  return Math.round(d * 1000) / 1000;
}
/* 🎫 Numéro professionnel unique (KP-482913) — public par nature */
function ensureNumPro(ag) {
  if (ag.numPro) return ag.numPro;
  const pris = new Set((db.agents || []).map(a => a.numPro).filter(Boolean));
  let n = '';
  do { n = 'KP-' + String(Math.floor(100000 + Math.random() * 900000)); } while (pris.has(n));
  ag.numPro = n;
  ag.numProAt = nowISO();
  return n;
}
/* 🚗 Zone d'intervention du pro (km autour de sa ville de service) */
function zoneOfAgent(ag) {
  const z = (ag && ag.zone) || {};
  const km = (typeof z.km === 'number' && z.km > 0) ? Math.min(800, z.km) : matchCfg().rayonDefautKm;
  const villes = Array.isArray(z.villes) ? z.villes.filter(Boolean).slice(0, 20) : [];
  return { km, villes };
}
function agentDansZone(ag, distKm, memeVille, memeQuartier, villeClient, bonusKm) {
  if (memeQuartier) return true;                                  // même quartier : toujours accepté
  if (memeVille) return true;                                     // sa ville de service
  const z = zoneOfAgent(ag);
  if (villeClient && z.villes.some(v => normVille(v) === normVille(villeClient))) return true;
  const bonus = Math.max(0, Math.min(200, Number(bonusKm) || 0));   // « chercher un peu plus loin »
  if (distKm != null) return distKm <= (z.km + bonus);             // zone d'intervention (+ élargissement demandé)
  return false;                                                    // ni ville ni distance vérifiable → exclu
}
/* 🟢 Disponibilité : libre / en mission / en pause / hors ligne */
function agentDispo(ag) {
  if (!agentIsOnline(ag)) return 'hors';
  if (ag.pause) return 'pause';
  const busy = db.missions.some(m => m.agentId === ag.id && ['accepted', 'enroute', 'arrive', 'encours'].includes(m.status));
  return busy ? 'occupe' : 'libre';
}
function dispoTxt(d) {
  return d === 'libre' ? 'Disponible' : d === 'occupe' ? 'En mission' : d === 'pause' ? 'En pause' : 'Hors ligne';
}
/* 🎫 Jeton pro : preuve que la position vient bien de SON téléphone (corrige l'anomalie A3) */
function issueAgentJeton(ag) {
  if (!ag.jeton) ag.jeton = crypto.randomBytes(16).toString('hex');
  return ag.jeton;
}
function agentJetonOk(req, ag, body) {
  const h = (req.headers && (req.headers['x-agent-token'] || req.headers['X-Agent-Token'])) || '';
  const tok = String(h || (body && body.jeton) || '').trim();
  if (!ag.jeton) { issueAgentJeton(ag); return { ok: true, nouveau: true, legacy: true }; }
  if (tok && tok === ag.jeton) return { ok: true, legacy: false };
  return { ok: false, nouveau: false, legacy: false };
}
/* 🧮 Statistiques du pro mises en cache (corrige l'anomalie A6 : plus de O(pros × missions)) */
function agentStatsCached(ag) {
  if (ag.stats && ag.stats._at && (Date.now() - ag.stats._at) < 120000) return ag.stats;
  const st = agentStats(ag);
  st._at = Date.now();
  ag.stats = st;
  return st;
}
function invaliderStats(agId) {
  const ag = db.agents.find(a => a.id === agId);
  if (ag) delete ag.stats;
}
/* ⚙️ Réglages d'un point de contact public (privacy) */
function privacyOf(ag) {
  const p = (ag && ag.privacy) || {};
  return {
    publierTel: p.publierTel !== false,        // afficher un numéro d'appel (pro si renseigné, sinon personnel)
    hideQuartier: !!p.hideQuartier,            // n'afficher qu'une zone, pas le quartier exact
    publieFiche: p.publieFiche !== false       // fiche consultable
  };
}
/* 📇 Carte publique d'un pro : uniquement les informations autorisées (jamais lat/lng, jamais d'adresse) */
/* ⭐ Note lissée : un seul avis 5★ ne doit pas battre 40 avis à 4,8★ */
function noteLissee(note, avis) {
  const n = Math.max(0, parseInt(avis, 10) || 0);
  const k = 3;                                        // confiance : 3 avis « virtuels » à 4,5
  return Math.round((((note * n) + (4.5 * k)) / (n + k)) * 100) / 100;
}
function fichePublique(ag, o) {
  o = o || {};
  const p = privacyOf(ag);
  const z = zoneOfAgent(ag);
  const dispo = agentDispo(ag);
  const st = agentStatsCached(ag);
  const tel = String(ag.telPro || ag.tel1 || ag.tel || '').replace(/\D/g, '');
  const telVisible = p.publierTel && !!tel;
  return {
    id: ag.id, nom: ag.nom,
    numPro: ensureNumPro(ag),
    photo: ag.photo || '',
    ville: ag.villeService || ag.ville || ag.villeIci || '',
    zoneAff: p.hideQuartier ? ('zone ' + (ag.quartier || ag.villeService || ag.ville || '')) : (ag.quartier || ''),
    quartier: p.hideQuartier ? '' : (ag.quartier || ''),
    services: Array.isArray(ag.services) ? ag.services.slice(0, 12) : [],
    online: agentIsOnline(ag), dispo, dispoTxt: dispoTxt(dispo),
    zoneKm: z.km, villesZone: z.villes,
    note: Math.round((st.rating || 5) * 10) / 10,
    noteLisse: noteLissee(st.rating || 5, st.avis || 0),
    avis: st.avis || 0,
    missionsDone: st.missionsDone || 0,
    verif: verifPro(ag), verifTxt: verifTxt(verifPro(ag)), verifPlus: verifPro(ag) >= 85,
    experience: parseInt(ag.experience, 10) || 0,
    membreDepuis: (ag.createdAt || '').slice(0, 7),
    tel: telVisible ? tel : '', typeNum: (ag.telPro ? 'professionnel' : 'personnel'),
    appelDirect: telVisible && dispo !== 'hors',
    ficheOuverte: p.publieFiche
  };
}


/* ═══════════════════════════════════════════════════════════════════════════
   🔌 CINETPAY — agrégateur unique retenu par le PDG
   Un seul contrat couvre Orange Money CI, Moov Money CI, MTN MoMo, Wave et
   les cartes. Rien n'est stocké ici : la clé d'API et le site_id vivent dans
   les variables d'environnement Render (KLEAN_CINETPAY_API_KEY / SITE_ID).
   Un paiement n'est déclaré « réussi » qu'après vérification du statut
   DIRECTEMENT chez CinetPay (appel serveur à serveur) + contrôle du montant.
   ═══════════════════════════════════════════════════════════════════════════ */
const CINETPAY_BASE = () => (process.env.KLEAN_CINETPAY_BASE || 'https://api-checkout.cinetpay.com');
function cinetpayCfg() {
  const cfg = payCfg();
  cfg.provider = cfg.provider || { nom: 'cinetpay', siteId: '', actif: true, canaux: 'ALL', dernierTest: null };
  if (!cfg.provider.nom) cfg.provider.nom = 'cinetpay';
  return cfg.provider;
}
function cinetpaySiteId() { return String(process.env.KLEAN_CINETPAY_SITE_ID || cinetpayCfg().siteId || '').trim(); }
function cinetpayApiKey() { return String(process.env.KLEAN_CINETPAY_API_KEY || '').trim(); }
function basePublique(req) {
  if (process.env.KLEAN_PUBLIC_URL) return String(process.env.KLEAN_PUBLIC_URL).replace(/\/+$/, '');
  try {
    const host = req && req.headers && req.headers.host;
    const proto = (req && req.headers && (req.headers['x-forwarded-proto'] || '')) || 'https';
    if (host) return proto + '://' + host;
  } catch (e) {}
  return '';
}
/* ce qui manque exactement pour que CinetPay encaisse */
function cinetpayManque(req) {
  const manque = [];
  if (!cinetpayApiKey()) manque.push('Clé d’API CinetPay (back-office CinetPay → Intégration → « API Key ») à mettre dans la variable Render KLEAN_CINETPAY_API_KEY');
  if (!cinetpaySiteId()) manque.push('Site ID CinetPay (page Intégration) — à saisir ci-dessous ou dans KLEAN_CINETPAY_SITE_ID');
  const pub = basePublique(req);
  if (!pub || /localhost|127\.0\.0\.1/.test(pub)) manque.push('Adresse publique de l’application (variable KLEAN_PUBLIC_URL, ex : https://klean-service.onrender.com) pour recevoir les notifications CinetPay');
  return manque;
}
/* 🛡️ sécurité supplémentaire, mais NON bloquante */
function cinetpayRecommande() {
  const out = [];
  if (!process.env.KLEAN_CINETPAY_HMAC_KEY) out.push('Clé HMAC CinetPay (protection anti-fausse notification) → KLEAN_CINETPAY_HMAC_KEY. La vérification serveur à serveur protège déjà, mais la signature est un plus.');
  return out;
}
function cinetpayPret(req) { return cinetpayManque(req).length === 0; }
function urlsCinetpay(req) {
  const b = basePublique(req);
  return { notify: b + '/api/pay/webhook/cinetpay', retour: b + '/api/paiement/retour', base: b };
}
/* appel HTTP JSON vers CinetPay (natif Node, aucune dépendance) */
function httpJson(url, body, timeoutMs) {
  return new Promise((resolve) => {
    let fini = false;
    const done = (v) => { if (!fini) { fini = true; resolve(v); } };
    try {
      const u = new URL(url);
      const payload = JSON.stringify(body || {});
      const mod = u.protocol === 'http:' ? require('http') : require('https');
      const req = mod.request({
        hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      }, (res) => {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} done({ ok: true, status: res.statusCode, json: j, texte: d.slice(0, 800) }); });
      });
      req.on('error', (e) => done({ ok: false, error: e.message }));
      req.setTimeout(timeoutMs || 15000, () => { try { req.destroy(); } catch (e) {} done({ ok: false, error: 'délai dépassé' }); });
      req.write(payload); req.end();
    } catch (e) { done({ ok: false, error: e.message }); }
  });
}
/* 1️⃣ initier un paiement : on demande à CinetPay un lien de paiement sécurisé */
async function cinetpayInitier(pa, req) {
  const u = urlsCinetpay(req);
  const r = await httpJson(CINETPAY_BASE() + '/v2/payment', {
    apikey: cinetpayApiKey(), site_id: cinetpaySiteId(),
    transaction_id: pa.ref,                 // 🆔 notre référence unique = identifiant CinetPay
    amount: pa.montant, currency: 'XOF',
    description: 'KLEAN Service — mission ' + (pa.missionId || pa.ref),
    notify_url: u.notify, return_url: u.retour,
    channels: cinetpayCfg().canaux || 'ALL', lang: 'fr',
    customer_id: pa.clientId || pa.id,
    customer_name: String(pa.clientNom || 'Client KLEAN').slice(0, 60),
    customer_surname: '',
    customer_phone_number: pa.payeurTel ? ('+225' + pa.payeurTel) : '',
    customer_country: 'CI',
    metadata: JSON.stringify({ ref: pa.ref, mission: pa.missionId || '', klean: 'KLEAN Service' })
  }, 20000);
  if (!r.ok) return { ok: false, error: 'CinetPay injoignable (' + (r.error || 'réseau') + ')' };
  const d = r.json || {};
  const data = d.data || {};
  const code = String(d.code || (data && data.code) || '');
  const lien = data.payment_url || (data.paymentUrl) || '';
  if (lien && (code === '201' || r.status === 200 || r.status === 201)) {
    return { ok: true, url: lien, token: data.payment_token || data.paymentToken || '', brut: d };
  }
  return { ok: false, error: (d.message || d.description || 'refus CinetPay') + (code ? (' [code ' + code + ']') : ''), brut: d };
}
/* 2️⃣ vérifier une transaction CHEZ CinetPay (source de vérité) */
async function cinetpayVerifier(ref) {
  const r = await httpJson(CINETPAY_BASE() + '/v2/payment/check', {
    apikey: cinetpayApiKey(), site_id: cinetpaySiteId(), transaction_id: ref
  }, 20000);
  if (!r.ok) return { ok: false, error: 'CinetPay injoignable (' + (r.error || 'réseau') + ')' };
  const d = r.json || {};
  const data = d.data || {};
  const statut = String(data.status || '').toUpperCase();
  const code = String(d.code || '');
  return {
    ok: true, statut, code, message: d.message || '', montant: parseInt(data.amount, 10) || 0,
    devise: data.currency || '', moyen: data.payment_method || '', operateur: data.operator_id || '',
    quand: data.payment_date || '', tx: data.cpm_trans_id || data.transaction_id || '', metadata: data.metadata || ''
  };
}
/* 3️⃣ appliquer le verdict du fournisseur sur notre transaction (jamais sur parole) */
function cinetpayAppliquer(pa, v) {
  const st = String(v.statut || '').toUpperCase();
  if (st === 'ACCEPTED') {
    if (v.montant && Math.round(v.montant) !== Math.round(pa.montant)) {
      pa.statut = 'echoue';
      pa.motif = 'Montant reçu (' + v.montant + ' F) différent du montant attendu (' + pa.montant + ' F)';
      tracePaiement(pa, '⚠️ ' + pa.motif + ' — paiement refusé par sécurité', 'CinetPay');
      return { ok: true, statut: 'echoue' };
    }
    pa.statut = 'reussi';
    pa.confirmePar = 'Fournisseur CinetPay';
    pa.confirmeAt = nowISO();
    pa.txOperateur = v.tx || pa.txOperateur || '';
    pa.txFourniPar = 'CinetPay (vérifié serveur à serveur)';
    pa.moyenPaiement = v.moyen || '';
    tracePaiement(pa, '✅ Confirmation FOURNISSEUR CinetPay — statut ACCEPTED vérifié (' + (v.moyen || '') + (v.tx ? (', tx ' + v.tx) : '') + ')', 'CinetPay');
    return { ok: true, statut: 'reussi' };
  }
  if (st === 'REFUSED' || st === 'CANCELED' || st === 'CANCELLED') {
    pa.statut = 'echoue';
    pa.motif = v.message || 'Paiement refusé par CinetPay';
    tracePaiement(pa, '❌ CinetPay : ' + pa.motif, 'CinetPay');
    return { ok: true, statut: 'echoue' };
  }
  return { ok: true, statut: pa.statut };   // PENDING / INITCHECK : on ne change rien
}

/* ═══════════════════════════════════════════════════════════════════════════
   💳 MOTEUR PAIEMENT — moyens de paiement + transactions vérifiées
   ---------------------------------------------------------------------------
   Règles absolues :
   • Aucun secret (PIN Mobile Money, mot de passe, clé d'API) n'est stocké ici.
   • Un paiement n'est JAMAIS « réussi » parce que l'utilisateur l'affirme :
     il faut la confirmation du fournisseur (webhook signé) ou du PDG (avec
     son mot de passe + le numéro de transaction de l'opérateur).
   ═══════════════════════════════════════════════════════════════════════════ */
function payCfg() {
  db.config = db.config || {};
  db.config.pay = db.config.pay || {
    providers: {
      orange: { mode: 'declaration', merchantConfigure: false },
      moov:   { mode: 'declaration', merchantConfigure: false },
      wave:   { mode: 'aucun',       merchantConfigure: false }
    }
  };
  const cfg = db.config.pay;
  cfg.providers = cfg.providers || {};
  return cfg;
}
/* 📞 opérateur déduit du préfixe ivoirien (10 chiffres) */
function operateurDeNumero(num) {
  const n = String(num || '').replace(/\D/g, '');
  if (/^07/.test(n)) return 'orange';      // Orange CI
  if (/^05/.test(n)) return 'mtn';         // MTN CI
  if (/^01/.test(n)) return 'moov';        // Moov Africa CI
  if (/^21/.test(n)) return 'moov';        // fixe Moov
  if (/^27/.test(n)) return 'orange';      // fixe Orange
  if (/^25/.test(n)) return 'mtn';         // fixe MTN
  return 'autre';
}
const OPERATEURS = {
  orange: { nom: 'Orange Money',      ic: '🟠', ussd: '#144#',   env: 'KLEAN_ORANGE_API_SECRET', doc: 'API Orange Money (merchant_key + Bearer Orange)' },
  moov:   { nom: 'Moov Money',        ic: '🔵', ussd: '*155#',   env: 'KLEAN_MOOV_API_SECRET',   doc: 'API Moov Money (contrat marchand Moov Africa CI)' },
  mtn:    { nom: 'MTN MoMo',          ic: '🟡', ussd: '*133#',   env: 'KLEAN_MTN_API_SECRET',    doc: 'API MTN MoMo CI' },
  wave:   { nom: 'Wave',              ic: '🌊', ussd: '',        env: 'KLEAN_WAVE_API_SECRET',   doc: 'Wave Business API (compte marchand Wave)' },
  autre:  { nom: 'Autre',             ic: '💳', ussd: '',        env: '',                        doc: 'Aucune API officielle connue pour ce moyen' }
};
function operateurInfo(op) { return OPERATEURS[op] || OPERATEURS.autre; }
function fmtNumeroCI(num) {
  const n = String(num || '').replace(/\D/g, '');
  return n.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
}
function nouveauIdPayMethod() { return uid('PM'); }
function payMethods() {
  db.payMethods = Array.isArray(db.payMethods) ? db.payMethods : [];
  return db.payMethods;
}
/* 🏁 premier démarrage : les deux numéros déjà utilisés par l'application deviennent gérables */
function seedPayMethods() {
  const list = payMethods();
  if (list.length) return false;
  const now = nowISO();
  list.push({
    id: nouveauIdPayMethod(), libelle: 'Orange Money', operateur: 'orange', numero: '0709076130', titulaire: 'KLEAN SERVICE',
    note: 'Numéro principal', principal: true, actif: true, visibleClient: true, visiblePro: true,
    createdAt: now, updatedAt: now, updatedBy: 'Système (reprise des numéros existants)'
  });
  list.push({
    id: nouveauIdPayMethod(), libelle: 'Moov Money', operateur: 'moov', numero: '0100277521', titulaire: 'KLEAN SERVICE',
    note: '', principal: false, actif: true, visibleClient: true, visiblePro: true,
    createdAt: now, updatedAt: now, updatedBy: 'Système (reprise des numéros existants)'
  });
  saveDb();
  console.log('💳 Moyens de paiement initialisés : 0709076130 (Orange Money, principal) + 0100277521 (Moov Money)');
  return true;
}
/* ce qui MANQUE pour encaisser en automatique — affiché tel quel dans le HQ (exigence 7) */
function integrationsPay() {
  const cfg = payCfg();
  const vus = new Set();
  const out = [];
  for (const m of payMethods()) {
    if (vus.has(m.operateur)) continue;
    vus.add(m.operateur);
    const info = operateurInfo(m.operateur);
    /* 🔌 Agrégateur UNIQUE retenu par le PDG : CinetPay (Orange + Moov + Wave + cartes) */
    const viaCinetpay = cinetpayCfg().nom === 'cinetpay' && ['orange', 'moov', 'mtn', 'wave'].includes(m.operateur);
    const manque = [];
    if (viaCinetpay) {
      for (const k of cinetpayManque(null)) manque.push(k);
      if (cinetpayCfg().actif === false) manque.push('Encaissement en ligne désactivé (interrupteur PDG)');
    } else if (!['orange', 'moov', 'mtn', 'wave'].includes(m.operateur)) {
      manque.push('Passerelle de paiement officielle (aucune API standard pour ce moyen)');
    } else {
      manque.push(info.doc);
      if (!process.env.KLEAN_PAY_API_KEY) manque.push('Clé d’API marchande (KLEAN_PAY_API_KEY)');
    }
    out.push({
      operateur: m.operateur, nom: info.nom, ic: info.ic,
      via: viaCinetpay ? 'CinetPay' : 'direct',
      mode: (viaCinetpay && cinetpayPret(null)) ? 'api' : 'declaration',
      apiOfficielle: viaCinetpay ? cinetpayPret(null) : !!process.env.KLEAN_PAY_API_KEY,
      webhookPret: viaCinetpay ? !!process.env.KLEAN_CINETPAY_HMAC_KEY : !!process.env.KLEAN_PAY_WEBHOOK_SECRET,
      webhookUrl: viaCinetpay ? '/api/pay/webhook/cinetpay' : ('/api/pay/webhook/' + m.operateur),
      manque
    });
  }
  return out;
}
/* 🔒 on ne renvoie JAMAIS un moyen non actif ou non visible */
function payMethodsPubliques(role) {
  const champ = role === 'pro' ? 'visiblePro' : 'visibleClient';
  return payMethods()
    .filter(m => m.actif && m[champ])
    .sort((a, b) => Number(!!b.principal) - Number(!!a.principal) || String(a.libelle).localeCompare(String(b.libelle), 'fr'))
    .map(m => {
      const info = operateurInfo(m.operateur);
      return {
        id: m.id, libelle: m.libelle, operateur: m.operateur, nomOperateur: info.nom, ic: info.ic,
        numero: m.numero, numeroAffiche: fmtNumeroCI(m.numero), ussd: info.ussd,
        principal: !!m.principal,
        mode: (payCfg().providers[m.operateur] && payCfg().providers[m.operateur].mode) || 'declaration',
        /* ℹ️ on dit franchement au client comment ça se passe */
        instructions: 'Envoyez le montant exact via ' + m.libelle + ' au ' + fmtNumeroCI(m.numero) + ' en mettant la RÉFÉRENCE dans le motif.'
      };
    });
}
/* 🆔 identifiant unique de transaction : KL-AAAAMMJJ-XXXX (aucun doublon possible) */
function nouvelleRefPaiement() {
  const d = new Date();
  const j = d.getFullYear().toString() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  let ref;
  do { ref = 'KL-' + j + '-' + crypto.randomBytes(2).toString('hex').toUpperCase(); }
  while ((db.paiements || []).some(x => x.ref === ref));
  return ref;
}
function paiements() { db.paiements = Array.isArray(db.paiements) ? db.paiements : []; return db.paiements; }
const PAY_STATUTS = { en_attente: 'En attente', declare: 'En attente', reussi: 'Réussi', echoue: 'Échoué', annule: 'Annulé' };
function paiementStatutTxt(st) { return PAY_STATUTS[st] || st; }
function paiementPublic(pa) {
  return {
    id: pa.id, ref: pa.ref, montant: pa.montant, statut: pa.statut, statutTxt: paiementStatutTxt(pa.statut),
    moyen: pa.moyen, missionId: pa.missionId || '', createdAt: pa.createdAt, updatedAt: pa.updatedAt,
    declareAt: pa.declareAt || '', confirmeAt: pa.confirmeAt || '', confirmePar: pa.confirmePar || '',
    txOperateur: pa.txOperateur || '', txFourniPar: pa.txFourniPar || '', motif: pa.motif || '', numeroAffiche: fmtNumeroCI((pa.moyen || {}).numero || ''),
    enLigne: !!(pa.checkoutUrl || pa.mode === 'api'), paiementLibelle: pa.moyenPaiement || '',
    /* 🔎 on explique au client pourquoi c'est encore en attente */
    explication: pa.statut === 'en_attente' ? (pa.checkoutUrl ? 'En attente : terminez le paiement sur la page sécurisée CinetPay (référence ' + pa.ref + ').' : 'En attente : payez avec la référence ' + pa.ref + ' puis appuyez sur « J’ai payé ».')
      : pa.statut === 'declare' ? 'Vous avez déclaré le paiement. Klean vérifie la réception auprès de l’opérateur — le statut passera à « Réussi » après confirmation.'
      : pa.statut === 'reussi' ? 'Paiement confirmé' + (pa.confirmePar ? ' par ' + pa.confirmePar : '') + '. Merci !'
      : pa.statut === 'echoue' ? ('Paiement refusé' + (pa.motif ? ' : ' + pa.motif : ''))
      : 'Paiement annulé.'
  };
}
/* qui a le droit de voir/modifier un paiement */
function paiementProprietaire(req, pa) {
  const cl = findClientByToken(req);
  if (cl && cl.id === pa.clientId) return { role: 'client', id: cl.id, nom: cl.nom };
  const aid = req.headers['x-agent-token'] || '';
  if (aid) {
    const ag = db.agents.find(a => a.jeton && a.jeton === aid);
    if (ag && (ag.id === pa.proId || ag.id === pa.agentId)) return { role: 'pro', id: ag.id, nom: ag.nom };
  }
  return null;
}
function tracePaiement(pa, ev, by) {
  pa.hist = pa.hist || [];
  pa.hist.push({ at: Date.now(), by: by || 'système', ev });
  pa.updatedAt = nowISO();
}

/* ═══════════ 🔎 LE MOTEUR : recherche intelligente (proximité + service + dispo + zone) ═══════════
   Proximité GPS = critère MAJEUR, mais jamais de pro hors métier, hors zone ou compte inactif. */
function recherchePro(o) {
  o = o || {};
  const cfg = matchCfg();
  const villeN = normVille(o.ville || '');
  const svc = String(o.service || '').trim();
  /* métiers demandés : un seul (ancien appel) ou plusieurs (phrase comprise → union bornée) */
  let svcIds = Array.isArray(o.services) && o.services.length ? o.services.filter(Boolean).slice(0, 3)
    : (svc && svc !== 'custom' ? [svc] : []);
  if (svc && svc !== 'custom' && !svcIds.includes(svc)) svcIds = [svc, ...svcIds].slice(0, 3);
  /* mots utiles de la demande (pour confronter aux compétences déclarées) */
  const motsDem = normFr(o.q || '').split(' ').filter(w => w.length > 2 && !FR_VIDES.has(w)).slice(0, 8);
  const qN = String(o.quartier || '').trim().toLowerCase();
  /* position du client : GPS vérifié, sinon le centre de sa ville (approx., on le dit au client) */
  let cPos = null, cSrc = 'aucune';
  if (validCILatLng(o.lat, o.lng)) { cPos = { lat: o.lat, lng: o.lng }; cSrc = 'gps'; }
  else { const v = coordsOfVille(o.ville); if (v) { cPos = v; cSrc = 'ville'; } }

  const liste = [];
  for (const ag of (db.agents || [])) {
    if (!ag || ag.blocked || (ag.status || 'approved') !== 'approved') continue;   // statut actif uniquement
    /* filtre DUR : le pro doit faire l'un des métiers compris (jamais de pro hors métier) */
    let metierFait = svcIds.length ? svcIds.filter(id => agentHasService(ag, id)) : [];
    if (svcIds.length && !metierFait.length) continue;
    /* fiche non publique = carte inutilisable : on ne la propose pas */
    if (!privacyOf(ag).publieFiche) continue;
    const online = agentIsOnline(ag);
    if (!online && !o.inclureHorsLigne) continue;                                   // dispo d'abord
    const dispo = agentDispo(ag);
    const memeVille = !!(villeN && villeOfAgent(ag) === villeN);
    const memeQuartier = !!(qN && String(ag.quartier || '').trim().toLowerCase() === qN);

    /* distance : GPS frais du pro si possible, sinon sa ville de service */
    let dist = null, distSource = 'aucune';
    const gpsFrais = posFreshGps(ag);
    const base = gpsFrais ? { lat: ag.pos.lat, lng: ag.pos.lng } : coordsOfVille(ag.villeService || ag.ville);
    if (cPos && base) {
      dist = haversineKm(cPos.lat, cPos.lng, base.lat, base.lng);
      distSource = gpsFrais ? 'gps' : (ag.pos && posUsable(ag) ? 'zone' : 'ville');
    }
    if (!agentDansZone(ag, dist, memeVille, memeQuartier, o.ville, o.zoneElargie)) continue;   // hors zone → exclu

    /* ═══ 🏆 SCORE 0–100 SUR LES 7 CRITÈRES DEMANDÉS (poids réglables par le PDG) ═══
       points bruts → × poids → ramenés sur 100. Plus le score est haut, plus le pro est pertinent. */
    const w = cfg.poids;
    const pDist = dist == null ? 6 : Math.max(0, Math.round(40 * Math.exp(-dist / 8)));
    const pDispo = dispo === 'libre' ? 25 : (dispo === 'occupe' ? 8 : 0);
    const stA = agentStatsCached(ag);
    const avis = stA.avis || 0;
    const nL = noteLissee(stA.rating || 5, avis);
    const pNote = Math.max(0, Math.min(15, Math.round((nL - 3.5) * 15)));
    const pMissions = Math.max(0, Math.min(10, Math.round(Math.log2(1 + (stA.missionsDone || 0)) * 2)));
    const vSc = verifPro(ag);
    const pVerif = Math.round(vSc / 20);                       // 0–5
    const pZone = (memeQuartier ? 6 : (memeVille ? 3 : 0)) + (distSource === 'gps' ? 4 : 0);
    const baseMin = metierFait.length ? Math.min(...metierFait.map(id => svcBaseP(id) || 999999)) : null;
    const pPrix = baseMin == null ? 0 : Math.max(0, Math.round(5 - (baseMin / 10000) * 2));   // indicatif
    const pComp = pCompPro(ag, motsDem);                                                  // compétences déclarées
    const obtenu = (pDist * w.distance) + (pDispo * w.dispo) + (pNote * w.note) + (pMissions * w.missions)
      + (pVerif * w.verif) + (pPrix * w.prix) + (pZone * w.zone) + (pComp * w.competences);
    const maxPoids = (40 * w.distance) + (25 * w.dispo) + (15 * w.note) + (10 * w.missions)
      + (5 * w.verif) + (5 * w.prix) + (10 * w.zone) + (5 * w.competences);
    const score = maxPoids > 0 ? Math.round(obtenu / maxPoids * 10000) / 100 : 0;   // 0–100, comparable entre pros

    const card = fichePublique(ag, o);
    /* 📏 distance affichée UNIQUEMENT si le GPS du pro est frais — sinon on donne une ZONE (jamais une fausse précision) */
    if (distSource === 'gps' && dist != null) {
      card.distKm = distPalier(dist);
      card.distTxt = fmtDist(card.distKm);
    } else {
      card.distKm = null;
      card.distTxt = '';
      card.zoneTxt = memeQuartier ? ('zone ' + (ag.quartier || '')) : ('zone ' + (ag.villeService || ag.ville || ag.villeIci || ''));
    }
    card.distSource = distSource;                 // gps | zone | ville | aucune
    card.distApprox = distSource !== 'gps';
    card.memeVille = memeVille; card.memeQuartier = memeQuartier;
    card.pourquoi = memeQuartier ? 'même quartier que vous'
      : (distSource === 'gps' ? ('à ' + card.distTxt + ' de vous (GPS)')
        : (memeVille ? ('même ville — ' + (ag.villeService || ag.ville || '') + ' (position ancienne)')
          : ('zone d’intervention ' + zoneOfAgent(ag).km + ' km')));
    /* 🧾 du détail lisible pour que le client COMPARE (mêmes critères, même ordre) */
    card.metierFait = metierFait;
    card.competences = competencesPro(ag).slice(0, 4);
    card.compTxt = card.competences.join(' · ');
    card.etaMin = etaMin(dist);
    card.etaTxt = card.etaMin != null ? etaTxt(card.etaMin) : '';
    card.prixIndicatif = baseMin;
    card.prixTxt = baseMin != null ? ('à partir de ' + baseMin.toLocaleString('fr-FR') + ' F') : '';
    card.note = Math.round(nL * 10) / 10;                      // note affichée = note lissée
    card.scorePct = Math.max(0, Math.min(100, Math.round(score)));
    card.raisons = [
      (card.distTxt ? (card.distApprox ? ('≈ ' + card.distTxt) : card.distTxt) : (card.zoneTxt || 'zone à confirmer')),
      (dispo === 'libre' ? '🟢 disponible' : (dispo === 'occupe' ? '🟠 en mission' : (dispo === 'pause' ? '⏸️ en pause' : '⚪ hors ligne'))),
      '⭐ ' + card.note + '/5' + (avis ? (' (' + avis + ' avis)') : ' (nouveau)'),
      (card.missionsDone || 0) + ' prestation(s)',
      card.verifTxt
    ];
    if (card.prixTxt) card.raisons.push(card.prixTxt);
    if (card.etaTxt) card.raisons.push('⏱️ ' + card.etaTxt + ' pour vous rejoindre');
    card._score = score; card._note = card.note; card._done = card.missionsDone;
    card._seen = posAtMs(ag.pos) || (Date.parse(ag.lastSeen || '') || 0);
    liste.push(card);
  }
  /* 🏆 classement : meilleur score d'abord ; à égalité, note, puis prestations, puis contact récent, puis alphabétique (stable) */
  liste.sort((a, b) => (b._score - a._score) || (b._note - a._note) || (b._done - a._done) || (b._seen - a._seen) || String(a.nom).localeCompare(String(b.nom)));
  const limit = Math.max(1, Math.min(100, o.limit || 40));
  const fin = liste.slice(0, limit).map(c => { delete c._score; delete c._note; delete c._done; delete c._seen; return c; });
  return {
    ok: true, service: svc || (svcIds[0] || ''), services: svcIds,
    serviceNom: svcIds.length ? svcIds.map(svcNomP).join(' · ') : '',
    ville: o.ville || '', quartier: o.quartier || '',
    posSource: cSrc, exact: cSrc === 'gps',
    n: fin.length, enLigne: fin.filter(x => x.online).length, libres: fin.filter(x => x.dispo === 'libre').length,
    prixIndicatif: svcIds.length ? Math.min(...svcIds.map(id => svcBaseP(id) || 999999)) || null : null,
    poids: cfg.poids,
    pros: fin, cfg: { distTtlMin: cfg.distTtlMin, zoneTtlMin: cfg.zoneTtlMin, rayonDefautKm: cfg.rayonDefautKm }
  };
}
/* 🔒 Plausibilité d'une position : pays, bornes, et vitesse impossible depuis la dernière position connue.
   On ne fait jamais confiance au GPS envoyé : c'est ici que la position est acceptée ou jetée. */
function posPlausible(ag, lat, lng) {
  if (!validCILatLng(lat, lng)) return false;
  const t = posAtMs(ag && ag.pos);
  if (t && agentHasGps(ag)) {
    const dtH = (Date.now() - t) / 3600000;
    if (dtH > 0.0008) {                       // ~3 secondes minimum entre deux points
      const d = haversineKm(ag.pos.lat, ag.pos.lng, lat, lng);
      if ((d / dtH) > 120) return false;      // > 120 km/h → position rejetée
    }
  }
  return true;
}

/* 🚦 Plafond d'appels par compte / par IP (anti-abus du moteur) */
const rechercheHits = new Map();
function recherchePlafond(cle, max) {
  const now = Date.now();
  const r = rechercheHits.get(cle) || { n: 0, t: now };
  if (now - r.t > 60000) { r.n = 0; r.t = now; }
  r.n++;
  rechercheHits.set(cle, r);
  if (rechercheHits.size > 5000) rechercheHits.clear();
  return r.n <= max;
}

function rankPro(m, ag) {
  const same = !!(m.villeN && villeOfAgent(ag) && m.villeN === villeOfAgent(ag));
  const gps = agentHasGps(ag);
  let dist = null;
  if (gps && typeof m.lat === 'number' && typeof m.lng === 'number') {
    dist = Math.round(haversineKm(m.lat, m.lng, ag.pos.lat, ag.pos.lng) * 10) / 10;
  }
  const rk = reachKm();
  const nation = gpsNationOn();
  const inReach = nation
    ? (gps && dist != null ? dist <= rk : true)
    : (gps && dist != null && dist <= rk);
  let ring = 9;
  if (same && inReach) ring = 1;
  else if (same && gps) ring = 2;
  else if (same && !gps) ring = 3;
  else if (!same && inReach) ring = 4;
  else if (!same && gps) ring = 5;
  else ring = 6;
  return { same, gps, dist, inReach, ring, mode: gps ? 'gps' : 'appel', reachKm: rk, nation };
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
    telAffiche: !r.gps || r.same || !online
  };
}
function broadcastNewMission(m) {
  const exc = m.exclAg || [];
  /* 🎯 demande ciblée : d'abord le pro choisi, puis (s'il ne répond pas) toutes les villes */
  if (m.cible && m.matchScope !== 'all') {
    broadcastMissionCiblee(m);
    setTimeout(() => {
      const live = db.missions.find(x => x.id === m.id);
      if (!live || live.status !== 'pending') return;
      live.matchScope = 'all'; live.exclAg = [...new Set([...(live.exclAg || []), live.cible])];
      live.cibleElargiAt = nowISO();
      saveDb();
      broadcastNewMission(live);
      emitAdmin('mission', '🌍 ' + live.id + ' — le pro choisi n’a pas répondu en 25 s : élargi à tous les pros (métier ' + (SVC_NAMES[live.service] || live.service) + ')');
    }, 25000);
    return;
  }
  const base = publicMissionForAgent(m);
  const targets = missionTargets(m);
  let sent = 0;
  for (const s of targets) {
    if (exc.includes(s.meta && s.meta.agentId)) continue;
    wsSend(s, { type: 'mission_request', mission: Object.assign({}, base, { dist: (typeof s._dist === 'number' ? s._dist : base.dist) }) });
    sent++;
    const agT = db.agents.find(a => a.id === (s.meta && s.meta.agentId));
    if (agT) { agT.demandes = (agT.demandes || 0) + 1; agT.lastDemandAt = nowISO(); }
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
  /* 📣 médias publicitaires (et icônes) : indispensables pour servir une image ou une vidéo de pub */
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf' };
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
/* ═══════════════════════════════════════════════════════════════════════════
   📣 MÉDIAS DE LA PUBLICITÉ — stockés sur le DISQUE (dossier pub/), jamais en base :
   une vidéo en base64 gonflerait db.json et la mémoire du serveur pour rien.
   Le navigateur ne reçoit qu'un chemin /pub/pub-xxxx.jpg → impossible d'inventer
   un autre chemin (le nom est fabriqué par le serveur, jamais par le client).
   ═══════════════════════════════════════════════════════════════════════════ */
const PUB_DIR = path.join(__dirname, 'pub');
try { fs.mkdirSync(PUB_DIR, { recursive: true }); } catch (e) {}
const PUB_IMG_MAX = 3 * 1024 * 1024;      // 3 Mo par image
const PUB_VID_MAX = 12 * 1024 * 1024;     // 12 Mo par vidéo (forfaits mobiles ivoiriens)
const PUB_MEDIA_TYPES = {
  'image/jpeg': { ext: 'jpg', genre: 'image', max: PUB_IMG_MAX },
  'image/png': { ext: 'png', genre: 'image', max: PUB_IMG_MAX },
  'image/webp': { ext: 'webp', genre: 'image', max: PUB_IMG_MAX },
  'image/gif': { ext: 'gif', genre: 'image', max: PUB_IMG_MAX },
  'video/mp4': { ext: 'mp4', genre: 'video', max: PUB_VID_MAX },
  'video/webm': { ext: 'webm', genre: 'video', max: PUB_VID_MAX }
};
/* 🔎 la vraie nature du fichier est vérifiée dans les OCTETS, pas dans la déclaration du navigateur */
function pubTypeReel(buf) {
  if (!buf || buf.length < 12) return null;
  const b = buf, hex = (i) => b[i];
  if (hex(0) === 0xff && hex(1) === 0xd8 && hex(2) === 0xff) return 'image/jpeg';
  if (hex(0) === 0x89 && hex(1) === 0x50 && hex(2) === 0x4e && hex(3) === 0x47) return 'image/png';
  if (b.slice(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.slice(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  if (hex(0) === 0x1a && hex(1) === 0x45 && hex(2) === 0xdf && hex(3) === 0xa3) return 'video/webm';
  return null;
}
/* 🧹 on ne garde jamais un média orphelin sur le disque */
/* 📤 LOT 96 — enregistrer un média (image/vidéo) envoyé par le PDG, avec vérification du contenu réel */
function pubMediaEnregistrer(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([a-z0-9.+\/-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) return { error: 'Fichier illisible — image JPG/PNG/WEBP/GIF ou vidéo MP4/WEBM' };
  const meta = PUB_MEDIA_TYPES[m[1].toLowerCase()];
  if (!meta) return { error: 'Format non autorisé. Images : JPG, PNG, WEBP, GIF. Vidéos : MP4, WEBM.' };
  let buf;
  try { buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64'); } catch (e) { return { error: 'Fichier illisible' }; }
  if (!buf || !buf.length) return { error: 'Fichier vide' };
  if (buf.length > meta.max) return { error: 'Trop lourd : ' + (buf.length / 1048576).toFixed(1) + ' Mo. Maximum ' + (meta.max / 1048576) + ' Mo pour une ' + meta.genre + '.', code: 413 };
  const reel = pubTypeReel(buf);
  if (!reel) return { error: 'Ce fichier n’est pas une vraie image ou vidéo (contenu non reconnu)' };
  if (PUB_MEDIA_TYPES[reel].genre !== meta.genre) return { error: 'Le contenu du fichier ne correspond pas à son type' };
  const nom = 'pub-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + '.' + meta.ext;
  try { fs.writeFileSync(path.join(PUB_DIR, nom), buf); }
  catch (e) { return { error: 'Enregistrement impossible sur le serveur', code: 500 }; }
  return { url: '/pub/' + nom, mediaType: meta.genre, octets: buf.length, mo: Math.round(buf.length / 104857.6) / 10 };
}

function pubSupprimerFichier(url) {
  try {
    const nom = String(url || '').replace(/^\/pub\//, '');
    if (!/^[A-Za-z0-9_.-]{3,80}$/.test(nom)) return;
    const fp = path.join(PUB_DIR, nom);
    if (path.dirname(fp) !== PUB_DIR) return;
    fs.unlink(fp, () => {});
  } catch (e) {}
}
/* corps volumineux : uniquement pour l'upload d'un média (le reste garde la limite serrée de readBody) */
function readBodyBig(req, max) {
  return new Promise(r => {
    let d = ''; let trop = false;
    req.on('data', c => { d += c; if (d.length > (max || 2e7)) { trop = true; req.destroy(); } });
    req.on('end', () => { if (trop) return r(null); try { r(JSON.parse(d || '{}')); } catch (e) { r({}); } });
    req.on('error', () => r(null));
  });
}

function readBody(req) {
  return new Promise(r => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 8e6) req.destroy(); });
    req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch (e) { r({}); } });
  });
}
/* corps BRUT (nécessaire pour vérifier la signature HMAC des webhooks de paiement) */
function readBodyRaw(req) {
  return new Promise(r => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on('end', () => r(d || ''));
  });
}
function agentStats(ag) {
  const done = db.missions.filter(x => x.agentId === ag.id && x.status === 'terminee');
  const gain = done.reduce((s, x) => s + Math.round(x.prixTotal * (1 - feePct())), 0);
  const comm = done.reduce((s, x) => s + Math.round(x.prixTotal * feePct()), 0);
  const notes = done.filter(x => x.note).map(x => x.note);
  return {
    missionsDone: done.length, gain, comm, avis: notes.length,
    rating: notes.length ? notes.reduce((s, n) => s + n, 0) / notes.length : 5.0,
    hist: done.slice(-30).reverse().map(x => ({ id: x.id, service: x.service, quartier: x.quartier, date: x.finishedAt && x.finishedAt.slice(5, 10), montant: x.prixTotal, gain: Math.round(x.prixTotal * (1 - feePct())), comm: Math.round(x.prixTotal * feePct()), note: x.note || 5 }))
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 🎮 FLIP FIZZ · 🪙 KLEAN POINTS · 🎁 RÉCOMPENSES · 🧠 QUIZ · ℹ️ INFOS · 🆘 URGENCE
 Règle d'or : TOUT ce qui donne des points est calculé ICI. Le téléphone ne fait
 que demander — il ne peut ni s'attribuer des points, ni contourner un quota.
 ═══════════════════════════════════════════════════════════════════════════ */
/* ⚠️ une seule source de vérité pour les valeurs par défaut : le bloc de chargement de la base
   (voir « 🎮 FLIP FIZZ · KLEAN POINTS … » plus haut). Ici on lit seulement, on ne redéfinit rien. */
const flipCfg = () => db.flip || {};
/* durée mini honnête : 0 = pas de minimum, plafonnée à 10 min (réglage PDG) */
function flipDureeMin(cfg) {
  const n = parseInt((cfg || flipCfg()).dureeMin, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(600, n)) : 20;
}
const jourKey = () => nowISO().slice(0, 10);
/* limite simple par clé (alertes, ouvertures de partie…) : protège le serveur et les données */
const HITS = new Map();
function hitsAutorises(cle, maxParMinute) {
const t = Date.now();
const r = HITS.get(cle) || { n: 0, t };
if (t - r.t > 60000) { r.n = 0; r.t = t; }
r.n++;
HITS.set(cle, r);
if (HITS.size > 5000) HITS.clear();
return r.n <= (maxParMinute || 30);
}
function ptsCompte(id, creer) {
if (!id) return null;
if (!db.kleanPts[id] && creer) db.kleanPts[id] = { solde: 0, hist: [] };
return db.kleanPts[id] || null;
}
/* 🪙 écriture au registre : jamais de solde « donné » par le client, toujours un mouvement tracé */
function ptsMouvement(clientId, pts, motif, ref) {
const c = ptsCompte(clientId, true);
if (!c) return null;
const n = Math.trunc(Number(pts) || 0);
if (!n) return c;
c.solde = Math.max(0, (c.solde || 0) + n);
c.hist.push({ at: nowISO(), pts: n, motif: String(motif || '').slice(0, 80), ref: String(ref || '').slice(0, 40), solde: c.solde });
if (c.hist.length > 300) c.hist = c.hist.slice(-300);
saveDb();
return c;
}
function ptsSolde(clientId) { const c = ptsCompte(clientId); return c ? (c.solde || 0) : 0; }
function partiesDuJour(clientId) {
const j = jourKey();
return (db.parties || []).filter(p => p.clientId === clientId && (p.at || '').slice(0, 10) === j).length;
}
function flipQuota(clientId) {
const max = Math.max(0, parseInt(flipCfg().partiesJour, 10) || 0);
const faites = clientId ? partiesDuJour(clientId) : 0;
return { max, faites, reste: Math.max(0, max - faites) };
}
function flipPublic(clientId) {
const f = flipCfg();
const q = flipQuota(clientId);
return {
  actif: !!f.actif, accueil: !!f.accueil, titre: f.titre || 'Flip Fizz', desc: f.desc || '',
  url: f.url || '', mediaUrl: f.mediaUrl || '', mediaType: f.mediaType || '', videoUrl: f.videoUrl || '',
  regles: f.regles || '', pointsParPartie: Math.max(1, parseInt(f.pointsParPartie, 10) || 10),
  pointsBonus: Math.max(0, parseInt(f.pointsBonus, 10) || 0), seuilBonus: Math.max(1, parseInt(f.seuilBonus, 10) || 100),
  partiesJour: q.max, partiesFaites: q.faites, partiesRestantes: q.reste,
  dureeMin: flipDureeMin(f),
  recompensesActives: !!f.recompensesActives, connecte: !!clientId, solde: clientId ? ptsSolde(clientId) : 0
};
}
/* 🎁 une récompense est-elle réclamable par ce client ? (le serveur seul en décide) */
function recompEtat(r, clientId) {
const t = Date.now();
const debut = r.debut ? new Date(r.debut).getTime() : 0;
const fin = r.fin ? new Date(r.fin + 'T23:59:59').getTime() : 0;
const pris = (db.parties && r.claims || []).filter(x => clientId && x.clientId === clientId).length;
const stock = (r.stock === null || r.stock === undefined) ? null : Math.max(0, parseInt(r.stock, 10) || 0);
let raison = '';
if (!r.actif) raison = 'Récompense désactivée';
else if (debut && t < debut) raison = 'Pas encore commencée';
else if (fin && t > fin) raison = 'Récompense expirée';
else if (stock !== null && stock <= 0) raison = 'Stock épuisé';
else if (clientId && r.unique !== false && pris > 0) raison = 'Déjà obtenue';
else if (clientId && ptsSolde(clientId) < (parseInt(r.points, 10) || 0)) raison = 'Points insuffisants';
return { dispo: !raison, raison, stock, dejapris: pris };
}
/* ════════ 🧠 QUIZ — 🎯 défi du jour & 🔥 séries : toutes les règles sont ICI (jamais dans le téléphone) ════════ */
function quizCfgQuiz() {
  const c = db.quizCfg || {};
  const nb = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d; };
  return {
    defiActif: c.defiActif !== false, defiPoints: nb(c.defiPoints, 10, 0, 1000),
    seriePas: nb(c.seriePas, 5, 0, 50), serieBonus: nb(c.serieBonus, 5, 0, 500),
    defiQuestionId: String(c.defiQuestionId == null ? '' : c.defiQuestionId).slice(0, 40)
  };
}
/* questions réellement publiées (actives + date de programmation atteinte) */
function quizPubliables() {
  const t = Date.now();
  return (db.quizBank.questions || []).filter(q => q.actif !== false && (!q.debut || new Date(q.debut).getTime() <= t));
}
function quizHash(s) { let h = 0; for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) % 1000003; return h; }
/* la question du jour : la même pour tout le monde pendant 24 h, sans jamais laisser fuiter la réponse */
function quizDefiQuestion() {
  const qs = quizPubliables();
  if (!qs.length) return null;
  /* le PDG peut imposer la question du jour ; sinon tirage stable pour la journée */
  const imposee = quizCfgQuiz().defiQuestionId;
  if (imposee) { const q = qs.find(x => x.id === imposee); if (q) return q; }
  return qs[quizHash(jourKey()) % qs.length];
}
/* 🔥 série en cours = bonnes réponses consécutives les plus récentes */
function quizSerieDe(clientId) {
  const faits = (db.quizPlay || []).filter(x => x.clientId === clientId);
  let n = 0;
  for (let i = faits.length - 1; i >= 0; i--) { if (faits[i].bon) n++; else break; }
  return n;
}
function quizDefiEtat(clientId) {
  const cfg = quizCfgQuiz();
  const q = quizDefiQuestion();
  const etat = (clientId && (db.quizDefi || {})[clientId]) || null;
  const jour = jourKey();
  if (!q) return { actif: false, points: cfg.defiPoints, fait: false, reussi: false, question: null };
  const fait = !!(etat && etat.jour === jour && etat.qid === q.id);
  return {
    actif: cfg.defiActif, jour, points: cfg.defiPoints, fait,
    reussi: !!(etat && etat.jour === jour && etat.reussi),
    /* la question est envoyée SANS la bonne réponse */
    question: (clientId && cfg.defiActif && !fait)
      ? { id: q.id, cat: q.cat || '', niveau: parseInt(q.niveau, 10) || 1, q: q.q,
          choix: (q.choix || []).slice(0, 4), points: parseInt(q.points, 10) || 10 }
      : null
  };
}
function quizStats() {
const play = db.quizPlay || [];
const parJour = {}, parMois = {};
play.forEach(p => { const j = (p.at || '').slice(0, 10); parJour[j] = (parJour[j] || 0) + 1; parMois[j.slice(0, 7)] = (parMois[j.slice(0, 7)] || 0) + 1; });
const clients = new Set(play.map(p => p.clientId));
return {
  questions: (db.quizBank.questions || []).length,
  categories: (db.quizBank.categories || []).length,
  actives: (db.quizBank.questions || []).filter(q => q.actif !== false).length,
  reponses: play.length,
  bonnes: play.filter(p => p.bon).length,
  joueurs: clients.size,
  points: play.reduce((a, p) => a + (p.pts || 0), 0),
  parJour, parMois,
  /* 🎯 défi du jour et 🔥 séries */
  defisJoues: Object.values(db.quizDefi || {}).length,
  defisReussis: Object.values(db.quizDefi || {}).filter(x => x.reussi).length,
  series: Object.values(db.quizSerie || {}).length,
  meilleureSerie: (() => {
    let m = 0; const par = {};
    play.forEach(p => { if (p.bon) { par[p.clientId] = (par[p.clientId] || 0) + 1; m = Math.max(m, par[p.clientId]); } else par[p.clientId] = 0; });
    return m;
  })(),
  jamaisArgent: true,
  cfg: quizCfgQuiz()
};
}
function flipStats() {
const parties = db.parties || [];
const parJour = {}, parMois = {};
parties.forEach(p => {
  const j = (p.at || '').slice(0, 10), m = j.slice(0, 7);
  parJour[j] = (parJour[j] || 0) + 1; parMois[m] = (parMois[m] || 0) + 1;
});
const claims = (db.recompenses || []).reduce((a, r) => a + ((r.claims || []).length), 0);
const restantes = (db.recompenses || []).reduce((a, r) => a + (r.stock === null || r.stock === undefined ? 0 : Math.max(0, parseInt(r.stock, 10) || 0)), 0);
return {
  joueurs: new Set(parties.map(p => p.clientId)).size,
  parties: parties.length,
  partiesGratuitesUtilisees: parties.filter(p => p.gratuite).length,
  pointsDistribues: parties.reduce((a, p) => a + (p.pts || 0), 0),
  recompensesReclamees: claims,
  recompensesRestantes: restantes,
  recompenses: (db.recompenses || []).length,
  pointsEnCirculation: Object.values(db.kleanPts || {}).reduce((a, c) => a + (c.solde || 0), 0),
  partiesRefusees: parties.filter(p => String(p.statut || '').indexOf('refusee') === 0).length,
  dureeSuspecte: parties.filter(p => p.triche).length,
  dureeMin: flipDureeMin(),
  parJour, parMois
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
        if (ag) ag.lastSeen = nowISO();
      }
      if (b.role === 'client' && b.id) {
        const cl = db.clients.find(x => x.id === b.id);
        if (cl) cl.lastSeen = nowISO();
      }
    } catch (e) {}
    return sendJson(res, 200, { ok: true, live: liveHome() });
  }
  if (p === '/api/agents/heartbeat' && req.method === 'POST') {
    const b = await readBody(req);
    const ag = db.agents.find(a => a.id === b.agentId);
    if (!ag || ag.blocked) return sendJson(res, 404, { error: 'pro introuvable' });
    /* 🎫 jeton : la position doit venir du téléphone du pro, pas d'un inconnu qui connaîtrait son identifiant */
    const jt = agentJetonOk(req, ag, b);
    if (!jt.ok) return sendJson(res, 401, { error: 'Jeton du professionnel requis', code: 'jeton' });
    ag.stayOnline = true;
    ag.lastSeen = nowISO();
    let posRefusee = false;
    if (typeof b.lat === 'number' && typeof b.lng === 'number' && !isNaN(b.lat)) {
      if (posPlausible(ag, b.lat, b.lng)) {
        ag.pos = { lat: b.lat, lng: b.lng, at: Date.now(), src: 'heartbeat', acc: typeof b.acc === 'number' ? Math.round(b.acc) : null };
        ag.villeIci = nearestVille(b.lat, b.lng);
      } else posRefusee = true;
    }
    if (b.villeService) ag.villeService = String(b.villeService).slice(0, 60);
    ag.hbCount = (ag.hbCount || 0) + 1;
    ensureNumPro(ag);
    saveDb();
    return sendJson(res, 200, {
      ok: true, online: true, stayOnline: true, reachKm: reachKm(), gpsNationOn: gpsNationOn(),
      lastSeen: ag.lastSeen, demandes: ag.demandes || 0, hb: ag.hbCount,
      posRefusee, numPro: ag.numPro, jeton: jt.nouveau ? ag.jeton : undefined,
      zoneKm: zoneOfAgent(ag).km, dispo: agentDispo(ag)
    });
  }
  /* 🛰️ POSTE DE VEILLE — le pro voit que la connexion tient vraiment (son, GPS, contact serveur) */
  if (p === '/api/agents/veille' && req.method === 'GET') {
    const ag = db.agents.find(a => a.id === String(url.searchParams.get('agentId') || ''));
    if (!ag) return sendJson(res, 404, { error: 'pro introuvable' });
    const jtV = agentJetonOk(req, ag, { jeton: url.searchParams.get('jeton') });   // 🔒 veille de SON téléphone
    if (!jtV.ok) return sendJson(res, 401, { error: 'Jeton du professionnel requis', code: 'jeton' });
    if (jtV.nouveau) saveDb();
    const gpsAge = agentHasGps(ag) ? Math.round((Date.now() - posAtMs(ag.pos)) / 1000) : null;
    const lastAge = ag.lastSeen ? Math.round((Date.now() - Date.parse(ag.lastSeen)) / 1000) : null;
    return sendJson(res, 200, {
      ok: true, online: agentIsOnline(ag), stayOnline: !!ag.stayOnline,
      lastSeen: ag.lastSeen || null, lastSeenAge: lastAge,
      gps: agentHasGps(ag) ? { lat: Math.round(ag.pos.lat * 10000) / 10000, lng: Math.round(ag.pos.lng * 10000) / 10000, age: gpsAge, villeIci: ag.villeIci || nearestVille(ag.pos.lat, ag.pos.lng) } : null,
      sonnerie: (Array.isArray(ag.pushSubs) ? ag.pushSubs.length : 0),
      demandes: ag.demandes || 0, hb: ag.hbCount || 0,
      villeService: ag.villeService || '', ville: ag.ville || '',
      services: Array.isArray(ag.services) ? ag.services : [],
      reachKm: reachKm(), gpsNationOn: gpsNationOn(), now: Date.now(),
      numPro: ensureNumPro(ag), zoneKm: zoneOfAgent(ag).km, dispo: agentDispo(ag), dispoTxt: dispoTxt(agentDispo(ag)),
      gpsFrais: posFreshGps(ag), posAgeMin: isFinite(posAgeMin(ag)) ? Math.round(posAgeMin(ag)) : null
    });
  }
  if (p === '/api/agents/me' && req.method === 'PUT') {
    const b = await readBody(req);
    const ag = db.agents.find(a => a.id === b.agentId);
    if (!ag) return sendJson(res, 404, { error: 'pro introuvable' });
    const jtMe = agentJetonOk(req, ag, b);
    if (!jtMe.ok) return sendJson(res, 401, { error: 'Jeton du professionnel requis', code: 'jeton' });
    if (b.telPro !== undefined) ag.telPro = String(b.telPro).replace(/\D/g, '').slice(0, 16);
    if (b.privacy && typeof b.privacy === 'object') {
      ag.privacy = ag.privacy || {};
      if (b.privacy.publierTel !== undefined) ag.privacy.publierTel = !!b.privacy.publierTel;
      if (b.privacy.hideQuartier !== undefined) ag.privacy.hideQuartier = !!b.privacy.hideQuartier;
      if (b.privacy.publieFiche !== undefined) ag.privacy.publieFiche = !!b.privacy.publieFiche;
    }
    if (b.zone && typeof b.zone === 'object') {
      ag.zone = ag.zone || {};
      if (!isNaN(parseInt(b.zone.km, 10))) ag.zone.km = Math.max(1, Math.min(800, parseInt(b.zone.km, 10)));
      if (Array.isArray(b.zone.villes)) ag.zone.villes = b.zone.villes.map(v => String(v).slice(0, 60)).filter(Boolean).slice(0, 20);
    }
    if (b.pause !== undefined) ag.pause = !!b.pause;
    if (b.nom && String(b.nom).trim().length >= 2) ag.nom = String(b.nom).trim().slice(0, 80);
    if (b.quartier !== undefined) ag.quartier = String(b.quartier).slice(0, 60);
    if (b.tel) ag.tel = ag.tel1 = String(b.tel).replace(/\D/g, '').slice(0, 16);
    if (b.ville !== undefined) ag.ville = String(b.ville).slice(0, 60);
    if (b.villeService !== undefined) ag.villeService = String(b.villeService).slice(0, 60);
    ensureNumPro(ag);
    saveDb();
    return sendJson(res, 200, {
      ok: true, villeService: ag.villeService || ag.ville || '', numPro: ag.numPro,
      zoneKm: zoneOfAgent(ag).km, privacy: privacyOf(ag), telPro: ag.telPro || '', pause: !!ag.pause,
      jeton: jtMe.nouveau ? ag.jeton : undefined
    });
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
    const cards = (db.agents || []).filter(a => !a.blocked && (a.status || 'approved') === 'approved' && agentIsOnline(a)).map(a => publicMatchCard(a, m, true));
    cards.sort((a, b) => (a.ring - b.ring) || ((a.distKm || 99) - (b.distKm || 99)));
    const same = cards.filter(x => x.sameCity);
    const other = cards.filter(x => !x.sameCity);
    return sendJson(res, 200, {
      ok: true, ville, scope: m.matchScope || 'city',
      nOnline: cards.length, nSame: same.length, nOther: other.length,
      sameCity: same.slice(0, 40), otherCities: other.slice(0, 40), service: svc
    });
  }



/* 🔎 RECHERCHE INTELLIGENTE — proximité GPS + service + disponibilité + zone d'intervention */
  if (p === '/api/recherche' && req.method === 'GET') {
    const cfg = matchCfg();
    const cli = findClientByToken(req);
    const ip = req.socket.remoteAddress || '?';
    const cle = (cli && cli.id) || ip;
    if (!recherchePlafond('r:' + cle, cfg.maxRecherchesMin))
      return sendJson(res, 429, { error: 'Trop de recherches en une minute — patientez un instant', code: 'plafond' });
    const service = String(url.searchParams.get('service') || '').slice(0, 40);
    const q = String(url.searchParams.get('q') || '').slice(0, 120);
    const ville = String(url.searchParams.get('ville') || (cli && cli.ville) || '').slice(0, 60);
    const quartier = String(url.searchParams.get('quartier') || (cli && cli.quartier) || '').slice(0, 60);
    const lat = parseFloat(url.searchParams.get('lat'));
    const lng = parseFloat(url.searchParams.get('lng'));
    const lim = parseInt(url.searchParams.get('limit'), 10) || 40;
    const horsLigne = url.searchParams.get('horsLigne') === '1';
    const zoneElargie = Math.max(0, Math.min(200, parseFloat(url.searchParams.get('zoneElargie')) || 0));

    /* 📍 LIEU DE PRESTATION — priorité absolue : on cherche autour de l'endroit indiqué,
       pas autour du client. Trois cas : ma position (GPS) · ma ville · un autre lieu saisi. */
    const lieuMode = String(url.searchParams.get('lieuMode') || '').slice(0, 12);
    const lieuTxt  = String(url.searchParams.get('lieu') || '').slice(0, 80);
    const lieuVilleQ = String(url.searchParams.get('lieuVille') || '').slice(0, 60);
    const lieuQuartQ = String(url.searchParams.get('lieuQuartier') || '').slice(0, 60);
    const lieuLat = parseFloat(url.searchParams.get('lieuLat'));
    const lieuLng = parseFloat(url.searchParams.get('lieuLng'));
    let prest = null;                       // lieu de prestation résolu
    let posSource = 'ville', lieuTxtFinal = '';
    if (lieuMode === 'autre') {
      prest = resoudreLieu(lieuTxt, lieuVilleQ, lieuQuartQ);
      if (!prest || !prest.ok) {
        const g = Number.isFinite(lieuLat) && validCILatLng(lieuLat, lieuLng) ? { lat: lieuLat, lng: lieuLng } : null;
        if (g) prest = { ok: true, ville: lieuVilleQ || '', quartier: lieuQuartQ || '', lat: g.lat, lng: g.lng, precis: true, texte: lieuTxt || lieuVilleQ };
      }
      if (prest && prest.ok) { posSource = 'prestation'; lieuTxtFinal = prest.texte; }
      else { prest = null; posSource = 'ville'; lieuTxtFinal = ''; }
    } else if (lieuMode === 'moi') {
      posSource = Number.isFinite(lat) && validCILatLng(lat, lng) ? 'gps' : 'ville';
      lieuTxtFinal = posSource === 'gps' ? 'ma position actuelle' : ('ma ville' + (ville ? (' (' + ville + ')') : ''));
    } else if (lieuMode === 'ville') {
      posSource = 'ville';
      lieuTxtFinal = lieuVilleQ || ville || '';
    } else {
      /* 🧩 ancien format (applications déjà installées) : des coordonnées valides = recherche autour du client */
      posSource = Number.isFinite(lat) && validCILatLng(lat, lng) ? 'gps' : 'ville';
      lieuTxtFinal = posSource === 'gps' ? 'ma position actuelle' : (ville || '');
    }
    const villeR = (prest && prest.ok && prest.ville) ? prest.ville : ((lieuMode === 'ville' && lieuVilleQ) ? lieuVilleQ : ville);
    /* ⚠️ le quartier DU CLIENT n'a rien à faire ici quand la prestation est ailleurs */
    const quartierR = (prest && prest.ok) ? String(prest.quartier || '') : quartier;
    const geo = (prest && prest.ok)
      ? { ville: villeR, quartier: quartierR, lat: prest.lat, lng: prest.lng }
      : { ville: villeR, quartier: quartierR,
          lat: (Number.isFinite(lat) && validCILatLng(lat, lng) && (lieuMode === 'moi' || !lieuMode)) ? lat : null,
          lng: (Number.isFinite(lng) && validCILatLng(lat, lng) && (lieuMode === 'moi' || !lieuMode)) ? lng : null };

    /* 🧠 COMPRÉHENSION de la demande : langage naturel, liste de métiers, ou code pro */
    const comp = resoudreRecherche(q || service || '');
    if (comp.type === 'kp') {
      /* 🎫 identifiant SECONDAIRE : le code amène droit à son pro, où qu'il soit */
      const ag = db.agents.find(a => a.numPro && a.numPro.replace(/\s/g, '').toUpperCase() === comp.code.replace(/\s/g, '').toUpperCase());
      const introuvable = () => {
        shieldLog(ip, 'kp-inconnu', '/api/recherche', comp.code, 2);
        return sendJson(res, 404, { error: 'Ce code professionnel ne correspond à aucun professionnel actif', code: 'inconnu', mode: 'kp' });
      };
      if (!ag || ag.blocked || (ag.status || 'approved') !== 'approved') return introuvable();
      const pv = privacyOf(ag);
      if (!pv.publieFiche) return sendJson(res, 403, { error: 'Ce professionnel ne rend pas sa fiche publique', code: 'prive', mode: 'kp' });
      const via = recherchePro({ ville: villeR, quartier: quartierR, lat: geo.lat, lng: geo.lng, inclureHorsLigne: true, limit: 200 });
      let card = (via.pros || []).find(x => x.id === ag.id);
      let horsZone = false;
      if (!card) { card = fichePublique(ag, {}); horsZone = true; }   // hors zone : fiche consultable, marquée
      card.recent = db.missions.filter(m => m.agentId === ag.id && m.status === 'terminee')
        .slice(-4).reverse().map(m => ({ service: SVC_NAMES[m.service] || m.service, quand: (m.finishedAt || m.createdAt || '').slice(0, 10) }));
      emitAdmin('recherche', '🎫 Code ' + comp.code + ' consulté (' + card.nom + ')');
      return sendJson(res, 200, { ok: true, mode: 'kp', code: comp.code, compris: comp.compris, pro: card, horsZone, enLigne: !!card.online, posSource: via.posSource });
    }
    if (comp.type === 'inconnu') {
      /* on ne devine pas : on dit honnêtement que la phrase n'a pas été comprise */
      return sendJson(res, 200, { ok: true, mode: 'inconnu', compris: '', q, pros: [], n: 0,
        suggestions: (comp.suggestions || []).length ? comp.suggestions : ['maison', 'clim', 'plomberie', 'cours'],
        aide: 'Dites-nous le service en un mot (ménage, plomberie, cours…), choisissez un métier ci-dessous, ou passez par une demande sur mesure.' });
    }
    const resu = recherchePro(Object.assign({}, geo, {
      service: service || '', services: (comp.ids && comp.ids.length) ? comp.ids : undefined,
      inclureHorsLigne: horsLigne, limit: lim, zoneElargie, q
    }));
    resu.mode = 'service';
    resu.compris = comp.compris || '';
    resu.q = q;
    resu.posSource = posSource;
    resu.lieuTxt = lieuTxtFinal;
    resu.lieuOk = !(lieuMode === 'autre' && !(prest && prest.ok));
    resu.lieu = prest && prest.ok ? { ville: prest.ville, quartier: prest.quartier, precis: !!prest.precis, texte: prest.texte } : null;
    resu.zoneElargie = zoneElargie;
    resu.suggestions = comp.suggestions || [];
    resu.quartier = resu.quartier || quartierR;
    resu.client = cli ? { id: cli.id, nom: cli.nom } : null;
    return sendJson(res, 200, resu);
  }

  /* ════════ 🎮 FLIP FIZZ — configuration publique (le jeu est INVISIBLE par défaut) ════════ */
  if (p === '/api/flip' && req.method === 'GET') {
    const cli = findClientByToken(req);
    return sendJson(res, 200, { ok: true, flip: flipPublic(cli && cli.id) });
  }
  /* ouvrir une partie : le SERVEUR vérifie le quota et remet un jeton de partie à usage unique */
  if (p === '/api/flip/ouvrir' && req.method === 'POST') {
    const cli = findClientByToken(req);
    if (!cli) return sendJson(res, 401, { error: 'Connectez-vous pour jouer et gagner des Klean Points', code: 'connexion' });
    const f = flipCfg();
    if (!f.actif) return sendJson(res, 403, { error: 'Le jeu est désactivé pour le moment', code: 'inactif' });
    const q = flipQuota(cli.id);
    if (q.reste <= 0) return sendJson(res, 403, { error: 'Vos ' + q.max + ' parties gratuites du jour sont utilisées. Revenez demain !', code: 'quota', reste: 0 });
    const sess = { id: uid('FF'), clientId: cli.id, at: nowISO(), t0: Date.now(), expireAt: Date.now() + 30 * 60000, use: false, ip: clientIp(req) };
    db.flipSess.push(sess);
    if (db.flipSess.length > 3000) db.flipSess = db.flipSess.slice(-2000);
    saveDb();
    return sendJson(res, 200, { ok: true, session: sess.id, expireDans: 1800, reste: q.reste - 1, url: f.url || '' });
  }
  /* fin de partie : le serveur plafonne, vérifie la durée, et n'accepte JAMAIS deux fois la même session */
  if (p === '/api/flip/fin' && req.method === 'POST') {
    const cli = findClientByToken(req);
    if (!cli) return sendJson(res, 401, { error: 'Connexion requise', code: 'connexion' });
    const b = await readBody(req);
    const sess = (db.flipSess || []).find(x => x.id === String(b.session || ''));
    if (!sess || sess.clientId !== cli.id) return sendJson(res, 400, { error: 'Partie inconnue — relancez le jeu', code: 'session' });
    if (sess.use) return sendJson(res, 409, { error: 'Cette partie a déjà été enregistrée', code: 'deja' });
    if (Date.now() > sess.expireAt) { sess.use = true; saveDb(); return sendJson(res, 410, { error: 'Partie expirée (plus de 30 minutes) — aucune point compté', code: 'expiree' }); }
    const f = flipCfg();
    const dureeMin = flipDureeMin(f);
    const score = Math.max(0, Math.min(99999, parseInt(b.score, 10) || 0));
    /* 🛡️ ANTI-TRICHE : la durée est celle MESURÉE PAR LE SERVEUR (sess.t0).
       La durée annoncée par le téléphone ne peut pas la rallonger ; si elle est plus grande,
       on note le mensonge et on garde la durée réelle. */
    const t0 = parseInt(sess.t0, 10) || Date.parse(sess.at) || Date.now();
    const reelleSec = Math.max(0, Math.min(3600, Math.floor((Date.now() - t0) / 1000)));
    const declareeSec = Math.max(0, Math.min(3600, parseInt(b.dureeSec, 10) || 0));
    const dureeSec = Math.min(declareeSec || reelleSec, reelleSec);
    const mensonge = declareeSec > reelleSec + 5 ? 'duree' : '';
    sess.use = true;
    /* 🛡️ ANTI-FRAUDE : durée minimale, plafond de points, une seule récompense par session */
    if (dureeSec < dureeMin || (mensonge && dureeMin > 0)) {
      db.parties.push({ id: uid('PA'), clientId: cli.id, at: nowISO(), score, dureeSec, declareeSec, triche: mensonge, pts: 0, statut: 'refusee-duree', gratuite: true, ip: clientIp(req) });
      saveDb();
      return sendJson(res, 200, { ok: true, pts: 0, refus: 'Partie trop courte pour compter (minimum ' + dureeMin + ' s) — la durée est vérifiée par le serveur' });
    }
    let pts = Math.min(Math.max(1, parseInt(f.pointsParPartie, 10) || 10), Math.max(1, Math.round(score / 10)));
    let bonus = 0;
    if (score >= (parseInt(f.seuilBonus, 10) || 100) && (parseInt(f.pointsBonus, 10) || 0) > 0) bonus = parseInt(f.pointsBonus, 10) || 0;
    if (db.parties.filter(x => x.clientId === cli.id && (x.at || '').slice(0, 10) === jourKey()).length >= (parseInt(f.partiesJour, 10) || 0)) {
      pts = 0; bonus = 0;
      db.parties.push({ id: uid('PA'), clientId: cli.id, at: nowISO(), score, dureeSec, pts: 0, statut: 'refusee-quota', gratuite: true, ip: clientIp(req) });
      saveDb();
      return sendJson(res, 200, { ok: true, pts: 0, refus: 'Quota du jour atteint' });
    }
    const total = pts + bonus;
    db.parties.push({ id: uid('PA'), clientId: cli.id, at: nowISO(), score, dureeSec, pts: total, statut: 'enregistree', gratuite: true, ip: clientIp(req) });
    if (total > 0) ptsMouvement(cli.id, total, 'Flip Fizz — score ' + score + (bonus ? ' (bonus +' + bonus + ')' : ''), 'FF');
    saveDb();
    const c = ptsCompte(cli.id);
    return sendJson(res, 200, { ok: true, pts: total, bonus, solde: c ? c.solde : 0, score, reste: flipQuota(cli.id).reste });
  }
  /* ════════ 🪙 KLEAN POINTS — solde, historique, récompenses obtenues ════════ */
  if (p === '/api/points' && req.method === 'GET') {
    const cli = findClientByToken(req);
    if (!cli) return sendJson(res, 401, { error: 'Connectez-vous', code: 'connexion' });
    const c = ptsCompte(cli.id, true);
    const parties = (db.parties || []).filter(x => x.clientId === cli.id).slice(-40).reverse();
    const obtenues = [];
    (db.recompenses || []).forEach(r => (r.claims || []).forEach(cl => { if (cl.clientId === cli.id) obtenues.push({ nom: r.nom, at: cl.at, points: r.points, code: cl.code }); }));
    return sendJson(res, 200, {
      ok: true, solde: c.solde || 0, hist: (c.hist || []).slice(-60).reverse(), parties,
      obtenues, jamaisArgent: true,
      regle: 'Les Klean Points ne sont pas convertibles en argent liquide : ils servent uniquement à obtenir des récompenses Klean.'
    });
  }
  /* ════════ 🎁 RÉCOMPENSES — liste éligible + échange sécurisé ════════ */
  if (p === '/api/recompenses' && req.method === 'GET') {
    const cli = findClientByToken(req);
    const solde = cli ? ptsSolde(cli.id) : 0;
    const liste = (db.recompenses || []).map(r => {
      const e = recompEtat(r, cli && cli.id);
      return { id: r.id, nom: r.nom, desc: r.desc, mediaUrl: r.mediaUrl || '', points: r.points || 0,
        stock: e.stock, debut: r.debut || '', fin: r.fin || '', actif: !!r.actif, dispo: e.dispo, raison: e.raison, unique: r.unique !== false };
    }).filter(r => r.actif);
    return sendJson(res, 200, { ok: true, liste, solde, connecte: !!cli });
  }
  if (p === '/api/recompenses/echanger' && req.method === 'POST') {
    const cli = findClientByToken(req);
    if (!cli) return sendJson(res, 401, { error: 'Connectez-vous', code: 'connexion' });
    if (!flipCfg().recompensesActives) return sendJson(res, 403, { error: 'Le programme de récompenses est en pause' });
    const b = await readBody(req);
    const r = (db.recompenses || []).find(x => x.id === String(b.id || ''));
    if (!r) return sendJson(res, 404, { error: 'Récompense introuvable' });
    const e = recompEtat(r, cli.id);
    if (!e.dispo) return sendJson(res, 400, { error: e.raison || 'Indisponible', code: 'indispo' });
    const pts = Math.max(1, parseInt(r.points, 10) || 0);
    if (ptsSolde(cli.id) < pts) return sendJson(res, 400, { error: 'Points insuffisants' });
    r.claims = r.claims || [];
    r.claims.push({ clientId: cli.id, at: nowISO(), points: pts, code: uid('RC') });
    if (r.stock !== null && r.stock !== undefined) r.stock = Math.max(0, (parseInt(r.stock, 10) || 0) - 1);
    ptsMouvement(cli.id, -pts, 'Récompense obtenue : ' + (r.nom || ''), 'RC');
    auditLog('recompense_echangee', { client: cli.nom, id: cli.id, recompense: r.nom, points: pts });
    emitAdmin('annonce', '🎁 ' + (cli.nom || 'Un client') + ' a obtenu « ' + (r.nom || '') + ' » (' + pts + ' pts)');
    saveDb();
    return sendJson(res, 200, { ok: true, solde: ptsSolde(cli.id), code: r.claims[r.claims.length - 1].code, resteStock: r.stock });
  }
  /* ════════ 🧠 QUIZ PERMANENT — banque gérée par le HQ, correction CÔTÉ SERVEUR ════════ */
  if (p === '/api/quiz/banque' && req.method === 'GET') {
    const cli = findClientByToken(req);
    const cfgQz = quizCfgQuiz();
    const cats = (db.quizBank.categories || []).filter(c => c.actif !== false);
    const faits = cli ? (db.quizPlay || []).filter(x => x.clientId === cli.id) : [];
    const faitIds = new Set(faits.map(x => x.qid));
    const parCat = {};
    cats.forEach(c => {
      const qs = (db.quizBank.questions || []).filter(q => q.cat === c.id && q.actif !== false);
      parCat[c.id] = { total: qs.length, faits: qs.filter(q => faitIds.has(q.id)).length, points: qs.reduce((a, q) => a + (parseInt(q.points, 10) || 10), 0) };
    });
    return sendJson(res, 200, {
      ok: true,
      categories: cats.map(c => ({ id: c.id, nom: c.nom, ic: c.ic || '🧠', desc: c.desc || '' })),
      progression: parCat,
      mesReponses: faits.length, mesBonnes: faits.filter(x => x.bon).length,
      mesPoints: faits.reduce((a, x) => a + (x.pts || 0), 0),
      solde: cli ? ptsSolde(cli.id) : 0,
      /* 🔥 série en cours, 🎯 défi du jour et 📜 historique des résultats */
      serie: cli ? quizSerieDe(cli.id) : 0,
      seriePas: cfgQz.seriePas, serieBonus: cfgQz.serieBonus,
      defi: quizDefiEtat(cli ? cli.id : null),
      hist: cli ? faits.slice(-20).reverse().map(x => {
        const q = (db.quizBank.questions || []).find(y => y.id === x.qid) || {};
        const c = (db.quizBank.categories || []).find(y => y.id === x.cat) || {};
        return { qid: x.qid, q: String(q.q || '').slice(0, 90), cat: c.nom || '', bon: !!x.bon, pts: x.pts || 0, at: x.at || '' };
      }) : []
    });
  }
  if (p === '/api/quiz/questions' && req.method === 'GET') {
    const cat = String(url.searchParams.get('cat') || '').slice(0, 40);
    const niv = parseInt(url.searchParams.get('niveau'), 10) || 0;
    const cli = findClientByToken(req);
    const faitIds = new Set((db.quizPlay || []).filter(x => cli && x.clientId === cli.id).map(x => x.qid));
    const t = Date.now();
    const qs = (db.quizBank.questions || [])
      .filter(q => q.actif !== false && !faitIds.has(q.id))
      .filter(q => !cat || q.cat === cat)
      .filter(q => !niv || (parseInt(q.niveau, 10) || 1) === niv)
      .filter(q => !q.debut || new Date(q.debut).getTime() <= t)
      .slice(0, 12)
      .map(q => ({ id: q.id, cat: q.cat, niveau: parseInt(q.niveau, 10) || 1, q: q.q, choix: (q.choix || []).slice(0, 4), points: parseInt(q.points, 10) || 10 }));
    return sendJson(res, 200, { ok: true, questions: qs, restantes: qs.length });
  }
  if (p === '/api/quiz/repondre' && req.method === 'POST') {
    const cli = findClientByToken(req);
    if (!cli) return sendJson(res, 401, { error: 'Connectez-vous pour gagner des points', code: 'connexion' });
    const b = await readBody(req);
    const q = (db.quizBank.questions || []).find(x => x.id === String(b.qid || '') && x.actif !== false);
    if (!q) return sendJson(res, 404, { error: 'Question introuvable' });
    if ((db.quizPlay || []).some(x => x.clientId === cli.id && x.qid === q.id))
      return sendJson(res, 409, { error: 'Vous avez déjà répondu à cette question', code: 'deja' });
    const choix = parseInt(b.choix, 10);
    const bonne = parseInt(q.bonne, 10) || 0;
    const bon = choix === bonne;
    const pts = bon ? (parseInt(q.points, 10) || 10) : 0;
    const cfgQz = quizCfgQuiz();
    const jour = jourKey();
    /* 🎯 défi du jour : une seule fois par jour et par client (impossible à rejouer depuis le téléphone) */
    const defiQ = quizDefiQuestion();
    let bonusDefi = 0, defiFait = false;
    if (defiQ && defiQ.id === q.id && cfgQz.defiActif) {
      const etat = (db.quizDefi || {})[cli.id] || null;
      const dejaFait = !!(etat && etat.jour === jour);
      if (!dejaFait) { db.quizDefi[cli.id] = { jour, qid: q.id, reussi: bon, at: nowISO() }; defiFait = true; }
      if (!dejaFait && bon) bonusDefi = cfgQz.defiPoints;
    }
    db.quizPlay.push({ id: uid('QP'), clientId: cli.id, nom: cli.nom || '', qid: q.id, cat: q.cat || '', bon, pts, at: nowISO() });
    if (db.quizPlay.length > 5000) db.quizPlay = db.quizPlay.slice(-4000);
    /* 🔥 série : une prime par palier atteint, et une seule fois par jour */
    let bonusSerie = 0;
    const serie = quizSerieDe(cli.id);
    if (bon && cfgQz.seriePas >= 2 && cfgQz.serieBonus > 0 && serie >= cfgQz.seriePas && serie % cfgQz.seriePas === 0) {
      const s0 = (db.quizSerie || {})[cli.id] || null;
      if (!s0 || s0.jour !== jour || (parseInt(s0.dernierPalier, 10) || 0) < serie) {
        bonusSerie = cfgQz.serieBonus;
        db.quizSerie[cli.id] = { jour, dernierPalier: serie, at: nowISO() };
      }
    }
    if (pts) ptsMouvement(cli.id, pts, 'Quiz Klean — bonne réponse', 'QZ');
    if (bonusDefi) ptsMouvement(cli.id, bonusDefi, 'Quiz Klean — défi du jour', 'QD');
    if (bonusSerie) ptsMouvement(cli.id, bonusSerie, 'Quiz Klean — série de ' + serie + ' bonnes réponses', 'QS');
    saveDb();
    return sendJson(res, 200, {
      ok: true, bon, bonne, pts, bonusDefi, bonusSerie, pointsTotaux: pts + bonusDefi + bonusSerie,
      serie, defiFait, defiPoints: cfgQz.defiPoints, seriePas: cfgQz.seriePas,
      solde: ptsSolde(cli.id), explication: q.expl || ''
    });
  }
  if (p === '/api/quiz/classement' && req.method === 'GET') {
    const m = {};
    (db.quizPlay || []).forEach(x => { if (!m[x.clientId]) m[x.clientId] = { nom: x.nom || 'Client Klean', pts: 0, bonnes: 0, n: 0 }; m[x.clientId].pts += x.pts || 0; m[x.clientId].n++; if (x.bon) m[x.clientId].bonnes++; });
    const liste = Object.entries(m).map(([id, v]) => ({ id, nom: v.nom, pts: v.pts, bonnes: v.bonnes, reponses: v.n })).sort((a, b) => b.pts - a.pts || b.bonnes - a.bonnes).slice(0, 20);
    return sendJson(res, 200, { ok: true, liste, soldeGlobal: Object.values(db.kleanPts || {}).reduce((a, c) => a + (c.solde || 0), 0) });
  }
  /* ════════ ℹ️ INFORMATIONS — contenus publiés par le HQ, par catégories ════════ */
  if (p === '/api/infos' && req.method === 'GET') {
    const cli = findClientByToken(req);
    const role = String(url.searchParams.get('role') || 'client');
    const t = Date.now();
    const liste = (db.infos || [])
      .filter(x => x.actif !== false)
      .filter(x => !x.debut || new Date(x.debut).getTime() <= t)
      .filter(x => !x.fin || new Date(x.fin + 'T23:59:59').getTime() >= t)
      .filter(x => role === 'pro' ? x.cible !== 'client' : x.cible !== 'pro')
      .sort((a, b) => (b.epin ? 1 : 0) - (a.epin ? 1 : 0) || String(b.at || '').localeCompare(String(a.at || '')))
      .map(x => ({ id: x.id, cat: x.cat, titre: x.titre, texte: x.texte, ic: x.ic || 'ℹ️', at: x.at, epin: !!x.epin, par: x.par || 'Klean' }));
    const cats = [...new Set(liste.map(x => x.cat))];
    return sendJson(res, 200, { ok: true, liste, categories: cats, vu: cli ? (db.prefs[cli.id] || {}).infosVues || [] : [] });
  }
  /* ════════ 🆘 URGENCE — alertes (position UNIQUEMENT si le client l'autorise) ════════ */
  if (p === '/api/urgence/alerte' && req.method === 'POST') {
    const cli = findClientByToken(req);
    const b = await readBody(req);
    const ip = clientIp(req);
    const cle = cli ? cli.id : ip;
    if (!hitsAutorises('urg:' + cle, 5)) return sendJson(res, 429, { error: 'Trop d’alertes envoyées — patientez une minute', code: 'plafond' });
    const motif = String(b.motif || 'Urgence').slice(0, 120);
    const partage = !!b.partage;
    let lat = parseFloat(b.lat), lng = parseFloat(b.lng);
    if (!partage || !validCILatLng(lat, lng)) { lat = null; lng = null; }
    const rec = {
      id: uid('UR'), at: nowISO(), clientId: cli ? cli.id : null, nom: cli ? (cli.nom || '') : 'Visiteur',
      tel: cli ? (cli.tel || '') : '', motif, lat, lng, partage, statut: 'nouvelle',
      appels: [{ at: nowISO(), service: String(b.service || '').slice(0, 20) }]
    };
    db.urgHist.push(rec);
    if (db.urgHist.length > 2000) db.urgHist = db.urgHist.slice(-1500);
    saveDb();
    emitAdmin('urgence', '🆘 ' + (rec.nom || 'Client') + ' — ' + motif + (partage && lat ? ' (position partagée)' : ''));
    return sendJson(res, 200, { ok: true, id: rec.id, at: rec.at });
  }
  if (p === '/api/urgence/historique' && req.method === 'GET') {
    const cli = findClientByToken(req);
    if (!cli) return sendJson(res, 401, { error: 'Connexion requise' });
    const liste = (db.urgHist || []).filter(x => x.clientId === cli.id).slice(-30).reverse()
      .map(x => ({ id: x.id, at: x.at, motif: x.motif, statut: x.statut, partage: !!x.partage }));
    return sendJson(res, 200, { ok: true, liste });
  }
  if (p === '/api/urgence/contacts' && req.method === 'GET') {
    const cli = findClientByToken(req);
    return sendJson(res, 200, { ok: true, contacts: (cli && db.urgContacts[cli.id]) || [] });
  }
  if (p === '/api/urgence/contacts' && req.method === 'POST') {
    const cli = findClientByToken(req);
    if (!cli) return sendJson(res, 401, { error: 'Connectez-vous pour enregistrer vos contacts' });
    const b = await readBody(req);
    const nom = String(b.nom || '').trim().slice(0, 40);
    const tel = String(b.tel || '').replace(/\D/g, '').slice(0, 15);
    if (nom.length < 2 || tel.length < 8) return sendJson(res, 400, { error: 'Nom et téléphone valides requis' });
    const liste = db.urgContacts[cli.id] = db.urgContacts[cli.id] || [];
    if (liste.length >= 5) return sendJson(res, 400, { error: '5 contacts maximum' });
    liste.push({ id: uid('UC'), nom, tel, lien: String(b.lien || '').slice(0, 30) });
    saveDb();
    return sendJson(res, 200, { ok: true, contacts: liste });
  }
  if (p === '/api/urgence/contacts/suppr' && req.method === 'POST') {
    const cli = findClientByToken(req);
    if (!cli) return sendJson(res, 401, { error: 'Connexion requise' });
    const b = await readBody(req);
    db.urgContacts[cli.id] = (db.urgContacts[cli.id] || []).filter(x => x.id !== String(b.id || ''));
    saveDb();
    return sendJson(res, 200, { ok: true, contacts: db.urgContacts[cli.id] });
  }
  /* ════════ ⚙️ OPTIONS — préférences du client (stockées sur le compte) ════════ */
  if (p === '/api/prefs' && req.method === 'GET') {
    const cli = findClientByToken(req);
    const defaut = { langue: 'fr', notif: true, sons: true, vibre: true, tailleTexte: 'normal', animReduites: false,
      partagePosition: true, partageNumero: false, masquerQuartier: false, pub: true, affichageCompact: false };
    if (!cli) return sendJson(res, 200, { ok: true, prefs: defaut, connecte: false });
    db.prefs[cli.id] = Object.assign(defaut, db.prefs[cli.id] || {});
    return sendJson(res, 200, { ok: true, prefs: db.prefs[cli.id], connecte: true });
  }
  if (p === '/api/prefs' && req.method === 'POST') {
    const cli = findClientByToken(req);
    if (!cli) return sendJson(res, 401, { error: 'Connectez-vous pour enregistrer vos préférences' });
    const b = await readBody(req);
    const p0 = db.prefs[cli.id] = Object.assign(db.prefs[cli.id] || {}, {});
    const bools = ['notif', 'sons', 'vibre', 'animReduites', 'partagePosition', 'partageNumero', 'masquerQuartier', 'pub', 'affichageCompact'];
    bools.forEach(k => { if (b[k] !== undefined) p0[k] = !!b[k]; });
    if (b.tailleTexte !== undefined) p0.tailleTexte = ['petit', 'normal', 'grand', 'tresgrand'].includes(b.tailleTexte) ? b.tailleTexte : 'normal';
    if (b.langue !== undefined) p0.langue = ['fr', 'en'].includes(b.langue) ? b.langue : 'fr';
    if (Array.isArray(b.infosVues)) p0.infosVues = b.infosVues.slice(0, 200).map(x => String(x).slice(0, 30));
    saveDb();
    return sendJson(res, 200, { ok: true, prefs: p0 });
  }
  /* ════════ 👤 COMPTE — fiche d'activité : ce que l'utilisateur peut vérifier lui-même ════════ */
  if (p === '/api/compte/activite' && req.method === 'GET') {
    const cli = findClientByToken(req);
    if (!cli) return sendJson(res, 401, { error: 'Connectez-vous', code: 'connexion' });
    const mes = (db.missions || []).filter(m => m.clientId === cli.id);
    const c = ptsCompte(cli.id);
    return sendJson(res, 200, {
      ok: true,
      profil: {
        nom: cli.nom || '', tel: cli.tel || '', quartier: cli.quartier || '', ville: cli.ville || '',
        mail: cli.mail || '', photo: !!cli.photo, creeLe: (cli.createdAt || '').slice(0, 10),
        desactive: !!cli.desactive, suppressionDemandee: !!cli.suppressionDemandee
      },
      activite: {
        missions: mes.length,
        missionsTerminees: mes.filter(x => x.status === 'terminee').length,
        derniere: mes.length ? { service: mes[mes.length - 1].service, at: mes[mes.length - 1].createdAt } : null,
        paiements: mes.filter(x => x.paiement && ['reussi', 'declare', 'en_attente'].includes(x.paiement.statut)).length,
        points: c ? (c.solde || 0) : 0,
        avis: mes.filter(x => x.note).length
      },
      connexions: {
        derniere: cli.lastLogin || null, appareil: cli.lastAppareil || '',
        actuel: String(req.headers['user-agent'] || '').slice(0, 120),
        note: 'Un seul accès par appareil : changer le mot de passe déconnecte immédiatement les autres appareils.'
      },
      droits: { export: true, desactivation: true, suppression: true, assistance: true }
    });
  }

  /* ════════ 👤 COMPTE — désactivation / demande de suppression (jamais sans mot de passe) ════════ */
  if (p === '/api/compte/statut' && req.method === 'POST') {
    const cli = findClientByToken(req);
    if (!cli) return sendJson(res, 401, { error: 'Connexion requise' });
    const b = await readBody(req);
    const type = String(b.type || '');
    if (!['desactiver', 'reactiver', 'supprimer'].includes(type)) return sendJson(res, 400, { error: 'Action inconnue' });
    const pw = String(b.password || '');
    if (clientToken(cli.passHash) !== clientToken(hashPassword(cli.salt, pw)) && hashPassword(cli.salt, pw) !== cli.passHash)
      return sendJson(res, 401, { error: 'Mot de passe incorrect' });
    if (type === 'desactiver') { cli.desactive = true; cli.desactiveAt = nowISO(); }
    if (type === 'reactiver') { cli.desactive = false; }
    if (type === 'supprimer') {
      db.accountRequests.push({ id: uid('AR'), at: nowISO(), type: 'client', nom: cli.nom, tel: cli.tel, clientId: cli.id, demande: 'suppression', statut: 'nouvelle' });
      cli.suppressionDemandee = nowISO();
    }
    auditLog('compte_' + type, { id: cli.id, tel: cli.tel });
    saveDb();
    return sendJson(res, 200, { ok: true, type, message: type === 'supprimer'
      ? 'Demande de suppression enregistrée. Le support Klean vous contacte sous 48 h (vos points et missions sont conservés jusqu’à confirmation).'
      : (type === 'desactiver' ? 'Compte désactivé : vous ne recevrez plus de notifications.' : 'Compte réactivé.') });
  }

  /* 👤 FICHE PUBLIQUE d'un professionnel — seulement ses informations autorisées */
  if (p === '/api/pros/fiche' && req.method === 'GET') {
    const cfg = matchCfg();
    const ip = req.socket.remoteAddress || '?';
    if (!recherchePlafond('f:' + ip, 60)) return sendJson(res, 429, { error: 'Trop de consultations — patientez un instant' });
    if (!cfg.ficheOuverte) return sendJson(res, 403, { error: 'La consultation des fiches est momentanément fermée' });
    const id = String(url.searchParams.get('id') || '').trim();
    const num = String(url.searchParams.get('num') || '').trim();
    let ag = null;
    if (id) ag = db.agents.find(a => a.id === id);
    if (!ag && num) ag = db.agents.find(a => a.numPro && a.numPro.toLowerCase() === num.toLowerCase());
    /* même réponse pour « inconnu » et « compte inactif » : rien à apprendre en balayant les numéros */
    const introuvable = () => {
      shieldLog(ip, 'fiche-inconnue', '/api/pros/fiche', num || id, 2);
      return sendJson(res, 404, { error: 'Ce numéro professionnel ne correspond à aucun professionnel actif', code: 'inconnu' });
    };
    if (!ag) return introuvable();
    if (ag.blocked || (ag.status || 'approved') !== 'approved') return introuvable();
    const pv = privacyOf(ag);
    if (!pv.publieFiche) return sendJson(res, 403, { error: 'Ce professionnel ne rend pas sa fiche publique', code: 'prive' });
    const cli = findClientByToken(req);
    const lat = parseFloat(url.searchParams.get('lat')), lng = parseFloat(url.searchParams.get('lng'));
    const ville = String(url.searchParams.get('ville') || (cli && cli.ville) || '').slice(0, 60);
    const quartier = String(url.searchParams.get('quartier') || (cli && cli.quartier) || '').slice(0, 60);
    /* la fiche passe par le MÊME moteur : zone d'intervention et fraîcheur du GPS sont respectées */
    const via = recherchePro({
      ville, quartier, service: '',
      lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null,
      inclureHorsLigne: true, limit: 100
    });
    let card = (via.pros || []).find(x => x.id === ag.id);
    if (!card) card = fichePublique(ag, {});      // pro hors zone : fiche consultable mais marquée comme telle
    else card.horsZone = false;
    if (!via.pros.some(x => x.id === ag.id)) card.horsZone = true;
    /* dernières réalisations : uniquement le métier, la zone générale et la date — jamais de nom de client */
    card.recent = db.missions.filter(m => m.agentId === ag.id && m.status === 'terminee')
      .slice(-4).reverse().map(m => ({ service: SVC_NAMES[m.service] || m.service, quand: (m.finishedAt || m.createdAt || '').slice(0, 10) }));
    return sendJson(res, 200, { ok: true, pro: card });
  }

  /* 📞 LE PLUS PROCHE — le client voit qui peut venir : même quartier, GPS le plus proche, puis même ville */
  if (p === '/api/pros/proches' && req.method === 'GET') {
    const cfg = matchCfg();
    const cli = findClientByToken(req);
    const ip = req.socket.remoteAddress || '?';
    if (!recherchePlafond('p:' + ((cli && cli.id) || ip), cfg.maxRecherchesMin * 2))
      return sendJson(res, 429, { error: 'Trop de recherches — patientez un instant' });
    const service = String(url.searchParams.get('service') || '').slice(0, 40);
    const ville = String(url.searchParams.get('ville') || (cli && cli.ville) || '').slice(0, 60);
    const quartier = String(url.searchParams.get('quartier') || (cli && cli.quartier) || '').slice(0, 60);
    const lat = parseFloat(url.searchParams.get('lat')), lng = parseFloat(url.searchParams.get('lng'));
    const resu = recherchePro({
      service, ville, quartier,
      lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null,
      inclureHorsLigne: url.searchParams.get('horsLigne') === '1',
      limit: parseInt(url.searchParams.get('limit'), 10) || 12
    });
    /* compatibilité avec l'écran existant : on garde ses champs, mais alimentés par le moteur */
    resu.pros = resu.pros.map(p => Object.assign(p, {
      hasGps: p.distSource === 'gps', distKm: p.distKm, distance: p.distTxt,
      pourquoi: p.pourquoi, memeQuartier: p.memeQuartier,
      tel: p.tel, telAffiche: p.appelDirect
    }));
    return sendJson(res, 200, resu);
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
    /* 🎯 demande d'un pro précis (choisi dans la liste ou trouvé par son numéro professionnel) */
    const veutCible = b.agentCible || b.cible || b.cibleId || b.numPro;
    if (veutCible) {
      const key = String(typeof veutCible === 'object' ? (veutCible.id || veutCible.numPro || '') : veutCible).trim();
      const agC = db.agents.find(a => a.id === key) || db.agents.find(a => String(a.numPro || '').toUpperCase() === key.toUpperCase());
      if (!agC || agC.blocked || (agC.status || 'approved') !== 'approved') return sendJson(res, 404, { error: 'Ce professionnel n’est plus disponible — choisissez-en un autre' });
      if (b.service && b.service !== 'custom' && !agentHasService(agC, b.service)) return sendJson(res, 409, { error: 'Ce professionnel ne fait pas ce service' });
      m.cible = agC.id; m.cibleNom = agC.nom; m.matchScope = 'cible';
      ensureNumPro(agC);
    }
    const cli = findClientByToken(req);   // 👤 mission rattachée au compte client
    if (!cli) return sendJson(res, 401, { error: 'Inscription requise : créez votre compte client gratuit pour réserver' });
    if (cli.blocked) return sendJson(res, 403, { error: 'Compte bloqué' + (cli.blockReason ? ' — motif : ' + cli.blockReason : '') + ' · Contactez Klean-Service', blocked: true });
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
    m.status = 'accepted'; m.agentId = ag.id; invaliderStats(ag.id); saveDb();
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
    if (status === 'terminee') { m.finishedAt = nowISO(); if (note) m.note = note; invaliderStats(agentId); }
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
    const cl = { id: uid('CL'), nom: b.nom.trim(), tel, quartier: String(b.quartier || '').slice(0, 60), ville: String(b.ville || '').slice(0, 60), mail: String(b.mail || '').slice(0, 80), salt, passHash: hashPassword(salt, b.password), createdAt: nowISO(),
      lastLogin: nowISO(), lastAppareil: String(req.headers['user-agent'] || '').slice(0, 120) };
    db.clients.push(cl); saveDb();
    console.log(`👤 Nouveau compte client : ${cl.nom} (${tel})`);
    return sendJson(res, 201, { ok: true, clientId: cl.id, token: clientToken(cl.passHash), nom: cl.nom });
  }

  if (p === '/api/clients/login' && req.method === 'POST') {
    const ipc = req.socket.remoteAddress || '?';
    const rcc = loginTries.get(ipc + '|cli') || { n: 0, t: 0 };
    if (rcc.n >= 10 && Date.now() - rcc.t < 600000) return sendJson(res, 429, { error: 'Trop d’essais — patientez 10 minutes' });
    const b = await readBody(req);
    const tel = String(b.tel || '').replace(/\D/g, '');
    const cl = db.clients.find(x => x.tel === tel);
    if (cl && cl.blocked) return sendJson(res, 403, { error: 'Compte bloqué' + (cl.blockReason ? ' — motif : ' + cl.blockReason : '') + ' · Contactez Klean-Service', blocked: true });
    const saisi = String(b.password || '').replace(/\s/g, '');
    let bon = !!(cl && hashPassword(cl.salt, b.password || '') === cl.passHash);
    if (!bon && cl && cl.codeAcces && /^\d{4,8}$/.test(saisi) && saisi === String(cl.codeAcces)) bon = true; // 🎟️ connexion par code d'accès
    if (!bon) {
      loginTries.set(ipc + '|cli', { n: rcc.n + 1, t: rcc.t || Date.now() });
      return sendJson(res, 401, { error: 'Téléphone, mot de passe ou code d’accès incorrect' });
    }
    loginTries.delete(ipc + '|cli');
    if (cl.blocked) return sendJson(res, 403, { error: 'Compte bloqué' + (cl.blockReason ? ' — motif : ' + cl.blockReason : '') + ' · Contactez Klean-Service', blocked: true });
    try { cl.lastLogin = nowISO(); cl.lastAppareil = String(req.headers['user-agent'] || '').slice(0, 120); cl.online = true; saveDb(); } catch (e) {}
    return sendJson(res, 200, { ok: true, clientId: cl.id, token: clientToken(cl.passHash), nom: cl.nom, quartier: cl.quartier, ville: cl.ville || '', mail: cl.mail || '', photo: cl.photo || '' });
  }

  /* 📜 MES ANCIENNES MISSIONS — le client retrouve tout son historique, sur n'importe quel téléphone
     (avant, l'historique vivait seulement dans le navigateur : réinstallation = tout perdu) */
  if (p === '/api/clients/missions' && req.method === 'GET') {
    const cli = findClientByToken(req);
    if (!cli) return sendJson(res, 401, { error: 'Connectez-vous pour retrouver vos anciennes missions', needLogin: true });
    const tel = String(cli.tel || '').replace(/\D/g, '');
    const miennes = db.missions.filter(m =>
      m.clientId === cli.id ||
      (tel && m.client && String(m.client.tel || '').replace(/\D/g, '') === tel));
    const liste = miennes.slice()
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, 200)
      .map(m => {
        const ag = m.agentId ? db.agents.find(a => a.id === m.agentId) : null;
        return {
          id: m.id, service: m.service, serviceNom: SVC_NAMES[m.service] || m.service,
          status: m.status, pro: ag ? ag.nom : '', proTel: ag ? String(ag.tel1 || ag.tel || '') : '',
          date: m.date || '', time: m.time || '', quartier: m.quartier || '', ville: m.ville || '',
          pieces: m.pieces || 0, prixTotal: m.prixTotal || 0, paiement: m.paiement || 'cash',
          note: m.note || 0, at: m.createdAt || '', fin: m.finishedAt || '',
          motifAnnulation: m.cancelReason || '', devis: !!m.quote
        };
      });
    const terminees = liste.filter(m => m.status === 'terminee');
    return sendJson(res, 200, {
      ok: true, missions: liste, total: liste.length, terminees: terminees.length,
      depense: terminees.reduce((s, m) => s + (m.prixTotal || 0), 0),
      blocked: !!cli.blocked, blockReason: cli.blockReason || ''
    });
  }

  /* 👤 Sa fiche + état du compte (bloqué ou non, avec le motif) — GET /api/clients/me */
  if (p === '/api/clients/me' && req.method === 'GET') {
    const cli = findClientByToken(req);
    if (!cli) return sendJson(res, 401, { error: 'Session requise', needLogin: true });
    return sendJson(res, 200, {
      ok: true, nom: cli.nom, tel: cli.tel, quartier: cli.quartier || '', ville: cli.ville || '',
      mail: cli.mail || '', photo: cli.photo || '', blocked: !!cli.blocked, blockReason: cli.blockReason || ''
    });
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
      ville: String(b.ville || '').slice(0, 60), villeService: String(b.villeService || b.ville || '').slice(0, 60), mail: String(b.mail || '').slice(0, 80),
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
    return sendJson(res, 200, db.agents.map(a => ({ id: a.id, nom: a.nom, quartier: a.quartier, ville: a.ville || '', mail: a.mail || '', online: agentIsOnline(a), status: a.status || 'approved', blocked: !!a.blocked, ...agentStatsCached(a) })));
  }

  if (p === '/api/admin/inscrits') {
    const mine = x => isPdg(req) || ownsRecord(req, x) || true;
    const clients = db.clients.filter(mine).map(c => {
      const ms = db.missions.filter(m => m.clientId === c.id);
      const depense = ms.filter(m => m.status === 'terminee').reduce((s, m) => s + (m.prixTotal || 0), 0);
      const paiements = ms.filter(m => m.status === 'terminee').map(m => ({ id: m.id, montant: m.prixTotal, at: m.finishedAt || m.createdAt, service: m.service }));
      return { id: c.id, nom: c.nom, tel: c.tel, quartier: c.quartier || '', ville: c.ville || '', createdAt: c.createdAt, photo: !!c.photo, missions: ms.length, depense, blocked: !!c.blocked, createdBy: c.createdBy || '', createdById: c.createdById || '', online: clientIsOnline(c), paiements };
    });
    const agents = db.agents.filter(mine).map(a => ({ id: a.id, nom: a.nom, tel: a.tel || a.tel1 || '', quartier: a.quartier || '', ville: a.ville || '', villeService: a.villeService || a.ville || '', mail: a.mail || '', status: a.status || 'approved', online: agentIsOnline(a), dispo: agentDispo(a), numPro: a.numPro || '', niveau: a.niveau || '', services: a.services || [], kind: a.kind || 'pro', createdAt: a.createdAt, photo: !!a.photo, blocked: !!a.blocked, createdBy: a.createdBy || '', createdById: a.createdById || '', ...agentStatsCached(a) }));
    return sendJson(res, 200, { clients: clients.slice().reverse(), agents: agents.slice().reverse(), canModerate: isPdg(req) });
  }

  /* --- 📜 Anciennes missions d'un client (PDG / gestionnaires) --- */
  if (p === '/api/admin/missions-client' && req.method === 'GET') {
    const cid = String(url.searchParams.get('id') || '').trim();
    const ctel = String(url.searchParams.get('tel') || '').replace(/\D/g, '');
    let nom = '', id = cid;
    if (cid) { const cl = db.clients.find(c => c.id === cid); if (cl) nom = cl.nom; }
    if (!id && ctel) { const cl = db.clients.find(c => String(c.tel || '').replace(/\D/g, '') === ctel); if (cl) { id = cl.id; nom = cl.nom; } }
    const liste = db.missions.filter(m =>
      (id && m.clientId === id) ||
      (ctel && m.client && String(m.client.tel || '').replace(/\D/g, '') === ctel))
      .slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, 300)
      .map(m => {
        const ag = m.agentId ? db.agents.find(a => a.id === m.agentId) : null;
        return {
          id: m.id, service: m.service, serviceNom: SVC_NAMES[m.service] || m.service, status: m.status,
          pro: ag ? ag.nom : '', proTel: ag ? String(ag.tel1 || ag.tel || '') : '',
          date: m.date || '', time: m.time || '', quartier: m.quartier || '', ville: m.ville || '',
          pieces: m.pieces || 0, prixTotal: m.prixTotal || 0, note: m.note || 0,
          at: m.createdAt || '', fin: m.finishedAt || '', motifAnnulation: m.cancelReason || '',
          telMission: (m.client && m.client.tel) || ''
        };
      });
    const fin = liste.filter(m => m.status === 'terminee');
    return sendJson(res, 200, {
      ok: true, nom: nom || (liste[0] && liste[0].telMission) || '', id,
      missions: liste, total: liste.length, terminees: fin.length,
      annulees: liste.filter(m => m.status === 'annulee').length,
      depense: fin.reduce((x, m) => x + (m.prixTotal || 0), 0),
      derniere: (liste[0] || {}).at || ''
    });
  }

  /* --- 📜 Missions d'un professionnel (PDG / gestionnaires) --- */
  if (p === '/api/admin/missions-pro' && req.method === 'GET') {
    const pid = String(url.searchParams.get('id') || '').trim();
    const pro = db.agents.find(a => a.id === pid);
    const liste = db.missions.filter(m => m.agentId === pid)
      .slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, 300)
      .map(m => ({
        id: m.id, service: m.service, serviceNom: SVC_NAMES[m.service] || m.service, status: m.status,
        client: (m.client && m.client.nom) || '', clientTel: (m.client && m.client.tel) || '',
        date: m.date || '', time: m.time || '', quartier: m.quartier || '', ville: m.ville || '',
        prixTotal: m.prixTotal || 0, note: m.note || 0, at: m.createdAt || '', fin: m.finishedAt || ''
      }));
    const fin = liste.filter(m => m.status === 'terminee');
    return sendJson(res, 200, {
      ok: true, nom: pro ? pro.nom : '', missions: liste, total: liste.length,
      terminees: fin.length, annulees: liste.filter(m => m.status === 'annulee').length,
      ca: fin.reduce((x, m) => x + (m.prixTotal || 0), 0), derniere: (liste[0] || {}).at || ''
    });
  }

  /* --- ⚙️ Réglages du moteur de mise en relation (PDG) --- */
  if (p === '/api/admin/match-config' && req.method === 'GET') {
    const cfg = matchCfg();
    saveDb();
    return sendJson(res, 200, { ok: true, match: cfg });
  }
  if (p === '/api/admin/match-config' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const cfg = matchCfg();
    const n = (k, min, max) => { const v = parseInt(b[k], 10); if (!isNaN(v)) cfg[k] = Math.max(min, Math.min(max, v)); };
    n('distTtlMin', 1, 120); n('zoneTtlMin', 5, 720); n('maxRecherchesMin', 5, 600);
    n('jitterM', 0, 2000); n('rayonDefautKm', 1, 800);
    if (b.ficheOuverte !== undefined) cfg.ficheOuverte = !!b.ficheOuverte;
    /* ⚖️ poids du classement : de 0 (ignoré) à 2 (prioritaire) */
    if (b.poids && typeof b.poids === 'object') {
      cfg.poids = cfg.poids || {};
      for (const k in b.poids) {
        if (!['distance', 'dispo', 'note', 'missions', 'verif', 'prix', 'zone', 'competences'].includes(k)) continue;
        const v = parseFloat(b.poids[k]);
        if (Number.isFinite(v)) cfg.poids[k] = Math.max(0, Math.min(2, v));
      }
    }
    saveDb();
    auditLog('match_config', Object.assign({ par: act(req) }, cfg));
    emitAdmin('admin', '⚙️ Mise en relation : TTL ' + cfg.distTtlMin + ' min · zone ' + cfg.rayonDefautKm + ' km · plafond ' + cfg.maxRecherchesMin + '/min');
    return sendJson(res, 200, { ok: true, match: cfg });
  }

  /* --- 🎟️ Codes d'accès : liste + remise d'un nouveau code (PDG / gestionnaires) --- */
  if (p === '/api/admin/acces' && req.method === 'GET') {
    const clients = db.clients.map(c => {
      const ms = db.missions.filter(m => m.clientId === c.id);
      const fin = ms.filter(m => m.status === 'terminee');
      return { kind: 'client', id: c.id, nom: c.nom, tel: c.tel, ville: c.ville || '', quartier: c.quartier || '', code: c.codeAcces || '', hasPw: !!c.passHash, blocked: !!c.blocked, blockReason: c.blockReason || '', online: clientIsOnline(c), createdAt: c.createdAt || '',
        missions: ms.length, terminees: fin.length, annulees: ms.filter(m => m.status === 'annulee').length,
        depense: fin.reduce((x, m) => x + (m.prixTotal || 0), 0),
        derniere: (ms.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || {}).createdAt || '' };
    });
    const pros = db.agents.map(a => {
      const ms = db.missions.filter(m => m.agentId === a.id);
      return { kind: 'pro', id: a.id, nom: a.nom, tel: a.tel1 || a.tel || '', ville: a.villeService || a.ville || '', villeIci: a.villeIci || '', quartier: a.quartier || '', code: a.codeAcces || a.claimPin || '', enAttenteLiaison: !!(a.claimPin), lie: !a.claimPin, blocked: !!a.blocked, blockReason: a.blockReason || '', online: agentIsOnline(a), createdAt: a.createdAt || '',
        hasGps: agentHasGps(a), gpsAge: agentHasGps(a) ? Math.round((Date.now() - (a.pos.at || 0)) / 1000) : null,
        sonnerie: (Array.isArray(a.pushSubs) ? a.pushSubs.length : 0), lastSeen: a.lastSeen || '', demandes: a.demandes || 0,
        missions: ms.length, terminees: ms.filter(m => m.status === 'terminee').length, annulees: ms.filter(m => m.status === 'annulee').length,
        note: Math.round(((agentStatsCached(a) || {}).rating || a.rating || 5) * 10) / 10,
        derniere: (ms.slice().sort((x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || '')))[0] || {}).createdAt || '' };
    });
    return sendJson(res, 200, { ok: true, clients, pros });
  }
  if (p === '/api/admin/acces/code' && req.method === 'POST') {
    const b = await readBody(req);
    const kind = b.kind === 'pro' ? 'pro' : 'client';
    const rec = kind === 'pro' ? db.agents.find(a => a.id === b.id) : db.clients.find(c => c.id === b.id);
    if (!rec) return sendJson(res, 404, { error: 'Compte introuvable' });
    const tousLesCodes = () => [...db.clients.map(x => x.codeAcces), ...db.agents.map(x => x.codeAcces || x.claimPin)].filter(Boolean).map(String);
    let code = String(b.code || '').replace(/\D/g, '').slice(0, 8);
    if (code && code.length < 4) return sendJson(res, 400, { error: 'Le code d’accès doit faire 4 à 8 chiffres' });
    if (!code) { do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (tousLesCodes().includes(code)); }
    else if (tousLesCodes().includes(code) && String(rec.codeAcces || rec.claimPin || '') !== code)
      return sendJson(res, 409, { error: 'Ce code est déjà utilisé par un autre compte — choisissez-en un autre' });
    const out = { ok: true, kind, id: rec.id, nom: rec.nom, tel: kind === 'pro' ? (rec.tel1 || rec.tel || '') : rec.tel, code };
    if (kind === 'pro') {
      rec.codeAcces = code; rec.claimPin = code;
      (rec.hist = rec.hist || []).push({ at: Date.now(), by: act(req), ev: '🎟️ Nouveau code d’accès remis par ' + act(req) });
    } else rec.codeAcces = code;
    if (b.password) {
      const perr = validPassword(b.password);
      if (perr) return sendJson(res, 400, { error: 'Mot de passe faible : ' + perr });
      const salt = crypto.randomBytes(12).toString('hex');
      rec.salt = salt; rec.passHash = hashPassword(salt, b.password); out.password = b.password;
    } else if (b.nouveauMdp) {
      const pw = 'Klean-' + Math.floor(1000 + Math.random() * 9000) + '!';
      const salt = crypto.randomBytes(12).toString('hex');
      rec.salt = salt; rec.passHash = hashPassword(salt, pw); out.password = pw; out.passwordGenere = true;
    }
    saveDb();
    auditLog('code_acces_remis', { type: kind, nom: rec.nom, tel: out.tel, par: act(req) });
    emitAdmin('codes', '🎟️ Code d’accès remis par ' + act(req) + ' — ' + (kind === 'pro' ? 'pro' : 'client') + ' ' + rec.nom);
    return sendJson(res, 200, out);
  }

  /* --- Admin : dossiers de candidature --- */
  if (p === '/api/config') return sendJson(res, 200, {
    commission: (db.config && db.config.commission) || 25,
    reachKm: reachKm(),
    gpsNationOn: gpsNationOn(),
    payDest: (db.config && db.config.hide) ? { hide: true } : ((db.config && db.config.payDest) || {}),
    hidePay: !!(db.config && db.config.payDest && db.config.payDest.hide),
    cities: db.cities || [],
    services: db.catalog || [],
    servicesVersion: db.catalogVersion || 1,
    citiesVersion: db.citiesVersion || 1,
    supportChat: db.config && db.config.supportChat === false ? false : true
  });
  if (p === '/api/cities' && req.method === 'GET')
    return sendJson(res, 200, {
      ok: true, cities: db.cities || [],
      version: db.citiesVersion || 1, deployAt: db.citiesDeployAt || null, dirty: !!db.citiesDirty
    });
  /* 🚀 DÉPLOYER les villes (création, quartiers) vers tous les écrans */
  if (p === '/api/admin/cities/deploy' && req.method === 'POST') {
    db.cities = db.cities || [];
    db.citiesVersion = (db.citiesVersion || 1) + 1;
    db.citiesDeployAt = nowISO();
    db.citiesDeployBy = act(req);
    db.citiesDirty = false;
    saveDb();
    bcAll({ type: 'cities_deploy', version: db.citiesVersion, n: db.cities.length, at: db.citiesDeployAt, by: db.citiesDeployBy });
    emitAdmin('admin', '🚀 ' + act(req) + ' a déployé ' + db.cities.length + ' ville(s) vers tous les écrans');
    auditLog('villes_deployees', { n: db.cities.length, version: db.citiesVersion, par: act(req) });
    return sendJson(res, 200, { ok: true, n: db.cities.length, version: db.citiesVersion, deployAt: db.citiesDeployAt });
  }
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
    db.cities.push(city); db.citiesDirty = true;
    /* ✨ déploiement AUTOMATIQUE : la ville part tout de suite vers clients et pros */
    db.citiesVersion = (db.citiesVersion || 1) + 1;
    db.citiesDeployAt = nowISO(); db.citiesDeployBy = act(req); db.citiesDirty = false;
    saveDb();
    bcAll({ type: 'cities_deploy', version: db.citiesVersion, n: db.cities.length, at: db.citiesDeployAt, by: db.citiesDeployBy });
    auditLog('ville_ajoutee', { nom, par: act(req), deploy: true });
    emitAdmin('admin', '🏙️ Nouvelle ville déployée partout : ' + nom);
    return sendJson(res, 201, { ok: true, city, deployed: true, version: db.citiesVersion, n: db.cities.length });
  }
  if (p === '/api/admin/cities' && req.method === 'GET') return sendJson(res, 200, { cities: db.cities || [] });
  if (p === '/api/services' && req.method === 'GET')
    return sendJson(res, 200, {
      ok: true, services: db.catalog || [],
      version: db.catalogVersion || 1, deployAt: db.catalogDeployAt || null, deployBy: db.catalogDeployBy || '',
      dirty: !!db.catalogDirty
    });
  /* 🚀 DÉPLOYER les services créés vers les écrans clients ET pros (instantané) */
  if (p === '/api/admin/services/deploy' && req.method === 'POST') {
    db.catalog = db.catalog || [];
    db.catalogVersion = (db.catalogVersion || 1) + 1;
    db.catalogDeployAt = nowISO();
    db.catalogDeployBy = act(req);
    db.catalogDirty = false;
    saveDb();
    bcAll({ type: 'services_deploy', version: db.catalogVersion, n: db.catalog.length, at: db.catalogDeployAt, by: db.catalogDeployBy });
    emitAdmin('admin', '🚀 ' + act(req) + ' a déployé ' + db.catalog.length + ' service(s) vers tous les écrans');
    auditLog('services_deployes', { n: db.catalog.length, version: db.catalogVersion, par: act(req) });
    console.log('🚀 Services déployés (' + db.catalog.length + ') par ' + act(req));
    return sendJson(res, 200, { ok: true, n: db.catalog.length, version: db.catalogVersion, deployAt: db.catalogDeployAt });
  }
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
    db.catalog.push(svc); db.catalogDirty = true; saveDb();
    auditLog('service_ajoute', { nom, par: act(req) });
    emitAdmin('admin', '🛠️ Service créé : ' + nom + ' — touchez 🚀 Déployer pour l’envoyer aux clients et aux pros');
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
    const ag = db.agents.find(a => String(a.tel1 || '').replace(/\D/g, '') === tel && ((a.codeAcces && a.codeAcces === pin) || (a.claimPin && a.claimPin === pin)) && (a.status || 'approved') === 'approved');
    if (!ag) {
      loginTries.set(ip + '|claim', { n: rc.n + 1, t: rc.t || Date.now() });
      return sendJson(res, 401, { error: 'Numéro ou code incorrect — vérifiez avec le gestionnaire' });
    }
    loginTries.delete(ip + '|claim');
    if (ag.claimPin && ag.claimPin === pin) delete ag.claimPin; // 🔒 le code à usage unique s'efface, le code d'accès durable reste
    ag.claimedAt = nowISO();
    if (!ag.zone) ag.zone = { km: matchCfg().rayonDefautKm, villes: [] };
    ensureNumPro(ag);
    const jetonLiaison = issueAgentJeton(ag);
    (ag.hist = ag.hist || []).push({ at: Date.now(), by: ag.nom, ev: '📱 Compte lié au téléphone du professionnel' });
    saveDb();
    auditLog('pro_lie', { pro: ag.nom, tel, numPro: ag.numPro });
    return sendJson(res, 200, { ok: true, agentId: ag.id, nom: ag.nom, numPro: ag.numPro, jeton: jetonLiaison, zoneKm: zoneOfAgent(ag).km });
  }
  if (p === '/api/agents/login' && req.method === 'POST') {
    const b = await readBody(req);
    const tel = String(b.tel || '').replace(/\D/g, '');
    const agTrouve = db.agents.find(a => String(a.tel1 || a.tel || '').replace(/\D/g, '') === tel && (a.status || 'approved') === 'approved');
    if (agTrouve && agTrouve.blocked) return sendJson(res, 403, { error: 'Compte bloqué' + (agTrouve.blockReason ? ' — motif : ' + agTrouve.blockReason : '') + ' · Contactez Klean-Service', blocked: true });
    const ag = (agTrouve && !agTrouve.blocked) ? agTrouve : null;
    if (!ag || !ag.passHash || hashPassword(ag.salt || '', b.password || '') !== ag.passHash)
      return sendJson(res, 401, { error: 'Téléphone ou mot de passe incorrect' });
    ensureNumPro(ag);
    if (!ag.zone) ag.zone = { km: matchCfg().rayonDefautKm, villes: [] };
    const jetonL = issueAgentJeton(ag);
    saveDb();
    return sendJson(res, 200, { ok: true, agentId: ag.id, nom: ag.nom, numPro: ag.numPro, jeton: jetonL, zoneKm: zoneOfAgent(ag).km });
  }



  /* ══════════════ 🔌 CINETPAY (agrégateur unique) ══════════════ */
  /* ── le client demande à payer en ligne : le serveur crée le lien CinetPay ── */
  const pInit = p.match(/^\/api\/paiements\/([^/]+)\/initier$/);
  if (pInit && req.method === 'POST') {
    const pa = paiements().find(x => x.id === pInit[1] || x.ref === pInit[1]);
    if (!pa) return sendJson(res, 404, { error: 'Paiement introuvable' });
    const q = paiementProprietaire(req, pa);
    if (!q) return sendJson(res, 403, { error: 'Accès refusé' });
    if (pa.statut === 'reussi') return sendJson(res, 409, { error: 'Ce paiement est déjà confirmé' });
    const manque = cinetpayManque(req);
    if (manque.length) return sendJson(res, 503, {
      error: 'Paiement en ligne non encore activé : le compte marchand CinetPay doit être validé.', code: 'non_configure', manque
    });
    const r = await cinetpayInitier(pa, req);
    if (!r.ok) {
      tracePaiement(pa, '⚠️ CinetPay a refusé la création du lien : ' + r.error, 'CinetPay');
      saveDb();
      return sendJson(res, 502, { error: 'CinetPay : ' + r.error });
    }
    pa.checkoutUrl = r.url; pa.checkoutToken = r.token; pa.checkoutAt = nowISO(); pa.mode = 'api';
    tracePaiement(pa, '🔗 Lien de paiement CinetPay généré — le client paie sur la page sécurisée CinetPay', 'système');
    saveDb();
    return sendJson(res, 200, { ok: true, checkoutUrl: r.url, token: r.token, paiement: paiementPublic(pa) });
  }
  /* ── revérifier maintenant (si la notification tarde) ── */
  const pVerif = p.match(/^\/api\/paiements\/([^/]+)\/verifier$/);
  if (pVerif && req.method === 'POST') {
    const pa = paiements().find(x => x.id === pVerif[1] || x.ref === pVerif[1]);
    if (!pa) return sendJson(res, 404, { error: 'Paiement introuvable' });
    const q = paiementProprietaire(req, pa);
    if (!q) return sendJson(res, 403, { error: 'Accès refusé' });
    if (['reussi', 'annule'].includes(pa.statut)) return sendJson(res, 200, { ok: true, paiement: paiementPublic(pa) });
    if (!cinetpayPret(req)) return sendJson(res, 503, { error: 'CinetPay non configuré', code: 'non_configure', manque: cinetpayManque(req) });
    const v = await cinetpayVerifier(pa.ref);
    if (!v.ok) return sendJson(res, 502, { error: v.error });
    const ap = cinetpayAppliquer(pa, v);
    saveDb();
    if (ap.statut === 'reussi') { emitAdmin('pay', '✅ ' + pa.ref + ' — paiement confirmé par CinetPay (' + pa.montant.toLocaleString('fr-FR') + ' F)'); bcAll({ type: 'paiement_update', paiement: paiementPublic(pa) }); }
    return sendJson(res, 200, { ok: true, statutFournisseur: v.statut, paiement: paiementPublic(pa) });
  }
  /* ── 🔔 NOTIFICATION CinetPay : on ne fait JAMAIS confiance au contenu reçu.
        On re-vérifie la transaction chez CinetPay puis on compare le montant. ── */
  if (p === '/api/pay/webhook/cinetpay' && (req.method === 'POST' || req.method === 'GET')) {
    if (!cinetpayPret(req)) return sendJson(res, 503, { error: 'CinetPay non configuré — aucune validation possible', code: 'non_configure', manque: cinetpayManque(req) });
    const corps = await readBodyRaw(req);
    let d = {}; try { d = JSON.parse(corps || '{}'); } catch (e) {}
    const q2 = Object.fromEntries(new URLSearchParams(corps || ''));
    const ref = String(d.cpm_trans_id || d.transaction_id || q2.cpm_trans_id || q2.transaction_id || url.searchParams.get('cpm_trans_id') || url.searchParams.get('transaction_id') || '');
    /* signature HMAC (optionnelle) : si la clé est configurée, elle est exigée */
    const hmacKey = process.env.KLEAN_CINETPAY_HMAC_KEY || '';
    if (hmacKey) {
      const recu = String(req.headers['x-token'] || d.x_token || '');
      const attendu = crypto.createHmac('sha256', hmacKey).update(corps || '').digest('hex');
      if (!recu || recu.toLowerCase() !== attendu.toLowerCase())
        return sendJson(res, 401, { error: 'Signature HMAC invalide', code: 'signature' });
    }
    if (!ref) return sendJson(res, 400, { error: 'transaction_id manquant' });
    const pa = paiements().find(x => x.ref === ref || x.id === ref);
    if (!pa) return sendJson(res, 404, { error: 'Transaction inconnue : ' + ref });
    if (pa.statut === 'reussi') return sendJson(res, 200, { ok: true, message: 'déjà confirmé' });
    const v = await cinetpayVerifier(pa.ref);
    if (!v.ok) { console.log('⚠️ CinetPay check impossible : ' + v.error); return sendJson(res, 502, { error: v.error }); }
    const ap = cinetpayAppliquer(pa, v);
    saveDb();
    console.log('🔔 CinetPay ' + pa.ref + ' → ' + v.statut + ' (notre statut : ' + pa.statut + ')');
    emitAdmin('pay', (ap.statut === 'reussi' ? '✅ Paiement ' + pa.ref + ' confirmé par CinetPay' : 'ℹ️ CinetPay ' + pa.ref + ' : ' + v.statut));
    bcAll({ type: 'paiement_update', paiement: paiementPublic(pa) });
    return sendJson(res, 200, { ok: true, statut: pa.statut });
  }
  /* ── page de retour après paiement (le client revient ici) ── */
  if (p === '/api/paiement/retour' && req.method === 'GET') {
    const ref = String(url.searchParams.get('cpm_trans_id') || url.searchParams.get('transaction_id') || '');
    try {
      if (ref && cinetpayPret(req)) {
        const pa = paiements().find(x => x.ref === ref);
        if (pa && pa.statut !== 'reussi') { const v = await cinetpayVerifier(ref); if (v.ok) { cinetpayAppliquer(pa, v); saveDb(); } }
      }
    } catch (e) {}
    res.writeHead(302, { Location: '/?paiement=' + encodeURIComponent(ref) + '#accueil' });
    return res.end();
  }
  /* ── HQ : configurer / tester l'agrégateur (PDG) ── */
  if (p === '/api/admin/pay/provider' && req.method === 'GET') {
    if (!pdgOnly(req, res)) return;
    const c = cinetpayCfg(), u = urlsCinetpay(req);
    return sendJson(res, 200, {
      ok: true, provider: { nom: c.nom, siteId: cinetpaySiteId(), siteIdEnBase: c.siteId || '', canaux: c.canaux || 'ALL', actif: c.actif !== false, dernierTest: c.dernierTest || null },
      cleApiPresente: !!cinetpayApiKey(), hmacPresent: !!process.env.KLEAN_CINETPAY_HMAC_KEY,
      base: CINETPAY_BASE(), pret: cinetpayPret(req), manque: cinetpayManque(req), recommande: cinetpayRecommande(), urls: u,
      docs: ['Extrait RCCM (ou CNI + attestation de résidence si activité individuelle)', 'NIF / IDU / DFE (identifiant fiscal)', 'CNI ou passeport du gérant', 'RIB bancaire ivoirien (SGBCI, BICICI, Ecobank…)', 'Justificatif de domicile professionnel', 'Formulaire de souscription CinetPay rempli (nom commercial, forme juridique, RCCM, coordonnées du représentant légal)'],
      delai: 'Activation du compte marchand : 24 à 72 h (jusqu’à 7 jours ouvrés selon le dossier) — inscription gratuite, sandbox disponible immédiatement'
    });
  }
  if (p === '/api/admin/pay/provider' && req.method === 'PUT') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const c = cinetpayCfg();
    if (b.siteId !== undefined) { c.siteId = String(b.siteId).replace(/[^0-9A-Za-z\-_]/g, '').slice(0, 40); }
    if (b.canaux !== undefined) c.canaux = ['ALL', 'MOBILE_MONEY', 'CREDIT_CARD'].includes(String(b.canaux)) ? String(b.canaux) : 'ALL';
    if (b.actif !== undefined) c.actif = !!b.actif;
    saveDb();
    auditLog('pay_provider_update', { provider: c.nom, siteId: c.siteId, canaux: c.canaux, actif: c.actif, par: 'PDG' });
    return sendJson(res, 200, { ok: true, provider: { nom: c.nom, siteId: cinetpaySiteId(), siteIdEnBase: c.siteId, canaux: c.canaux, actif: c.actif }, pret: cinetpayPret(req), manque: cinetpayManque(req) });
  }
  if (p === '/api/admin/pay/provider/test' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const manque = cinetpayManque(req);
    if (manque.length) return sendJson(res, 200, { ok: false, message: 'Configuration incomplète', manque });
    /* vrai appel de test : on interroge une transaction fictive.
       CinetPay répond « transaction introuvable » = identifiants VALIDES ; « apikey incorrecte » = à corriger. */
    const r = await httpJson(CINETPAY_BASE() + '/v2/payment/check', { apikey: cinetpayApiKey(), site_id: cinetpaySiteId(), transaction_id: 'KLEAN-TEST-' + Date.now() }, 20000);
    const c = cinetpayCfg();
    const d = (r && r.json) || {};
    const code = String(d.code || '');
    const authOk = r.ok && !['AUTH_NOT_FOUND', '600', '624', '401'].includes(code) && !/apikey|api key|incorrect/i.test(String(d.message || '') + String(d.description || ''));
    c.dernierTest = { at: nowISO(), ok: !!authOk, code, message: d.message || d.description || (r.ok ? '' : r.error || '') };
    saveDb();
    auditLog('pay_provider_test', { ok: !!authOk, code, par: 'PDG' });
    return sendJson(res, 200, {
      ok: !!authOk,
      message: authOk
        ? 'Identifiants CinetPay ACCEPTÉS — les vrais paiements peuvent partir (réponse CinetPay : ' + (d.message || code || 'OK') + ')'
        : 'Identifiants refusés par CinetPay : ' + (d.message || d.description || r.error || 'vérifiez la clé d’API et le Site ID'),
      reponse: { code, message: d.message || '', statut: r.status || 0 }
    });
  }

  /* ══════════════ 💳 MOYENS DE PAIEMENT & TRANSACTIONS ══════════════ */
  /* ── public / connecté : uniquement les moyens ACTIFS + VISIBLES pour ce rôle ── */
  if (p === '/api/pay-methods' && req.method === 'GET') {
    const role = url.searchParams.get('role') === 'pro' ? 'pro' : 'client';
    return sendJson(res, 200, { ok: true, role, methods: payMethodsPubliques(role), cash: true });
  }
  /* ── créer un paiement (en attente) : le montant et la référence sont calculés ICI ── */
  if (p === '/api/paiements' && req.method === 'POST') {
    const b = await readBody(req);
    const cl = findClientByToken(req);
    const jtBody = req.headers['x-agent-token'] || b.jeton || '';
    const agPay = jtBody ? db.agents.find(a => a.jeton && a.jeton === jtBody) : null;
    if (!cl && !agPay) return sendJson(res, 401, { error: 'Connexion requise pour enregistrer un paiement' });
    const m = db.payMethods.find(x => x.id === b.payMethodId);
    if (!m) return sendJson(res, 404, { error: 'Moyen de paiement introuvable' });
    const role = (cl && !agPay) ? 'client' : 'pro';
    if (!m.actif) return sendJson(res, 409, { error: 'Ce moyen de paiement est désactivé' });
    if (role === 'client' && !m.visibleClient) return sendJson(res, 409, { error: 'Ce moyen de paiement n’est pas proposé aux clients' });
    if (role === 'pro' && !m.visiblePro) return sendJson(res, 409, { error: 'Ce moyen de paiement n’est pas proposé aux professionnels' });
    let montant = Math.round(parseInt(b.montant, 10) || 0);
    let mission = null;
    if (b.missionId) {
      mission = db.missions.find(x => x.id === b.missionId);
      if (!mission) return sendJson(res, 404, { error: 'Mission introuvable' });
      if (cl && mission.clientId && mission.clientId !== cl.id) return sendJson(res, 403, { error: 'Cette mission n’est pas la vôtre' });
      if (!montant) montant = Math.round(mission.prixTotal || 0);
    }
    if (montant <= 0) return sendJson(res, 400, { error: 'Montant invalide' });
    if (montant > 5000000) return sendJson(res, 400, { error: 'Montant trop élevé — contactez Klean-Service' });
    const dejaPaye = paiements().find(x => x.missionId && x.missionId === b.missionId && x.statut === 'reussi');
    if (dejaPaye) return sendJson(res, 409, { error: 'Cette mission est déjà réglée (' + dejaPaye.ref + ')' });
    const now = nowISO();
    const pa = {
      id: uid('PAY'), ref: nouvelleRefPaiement(), missionId: mission ? mission.id : '', clientId: cl ? cl.id : '',
      clientNom: cl ? cl.nom : (agPay ? agPay.nom : ''), proId: mission ? (mission.agentId || '') : (agPay ? agPay.id : ''),
      montant, payMethodId: m.id, moyen: { libelle: m.libelle, operateur: m.operateur, numero: m.numero },
      statut: 'en_attente', txOperateur: '', payeurTel: '', motif: '', hist: [],
      createdAt: now, updatedAt: now, source: role
    };
    tracePaiement(pa, '🧾 Paiement créé (' + montant.toLocaleString('fr-FR') + ' F) via ' + m.libelle + ' — en attente', role === 'client' ? 'client ' + pa.clientNom : 'pro ' + pa.clientNom);
    paiements().push(pa); saveDb();
    emitAdmin('pay', '💳 Nouveau paiement ' + pa.ref + ' — ' + montant.toLocaleString('fr-FR') + ' F · ' + m.libelle + ' (' + pa.clientNom + ')');
    return sendJson(res, 201, { ok: true, paiement: paiementPublic(pa) });
  }
  /* ── suivi du statut ── */
  const pGet = p.match(/^\/api\/paiements\/([^/]+)$/);
  if (pGet && req.method === 'GET') {
    const pa = paiements().find(x => x.id === pGet[1] || x.ref === pGet[1]);
    if (!pa) return sendJson(res, 404, { error: 'Paiement introuvable' });
    const q = paiementProprietaire(req, pa);
    if (!q && !(hqIdentity(req))) return sendJson(res, 403, { error: 'Accès refusé' });
    return sendJson(res, 200, { ok: true, paiement: paiementPublic(pa) });
  }
  /* ── « J'ai payé » : on enregistre une DÉCLARATION, jamais un succès ── */
  const pDec = p.match(/^\/api\/paiements\/([^/]+)\/declare$/);
  if (pDec && req.method === 'POST') {
    const b = await readBody(req);
    const pa = paiements().find(x => x.id === pDec[1] || x.ref === pDec[1]);
    if (!pa) return sendJson(res, 404, { error: 'Paiement introuvable' });
    const q = paiementProprietaire(req, pa);
    if (!q) return sendJson(res, 403, { error: 'Accès refusé' });
    if (pa.statut === 'reussi') return sendJson(res, 409, { error: 'Ce paiement est déjà confirmé' });
    if (pa.statut === 'annule') return sendJson(res, 409, { error: 'Ce paiement est annulé — créez-en un nouveau' });
    const tx = String(b.txOperateur || '').replace(/[^A-Za-z0-9\-\.\/]/g, '').slice(0, 40);
    if (!tx) return sendJson(res, 400, { error: 'Indiquez le numéro de transaction reçu par SMS de l’opérateur' });
    pa.payeurTel = String(b.payeurTel || '').replace(/\D/g, '').slice(0, 16);
    pa.txOperateur = tx;
    pa.declareAt = nowISO();
    pa.statut = 'declare';
    tracePaiement(pa, '📨 Client déclare avoir payé — n° de transaction opérateur : ' + tx + ' (en attente de vérification)', q.role + ' ' + q.nom);
    saveDb();
    emitAdmin('pay', '📨 ' + pa.ref + ' — paiement déclaré (' + pa.montant.toLocaleString('fr-FR') + ' F) · txn ' + tx + ' — à vérifier');
    return sendJson(res, 200, { ok: true, paiement: paiementPublic(pa), message: 'Déclaration enregistrée. Klean vérifie la réception auprès de l’opérateur : le statut passera à « Réussi » après confirmation.' });
  }
  /* ── annulation par le client (uniquement avant confirmation) ── */
  const pAnn = p.match(/^\/api\/paiements\/([^/]+)\/annuler$/);
  if (pAnn && req.method === 'POST') {
    const pa = paiements().find(x => x.id === pAnn[1] || x.ref === pAnn[1]);
    if (!pa) return sendJson(res, 404, { error: 'Paiement introuvable' });
    const q = paiementProprietaire(req, pa);
    if (!q) return sendJson(res, 403, { error: 'Accès refusé' });
    if (pa.statut === 'reussi') return sendJson(res, 409, { error: 'Impossible d’annuler un paiement confirmé' });
    pa.statut = 'annule';
    tracePaiement(pa, '🚫 Annulé par ' + q.role + ' ' + q.nom, q.role + ' ' + q.nom);
    saveDb();
    return sendJson(res, 200, { ok: true, paiement: paiementPublic(pa) });
  }
  /* ── historique du client connecté ── */
  if (p === '/api/clients/paiements' && req.method === 'GET') {
    const cl = findClientByToken(req);
    if (!cl) return sendJson(res, 401, { error: 'Connexion requise' });
    const list = paiements().filter(x => x.clientId === cl.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const totalReussi = list.filter(x => x.statut === 'reussi').reduce((s, x) => s + x.montant, 0);
    return sendJson(res, 200, { ok: true, n: list.length, totalReussi, paiements: list.slice(0, 100).map(paiementPublic) });
  }
  /* ── historique du pro connecté (ses missions) ── */
  if (p === '/api/agents/paiements' && req.method === 'GET') {
    const tk = url.searchParams.get('jeton') || req.headers['x-agent-token'] || '';
    const ag = db.agents.find(a => a.jeton && a.jeton === tk);
    if (!ag) return sendJson(res, 401, { error: 'Jeton du professionnel requis', code: 'jeton' });
    const miens = new Set(db.missions.filter(m => m.agentId === ag.id).map(m => m.id));
    const list = paiements().filter(x => miens.has(x.missionId) || x.proId === ag.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return sendJson(res, 200, {
      ok: true, n: list.length,
      encaisse: list.filter(x => x.statut === 'reussi').reduce((s, x) => s + x.montant, 0),
      enAttente: list.filter(x => ['en_attente', 'declare'].includes(x.statut)).reduce((s, x) => s + x.montant, 0),
      paiements: list.slice(0, 100).map(paiementPublic)
    });
  }
  /* ── où mes clients paient (pro) : moyens visibles côté pro ── */
  if (p === '/api/agents/moyens-paiement' && req.method === 'GET') {
    const tk = url.searchParams.get('jeton') || req.headers['x-agent-token'] || '';
    const ag = db.agents.find(a => a.jeton && a.jeton === tk);
    if (!ag) return sendJson(res, 401, { error: 'Jeton du professionnel requis', code: 'jeton' });
    return sendJson(res, 200, { ok: true, methods: payMethodsPubliques('pro') });
  }
  /* ── HQ : tableau des moyens de paiement (PDG) ── */
  if (p === '/api/admin/pay-methods' && req.method === 'GET') {
    if (!pdgOnly(req, res)) return;
    return sendJson(res, 200, {
      ok: true,
      methods: payMethods().map(m => Object.assign({}, m, { numeroAffiche: fmtNumeroCI(m.numero), nomOperateur: operateurInfo(m.operateur).nom, ic: operateurInfo(m.operateur).ic })),
      integrations: integrationsPay(),
      totaux: {
        transactions: paiements().length,
        encaisse: paiements().filter(x => x.statut === 'reussi').reduce((s, x) => s + x.montant, 0),
        enAttente: paiements().filter(x => ['en_attente', 'declare'].includes(x.statut)).reduce((s, x) => s + x.montant, 0),
        aVerifier: paiements().filter(x => x.statut === 'declare').length
      },
      notice: 'Les numéros d’un encaissement automatique par API exigent un compte marchand : voir « Intégrations officielles ».'
    });
  }
  if (p === '/api/admin/pay-methods' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const numero = String(b.numero || '').replace(/\D/g, '');
    if (numero.length < 8) return sendJson(res, 400, { error: 'Numéro invalide (10 chiffres en Côte d’Ivoire)' });
    if (payMethods().some(m => m.numero === numero && String(m.operateur) === String(b.operateur || operateurDeNumero(numero))))
      return sendJson(res, 409, { error: 'Ce numéro est déjà enregistré pour cet opérateur' });
    const now = nowISO();
    const m = {
      id: nouveauIdPayMethod(), libelle: String(b.libelle || '').trim() || operateurInfo(b.operateur || operateurDeNumero(numero)).nom,
      operateur: String(b.operateur || operateurDeNumero(numero)), numero, titulaire: String(b.titulaire || '').slice(0, 60),
      note: String(b.note || '').slice(0, 120),
      principal: !!b.principal, actif: b.actif !== false,
      visibleClient: b.visibleClient !== false, visiblePro: b.visiblePro !== false,
      createdAt: now, updatedAt: now, updatedBy: 'PDG'
    };
    if (m.principal) payMethods().forEach(x => x.principal = false);
    payMethods().push(m); saveDb();
    auditLog('pay_method_create', { numero, operateur: m.operateur, par: 'PDG' });
    emitAdmin('pay', '💳 Moyen de paiement ajouté : ' + m.libelle + ' — ' + fmtNumeroCI(numero));
    return sendJson(res, 201, { ok: true, method: m });
  }
  const pmPut = p.match(/^\/api\/admin\/pay-methods\/([^/]+)$/);
  if (pmPut && req.method === 'PUT') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const m = db.payMethods.find(x => x.id === pmPut[1]);
    if (!m) return sendJson(res, 404, { error: 'Moyen de paiement introuvable' });
    if (b.numero !== undefined) {
      const numero = String(b.numero).replace(/\D/g, '');
      if (numero.length < 8) return sendJson(res, 400, { error: 'Numéro invalide' });
      if (payMethods().some(x => x.id !== m.id && x.numero === numero)) return sendJson(res, 409, { error: 'Ce numéro est déjà utilisé par un autre moyen de paiement' });
      m.numero = numero;
      if (b.operateur === undefined) m.operateur = operateurDeNumero(numero);
    }
    if (b.operateur !== undefined) m.operateur = String(b.operateur);
    if (b.libelle !== undefined) m.libelle = String(b.libelle).slice(0, 60) || m.libelle;
    if (b.titulaire !== undefined) m.titulaire = String(b.titulaire).slice(0, 60);
    if (b.note !== undefined) m.note = String(b.note).slice(0, 120);
    if (b.actif !== undefined) m.actif = !!b.actif;
    if (b.visibleClient !== undefined) m.visibleClient = !!b.visibleClient;
    if (b.visiblePro !== undefined) m.visiblePro = !!b.visiblePro;
    if (b.principal !== undefined) { m.principal = !!b.principal; if (m.principal) payMethods().forEach(x => { if (x.id !== m.id) x.principal = false; }); }
    if (m.principal && !m.actif) return sendJson(res, 409, { error: 'Un moyen de paiement inactif ne peut pas être principal — activez-le d’abord' });
    m.updatedAt = nowISO(); m.updatedBy = 'PDG';
    saveDb();
    auditLog('pay_method_update', { id: m.id, numero: m.numero, actif: m.actif, client: m.visibleClient, pro: m.visiblePro, principal: m.principal, par: 'PDG' });
    return sendJson(res, 200, { ok: true, method: m });
  }
  if (pmPut && req.method === 'DELETE') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req).catch(() => ({}));
    const i = db.payMethods.findIndex(x => x.id === pmPut[1]);
    if (i < 0) return sendJson(res, 404, { error: 'Moyen de paiement introuvable' });
    const usage = paiements().filter(x => x.payMethodId === db.payMethods[i].id).length;
    if (usage && !b.force) return sendJson(res, 409, { error: 'Ce moyen a ' + usage + ' transaction(s) : désactivez-le au lieu de le supprimer (ou confirmez la suppression)', usage });
    const [suppr] = db.payMethods.splice(i, 1);
    if (suppr.principal && db.payMethods.length) db.payMethods[0].principal = true;
    saveDb();
    auditLog('pay_method_delete', { numero: suppr.numero, par: 'PDG' });
    emitAdmin('pay', '🗑️ Moyen de paiement supprimé : ' + suppr.libelle + ' — ' + fmtNumeroCI(suppr.numero));
    return sendJson(res, 200, { ok: true, deleted: suppr.id });
  }
  /* ── HQ : journal des transactions ── */
  if (p === '/api/admin/paiements' && req.method === 'GET') {
    if (!pdgOnly(req, res)) return;
    const st = url.searchParams.get('statut') || '';
    let list = paiements().slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (st) list = list.filter(x => x.statut === st);
    return sendJson(res, 200, {
      ok: true, n: list.length,
      totaux: {
        encaisse: paiements().filter(x => x.statut === 'reussi').reduce((s, x) => s + x.montant, 0),
        enAttente: paiements().filter(x => ['en_attente', 'declare'].includes(x.statut)).reduce((s, x) => s + x.montant, 0),
        aVerifier: paiements().filter(x => x.statut === 'declare').length
      },
      paiements: list.slice(0, 200).map(paiementPublic)
    });
  }
  /* ── HQ : CONFIRMER un paiement — mot de passe PDG + n° de transaction obligatoires.
        C'est la SEULE voie manuelle vers « réussi » : jamais sur simple déclaration. ── */
  const pConf = p.match(/^\/api\/admin\/paiements\/([^/]+)\/(confirmer|refuser)$/);
  if (pConf && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    if (!db.admin || hashPassword(db.admin.salt, b.password || '') !== db.admin.passHash)
      return sendJson(res, 401, { error: 'Mot de passe PDG requis pour confirmer un paiement' });
    const pa = paiements().find(x => x.id === pConf[1] || x.ref === pConf[1]);
    if (!pa) return sendJson(res, 404, { error: 'Paiement introuvable' });
    if (pa.statut === 'reussi') return sendJson(res, 409, { error: 'Paiement déjà confirmé' });
    if (pConf[2] === 'confirmer') {
      const txSaisi = String(b.txOperateur || '').replace(/[^A-Za-z0-9\-\.\/]/g, '').slice(0, 40);
      const tx = txSaisi || pa.txOperateur || '';
      if (!tx) return sendJson(res, 400, { error: 'Indiquez le numéro de transaction lu chez l’opérateur (SMS ou application) — aucune confirmation sans preuve' });
      pa.txOperateur = tx;
      pa.txFourniPar = txSaisi ? 'PDG (saisi au moment de la confirmation)' : 'client (déclaré) — à vérifier sur le SMS de l’opérateur';
      pa.statut = 'reussi'; pa.confirmeAt = nowISO(); pa.confirmePar = 'PDG';
      tracePaiement(pa, '✅ Confirmation PDG — n° transaction opérateur ' + tx + ' (' + pa.txFourniPar + ')', 'PDG');
      saveDb(); auditLog('paiement_confirme', { ref: pa.ref, montant: pa.montant, tx, par: 'PDG' });
      emitAdmin('pay', '✅ Paiement ' + pa.ref + ' CONFIRMÉ — ' + pa.montant.toLocaleString('fr-FR') + ' F');
      bcAll({ type: 'paiement_update', paiement: paiementPublic(pa) });
      return sendJson(res, 200, { ok: true, paiement: paiementPublic(pa) });
    }
    pa.statut = 'echoue'; pa.motif = String(b.motif || 'Paiement non reçu').slice(0, 140); pa.confirmePar = 'PDG'; pa.confirmeAt = nowISO();
    tracePaiement(pa, '❌ Refusé par le PDG — ' + pa.motif, 'PDG');
    saveDb(); auditLog('paiement_refuse', { ref: pa.ref, motif: pa.motif, par: 'PDG' });
    bcAll({ type: 'paiement_update', paiement: paiementPublic(pa) });
    return sendJson(res, 200, { ok: true, paiement: paiementPublic(pa) });
  }
  /* ── 🔌 WEBHOOK fournisseur (quand l'API marchande sera branchée) :
        sans secret configuré, on REFUSE de valider — impossible de « simuler » un succès ── */
  const wHook = p.match(/^\/api\/pay\/webhook\/([a-z]+)$/);
  if (wHook && req.method === 'POST') {
    const op = wHook[1];
    const secret = process.env.KLEAN_PAY_WEBHOOK_SECRET || '';
    const body = await readBodyRaw(req);
    const sig = String(req.headers['x-klean-signature'] || req.headers['x-pay-signature'] || '');
    const attendu = secret ? crypto.createHmac('sha256', secret).update(body).digest('hex') : '';
    if (!secret) return sendJson(res, 503, { error: 'Intégration ' + operateurInfo(op).nom + ' non configurée : secret de webhook manquant (KLEAN_PAY_WEBHOOK_SECRET). Aucun paiement ne sera validé.', code: 'non_configure' });
    if (!sig || sig.toLowerCase() !== attendu.toLowerCase()) return sendJson(res, 401, { error: 'Signature invalide', code: 'signature' });
    let d = {}; try { d = JSON.parse(body || '{}'); } catch (e) {}
    const pa = paiements().find(x => x.ref === d.ref || x.txOperateur === d.txOperateur);
    if (!pa) return sendJson(res, 404, { error: 'Transaction inconnue' });
    if (String(d.statut || '').toLowerCase() === 'reussi' || d.success === true) {
      pa.statut = 'reussi'; pa.confirmePar = 'Fournisseur ' + operateurInfo(op).nom; pa.confirmeAt = nowISO();
      if (d.txOperateur) pa.txOperateur = String(d.txOperateur).slice(0, 40);
      tracePaiement(pa, '✅ Confirmation FOURNISSEUR ' + operateurInfo(op).nom + ' (webhook signé)', 'webhook');
      saveDb(); bcAll({ type: 'paiement_update', paiement: paiementPublic(pa) });
      console.log('✅ Webhook ' + op + ' : paiement ' + pa.ref + ' confirmé');
      return sendJson(res, 200, { ok: true });
    }
    pa.statut = 'echoue'; pa.motif = String(d.motif || 'Refus du fournisseur').slice(0, 140); pa.confirmePar = 'Fournisseur ' + operateurInfo(op).nom;
    tracePaiement(pa, '❌ Refus FOURNISSEUR : ' + pa.motif, 'webhook');
    saveDb(); bcAll({ type: 'paiement_update', paiement: paiementPublic(pa) });
    return sendJson(res, 200, { ok: true });
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
      db.config.reachKm = Math.max(1, Math.min(800, Math.round(parseFloat(b2.reachKm))));
      auditLog('rayon_regle', { nouveau: db.config.reachKm, par: act(req) });
    }
    if (b2.gpsNationOn !== undefined) {
      db.config.gpsNationOn = !!b2.gpsNationOn;
      auditLog('gps_nation', { on: db.config.gpsNationOn, km: db.config.reachKm, par: act(req) });
    }
    auditLog('commission_modifiee', { nouveau: db.config.commission, par: act(req) });
    saveDb();
    emitAdmin('admin', `⚙️ Commission ${db.config.commission} % · rayon ${reachKm()} km · territoire ${gpsNationOn() ? 'ON' : 'off'}`);
    return sendJson(res, 200, { ok: true, commission: db.config.commission, reachKm: reachKm(), gpsNationOn: gpsNationOn() });
  }
  if (p === '/api/admin/gps-nation' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    db.config = db.config || {};
    if (b.reachKm !== undefined && !isNaN(parseFloat(b.reachKm))) {
      db.config.reachKm = Math.max(1, Math.min(800, Math.round(parseFloat(b.reachKm))));
    }
    if (b.on !== undefined) db.config.gpsNationOn = !!b.on;
    else db.config.gpsNationOn = true;
    db.config.updatedAt = nowISO();
    saveDb();
    auditLog('gps_nation', { on: gpsNationOn(), km: reachKm(), par: act(req) });
    emitAdmin('admin', gpsNationOn()
      ? ('📡 GPS Côte d’Ivoire ACTIVÉ — rayon ' + reachKm() + ' km, tout le monde peut se croiser')
      : '⚪ GPS territoire coupé');
    return sendJson(res, 200, { ok: true, reachKm: reachKm(), gpsNationOn: gpsNationOn() });
  }

  /* --- 🔒 Pouvoirs du PDG : bloquer / débloquer / supprimer un professionnel --- */
  const kickOut = id => { for (const s of [...sockets].filter(x => x.meta && x.meta.agentId === id)) { try { wsSend(s, { type: 'agent_denied', reason: 'blocked' }); } catch (e) {} try { s.end(); } catch (e) {} } };
  const aBlock = p.match(/^\/api\/admin\/agents\/(.+)\/block$/);
  if (aBlock && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const bB = await readBody(req);
    const motifP = String(bB.motif || bB.reason || '').trim().slice(0, 200);
    const ag = db.agents.find(a => a.id === aBlock[1]); if (!ag) return sendJson(res, 404, {});
    ag.blocked = true; ag.blockedAt = nowISO(); ag.online = false; if (motifP) ag.blockReason = motifP; saveDb(); kickOut(ag.id);
    (ag.history = ag.history || []).push({ at: nowISO(), by: act(req), action: 'bloque', motif: motifP });
    auditLog('pro_bloque', { pro: ag.nom, id: ag.id, motif: motifP });
    emitAdmin('admin', `🔒 ${ag.nom} bloqué${motifP ? ' — motif : ' + motifP : ''} — hors ligne, ne reçoit plus aucune demande`);
    console.log(`🔒 Professionnel bloqué : ${ag.nom}`);
    return sendJson(res, 200, { ok: true, blockReason: ag.blockReason || '' });
  }
  const aUnblock = p.match(/^\/api\/admin\/agents\/(.+)\/unblock$/);
  if (aUnblock && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const ag = db.agents.find(a => a.id === aUnblock[1]); if (!ag) return sendJson(res, 404, {});
    ag.blocked = false; delete ag.blockedAt; delete ag.blockReason; saveDb();
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
    db.missions.forEach(m => { if (m.agentId === ag.id && ['accepted', 'enroute', 'arrive', 'encours'].includes(m.status)) { m.status = 'pending'; m.agentId = null; m.cancelReason = 'pro supprime'; } });
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
    const bC = await readBody(req);
    const motifC = String(bC.motif || bC.reason || '').trim().slice(0, 200);
    const cl = db.clients.find(c => c.id === cBlock[1]); if (!cl) return sendJson(res, 404, {});
    cl.blocked = true; cl.blockedAt = nowISO(); if (motifC) cl.blockReason = motifC; saveDb();
    auditLog('client_bloque', { client: cl.nom, id: cl.id, motif: motifC });
    emitAdmin('admin', `🔒 Client ${cl.nom} bloqué${motifC ? ' — motif : ' + motifC : ''} — ne peut plus passer de demandes`);
    return sendJson(res, 200, { ok: true, blockReason: cl.blockReason || '' });
  }
  const cUnblock = p.match(/^\/api\/admin\/clients\/(.+)\/unblock$/);
  if (cUnblock && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const cl = db.clients.find(c => c.id === cUnblock[1]); if (!cl) return sendJson(res, 404, {});
    cl.blocked = false; delete cl.blockedAt; delete cl.blockReason; saveDb();
    auditLog('client_debloque', { client: cl.nom, id: cl.id });
    emitAdmin('admin', `✅ Client ${cl.nom} débloqué`);
    return sendJson(res, 200, { ok: true });
  }
  const cDel = p.match(/^\/api\/admin\/clients\/(.+)$/);
  if (cDel && req.method === 'DELETE') {
    if (!pdgOnly(req, res)) return;
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
  /* ═══ 🧼 nettoie/borne tout ce que le PDG envoie pour la publicité ═══ */
  function pubHex(v, def) {
    const x = String(v || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(x) ? x.toLowerCase() : def;
  }
  function pubMediaOk(u) {
    return /^\/pub\/[A-Za-z0-9_.-]{3,80}\.(jpe?g|png|webp|gif|mp4|webm)$/i.test(String(u || ''));
  }
  function sanitizeAd(b, base) {
    const a = Object.assign({}, base || {});
    const sTxt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n || 140);
    if (b.kind !== undefined) a.kind = ['produit', 'promo', 'lancement', 'stock'].includes(b.kind) ? b.kind : 'produit';
    if (b.firm !== undefined) a.firm = sTxt(b.firm, 60);
    if (b.prod !== undefined) a.prod = sTxt(b.prod, 80);
    if (b.cat !== undefined) a.cat = sTxt(b.cat, 20) || 'autre';
    if (b.text !== undefined) a.text = sTxt(b.text, 200);
    if (b.prix !== undefined) a.prix = sTxt(b.prix, 40);
    if (b.old !== undefined) a.old = sTxt(b.old, 40);
    if (b.off !== undefined) a.off = sTxt(b.off, 40);
    if (b.tel !== undefined) a.tel = String(b.tel || '').replace(/\D/g, '').slice(0, 15);
    if (b.clients !== undefined) a.hideClient = !b.clients;
    if (b.pros !== undefined) a.hideAgent = !b.pros;
    /* 🟩 fond vert : 2 couleurs du dégradé + un jeu prêt à l'emploi */
    if (b.fond1 !== undefined) a.fond1 = pubHex(b.fond1, a.fond1 || '#0e8a4c');
    if (b.fond2 !== undefined) a.fond2 = pubHex(b.fond2, a.fond2 || '#075f34');
    if (b.fond !== undefined) a.fond = ['emeraude', 'foret', 'menthe', 'lagon', 'ananas', 'perso'].includes(b.fond) ? b.fond : 'emeraude';
    /* ✍️ écriture */
    if (b.police !== undefined) a.police = ['moderne', 'classique', 'arrondie'].includes(b.police) ? b.police : 'moderne';
    if (b.taille !== undefined) a.taille = Math.max(12, Math.min(20, parseInt(b.taille, 10) || 14));
    /* ✨ clignotement */
    if (b.clignote !== undefined) a.clignote = !!b.clignote;
    if (b.rythme !== undefined) a.rythme = ['doux', 'moyen', 'net'].includes(b.rythme) ? b.rythme : 'doux';
    /* 🖼️ média : seul un chemin fabriqué par le serveur est accepté */
    if (b.mediaUrl !== undefined) {
      const u = String(b.mediaUrl || '');
      if (u && !pubMediaOk(u)) return { err: 'Média refusé (chemin invalide)' };
      if (a.mediaUrl && a.mediaUrl !== u) pubSupprimerFichier(a.mediaUrl);   // remplacé → on nettoie
      a.mediaUrl = u;
      a.mediaType = u ? (/^\/pub\/.*\.(mp4|webm)$/i.test(u) ? 'video' : 'image') : '';
    }
    if (b.actif !== undefined) a.active = !!b.actif;
    if (b.mediaType !== undefined && a.mediaUrl) a.mediaType = (b.mediaType === 'video' ? 'video' : 'image');
    a.parent = a.parent || 'accueil';
    a.majAt = nowISO();
    return { ad: a };
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
    const avant = db.ad || {};
    const r = sanitizeAd(b, {
      active: true, kind, firm, prod, cat: 'autre', text: '', prix: '', old: '', off: '', tel: '',
      hideClient: false, hideAgent: false, views: avant.views || {},
      fond: 'emeraude', fond1: '#0e8a4c', fond2: '#075f34',
      police: 'moderne', taille: 14, clignote: true, rythme: 'doux',
      mediaUrl: avant.mediaUrl || '', mediaType: avant.mediaType || '',
      at: avant.at || nowISO(), par: avant.par || act(req), parent: 'accueil'
    });
    if (r.err) return sendJson(res, 400, { error: r.err });
    r.ad.at = nowISO(); r.ad.par = act(req); r.ad.active = (b.actif === undefined) ? true : !!b.actif;
    db.ad = r.ad;
    saveDb();
    emitAdmin('annonce', '📣 Publicité mise à jour par le PDG');
    return sendJson(res, 200, { ok: true, ad: db.ad });
  }
  /* 🔌 activer / désactiver la publicité SANS la supprimer ni retoucher ses réglages */
  if (p === '/api/admin/ads/actif' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    if (!db.ad) return sendJson(res, 400, { error: 'Aucune publicité enregistrée' });
    db.ad.active = !!b.actif;
    db.ad.majAt = nowISO();
    saveDb();
    emitAdmin('annonce', db.ad.active ? '📣 Publicité ACTIVÉE pour les clients' : '⏸️ Publicité désactivée');
    return sendJson(res, 200, { ok: true, actif: db.ad.active });
  }
  /* ⬆️ TÉLÉVERSEMENT D'UN MÉDIA DE PUBLICITÉ (image ou vidéo) — PDG uniquement */
  if (p === '/api/admin/pub/media' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBodyBig(req, 2e7);
    if (!b) return sendJson(res, 413, { error: 'Fichier trop lourd (limite 12 Mo pour une vidéo, 3 Mo pour une image)' });
    const dataUrl = String(b.dataUrl || '');
    const m = dataUrl.match(/^data:([a-z0-9.+\/-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!m) return sendJson(res, 400, { error: 'Fichier illisible — choisissez une image JPG/PNG/WEBP/GIF ou une vidéo MP4/WEBM' });
    const mime = m[1].toLowerCase();
    const meta = PUB_MEDIA_TYPES[mime];
    if (!meta) return sendJson(res, 400, { error: 'Format non autorisé (' + mime + '). Images : JPG, PNG, WEBP, GIF. Vidéos : MP4, WEBM.' });
    let buf;
    try { buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64'); } catch (e) { return sendJson(res, 400, { error: 'Fichier illisible' }); }
    if (!buf || !buf.length) return sendJson(res, 400, { error: 'Fichier vide' });
    if (buf.length > meta.max) return sendJson(res, 413, { error: 'Trop lourd : ' + (buf.length / 1048576).toFixed(1) + ' Mo. Maximum ' + (meta.max / 1048576) + ' Mo pour une ' + meta.genre + '.' });
    const reel = pubTypeReel(buf);
    if (!reel) return sendJson(res, 400, { error: 'Ce fichier n’est pas une vraie image ou vidéo (contenu non reconnu)' });
    if (PUB_MEDIA_TYPES[reel].genre !== meta.genre) return sendJson(res, 400, { error: 'Le contenu du fichier ne correspond pas à son type' });
    const nom = 'pub-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + '.' + meta.ext;
    try { fs.writeFileSync(path.join(PUB_DIR, nom), buf); }
    catch (e) { return sendJson(res, 500, { error: 'Enregistrement impossible sur le serveur' }); }
    const ancien = db.ad && db.ad.mediaUrl;
    if (ancien && ancien !== '/pub/' + nom) pubSupprimerFichier(ancien);
    auditLog('pub_media', { nom, genre: meta.genre, octets: buf.length });
    return sendJson(res, 200, { ok: true, url: '/pub/' + nom, mediaType: meta.genre, octets: buf.length, mo: Math.round(buf.length / 104857.6) / 10 });
  }
  /* 🧹 retirer le média sans toucher au reste de la publicité */
  if (p === '/api/admin/pub/media' && req.method === 'DELETE') {
    if (!pdgOnly(req, res)) return;
    if (db.ad && db.ad.mediaUrl) { pubSupprimerFichier(db.ad.mediaUrl); db.ad.mediaUrl = ''; db.ad.mediaType = ''; db.ad.majAt = nowISO(); saveDb(); }
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/admin/ads' && req.method === 'DELETE') {
    if (!pdgOnly(req, res)) return;
    if (db.ad && db.ad.mediaUrl) pubSupprimerFichier(db.ad.mediaUrl);   // 🧹 pas de fichier orphelin
    db.ad = null; saveDb();
    return sendJson(res, 200, { ok: true });
  }

  /* ════════ 🎮 FLIP FIZZ — image / vidéo du jeu (téléversement PDG) ════════ */
  if (p === '/api/admin/flip/media' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBodyBig(req, 2e7);
    if (!b) return sendJson(res, 413, { error: 'Fichier trop lourd (limite 12 Mo vidéo / 3 Mo image)' });
    const out = pubMediaEnregistrer(String(b.dataUrl || ''));
    if (out.error) return sendJson(res, out.code || 400, { error: out.error });
    const f = db.flip = db.flip || {};
    const genre = String(b.genre || 'image') === 'video' ? 'video' : 'image';
    if (genre === 'video') {
      if (f.videoUrl && f.videoUrl !== out.url) pubSupprimerFichier(f.videoUrl);
      f.videoUrl = out.url;
    } else {
      if (f.mediaUrl && f.mediaUrl !== out.url) pubSupprimerFichier(f.mediaUrl);
      f.mediaUrl = out.url; f.mediaType = out.mediaType;
    }
    f.majAt = nowISO(); saveDb();
    auditLog('flip_media', { url: out.url, genre, par: act(req) });
    return sendJson(res, 200, { ok: true, url: out.url, mediaType: out.mediaType, mo: out.mo, flip: f });
  }
  if (p === '/api/admin/flip/media' && req.method === 'DELETE') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const f = db.flip = db.flip || {};
    if (String(b.quoi || 'image') === 'video') { if (f.videoUrl) pubSupprimerFichier(f.videoUrl); f.videoUrl = ''; }
    else { if (f.mediaUrl) pubSupprimerFichier(f.mediaUrl); f.mediaUrl = ''; f.mediaType = ''; }
    f.majAt = nowISO(); saveDb();
    return sendJson(res, 200, { ok: true, flip: f });
  }
  /* ════════ 🎁 RÉCOMPENSE — visuel (téléversement PDG, isolé de la publicité) ════════ */
  if (p === '/api/admin/recomp/media' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBodyBig(req, 2e7);
    if (!b) return sendJson(res, 413, { error: 'Fichier trop lourd' });
    const out = pubMediaEnregistrer(String(b.dataUrl || ''));
    if (out.error) return sendJson(res, out.code || 400, { error: out.error });
    auditLog('recomp_media', { url: out.url, par: act(req) });
    return sendJson(res, 200, { ok: true, url: out.url, mediaType: out.mediaType, mo: out.mo });
  }

  /* ════════ 🎮 FLIP FIZZ — réglages complets (PDG) ════════ */
  if (p === '/api/admin/flip' && req.method === 'GET') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    return sendJson(res, 200, { ok: true, flip: flipCfg(), stats: flipStats(), quotas: { partiesJour: flipCfg().partiesJour } });
  }
  if (p === '/api/admin/flip' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const f = db.flip = db.flip || {};
    const sTxt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n || 200);
    if (b.actif !== undefined) f.actif = !!b.actif;
    if (b.accueil !== undefined) f.accueil = !!b.accueil;
    if (b.titre !== undefined) f.titre = sTxt(b.titre, 40) || 'Flip Fizz';
    if (b.desc !== undefined) f.desc = sTxt(b.desc, 240);
    if (b.regles !== undefined) f.regles = sTxt(b.regles, 1200);
    if (b.url !== undefined) {
      const u = String(b.url || '').trim();
      f.url = /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/[^\s]*)?$/i.test(u) ? u.slice(0, 200) : (u ? f.url : '');
    }
    if (b.mediaUrl !== undefined) {
      const u = String(b.mediaUrl || '');
      if (u && !pubMediaOk(u)) return sendJson(res, 400, { error: 'Image refusée (téléversez-la depuis ce panneau)' });
      f.mediaUrl = u; f.mediaType = u ? (/^\/pub\/.*\.(mp4|webm)$/i.test(u) ? 'video' : 'image') : '';
    }
    if (b.videoUrl !== undefined) {
      const u = String(b.videoUrl || '');
      if (u && !pubMediaOk(u)) return sendJson(res, 400, { error: 'Vidéo refusée (téléversez-la depuis ce panneau)' });
      f.videoUrl = u;
    }
    if (b.partiesJour !== undefined) f.partiesJour = Math.max(0, Math.min(50, parseInt(b.partiesJour, 10) || 0));
    if (b.pointsParPartie !== undefined) f.pointsParPartie = Math.max(1, Math.min(500, parseInt(b.pointsParPartie, 10) || 10));
    if (b.pointsBonus !== undefined) f.pointsBonus = Math.max(0, Math.min(500, parseInt(b.pointsBonus, 10) || 0));
    if (b.seuilBonus !== undefined) f.seuilBonus = Math.max(1, Math.min(99999, parseInt(b.seuilBonus, 10) || 100));
    if (b.recompensesActives !== undefined) f.recompensesActives = !!b.recompensesActives;
    if (b.dureeMin !== undefined) f.dureeMin = Math.max(0, Math.min(600, parseInt(b.dureeMin, 10) || 0));
    f.majAt = nowISO(); f.par = act(req);
    saveDb();
    auditLog('flip_config', { actif: f.actif, accueil: f.accueil, par: act(req) });
    emitAdmin('annonce', (f.actif && f.accueil) ? '🎮 Flip Fizz AFFICHÉ sur la page d’accueil' : (f.actif ? '🎮 Flip Fizz activé (non affiché sur l’accueil)' : '⏸️ Flip Fizz désactivé'));
    return sendJson(res, 200, { ok: true, flip: f, stats: flipStats() });
  }
  /* ════════ 🎁 RÉCOMPENSES — création / modification / suppression (PDG) ════════ */
  if (p === '/api/admin/recompenses' && req.method === 'GET') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    return sendJson(res, 200, { ok: true, liste: db.recompenses || [], stats: flipStats() });
  }
  if (p === '/api/admin/recompenses' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const sTxt = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
    const nom = sTxt(b.nom, 60);
    if (nom.length < 2) return sendJson(res, 400, { error: 'Nom de la récompense requis' });
    const d0 = new Date(b.debut || ''), f0 = new Date(b.fin || '');
    const rec = {
      id: String(b.id || '').trim() || uid('RE'),
      nom, desc: sTxt(b.desc, 200),
      mediaUrl: pubMediaOk(b.mediaUrl) ? String(b.mediaUrl) : '',
      points: Math.max(1, Math.min(100000, parseInt(b.points, 10) || 100)),
      stock: (b.stock === '' || b.stock === null || b.stock === undefined) ? null : Math.max(0, Math.min(100000, parseInt(b.stock, 10) || 0)),
      debut: (b.debut && !isNaN(d0)) ? b.debut.slice(0, 10) : '',
      fin: (b.fin && !isNaN(f0)) ? b.fin.slice(0, 10) : '',
      actif: b.actif !== undefined ? !!b.actif : true,
      unique: b.unique !== false,
      type: ['reduction', 'coupon', 'partenaire', 'avantage', 'cadeau'].includes(b.type) ? b.type : 'cadeau',
      at: nowISO(), par: act(req)
    };
    const i = (db.recompenses || []).findIndex(x => x.id === rec.id);
    if (i >= 0) { rec.claims = db.recompenses[i].claims || []; rec.at = db.recompenses[i].at; db.recompenses[i] = rec; }
    else db.recompenses.push(rec);
    saveDb();
    auditLog('recompense_enregistree', { nom: rec.nom, points: rec.points, par: act(req) });
    return sendJson(res, 200, { ok: true, recompense: rec, liste: db.recompenses });
  }
  if (p === '/api/admin/recompenses/suppr' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const r = (db.recompenses || []).find(x => x.id === String(b.id || ''));
    if (!r) return sendJson(res, 404, { error: 'Introuvable' });
    /* 🛡️ on n'efface pas une récompense déjà remise : on la désactive (les clients gardent leur gain) */
    if ((r.claims || []).length) { r.actif = false; saveDb(); return sendJson(res, 200, { ok: true, desactivee: true, message: 'Récompense désactivée (déjà remise ' + r.claims.length + ' fois : elle est conservée pour l’historique des clients)' }); }
    db.recompenses = db.recompenses.filter(x => x.id !== r.id);
    saveDb();
    return sendJson(res, 200, { ok: true, supprimee: true });
  }
  /* ════════ 🧠 QUIZ — catégories, questions, activation, statistiques (PDG) ════════ */
  if (p === '/api/admin/quiz-bank' && req.method === 'GET') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    return sendJson(res, 200, { ok: true, banque: db.quizBank, stats: quizStats(), cfg: quizCfgQuiz(),
      defiQuestion: (() => { const q = quizDefiQuestion(); return q ? { id: q.id, q: q.q } : null; })(),
      reponses: (db.quizPlay || []).slice(-80).reverse() });
  }
  if (p === '/api/admin/quiz-bank' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const sTxt = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
    /* ⚙️ réglages du quiz : 🎯 défi quotidien et 🔥 séries (bornés côté serveur) */
    if (b.type === 'reglages') {
      const c = db.quizCfg = db.quizCfg || {};
      const nb = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d; };
      if (b.defiActif !== undefined) c.defiActif = !!b.defiActif;
      if (b.defiPoints !== undefined) c.defiPoints = nb(b.defiPoints, 10, 0, 1000);
      if (b.seriePas !== undefined) c.seriePas = nb(b.seriePas, 5, 0, 50);
      if (b.serieBonus !== undefined) c.serieBonus = nb(b.serieBonus, 5, 0, 500);
      if (b.defiQuestionId !== undefined) {
        const id = String(b.defiQuestionId || '').slice(0, 40);
        c.defiQuestionId = (id && (db.quizBank.questions || []).some(q => q.id === id)) ? id : '';   /* vide = tirage auto */
      }
      saveDb();
      auditLog('quiz_reglages', Object.assign({ par: act(req) }, quizCfgQuiz()));
      return sendJson(res, 200, { ok: true, cfg: quizCfgQuiz() });
    }
    if (b.type === 'categorie') {
      const nom = sTxt(b.nom, 40);
      if (nom.length < 2) return sendJson(res, 400, { error: 'Nom de catégorie requis' });
      const cat = { id: String(b.id || '').trim() || uid('QC'), nom, ic: sTxt(b.ic, 4) || '🧠', desc: sTxt(b.desc, 120), actif: b.actif !== false, at: nowISO() };
      const i = db.quizBank.categories.findIndex(x => x.id === cat.id);
      if (i >= 0) db.quizBank.categories[i] = Object.assign(db.quizBank.categories[i], cat);
      else db.quizBank.categories.push(cat);
      saveDb();
      return sendJson(res, 200, { ok: true, categorie: cat, banque: db.quizBank });
    }
    /* question */
    const q = sTxt(b.q, 240);
    if (q.length < 6) return sendJson(res, 400, { error: 'Question trop courte' });
    const choix = Array.isArray(b.choix) ? b.choix.map(x => sTxt(x, 90)).filter(Boolean).slice(0, 4) : [];
    if (choix.length < 2) return sendJson(res, 400, { error: 'Au moins 2 réponses possibles' });
    const bonne = Math.max(0, Math.min(choix.length - 1, parseInt(b.bonne, 10) || 0));
    const rec = {
      id: String(b.id || '').trim() || uid('QQ'), cat: sTxt(b.cat, 40), niveau: Math.max(1, Math.min(3, parseInt(b.niveau, 10) || 1)),
      q, choix, bonne, points: Math.max(1, Math.min(1000, parseInt(b.points, 10) || 10)),
      expl: sTxt(b.expl, 200), actif: b.actif !== false,
      debut: b.debut ? String(b.debut).slice(0, 16) : '', createdBy: act(req), at: nowISO()
    };
    const i = db.quizBank.questions.findIndex(x => x.id === rec.id);
    if (i >= 0) db.quizBank.questions[i] = Object.assign(db.quizBank.questions[i], rec);
    else db.quizBank.questions.push(rec);
    saveDb();
    auditLog('quiz_question', { q: rec.q.slice(0, 60), par: act(req) });
    return sendJson(res, 200, { ok: true, question: rec, banque: db.quizBank });
  }
  if (p === '/api/admin/quiz-bank/suppr' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const id = String(b.id || '');
    if (b.type === 'categorie') db.quizBank.categories = db.quizBank.categories.filter(x => x.id !== id);
    else {
      const qu = db.quizBank.questions.find(x => x.id === id);
      if (qu && (db.quizPlay || []).some(x => x.qid === id)) { qu.actif = false; saveDb(); return sendJson(res, 200, { ok: true, desactivee: true, message: 'Question désactivée (des clients y ont déjà répondu : elle est conservée pour leur historique)' }); }
      db.quizBank.questions = db.quizBank.questions.filter(x => x.id !== id);
    }
    saveDb();
    return sendJson(res, 200, { ok: true, banque: db.quizBank });
  }
  /* ════════ ℹ️ INFORMATIONS — contenus publiés par le HQ ════════ */
  if (p === '/api/admin/infos' && req.method === 'GET') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    return sendJson(res, 200, { ok: true, liste: db.infos || [] });
  }
  if (p === '/api/admin/infos' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const sTxt = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
    const titre = sTxt(b.titre, 90);
    if (titre.length < 3) return sendJson(res, 400, { error: 'Titre requis' });
    const rec = {
      id: String(b.id || '').trim() || uid('IN'), cat: sTxt(b.cat, 30) || 'actualite', ic: sTxt(b.ic, 4) || 'ℹ️',
      titre, texte: sTxt(b.texte, 1200), cible: ['client', 'pro', 'tous'].includes(b.cible) ? b.cible : 'tous',
      epin: !!b.epin, actif: b.actif !== false,
      debut: b.debut ? String(b.debut).slice(0, 10) : '', fin: b.fin ? String(b.fin).slice(0, 10) : '',
      at: nowISO(), par: act(req)
    };
    const i = (db.infos || []).findIndex(x => x.id === rec.id);
    if (i >= 0) { rec.at = db.infos[i].at; db.infos[i] = rec; } else db.infos.push(rec);
    saveDb();
    return sendJson(res, 200, { ok: true, info: rec, liste: db.infos });
  }
  if (p === '/api/admin/infos/suppr' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    db.infos = (db.infos || []).filter(x => x.id !== String(b.id || ''));
    saveDb();
    return sendJson(res, 200, { ok: true, liste: db.infos });
  }
  /* ════════ 🆘 URGENCE — alertes reçues (suivi PDG) ════════ */
  if (p === '/api/admin/urgences' && req.method === 'GET') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const liste = (db.urgHist || []).slice(-120).reverse();
    return sendJson(res, 200, { ok: true, liste, total: (db.urgHist || []).length,
      aujourdhui: (db.urgHist || []).filter(x => (x.at || '').slice(0, 10) === nowISO().slice(0, 10)).length });
  }
  if (p === '/api/admin/urgences/statut' && req.method === 'POST') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const b = await readBody(req);
    const r = (db.urgHist || []).find(x => x.id === String(b.id || ''));
    if (r) { r.statut = ['nouvelle', 'en_cours', 'traitee', 'fausse_alerte'].includes(b.statut) ? b.statut : r.statut; r.majAt = nowISO(); saveDb(); }
    return sendJson(res, 200, { ok: true });
  }
  /* ════════ 📊 STATISTIQUES GLOBALES du jeu (pour le panneau PDG) ════════ */
  if (p === '/api/admin/flip/stats' && req.method === 'GET') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    return sendJson(res, 200, { ok: true, stats: flipStats(), quiz: quizStats() });
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
    /* 🎟️ Code d'accès (4 à 8 chiffres) : donné par le PDG ou tiré au hasard — connexion rapide par téléphone + code */
    let code = String(b.pin || b.code || '').replace(/\D/g, '').slice(0, 8);
    if (code && code.length < 4) return sendJson(res, 400, { error: 'Le code d’accès doit faire 4 à 8 chiffres' });
    const codePris = c => [...db.clients.map(x => x.codeAcces), ...db.agents.map(x => x.codeAcces || x.claimPin)].filter(Boolean).map(String).includes(c);
    if (!code) { do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (codePris(code)); }
    if (codePris(code)) return sendJson(res, 409, { error: 'Ce code est déjà utilisé par un autre compte — changez-en un autre' });
    const salt = crypto.randomBytes(12).toString('hex');
    const fid = fieldIdentity(req);
    const cl = { id: uid('CL'), nom, tel, quartier: String(b.quartier || '').trim(), ville: String(b.ville || '').trim().slice(0, 60), mail: String(b.mail || '').trim().slice(0, 80), salt, passHash: hashPassword(salt, pw), codeAcces: code, createdAt: nowISO(), createdBy: act(req), createdById: actorId(req) || (fid && fid.id), createdByGestId: fid ? fid.gestId : (hqIdentity(req) && hqIdentity(req).role === 'gest' ? hqIdentity(req).id : null) };
    db.clients.push(cl); saveDb();
    auditLog('client_cree_hq', { nom, tel, par: act(req) });
    emitAdmin('client', '👤 Compte client créé par ' + act(req) + ' : ' + nom + ' (' + tel + ')');
    return sendJson(res, 201, { ok: true, id: cl.id, nom, tel, password: pw, passwordGenere: gen, pin: code, code });
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
    const na = { id: uid('AG'), nom: (prenom + ' ' + nom).trim(), prenom, tel1, tel: tel1, salt, passHash: hashPassword(salt, pw), quartier: String(b.quartier || '').trim(), ville: String(b.ville || '').trim().slice(0, 60), villeService: String(b.villeService || b.ville || '').trim().slice(0, 60), mail: String(b.mail || '').trim().slice(0, 80), adresse: String(b.adresse || '').trim(),
      naissance: '', experience: b.experience || 0, pieceType: '', pieceNum: '', tel2: '', urgenceNom: '', urgenceTel: '', ref1Nom: '', ref1Tel: '',
      services, niveau: '', photo: '', pushSubs: [], hist: [{ at: Date.now(), by: act(req), ev: '🏗️ Compte créé à la main par l’équipe — vérification immédiate' }],
      status: 'approved', approvedAt: nowISO(), createdAt: nowISO(), createdBy: act(req), createdById: actorId(req), createdByGestId: fieldIdentity(req) ? fieldIdentity(req).gestId : ((hqIdentity(req)||{}).role==='gest' ? hqIdentity(req).id : null), claimPin: pin, codeAcces: pin, online: false, pos: null, kind: 'pro' };
    na.zone = na.zone || { km: matchCfg().rayonDefautKm, villes: [] };
    db.agents.push(na);
    ensureNumPro(na);
    const jetonPro = issueAgentJeton(na);
    saveDb();
    auditLog('pro_cree_hq', { pro: na.nom, tel: tel1, numPro: na.numPro, par: act(req) });
    emitAdmin('agent', '🏗️ ' + act(req) + ' a créé le professionnel ' + na.nom + ' (' + na.numPro + ') — code de liaison remis en main');
    return sendJson(res, 201, { ok: true, id: na.id, nom: na.nom, tel: tel1, pin, code: pin, password: pw, numPro: na.numPro, jeton: jetonPro });
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
    if (oldId) invaliderStats(oldId);
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
    rq.status = b.accept ? 'acceptee' : 'refusee'; rq.decidedAt = nowISO(); rq.decidedBy = act(req);
    let applique = false, detail = '';
    if (b.accept && rq.targetId) {
      const motifFinal = String(b.motif || rq.motif || ('Demande de ' + (rq.by || 'gestionnaire'))).slice(0, 200);
      if (rq.role === 'client') {
        const cl = db.clients.find(c => c.id === rq.targetId);
        if (cl) {
          if (rq.kind === 'block') {
            cl.blocked = true; cl.blockedAt = nowISO(); cl.blockReason = motifFinal;
            auditLog('client_bloque', { client: cl.nom, id: cl.id, motif: motifFinal, par: act(req) });
            emitAdmin('admin', '🔒 ' + cl.nom + ' bloqué (demande de ' + rq.by + ') — motif : ' + motifFinal);
          } else {
            const busy = db.missions.some(m => m.clientId === cl.id && ['accepted', 'enroute', 'arrive', 'encours'].includes(m.status));
            if (busy) { detail = 'Mission en cours : le client a été BLOQUÉ à la place. Supprimez-le après la fin.'; cl.blocked = true; cl.blockedAt = nowISO(); cl.blockReason = motifFinal; }
            else {
              db.missions.forEach(m => { if (m.clientId === cl.id && m.status === 'pending') { m.status = 'annulee'; m.cancelReason = 'compte supprime'; } });
              trashPush('client', cl);
              db.clients = db.clients.filter(c => c.id !== cl.id);
              auditLog('client_supprime', { client: cl.nom, id: cl.id, par: act(req), sur: 'demande de ' + rq.by });
              emitAdmin('admin', '🗑️ Client ' + cl.nom + ' supprimé (demande de ' + rq.by + ')');
            }
          }
          applique = true;
        }
      } else {
        const ag = db.agents.find(a => a.id === rq.targetId);
        if (ag) {
          if (rq.kind === 'block') {
            ag.blocked = true; ag.blockedAt = nowISO(); ag.online = false; ag.blockReason = motifFinal;
            (ag.history = ag.history || []).push({ at: nowISO(), by: act(req), action: 'bloque', motif: motifFinal });
            try { kickOut(ag.id); } catch (e) {}
            auditLog('pro_bloque', { pro: ag.nom, id: ag.id, motif: motifFinal, par: act(req) });
            emitAdmin('admin', '🔒 ' + ag.nom + ' bloqué (demande de ' + rq.by + ') — motif : ' + motifFinal);
          } else {
            const busy = db.missions.some(m => m.agentId === ag.id && ['accepted', 'enroute', 'arrive', 'encours'].includes(m.status));
            if (busy) { detail = 'Mission en cours : le pro a été BLOQUÉ à la place. Supprimez-le après la fin.'; ag.blocked = true; ag.blockedAt = nowISO(); ag.online = false; ag.blockReason = motifFinal; try { kickOut(ag.id); } catch (e) {} }
            else {
              trashPush('agent', ag);
              db.agents = db.agents.filter(a => a.id !== ag.id);
              auditLog('pro_supprime', { pro: ag.nom, id: ag.id, par: act(req), sur: 'demande de ' + rq.by });
              emitAdmin('admin', '🗑️ ' + ag.nom + ' supprimé (demande de ' + rq.by + ')');
            }
          }
          applique = true;
        }
      }
    }
    saveDb();
    return sendJson(res, 200, { ok: true, applique, detail, kind: rq.kind, role: rq.role, nom: rq.nom });
  }
  if (p === '/api/admin/account-request/voir' && req.method === 'GET') {
    if (!pdgOnly(req, res)) return;
    const toutes = (db.accountRequests || []).slice().reverse();
    return sendJson(res, 200, { ok: true, enAttente: toutes.filter(x => x.status === 'pending'), historique: toutes.filter(x => x.status !== 'pending').slice(0, 30) });
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
    const enrichi = (db.trash || []).map(t => {
      let missions = 0;
      if (t.kind === 'client') missions = db.missions.filter(m => m.clientId === t.data.id && m.status === 'annulee' && m.cancelReason === 'compte supprime').length;
      else if (t.kind === 'agent') missions = db.missions.filter(m => m.agentId === t.data.id).length;
      return { id: t.id, kind: t.kind, at: t.at, data: t.data, missions,
        compte: { clients: db.clients.some(c => c.tel === t.data.tel), pros: db.agents.some(a => String(a.tel1 || a.tel || '').replace(/\D/g, '') === String(t.data.tel || t.data.tel1 || '').replace(/\D/g, '')) } };
    });
    return sendJson(res, 200, enrichi);
  }
  if (p === '/api/admin/trash/restore' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const t = (db.trash || []).find(x => x.id === b.id);
    if (!t) return sendJson(res, 404, {});
    let ramenees = 0, compte = '';
    if (t.kind === 'client') {
      db.clients.push(t.data);
      compte = t.data.nom;
      /* ♻️ on ramène SES anciennes missions : celles annulées au moment de la suppression repartent en circulation */
      for (const m of db.missions) {
        if (m.clientId === t.data.id && m.status === 'annulee' && m.cancelReason === 'compte supprime') {
          m.status = 'pending';
          delete m.cancelReason;
          m.hist = m.hist || [];
          m.hist.push({ at: Date.now(), by: act(req), ev: '♻️ Compte restauré — mission remise en circulation' });
          ramenees++;
          try { broadcastNewMission(m); } catch (e) {}
        }
      }
    } else if (t.kind === 'agent') {
      db.agents.push(t.data);
      compte = t.data.nom;
      /* ♻️ on ramène aussi les missions que ce pro avait en cours avant sa suppression */
      for (const m of db.missions) {
        if (m.agentId === t.data.id && ['annulee'].includes(m.status) && m.cancelReason === 'pro supprime') {
          m.status = 'pending'; m.agentId = null;
          delete m.cancelReason;
          m.hist = m.hist || [];
          m.hist.push({ at: Date.now(), by: act(req), ev: '♻️ Professionnel restauré — mission remise en circulation' });
          ramenees++;
          try { broadcastNewMission(m); } catch (e) {}
        }
      }
    } else if (t.kind === 'field') db.fieldAgents = [...(db.fieldAgents || []), t.data];
    db.trash = db.trash.filter(x => x.id !== t.id);
    saveDb();
    auditLog('compte_restaure', { type: t.kind, nom: compte, missions: ramenees, par: act(req) });
    if (t.kind !== 'field') emitAdmin('admin', `♻️ ${compte} restauré${ramenees ? ' — ' + ramenees + ' mission(s) remise(s) en circulation' : ''}`);
    return sendJson(res, 200, { ok: true, missionsRamenees: ramenees, nom: compte });
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
      (a.status || 'approved') === 'approved' && !a.blocked &&
      (normVille(a.villeService || a.ville) === normVille(villeN) ||
       normVille(a.villeIci) === normVille(villeN) ||
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
  /* ═══════════════════════════════════════════════════════════════════════
     🔒 LISTE BLANCHE DES FICHIERS PUBLICS
     Avant ce correctif, TOUT fichier posé à la racine était téléchargeable :
     /db.json (toute la base : téléphones, jetons, paiements) et /server.js
     étaient accessibles à n'importe qui. On n'expose plus que ce dont
     l'application a besoin + les médias de publicité (/pub/…).
     ═══════════════════════════════════════════════════════════════════════ */
  const PUB_FICHIERS = new Set([
    '/index.html', '/admin.html', '/admin-login.html', '/gest.html', '/gest-login.html', '/field.html',
    '/net.js', '/sw.js', '/hq-sw.js', '/klean-guard.js',
    '/manifest.json', '/manifest-hq.json', '/favicon.ico', '/robots.txt'
  ]);
  const PUB_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.css', '.woff2', '.mp4', '.webm']);
  const ext = path.extname(file).toLowerCase();
  const dansPub = /^\/pub\/[A-Za-z0-9_.-]{3,80}\.(jpe?g|png|webp|gif|mp4|webm)$/i.test(file);
  if (!PUB_FICHIERS.has(file) && !PUB_EXT.has(ext) && !dansPub) {
    res.writeHead(404, { 'X-Content-Type-Options': 'nosniff' }); res.end('404'); return;
  }
  if (dansPub) file = '/pub/' + path.basename(file);
  const fp = path.join(__dirname, file);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
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
      if (ag && ![...sockets].some(s => s.meta && s.meta.agentId === ag.id)) {
        if (ag.stayOnline) { ag.lastSeen = ag.lastSeen || nowISO(); }
        else { ag.online = false; saveDb(); }
      }
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
    try {
      const cree = seedPayMethods();   // 💳 reprise des numéros existants au premier démarrage
      const n = payMethods().filter(m => m.actif).length;
      console.log('  💳 Moyens de paiement : ' + n + ' actif(s)' + (cree ? ' (initialisés depuis les numéros existants)' : ''));
      console.log('  🔌 CinetPay (agrégateur) : ' + (cinetpayPret(null) ? 'configuré ✓ — paiement en ligne + vérification automatique' : 'non configuré → ' + cinetpayManque(null).length + ' élément(s) manquant(s), confirmation par le PDG (aucun succès automatique)'));
    } catch (e) { console.error('Paiement :', e); }
  }).catch(e => { console.error('Stockage :', e); });
});
