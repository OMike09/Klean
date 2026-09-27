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
/* 💾 Valeurs par défaut : appliquées au DÉMARRAGE et après une RESTAURATION de sauvegarde.
   Aucune donnée existante n'est remplacée : on ne pose que ce qui manque. */
function poserDefauts() {
  db.agents = db.agents || []; db.missions = db.missions || []; db.clients = db.clients || [];
  if (!db.config || typeof db.config.commission !== 'number') db.config = { commission: 25, updatedAt: null };
  db.config.payDest = db.config.payDest || { wave: ['0100277521', '0709076130'], om: '0709076130', moov: '0100277521', hide: false };
  /* 📞 coordonnées publiques de Klean-Service (téléphone + WhatsApp), réglées par le PDG.
     ⚠️ Volontairement VIDES au départ : on n'invente jamais un numéro. Tant qu'elles sont vides,
     l'application renvoie vers l'assistance interne au lieu d'afficher un faux numéro. */
  db.config.contact = db.config.contact || { tel: '', whatsapp: '' };
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
  db.litiges = db.litiges || [];            // 🟠 litiges & remboursements (lot 99) — dossiers de réclamation
  db.pubFiles = db.pubFiles || {};          // 🖼️ copie des médias de publicité (lot 100) — survit aux redéploiements
  /* ═══ 🎮 JEUX EN DIRECT (lot 101) ═══ */
  db.jeux = db.jeux || [];                  // jeux créés depuis le HQ (configurations)
  db.jeuxParties = db.jeuxParties || [];    // parties en direct (participants, éliminations, gagnants)
  db.vitesses = Object.assign({ pub: 3.2, jeux: 3.2, urgence: 3.2, infos: 3.2 }, db.vitesses || {});
}

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
  poserDefauts();
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
        return pgClient.query('UPDATE klean_state SET data=$1, updated=now() WHERE id=1', [JSON.parse(snap)])
          .then(() => { sauvegardeAuto().catch(() => { }); });      /* 💾 historique automatique (1× / 30 min) */
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
    tarif: m.tarif || null, ville: m.ville || '',
    devis: m.devis || null, prixVerrouille: m.prixVerrouille || null,   /* 🧾 lot 109 : le pro voit le devis et le verrou */
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
/* ═══════════ 🆕 MÉTIERS AJOUTÉS PAR LA RECHERCHE EN LANGAGE SIMPLE (lot 102) ═══════════
   Le PDG a demandé que le client n'ait jamais besoin de connaître le nom professionnel du service.
   Ces métiers complètent le catalogue : AUCUN métier existant n'a été supprimé ni renommé.
   « famille » sert à ranger/expliquer · « mots » sont les mots-clés (synonymes ET fautes courantes). */
const SVC_NOUVEAUX = {
  peinture:   { ic:'🎨', nom:'Peinture & façades',      base:15000, desc:'Murs, plafonds, façades', famille:'bâtiment',   mots:'peinture peintre repeindre badigeon mur murs plafond facade laque vernis enduit couleur ' },
  carrelage:  { ic:'🧱', nom:'Carrelage & faïence',     base:18000, desc:'Sols, murs, faïence, joints', famille:'bâtiment',   mots:'carrelage carreleur carreau faience dalle sol murale joint pose ' },
  macon:      { ic:'🏗️', nom:'Maçonnerie & clôtures',   base:20000, desc:'Murs, dalles, clôtures, crépissage', famille:'bâtiment',   mots:'macon maconnerie cloture portail mur dalle ciment beton crepissage fondation ' },
  menuiserie: { ic:'🪵', nom:'Menuiserie & meubles',    base:15000, desc:'Portes, placards, meubles sur mesure', famille:'bâtiment',   mots:'menuisier menuiserie bois meuble placard armoire table lit porte charniere sur mesure ebeniste ' },
  vitrerie:   { ic:'🪞', nom:'Vitrerie & miroirs',      base:8000,  desc:'Vitres cassées, miroirs, vitrines', famille:'bâtiment',   mots:'vitrier vitrerie vitre glace miroir verre cassure ' },
  soudure:    { ic:'🔥', nom:'Soudure & ferronnerie',   base:10000, desc:'Portails, grilles, ferronnerie', famille:'bâtiment',   mots:'soudeur souder soudure fer ferronnerie grille barriere metallique portail metal portail casse reparer portail ' },
  meca_auto:  { ic:'🚙', nom:'Mécanique auto',          base:15000, desc:'Panne, vidange, freins, batterie', famille:'réparation', mots:'mecanicien mecanicien mecano meca garagiste voiture auto vehicule panne batterie pneu creve vidange freins moteur courroie demarrage ' },
  meca_moto:  { ic:'🏍️', nom:'Mécanique moto',          base:8000,  desc:'Entretien et réparation de moto', famille:'réparation', mots:'moto motocyclette scooter mecanicien panne chaine huile ' },
  telephone:  { ic:'📱', nom:'Réparation téléphone',    base:8000,  desc:'Écran, batterie, connecteur', famille:'réparation', mots:'telephone portable smartphone ecran tactile batterie reparateur vitre arriere connecteur ' },
  ordinateur: { ic:'💻', nom:'Ordinateur & informatique',base:10000, desc:'Dépannage, nettoyage, logiciels', famille:'réparation', mots:'ordinateur pc laptop portable informaticien windows logiciel fichier imprimante lent virus ' },
  internet:   { ic:'📶', nom:'Internet & wifi',         base:10000, desc:'Wifi, box, câblage, réseau', famille:'installation', mots:'internet wifi connexion routeur box fibre reseau lente debit ' },
  camera:     { ic:'📹', nom:'Caméras & alarmes',       base:25000, desc:'Caméras, alarmes, interphone', famille:'installation', mots:'camera cameras surveillance videosurveillance alarme securite interphone portail surveillance ' },
  cordonnerie:{ ic:'👟', nom:'Cordonnerie (chaussures, sacs)', base:3000, desc:'Chaussures, sacs, ceintures', famille:'réparation', mots:'cordonnier chaussure chaussures sac talon semelle couture cuir ' },
  documents:  { ic:'🖨️', nom:'Documents, CV & impression', base:3000, desc:'CV, dossiers, impression, scan', famille:'services', mots:'cv impression imprimer photocopie scanner taper document affiche flyer logo carte visite brocure reluire ' },
  conseil:    { ic:'💼', nom:'Conseil & entreprise',    base:25000, desc:'Entreprise, démarches, projets', famille:'services',   mots:'comptable comptabilite business plan entreprise etude marche fiscal declaration community manager publicite communication marketing ' },
  immobilier: { ic:'🏘️', nom:'Immobilier',              base:15000, desc:'Visite, location, achat, vente', famille:'services',   mots:'immobilier maison chambre appartement terrain location louer vendre locataire visite agence ' },
  coiffure:   { ic:'💈', nom:'Coiffure à domicile',     base:5000,  desc:'Coiffure à domicile', famille:'personne',   mots:'coiffeur coiffeuse coiffure cheveux tresses nattes degrade barbe raser perruque meches ' },
  beaute:     { ic:'💅', nom:'Beauté & soins',          base:6000,  desc:'Ongles, maquillage, soins', famille:'personne',   mots:'ongles manucure pedicure maquillage maquilleuse beaute soin visage cils epilation esthetique ' },
  photo:      { ic:'📸', nom:'Photo & vidéo',           base:25000, desc:'Photos et vidéos, montage', famille:'personne',   mots:'photographe photo video videaste cameraman film montage retouche mariage shooting ' },
  couture:    { ic:'🧵', nom:'Couture & retouches',     base:8000,  desc:'Retouches, couture sur mesure', famille:'personne',   mots:'couturier couturiere couture robe chemise pantalon tenue retouche fermeture tailleur sur mesure ' },
  livraison:  { ic:'🛵', nom:'Livraison & coursier',    base:3000,  desc:'Colis, courses, documents', famille:'transport',  mots:'livreur livraison colis coursier paquet document deplacement envoi transport express ' },
  chauffeur:  { ic:'🚕', nom:'Chauffeur',               base:15000, desc:'Déplacements, transferts, mise à dispo', famille:'transport',  mots:'chauffeur voiture avec conducteur deplacement trajet conduire ' }
};
/* on AJOUTE ces métiers au catalogue existant (les 22 d'origine restent intacts) */
for (const [id, s2] of Object.entries(SVC_NOUVEAUX)) SVC_CAT.push({ id, nom: s2.nom, ic: s2.ic, base: s2.base, desc: s2.desc || '', famille: s2.famille, mots: s2.mots });
/* ═══════════════════════════════════════════════════════════════════════════════
   📚 CATALOGUE NATIONAL KLEAN — Côte d'Ivoire (lot « Klean Service »)
   4 niveaux : CATÉGORIE → SERVICE → SOUS-SERVICE → TÂCHE  (768 tâches)
   Il est reconstruit à partir de KLEAN-CATALOGUE-NATIONAL.md par tools/construire-catalogue.py.
   Le PDG peut l'enrichir depuis le tableau de bord (ajouts, mots-clés, désactivations) —
   on ne SUPPRIME jamais une entrée utilisée par d'anciennes commandes : on la désactive.
   ═══════════════════════════════════════════════════════════════════════════════ */
const CAT_NAT_FAM = [
  { id:'maison', ic:'🏠', nom:'Maison, ménage & nettoyage', services:['1','2','44'], populaire:true },
  { id:'depannage', ic:'🔧', nom:'Dépannage & technique', services:['3','4','5','6'], populaire:true },
  { id:'travaux', ic:'🛠️', nom:'Bâtiment & travaux', services:['7','8','9','10'], populaire:true },
  { id:'transport', ic:'🚚', nom:'Transport, déménagement & stockage', services:['12','13','31'], populaire:true },
  { id:'auto', ic:'🚗', nom:'Auto & moto', services:['14','15'], populaire:true },
  { id:'pers', ic:'💇', nom:'Beauté, bien-être & sport', services:['18','19','20','21'], populaire:true },
  { id:'numerique', ic:'📱', nom:'Téléphone, informatique & sécurité', services:['16','17','26','37'], populaire:true },
  { id:'jardin', ic:'🌿', nom:'Jardin, animaux & agriculture', services:['11','32','33'], populaire:true },
  { id:'personne', ic:'👶', nom:'Personne, famille & main-d\'œuvre', services:['22','45'], populaire:true },
  { id:'cuisine', ic:'🍳', nom:'Cuisine, événementiel & médias', services:['23','24','25'], populaire:true },
  { id:'formation', ic:'🎓', nom:'Cours, formation & démarches', services:['27','28','29','46'], populaire:true },
  { id:'urgence', ic:'🚨', nom:'Urgence & dépannage immédiat', services:['43'], populaire:true },
  { id:'pro', ic:'🏢', nom:'Entreprises, commerces & hôtels', services:['39','40','41','42'], populaire:false },
  { id:'artisanat', ic:'✂️', nom:'Couture, artisanat & créations', services:['34','35','36'], populaire:false },
  { id:'immo', ic:'🏘️', nom:'Immobilier & voyageurs', services:['30','47'], populaire:false },
  { id:'funeraire', ic:'⚱️', nom:'Services funéraires', services:['38'], populaire:false },
  { id:'autre', ic:'🛠️', nom:'Je ne trouve pas mon service', services:['48'], populaire:false },
];
const CAT_NAT = [
  { num:'1', nom:'Maison, ménage et nettoyage', ic:'🏠', sous:[
    { num:'1.1', nom:'Ménage à domicile', taches:'ménage général|balayage|lavage des sols|nettoyage des murs|dépoussiérage|nettoyage des meubles|nettoyage des chambres|nettoyage du salon|nettoyage de la cuisine|nettoyage de la salle de bain|nettoyage des toilettes|nettoyage de la terrasse|nettoyage du balcon|nettoyage après réception|ménage avant emménagement|ménage après déménagement|ménage régulier|ménage ponctuel|grand ménage' },
    { num:'1.2', nom:'Nettoyage spécialisé', taches:'nettoyage de canapé|nettoyage de fauteuil|nettoyage de matelas|nettoyage de tapis|nettoyage de moquette|nettoyage de rideaux|nettoyage de vitres|nettoyage de baies vitrées|nettoyage de portes|nettoyage de façades|nettoyage de bureaux|nettoyage de magasins|nettoyage de restaurants|nettoyage d\'hôtels|nettoyage d\'écoles|nettoyage de locaux professionnels' },
    { num:'1.3', nom:'Nettoyage après travaux', taches:'nettoyage après construction|nettoyage après rénovation|enlèvement de poussière de chantier|nettoyage de peinture|nettoyage de ciment|nettoyage de carrelage après travaux|évacuation de petits déchets de chantier' },
    { num:'1.4', nom:'Désinfection et assainissement', taches:'désinfection de maison|désinfection de bureau|désinfection de toilettes|désinfection de locaux|traitement anti-odeurs|désinsectisation|dératisation|traitement contre les cafards|traitement contre les fourmis|traitement contre les moustiques|traitement contre les termites' },
  ]},
  { num:'2', nom:'Blanchisserie, linge et repassage', ic:'🧺', sous:[
    { num:'2.1', nom:'Linge', taches:'lavage de vêtements|lavage à la main|lavage en machine|lavage de linge de maison|lavage de draps|lavage de couvertures|lavage de couettes|lavage de serviettes' },
    { num:'2.2', nom:'Repassage', taches:'repassage de vêtements|repassage de chemises|repassage de pantalons|repassage de robes|repassage de tenues professionnelles|repassage de linge de maison' },
    { num:'2.3', nom:'Pressing', taches:'nettoyage à sec|nettoyage de costume|nettoyage de robe|nettoyage de veste|nettoyage de chaussures|nettoyage de sacs' },
    { num:'2.4', nom:'Collecte et livraison du linge', taches:'collecte du linge|livraison du linge|lavage + repassage|collecte + lavage + livraison' },
  ]},
  { num:'3', nom:'Plomberie et installations sanitaires', ic:'🔧', sous:[
    { num:'3.1', nom:'Dépannage plomberie', taches:'fuite d\'eau|fuite de robinet|fuite de tuyau|fuite sous évier|fuite de WC|fuite de douche|fuite de chauffe-eau|canalisation bouchée|évier bouché|lavabo bouché|douche bouchée|WC bouché' },
    { num:'3.2', nom:'Installation sanitaire', taches:'installation de robinet|installation de douche|installation de lavabo|installation de WC|installation d\'évier|installation de chauffe-eau|installation de tuyauterie|installation de réservoir d\'eau|installation de pompe' },
    { num:'3.3', nom:'Entretien plomberie', taches:'entretien de plomberie|entretien de chauffe-eau|nettoyage de canalisation|recherche de fuite|remplacement de tuyaux|remplacement de robinetterie' },
  ]},
  { num:'4', nom:'Électricité', ic:'💡', sous:[
    { num:'4.1', nom:'Dépannage électrique', taches:'panne électrique|coupure électrique intérieure|prise qui ne fonctionne pas|interrupteur défectueux|disjoncteur qui saute|court-circuit|problème d\'éclairage|problème de câblage' },
    { num:'4.2', nom:'Installation électrique', taches:'installation de prise|installation d\'interrupteur|installation de lampe|installation de plafonnier|installation de ventilateur|installation de climatiseur|installation de tableau électrique|câblage maison|câblage bureau|câblage magasin' },
    { num:'4.3', nom:'Sécurité électrique', taches:'diagnostic électrique|mise en sécurité|remplacement de tableau|remplacement de disjoncteur|mise à la terre|recherche de surcharge' },
  ]},
  { num:'5', nom:'Climatisation, froid et réfrigération', ic:'❄️', sous:[
    { num:'5.1', nom:'Climatisation', taches:'installation de climatiseur|entretien de climatiseur|nettoyage de climatiseur|recharge de gaz|dépannage de climatiseur|fuite de gaz|climatiseur qui ne refroidit plus|climatiseur qui coule|climatiseur bruyant|changement de condensateur|changement de ventilateur' },
    { num:'5.2', nom:'Réfrigération', taches:'réparation de réfrigérateur|réparation de congélateur|entretien de réfrigérateur|recharge de gaz frigo|diagnostic frigorifique|réparation de chambre froide|installation de chambre froide' },
  ]},
  { num:'6', nom:'Électroménager', ic:'🔌', sous:[
    { num:'6.1', nom:'Gros électroménager', taches:'réparation de réfrigérateur|réparation de congélateur|réparation de machine à laver|réparation de lave-vaisselle|réparation de four|réparation de cuisinière|réparation de chauffe-eau' },
    { num:'6.2', nom:'Petit électroménager', taches:'réparation de mixeur|réparation de blender|réparation de fer à repasser|réparation de micro-ondes|réparation d\'aspirateur|réparation de cafetière|réparation de bouilloire|réparation de ventilateur' },
    { num:'6.3', nom:'Prestations électroménager', taches:'diagnostic appareil|réparation appareil|entretien appareil|installation appareil|remplacement de pièces|démontage appareil|remontage appareil' },
  ]},
  { num:'7', nom:'Bâtiment, construction et rénovation', ic:'🛠️', sous:[
    { num:'7.1', nom:'Maçonnerie', taches:'construction de mur|réparation de mur|fondation|dalle|chape|escalier|clôture|portail|réparation de fissures|démolition légère' },
    { num:'7.2', nom:'Carrelage', taches:'pose de carrelage|remplacement de carreau|réparation de carrelage|carrelage sol|carrelage mur|faïence|joints de carrelage' },
    { num:'7.3', nom:'Peinture bâtiment', taches:'peinture intérieure|peinture extérieure|peinture plafond|peinture murale|peinture façade|préparation des murs|enduit|ponçage|finition peinture' },
    { num:'7.4', nom:'Plafonds', taches:'plafond PVC|plafond staff|faux plafond|plafond décoratif|réparation de plafond' },
    { num:'7.5', nom:'Étanchéité', taches:'étanchéité toiture|étanchéité terrasse|étanchéité salle de bain|traitement infiltration|réparation fuite toiture' },
  ]},
  { num:'8', nom:'Menuiserie bois', ic:'🪵', sous:[
    { num:'8.1', nom:'Fabrication bois', taches:'fabrication de porte|fabrication de fenêtre|fabrication de placard|fabrication d\'armoire|fabrication de lit|fabrication de table|fabrication de chaise|fabrication de bureau|fabrication d\'étagère|fabrication de meuble TV|cuisine en bois|meuble sur mesure' },
    { num:'8.2', nom:'Réparation bois', taches:'réparation de porte|réparation de meuble|remplacement de charnière|réparation de tiroir|réparation de serrure de meuble|restauration de meuble' },
  ]},
  { num:'9', nom:'Menuiserie aluminium et vitrerie', ic:'🪟', sous:[
    { num:'9.1', nom:'Aluminium', taches:'porte aluminium|fenêtre aluminium|baie vitrée|véranda|garde-corps aluminium|vitrine' },
    { num:'9.2', nom:'Vitrerie', taches:'moustiquaire|vitrage|remplacement de vitre|réparation de vitre|pose de miroir|découpe de verre' },
  ]},
  { num:'10', nom:'Ferronnerie et soudure', ic:'🔥', sous:[
    { num:'10.1', nom:'Fabrication métallique', taches:'portail métallique|porte métallique|grille de sécurité|fenêtre métallique|clôture métallique|garde-corps métallique|escalier métallique|charpente métallique' },
    { num:'10.2', nom:'Soudure et réparation métal', taches:'soudure|réparation métallique|soudure de portail cassé|fabrication sur mesure métal' },
  ]},
  { num:'11', nom:'Jardinage et espaces verts', ic:'🌿', sous:[
    { num:'11.1', nom:'Entretien jardin', taches:'tonte de pelouse|débroussaillage|désherbage|taille de haie|taille d\'arbres|élagage|ramassage de feuilles|nettoyage de jardin' },
    { num:'11.2', nom:'Aménagement jardin', taches:'création de jardin|plantation|installation de gazon|création de potager|installation d\'arrosage|aménagement paysager' },
    { num:'11.3', nom:'Entretien spécialisé jardin', taches:'traitement des plantes|lutte contre parasites|entretien d\'arbres|entretien de fleurs' },
  ]},
  { num:'12', nom:'Déménagement et manutention', ic:'📦', sous:[
    { num:'12.1', nom:'Déménagement', taches:'déménagement maison|déménagement appartement|déménagement bureau|déménagement magasin|transport de meubles|emballage|déballage' },
    { num:'12.2', nom:'Manutention', taches:'chargement|déchargement|manutention|démontage de meubles|remontage de meubles|évacuation d\'objets' },
  ]},
  { num:'13', nom:'Transport et livraison', ic:'🛵', sous:[
    { num:'13.1', nom:'Livraison', taches:'livraison de documents|livraison de colis|livraison de repas|livraison de courses|livraison de médicaments|livraison de vêtements|livraison de meubles|livraison de matériaux' },
    { num:'13.2', nom:'Courses et commissions', taches:'faire des courses|achat au marché|retrait de colis|dépôt de documents|commission administrative|livraison urgente' },
    { num:'13.3', nom:'Transport de biens', taches:'transport de meubles|transport de matériel|transport de marchandises|transport de matériaux' },
  ]},
  { num:'14', nom:'Automobile', ic:'🚙', sous:[
    { num:'14.1', nom:'Mécanique auto', taches:'vidange|changement de filtre|diagnostic auto|réparation moteur|réparation frein|réparation embrayage|réparation suspension|réparation direction|réparation échappement' },
    { num:'14.2', nom:'Pneumatiques', taches:'changement de pneu|réparation de pneu|crevaison|équilibrage|permutation des pneus' },
    { num:'14.3', nom:'Batterie auto', taches:'dépannage batterie|recharge batterie|remplacement batterie|démarrage avec batterie externe' },
    { num:'14.4', nom:'Entretien esthétique auto', taches:'lavage automobile|nettoyage intérieur voiture|nettoyage extérieur voiture|nettoyage siège voiture|polissage|lustrage|rénovation des phares' },
  ]},
  { num:'15', nom:'Moto', ic:'🏍️', sous:[
    { num:'15.1', nom:'Mécanique moto', taches:'réparation moto|vidange moto|réparation frein moto|changement pneu moto|réparation moteur moto|batterie moto|chaîne|embrayage|diagnostic moto|dépannage moto|lavage moto' },
  ]},
  { num:'16', nom:'Téléphones, informatique et électronique', ic:'📱', sous:[
    { num:'16.1', nom:'Téléphones', taches:'changement écran|changement batterie téléphone|réparation connecteur|réparation bouton|diagnostic téléphone|récupération de données téléphone|configuration téléphone' },
    { num:'16.2', nom:'Ordinateurs', taches:'réparation ordinateur|installation système|installation logiciels|nettoyage ordinateur|changement disque|changement RAM|récupération de données ordinateur|configuration réseau' },
    { num:'16.3', nom:'Réseaux', taches:'installation Wi-Fi|configuration routeur|câblage réseau|réseau d\'entreprise|installation caméra IP|dépannage Internet' },
    { num:'16.4', nom:'Autres appareils', taches:'réparation télévision|réparation décodeur|réparation imprimante|réparation vidéoprojecteur|réparation console de jeux|réparation appareils électroniques' },
  ]},
  { num:'17', nom:'Caméras, sécurité et domotique', ic:'📹', sous:[
    { num:'17.1', nom:'Vidéosurveillance', taches:'installation caméra|configuration caméra|maintenance caméra|installation alarme|installation interphone|installation visiophone' },
    { num:'17.2', nom:'Domotique', taches:'serrure connectée|contrôle d\'accès|automatisation portail|domotique maison|configuration objets connectés' },
  ]},
  { num:'18', nom:'Coiffure', ic:'💈', sous:[
    { num:'18.1', nom:'Coiffure hommes', taches:'coupe classique|coupe moderne|dégradé|taille de barbe|rasage|coloration cheveux homme|soins capillaires homme' },
    { num:'18.2', nom:'Coiffure femmes', taches:'tresses|nattes|vanilles|locks|perruque|pose perruque|coiffure naturelle|brushing|coloration cheveux femme|soins capillaires femme|coiffure mariage|coiffure événementielle' },
    { num:'18.3', nom:'Coiffure enfants', taches:'coupe enfant|coiffure enfant|tresses enfant' },
  ]},
  { num:'19', nom:'Beauté et esthétique', ic:'💅', sous:[
    { num:'19.1', nom:'Ongles et mains', taches:'manucure|pédicure|pose d\'ongles|vernis|nail art|soins des mains' },
    { num:'19.2', nom:'Maquillage et visage', taches:'maquillage|maquillage mariage|maquillage événement|soins du visage' },
    { num:'19.3', nom:'Corps', taches:'soins corporels|épilation|soins des pieds' },
  ]},
  { num:'20', nom:'Bien-être', ic:'💆', sous:[
    { num:'20.1', nom:'Massages', taches:'massage relaxant|massage sportif|massage de bien-être|soins spa|relaxation' },
    { num:'20.2', nom:'Bien-être à domicile', taches:'yoga|coaching bien-être|soins corporels à domicile' },
  ]},
  { num:'21', nom:'Sport et coaching', ic:'🏃', sous:[
    { num:'21.1', nom:'Coaching sportif', taches:'coach sportif|entraînement à domicile|préparation physique|fitness|musculation|remise en forme|accompagnement sportif|programme d\'entraînement' },
    { num:'21.2', nom:'Sports', taches:'football|basketball|course' },
  ]},
  { num:'22', nom:'Garde et aide à la personne', ic:'👶', sous:[
    { num:'22.1', nom:'Enfants', taches:'baby-sitting|garde ponctuelle d\'enfant|garde régulière d\'enfant|accompagnement scolaire|accompagnement école-maison' },
    { num:'22.2', nom:'Personnes âgées', taches:'compagnie pour personne âgée|aide quotidienne personne âgée|courses pour personne âgée|accompagnement extérieur|aide non médicale' },
    { num:'22.3', nom:'Assistance à domicile', taches:'aide aux courses|aide au rangement|aide aux tâches quotidiennes|accompagnement administratif' },
  ]},
  { num:'23', nom:'Cuisine et alimentation', ic:'🍳', sous:[
    { num:'23.1', nom:'Cuisinier à domicile', taches:'cuisinier à domicile|préparation de repas|cuisine événementielle|préparation de repas familiaux|préparation de repas professionnels' },
    { num:'23.2', nom:'Pâtisserie et boissons', taches:'pâtisserie|gâteaux|gâteaux d\'anniversaire|jus naturels|cocktails sans alcool' },
    { num:'23.3', nom:'Traiteur', taches:'traiteur|repas pour événements' },
  ]},
  { num:'24', nom:'Événementiel', ic:'🎉', sous:[
    { num:'24.1', nom:'Organisation d\'événements', taches:'organisation mariage|organisation anniversaire|organisation baptême|organisation cérémonie|organisation conférence|organisation réunion|organisation cérémonie funéraire|événement professionnel' },
    { num:'24.2', nom:'Décoration', taches:'décoration mariage|décoration anniversaire|décoration salle|décoration extérieure|décoration table|arche de mariage|fleurs|ballons' },
    { num:'24.3', nom:'Technique événementielle', taches:'sonorisation|éclairage événement|DJ|écran|vidéoprojecteur|scène|groupe électrogène' },
    { num:'24.4', nom:'Personnel événementiel', taches:'serveur|hôtesse|maître de cérémonie|animateur|agent d\'accueil' },
  ]},
  { num:'25', nom:'Photo et vidéo', ic:'📸', sous:[
    { num:'25.1', nom:'Photographie', taches:'photographie mariage|photographie anniversaire|photographie événement|portrait|photo professionnelle|photo produit' },
    { num:'25.2', nom:'Vidéo', taches:'vidéo événement|vidéo mariage|vidéo promotionnelle|montage vidéo|retouche photo|drone|couverture en direct' },
  ]},
  { num:'26', nom:'Communication, design et numérique', ic:'💻', sous:[
    { num:'26.1', nom:'Design graphique', taches:'création de logo|affiche|flyer|carte de visite|invitation|identité visuelle|design réseaux sociaux|animation graphique' },
    { num:'26.2', nom:'Web et applications', taches:'création site web|création application|maintenance site web|référencement' },
    { num:'26.3', nom:'Contenu et réseaux sociaux', taches:'community management|publicité numérique|rédaction de contenu|traduction|transcription' },
  ]},
  { num:'27', nom:'Cours, formation et éducation', ic:'📚', sous:[
    { num:'27.1', nom:'Cours particuliers', taches:'cours d\'anglais|cours de français|cours de mathématiques|cours de physique|cours de chimie|cours d\'informatique|cours de musique|cours de dessin|soutien scolaire|cours à domicile|cours en ligne' },
    { num:'27.2', nom:'Préparation examens', taches:'préparation BEPC|préparation BAC|préparation concours|préparation examens' },
    { num:'27.3', nom:'Formation professionnelle', taches:'formation professionnelle|formation bureautique|formation informatique' },
  ]},
  { num:'28', nom:'Administratif et professionnel', ic:'🗂️', sous:[
    { num:'28.1', nom:'Documents', taches:'saisie de documents|impression|photocopie|scan|reliure|numérisation de documents' },
    { num:'28.2', nom:'Rédaction', taches:'rédaction de CV|rédaction de lettre|correction de documents|création de présentations' },
    { num:'28.3', nom:'Assistance administrative', taches:'assistance administrative|secrétariat|classement de documents|saisie de données' },
  ]},
  { num:'29', nom:'Comptabilité, gestion et entreprise', ic:'📊', sous:[
    { num:'29.1', nom:'Comptabilité', taches:'tenue de comptabilité|établissement de factures|suivi financier|gestion de paie|assistance fiscale' },
    { num:'29.2', nom:'Création et conseil d\'entreprise', taches:'conseil en gestion|création d\'entreprise|assistance entrepreneuriale|business plan|étude de marché|gestion administrative' },
  ]},
  { num:'30', nom:'Immobilier', ic:'🏘️', sous:[
    { num:'30.1', nom:'Recherche et transaction', taches:'recherche de logement|recherche de maison|recherche d\'appartement|recherche de terrain|location|vente' },
    { num:'30.2', nom:'Gestion et visites', taches:'gestion locative|état des lieux|visite immobilière|estimation' },
    { num:'30.3', nom:'Services immobiliers', taches:'photographie immobilière|entretien de propriété|surveillance de propriété' },
  ]},
  { num:'31', nom:'Stockage et logistique', ic:'🏬', sous:[
    { num:'31.1', nom:'Stockage', taches:'garde-meuble|stockage temporaire|entreposage|inventaire' },
    { num:'31.2', nom:'Logistique', taches:'transport|manutention logistique|emballage logistique|déménagement professionnel|déménagement particulier' },
  ]},
  { num:'32', nom:'Agriculture et services ruraux', ic:'🌾', sous:[
    { num:'32.1', nom:'Travaux agricoles', taches:'préparation de terrain|débroussaillage agricole|labour|semis|plantation agricole|désherbage agricole|traitement des cultures|récolte' },
    { num:'32.2', nom:'Exploitation et ferme', taches:'transport agricole|entretien de plantation|entretien de ferme|élevage|alimentation animale|nettoyage d\'enclos|gardiennage agricole' },
  ]},
  { num:'33', nom:'Élevage et services animaliers', ic:'🐐', sous:[
    { num:'33.1', nom:'Animaux de compagnie', taches:'toilettage animal|lavage animal|promenade chien|garde animal|pension animale|transport animal|alimentation animale|nettoyage d\'espace animal|photographie animale' },
  ]},
  { num:'34', nom:'Couture, mode et retouches', ic:'🧵', sous:[
    { num:'34.1', nom:'Confection', taches:'couture homme|couture femme|couture enfant|confection sur mesure|confection uniforme|confection tenue événementielle|broderie' },
    { num:'34.2', nom:'Retouches', taches:'retouche|ourlet|ajustement taille|réparation vêtement|changement fermeture|réparation bouton' },
  ]},
  { num:'35', nom:'Cordonnerie et maroquinerie', ic:'👟', sous:[
    { num:'35.1', nom:'Chaussures', taches:'réparation chaussures|changement semelle|collage chaussures|cirage|nettoyage chaussures|teinture chaussures' },
    { num:'35.2', nom:'Maroquinerie', taches:'réparation sac|réparation ceinture|réparation portefeuille|remplacement fermeture sac' },
  ]},
  { num:'36', nom:'Artisanat et création', ic:'🎭', sous:[
    { num:'36.1', nom:'Création artistique', taches:'sculpture|peinture artistique|dessin|portrait dessiné|calligraphie' },
    { num:'36.2', nom:'Objets personnalisés', taches:'artisanat décoratif|objets personnalisés|cadeaux personnalisés|gravure|impression personnalisée' },
  ]},
  { num:'37', nom:'Sécurité privée', ic:'🛡️', sous:[
    { num:'37.1', nom:'Gardiennage', taches:'agent de sécurité|gardiennage|surveillance événement|surveillance domicile|surveillance commerce|surveillance chantier|contrôle d\'accès sécurité' },
  ]},
  { num:'38', nom:'Services funéraires', ic:'⚱️', sous:[
    { num:'38.1', nom:'Organisation funéraire', taches:'organisation de cérémonie funéraire|décoration funéraire|transport funéraire|photographie funéraire|impression de faire-part|sonorisation funéraire|restauration événementielle funéraire|assistance logistique funéraire' },
  ]},
  { num:'39', nom:'Assistance aux entreprises', ic:'🏢', sous:[
    { num:'39.1', nom:'Entretien et maintenance de locaux', taches:'nettoyage de bureaux|maintenance de locaux|entretien climatisation entreprise|entretien électrique entreprise|plomberie entreprise|jardinage entreprise|gardiennage entreprise' },
    { num:'39.2', nom:'Services aux entreprises', taches:'informatique entreprise|réseau informatique entreprise|maintenance équipements|déménagement de bureaux|archivage|secrétariat entreprise' },
  ]},
  { num:'40', nom:'Services pour commerces', ic:'🏬', sous:[
    { num:'40.1', nom:'Aménagement de commerce', taches:'nettoyage magasin|installation étagères|décoration magasin|enseigne|vitrine' },
    { num:'40.2', nom:'Maintenance de commerce', taches:'réparation équipements|installation caméra commerce|installation réseau commerce|maintenance électrique commerce|maintenance plomberie commerce' },
    { num:'40.3', nom:'Logistique de commerce', taches:'livraison commerce|manutention commerce|inventaire commerce' },
  ]},
  { num:'41', nom:'Services pour restaurants et maquis', ic:'🍽️', sous:[
    { num:'41.1', nom:'Personnel de restaurant', taches:'plonge|cuisinier restaurant|serveur restaurant' },
    { num:'41.2', nom:'Entretien de restaurant', taches:'nettoyage restaurant|maintenance réfrigérateur restaurant|maintenance congélateur restaurant|climatisation restaurant|électricité restaurant|plomberie restaurant|dératisation restaurant|désinfection restaurant' },
    { num:'41.3', nom:'Ambiance de restaurant', taches:'décoration restaurant|sonorisation restaurant' },
  ]},
  { num:'42', nom:'Services pour hôtels et résidences', ic:'🏨', sous:[
    { num:'42.1', nom:'Entretien hôtelier', taches:'ménage hôtel|blanchisserie hôtel|repassage hôtel|jardinage hôtel|nettoyage spécialisé hôtel' },
    { num:'42.2', nom:'Technique et maintenance hôtel', taches:'piscine|climatisation hôtel|plomberie hôtel|électricité hôtel|maintenance hôtel|sécurité hôtel' },
    { num:'42.3', nom:'Services hôteliers', taches:'informatique hôtel|décoration hôtel|photographie hôtel' },
  ]},
  { num:'43', nom:'Urgence et dépannage immédiat', ic:'🚨', sous:[
    { num:'43.1', nom:'Urgences maison', taches:'plombier urgent|électricien urgent|serrurier urgent|fuite d\'eau urgente|panne électrique urgente|porte bloquée|vitre cassée|canalisation bouchée urgente' },
    { num:'43.2', nom:'Urgences véhicules', taches:'dépannage voiture|dépannage moto|batterie voiture|crevaison urgente' },
    { num:'43.3', nom:'Urgences appareils', taches:'dépannage climatisation|dépannage réfrigérateur|dépannage électroménager|dépannage informatique' },
  ]},
  { num:'44', nom:'Petits travaux et bricolage', ic:'🪛', sous:[
    { num:'44.1', nom:'Fixations et montage', taches:'accrocher une télévision|installer une étagère|monter un meuble|fixer un miroir|poser une tringle|installer un rideau|assembler un équipement' },
    { num:'44.2', nom:'Petites réparations maison', taches:'changer une ampoule|changer une prise|changer un robinet|poser une serrure|réparer une porte|déplacer un meuble|installer une moustiquaire|petite réparation domestique' },
  ]},
  { num:'45', nom:'Main-d\'œuvre et journaliers', ic:'👷', sous:[
    { num:'45.1', nom:'Aides et manœuvres', taches:'manœuvre|aide-maçon|aide-menuisier|aide-peintre|aide-électricien|aide-plombier|aide-déménageur|manutentionnaire|aide-jardinier|aide-cuisinier' },
    { num:'45.2', nom:'Personnel de service', taches:'serveur|plongeur|aide événementiel' },
  ]},
  { num:'46', nom:'Services aux étudiants et jeunes', ic:'🎓', sous:[
    { num:'46.1', nom:'Travaux scolaires', taches:'impression|photocopie|reliure|saisie|correction|traduction' },
    { num:'46.2', nom:'Accompagnement', taches:'cours particuliers|formation informatique|conception CV|conception présentation|accompagnement numérique|photographie|montage vidéo' },
  ]},
  { num:'47', nom:'Services aux voyageurs et visiteurs', ic:'✈️', sous:[
    { num:'47.1', nom:'Transport et accompagnement', taches:'chauffeur|transport local|transfert aéroport|accompagnement touristique|guide' },
    { num:'47.2', nom:'Assistance aux visiteurs', taches:'traduction|interprétation|réservation de services locaux|livraison de bagages|assistance pratique' },
  ]},
  { num:'48', nom:'Je ne trouve pas mon service', ic:'🛠️', sous:[
    { num:'48.1', nom:'Demande personnalisée', taches:'je ne trouve pas mon service|décrire mon besoin|demande sur mesure|un service qui n\'existe pas dans la liste' },
  ]},
];
const CAT_METIER = {'1':'maison', '2':'blanchisserie', '3':'plomberie', '4':'electricite', '5':'clim', '6':'electro', '7':'macon', '8':'menuiserie', '9':'alu', '10':'soudure', '11':'jardinage', '12':'demen', '13':'livraison', '14':'meca_auto', '15':'meca_moto', '16':'telephone', '17':'camera', '18':'coiffure', '19':'beaute', '20':'bienetre', '21':'sport', '22':'placement', '23':'cuisine', '24':'evenement', '25':'photo', '26':'numerique', '27':'cours', '28':'documents', '29':'conseil', '30':'immobilier', '31':'demen', '32':'agriculture', '33':'elevage', '34':'couture', '35':'cordonnerie', '36':'artisanat', '37':'securite', '38':'funeraire', '39':'bureaux', '40':'bureaux', '41':'bureaux', '42':'bureaux', '43':'', '44':'bricolage', '45':'mainoeuvre', '46':'documents', '47':'chauffeur', '48':''};
const CAT_METIER_SS = {'7.2':'carrelage', '7.3':'peinture', '7.4':'plafond', '7.5':'etancheite', '9.2':'vitrerie', '16.2':'ordinateur', '16.3':'internet', '16.4':'ordinateur', '42.1':'maison', '42.2':'piscine', '43.1':'bricolage'};
const CAT_METIER_TACHE = {'nettoyage de canapé':'canapes', 'nettoyage de fauteuil':'canapes', 'nettoyage de vitres':'vitres', 'nettoyage de baies vitrées':'vitres', 'nettoyage de matelas':'canapes', 'nettoyage de tapis':'canapes', 'nettoyage de moquette':'canapes', 'grand ménage':'grand', 'ménage avant emménagement':'maison', 'ménage après déménagement':'maison', 'désinfection de maison':'desinfection', 'désinsectisation':'desinfection', 'dératisation':'desinfection', 'traitement contre les cafards':'desinfection', 'traitement contre les moustiques':'desinfection', 'nettoyage de bureaux':'bureaux', 'nettoyage de magasins':'bureaux', 'nettoyage de restaurants':'bureaux', 'nettoyage d\'hôtels':'bureaux', 'nettoyage d\'écoles':'bureaux', 'nettoyage de locaux professionnels':'bureaux', 'installation de chambre froide':'clim', 'réparation de chambre froide':'clim', 'plombier urgent':'plomberie', 'électricien urgent':'electricite', 'serrurier urgent':'serrurerie', 'porte bloquée':'serrurerie', 'vitre cassée':'vitrerie', 'fuite d\'eau urgente':'plomberie', 'panne électrique urgente':'electricite', 'canalisation bouchée urgente':'plomberie', 'dépannage voiture':'meca_auto', 'dépannage moto':'meca_moto', 'batterie voiture':'meca_auto', 'crevaison urgente':'meca_auto', 'dépannage climatisation':'clim', 'dépannage réfrigérateur':'electro', 'dépannage électroménager':'electro', 'dépannage informatique':'ordinateur','réparation télévision':'electro','réparation décodeur':'electro','réparation console de jeux':'electro', 'réparation de serrure de meuble':'menuiserie', 'nettoyage de chaussures':'cordonnerie', 'cirage':'cordonnerie', 'repassage de vêtements':'blanchisserie', 'nettoyage à sec':'blanchisserie', 'lavage de vêtements':'blanchisserie', 'piscine':'piscine', 'garde-meuble':'demen'};
const SVC_NAT = {
  blanchisserie: { ic:'🧺', nom:'Blanchisserie, linge & repassage', base:5000, desc:'Lavage, repassage, pressing', famille:'maison', mots:'blanchisserie pressing repassage linge lavage vetements draps couvertures repassage chemise costume' },
  desinfection: { ic:'🧴', nom:'Désinfection & assainissement', base:12000, desc:'Désinfection, insectes, rongeurs', famille:'maison', mots:'desinfection assainissement desinsectisation deratisation cafards fourmis moustiques termites punaises' },
  plafond: { ic:'🏗️', nom:'Plafonds & staff', base:15000, desc:'PVC, staff, faux plafond', famille:'bâtiment', mots:'plafond plafonds staff pvc faux plafond lambris decoration plafond reparer plafond' },
  etancheite: { ic:'🚧', nom:'Étanchéité & toiture', base:20000, desc:'Toiture, terrasse, infiltration', famille:'bâtiment', mots:'etancheite toiture terrasse infiltration fuite toiture reparer toiture tole couverture' },
  alu: { ic:'🪟', nom:'Aluminium & vérandas', base:15000, desc:'Portes, fenêtres, baies alu', famille:'bâtiment', mots:'aluminium alu veranda baie vitree garde corps vitrine fenetre alu porte alu' },
  sport: { ic:'🏃', nom:'Sport & coaching', base:8000, desc:'Coach sportif, préparation physique', famille:'personne', mots:'sport coach sportif entrainement fitness musculation remise en forme football basket course athletic' },
  bienetre: { ic:'💆', nom:'Bien-être & massages', base:10000, desc:'Massage, spa, yoga, relaxation', famille:'personne', mots:'bien etre massage massages spa relaxation yoga detente soins corps' },
  numerique: { ic:'💻', nom:'Web, design & numérique', base:20000, desc:'Logo, site web, réseaux sociaux', famille:'services', mots:'logo site web application design graphique reseaux sociaux community management flyer affiche carte visite montage video referencement contenu traduction' },
  securite: { ic:'🛡️', nom:'Sécurité & gardiennage', base:15000, desc:'Gardien, surveillance, contrôle d\'accès', famille:'services', mots:'securite gardien gardiennage surveillance vigile controle acces agent securite' },
  funeraire: { ic:'⚱️', nom:'Services funéraires', base:25000, desc:'Organisation, décoration, transport', famille:'services', mots:'funeraire funerailles deces ceremonie funeraire faire part transport funeraire' },
  mainoeuvre: { ic:'👷', nom:'Main-d\'œuvre & journaliers', base:5000, desc:'Manœuvre, aides, journaliers', famille:'bâtiment', mots:'manoeuvre journalier aide macon aide menuisier aide peintre aide electricien aide plombier manutentionnaire aide demenageur aide jardinier aide cuisinier plongeur' },
  agriculture: { ic:'🌾', nom:'Agriculture & travaux ruraux', base:15000, desc:'Labour, semis, récolte', famille:'agri', mots:'agriculture champ labour semis plantation recolte debroussaillage agricole entretien ferme plantation culture' },
  elevage: { ic:'🐐', nom:'Élevage & services animaliers', base:10000, desc:'Animaux, enclos, alimentation', famille:'agri', mots:'elevage animaux betail animal chien chat toilettage animal promenade chien garde animal alimentation animale enclos ferme' },
  piscine: { ic:'🏊', nom:'Entretien de piscine', base:15000, desc:'Nettoyage, traitement, pompe', famille:'bâtiment', mots:'piscine nettoyage piscine traitement piscine pompe piscine entretien piscine filtre' },
  artisanat: { ic:'🎭', nom:'Artisanat & créations', base:12000, desc:'Sculpture, gravure, objets personnalisés', famille:'personne', mots:'artisanat sculpture gravure dessin calligraphie peinture artistique objets personnalises cadeaux personnalises bijoux' },
};

/* ═══════════════════════════════════════════════════════════════════════════════
   🩺 PRESTATIONS RÉGLEMENTÉES — séparées du reste et RÉSERVÉES aux professionnels
   légalement habilités (actes médicaux, vétérinaires, sécurité privée, gaz…).
   Klean ne publie jamais ces prestations sans vérification du diplôme / de l'agrément,
   et un pro non habilité NE PEUT PAS accepter une mission réglementée.
   ═══════════════════════════════════════════════════════════════════════════════ */
const CAT_REGLEMENTE = [
  { id: 'medical', ic: '🩺', nom: 'Actes médicaux et soins de santé',
    exige: 'Diplôme reconnu + autorisation d’exercer en Côte d’Ivoire (Ordre professionnel)',
    services: [],
    cles: ['medecin', 'docteur en medecine', 'infirmier', 'infirmiere', 'sage femme', 'kinesitherapeute', 'kine',
      'prise de sang', 'piqure a domicile', 'injection a domicile', 'perfusion', 'pansement a domicile',
      'vaccination', 'vaccin', 'soins a domicile', 'soins medicaux', 'acte medical', 'ordonnance medicale', 'ambulance'],
    note: 'Klean ne fait jamais exécuter un acte médical sans diplôme et autorisation vérifiés.' },
  { id: 'veterinaire', ic: '🐕', nom: 'Actes vétérinaires',
    exige: 'Diplôme de docteur vétérinaire + inscription à l’Ordre des vétérinaires',
    services: [],
    cles: ['veterinaire', 'docteur veterinaire', 'acte veterinaire', 'vaccination animale', 'castration'],
    note: 'Les soins et actes sur les animaux sont réservés aux vétérinaires habilités.' },
  { id: 'securite', ic: '🛡️', nom: 'Sécurité privée et gardiennage',
    exige: 'Autorisation d’exercice (ministère de l’Intérieur) pour l’agent et l’entreprise',
    services: ['37'],
    cles: ['agent de securite', 'societe de securite', 'securite privee', 'gardien de nuit', 'garde du corps',
      'vigile', 'gardiennage', 'maitre chien'],
    note: 'Uniquement des professionnels autorisés lorsque la réglementation l’exige.' },
  { id: 'gaz', ic: '🔥', nom: 'Installation et dépannage gaz',
    exige: 'Agrément pour les installations de gaz',
    services: [],
    cles: ['fuite de gaz', 'odeur de gaz', 'bouteille de gaz', 'installation de gaz', 'installation gaz',
      'chauffe bain gaz', 'compteur gaz', 'detendeur gaz'],
    note: 'Les interventions gaz exigent un agrément : sécurité des personnes avant tout.' },
  { id: 'electricite_habilitation', ic: '⚡', nom: 'Travaux électriques sous habilitation',
    exige: 'Habilitation électrique (travaux sur réseau, poste, tableau général)',
    services: [],
    cles: ['reseau electrique', 'poste electrique', 'branchement compteur', 'haute tension', 'lcgb', 'cie branchement'],
    note: 'Les travaux sur le réseau ou le compteur doivent être confiés à un professionnel habilité.' },
  { id: 'transport_personnes', ic: '🚐', nom: 'Transport de personnes (taxi, VTC, scolaire)',
    exige: 'Permis correspondant + carte professionnelle de transport',
    services: [],
    cles: ['taxi', 'vtc', 'transport scolaire', 'navette passagers', 'location de voiture avec chauffeur'],
    note: 'Le transport payant de personnes est réglementé en Côte d’Ivoire.' },
  { id: 'immobilier_carte', ic: '🏘️', nom: 'Transaction immobilière',
    exige: 'Carte professionnelle d’agent immobilier',
    services: [],
    cles: ['agent immobilier', 'transaction immobiliere', 'vente immobiliere', 'commission sur vente de terrain',
      'promotion immobiliere', 'agence immobiliere'],
    note: 'Les transactions immobilières sont réservées aux professionnels ayant la carte.' },
  { id: 'pharmacie', ic: '💊', nom: 'Vente de médicaments',
    exige: 'Autorisation de pharmacie — jamais à domicile',
    services: [],
    cles: ['vente de medicaments', 'acheter des medicaments', 'medicaments a domicile', 'pharmacie de garde'],
    note: 'La vente de médicaments n’est possible qu’en pharmacie autorisée.' }
];
function reglementeIdx(id) { return CAT_REGLEMENTE.find(r => r.id === id) || null; }
/* 🔎 est-ce que cette demande touche une prestation réglementée ?
   ⚠️ Règle de prudence : on ne cherche QUE des expressions précises (« infirmière », « fuite de gaz »).
   Un mot courant (« fuite », « maison », « analyse ») ne doit JAMAIS déclencher une alerte :
   sinon on bloquerait des demandes normales de plomberie ou de ménage. */
function reglementePour(service, taches, texte) {
  /* ⚠️ le service peut être un numéro du catalogue national (« 37 ») : un identifiant de métier
     (« maison », « plomberie ») n'est PAS du texte à analyser, sinon « maison » déclencherait l'immobilier. */
  const num = /^\d+(\.\d+)?$/.test(String(service || '').trim()) ? String(service).trim() : '';
  const tas = Array.isArray(taches) ? taches : (taches ? [String(taches)] : []);
  const txt = ' ' + normFr([tas.join(' '), String(texte || '')].join(' ')).replace(/\s+/g, ' ').trim() + ' ';
  const dedans = r => {
    if (num && (r.services || []).indexOf(num) >= 0) return true;
    return (r.cles || []).some(c => txt.indexOf(' ' + normFr(c) + ' ') >= 0);
  };
  const r = CAT_REGLEMENTE.find(dedans);
  return r ? r.id : '';
}
/* 🏠 où la prestation se passe · ⏱️ comment elle est facturée (le PDG peut ajuster service par service) */
const CAT_LIEUX = [
  { id: 'domicile', ic: '🏠', nom: 'Au domicile du client' },
  { id: 'chez_pro', ic: '🧑‍🔧', nom: 'Chez le professionnel' },
  { id: 'atelier', ic: '🏭', nom: 'En atelier' },
  { id: 'distance', ic: '💻', nom: 'À distance' },
  { id: 'chantier', ic: '🏗️', nom: 'Sur le chantier' },
  { id: 'entreprise', ic: '🏢', nom: 'Dans l’entreprise' },
  { id: 'commerce', ic: '🏬', nom: 'Dans le commerce / magasin' },
  { id: 'bureau', ic: '🗂️', nom: 'Au bureau' },
  { id: 'deplacement', ic: '🚗', nom: 'Le pro se déplace' }
];
const CAT_DISPO = [
  { id: 'immediat', ic: '⚡', nom: 'Disponible immédiatement' },
  { id: 'rdv', ic: '📅', nom: 'Sur rendez-vous' }
];
const CAT_TARIFS = [
  { id: 'fixe', ic: '💰', nom: 'Prix fixe' },
  { id: 'partir', ic: '🏷️', nom: 'À partir de' },
  { id: 'horaire', ic: '⏱️', nom: 'À l’heure' },
  { id: 'journalier', ic: '📆', nom: 'À la journée' },
  { id: 'tache', ic: '✅', nom: 'Par tâche' },
  { id: 'm2', ic: '📐', nom: 'Au m²' },
  { id: 'devis', ic: '💬', nom: 'Sur devis' },
  { id: 'diagnostic', ic: '🔍', nom: 'Après diagnostic' }
];
/* les valeurs par défaut de chaque service (modifiables au HQ, jamais supprimées) */
const CAT_LIEUX_DEF = {
  '1': ['domicile', 'bureau'], '2': ['domicile', 'atelier'], '3': ['domicile'], '4': ['domicile', 'chantier'],
  '5': ['domicile'], '6': ['domicile', 'atelier'], '7': ['chantier', 'domicile'], '8': ['atelier', 'domicile'],
  '9': ['atelier', 'domicile', 'chantier'], '10': ['atelier', 'domicile'], '11': ['domicile'],
  '12': ['domicile', 'chantier'], '13': ['deplacement'], '14': ['atelier', 'chez_pro'], '15': ['atelier', 'chez_pro'],
  '16': ['atelier', 'domicile', 'distance'], '17': ['domicile', 'entreprise', 'commerce'], '18': ['domicile', 'chez_pro'],
  '19': ['domicile', 'chez_pro'], '20': ['domicile', 'chez_pro'], '21': ['domicile', 'distance'],
  '22': ['domicile'], '23': ['domicile', 'entreprise'], '24': ['chantier', 'domicile'], '25': ['domicile', 'chantier'],
  '26': ['distance', 'domicile'], '27': ['distance', 'domicile'], '28': ['distance', 'deplacement'],
  '29': ['distance', 'entreprise', 'bureau'], '30': ['distance', 'deplacement'], '31': ['chez_pro', 'domicile'],
  '32': ['deplacement', 'chantier'], '33': ['domicile', 'deplacement'], '34': ['atelier', 'domicile'],
  '35': ['atelier'], '36': ['atelier', 'domicile'], '37': ['entreprise', 'commerce', 'chantier'],
  '38': ['deplacement'], '39': ['entreprise', 'bureau', 'commerce'], '40': ['commerce'], '41': ['commerce'],
  '42': ['entreprise', 'commerce'], '43': ['domicile'], '44': ['domicile'], '45': ['domicile', 'chantier', 'entreprise'],
  '46': ['distance', 'domicile'], '47': ['deplacement'], '48': ['domicile']
};
const CAT_TARIFS_DEF = {
  '1': ['partir', 'm2', 'horaire'], '2': ['tache', 'partir'], '3': ['diagnostic', 'partir'], '4': ['diagnostic', 'partir'],
  '5': ['diagnostic', 'partir'], '6': ['diagnostic', 'partir'], '7': ['devis', 'm2'], '8': ['devis', 'partir'],
  '9': ['devis', 'm2'], '10': ['devis', 'partir'], '11': ['partir', 'm2', 'tache'], '12': ['devis', 'horaire'],
  '13': ['partir', 'tache'], '14': ['diagnostic', 'devis'], '15': ['diagnostic', 'devis'], '16': ['diagnostic', 'partir'],
  '17': ['devis', 'partir'], '18': ['partir', 'tache'], '19': ['partir', 'tache'], '20': ['horaire', 'partir'],
  '21': ['horaire', 'partir'], '22': ['horaire', 'journalier', 'fixe'], '23': ['tache', 'journalier', 'devis'],
  '24': ['devis'], '25': ['tache', 'devis'], '26': ['devis', 'tache'], '27': ['horaire', 'tache'],
  '28': ['tache', 'devis'], '29': ['devis', 'horaire'], '30': ['devis'], '31': ['partir', 'horaire'],
  '32': ['devis', 'journalier'], '33': ['partir', 'devis'], '34': ['tache', 'devis'], '35': ['tache', 'partir'],
  '36': ['devis', 'partir'], '37': ['horaire', 'journalier'], '38': ['devis'], '39': ['devis', 'horaire'],
  '40': ['devis'], '41': ['devis', 'journalier'], '42': ['devis'], '43': ['diagnostic', 'partir'],
  '44': ['tache', 'horaire'], '45': ['horaire', 'journalier', 'tache'], '46': ['tache', 'horaire'],
  '47': ['journalier', 'devis'], '48': ['devis']
};
/* 🔁 le PDG ajuste : { numService: ['domicile','distance'] } — on garde toujours le défaut en secours */
/* ═══════════════════════════════════════════════════════════════════════════
   💰 MOTEUR DE TARIFICATION KLEAN — LOT 107 (« SOCLE »)
   Demande du PDG (27/09) : « Tu prends encore le prix actuel des services mais tu
   calcules selon les prix détaillés des services. »

   • Les PRIX restent ceux d'aujourd'hui (aucun prix inventé, aucun prix du marché
     imposé) : chaque service garde son prix de référence actuel.
   • Le CALCUL, lui, devient détaillé : unité de facturation, quantité (avec paliers),
     niveau, état, difficulté, urgence, horaire, accès, zone, déplacement, matériel,
     options, remise → une ligne par élément, un total, une fourchette, un mode.
   • Tout est ADMINISTRABLE au tableau de bord (prix, unités, coefficients, paliers,
     déplacement, zones, devis, seuils) et VERSIONNÉ : une mission garde la version de
     tarif de son jour.
   • Le calcul se fait côté SERVEUR (le téléphone ne décide plus du prix). Les anciens
     appels qui envoient encore un prix sont acceptés mais MARQUÉS « à vérifier ».
   ═══════════════════════════════════════════════════════════════════════════ */
const TARIF_PRIX_DEF = {
  maison: { nom:"Nettoyage maison", ic:"", base:7000, cat:"clean", piecesLabel:"", opts:[] },
  bureaux: { nom:"Nettoyage bureaux", ic:"", base:15000, cat:"clean", piecesLabel:"", opts:[] },
  canapes: { nom:"Canapés & fauteuils", ic:"", base:6000, cat:"clean", piecesLabel:"", opts:[] },
  vitres: { nom:"Vitres & baies", ic:"", base:4500, cat:"clean", piecesLabel:"", opts:[] },
  demenagement: { nom:"Après déménagement", ic:"", base:15000, cat:"clean", piecesLabel:"", opts:[] },
  sdb: { nom:"Salles de bains", ic:"", base:5500, cat:"clean", piecesLabel:"", opts:[] },
  grand: { nom:"Grand ménage", ic:"", base:16000, cat:"clean", piecesLabel:"", opts:[] },
  plomberie: { nom:"Plomberie", ic:"", base:6000, cat:"tech", piecesLabel:"", opts:[{id:'robinet',nom:"Remplacement robinet",prix:3500}, {id:'fuite',nom:"Réparation fuite",prix:5000}, {id:'debouch',nom:"Débouchage canalisation",prix:7000}, {id:'chauffe',nom:"Chauffe-eau",prix:10000}] },
  electricite: { nom:"Électricité", ic:"", base:6000, cat:"tech", piecesLabel:"", opts:[{id:'prise',nom:"Prise / interrupteur",prix:2500}, {id:'tableau',nom:"Tableau électrique",prix:9000}, {id:'plaf',nom:"Ventilateur / plafonnier",prix:4500}, {id:'court',nom:"Court-circuit / panne",prix:6000}] },
  clim: { nom:"Climatisation", ic:"", base:10000, cat:"tech", piecesLabel:"", opts:[{id:'gaz',nom:"Recharge de gaz",prix:16000}, {id:'repar',nom:"Réparation panne",prix:12000}, {id:'instal',nom:"Installation split",prix:25000}, {id:'split2',nom:"Split supplémentaire",prix:5000}] },
  serrurerie: { nom:"Serrurerie", ic:"", base:5000, cat:"tech", piecesLabel:"", opts:[{id:'ouvert',nom:"Ouverture de porte",prix:5000}, {id:'serrure',nom:"Remplacement serrure",prix:6000}, {id:'cylindre',nom:"Cylindre haute sécurité",prix:9000}] },
  electro: { nom:"Électroménager", ic:"", base:5000, cat:"tech", piecesLabel:"", opts:[{id:'frigo2',nom:"Réparation frigo/congélo",prix:9000}, {id:'mav',nom:"Machine à laver",prix:8000}, {id:'four2',nom:"Four / cuisinière",prix:7000}] },
  jardinage: { nom:"Jardinage", ic:"", base:7000, cat:"home", piecesLabel:"", opts:[{id:'tonte',nom:"Tonte de pelouse",prix:4000}, {id:'haie',nom:"Taille de haie",prix:3500}, {id:'desherb',nom:"Désherbage",prix:3500}] },
  lavageauto: { nom:"Lavage auto à domicile", ic:"", base:4000, cat:"home", piecesLabel:"v\u00e9hicule(s)", opts:[{id:'inter',nom:"Intérieur complet",prix:3000}, {id:'suv',nom:"SUV / 4x4",prix:2500}, {id:'cire',nom:"Cire de protection",prix:2500}, {id:'moteur',nom:"Nettoyage moteur",prix:3500}] },
  bricolage: { nom:"Bricolage & montage", ic:"", base:6000, cat:"home", piecesLabel:"", opts:[{id:'meuble',nom:"Montage de meuble",prix:6000}, {id:'etagere',nom:"Fixation étagère/TV",prix:2500}, {id:'tringle',nom:"Tringles & rideaux",prix:2000}] },
  demen: { nom:"Déménagement & portage", ic:"", base:30000, cat:"home", piecesLabel:"pi\u00e8ce(s) \u00e0 vider", opts:[{id:'cartons',nom:"Cartons & emballage",prix:5000}, {id:'porteur',nom:"Porteur supplémentaire",prix:8000}, {id:'demont',nom:"Montage / démontage meubles",prix:6000}] },
  cuisine: { nom:"Cuisinier à domicile", ic:"", base:10000, cat:"home", piecesLabel:"", opts:[{id:'courses',nom:"Courses incluses",prix:4000}, {id:'groupe',nom:"Repas 5+ personnes",prix:4000}, {id:'patiss',nom:"Pâtisserie / dessert",prix:3500}] },
  evenement: { nom:"Après événement", ic:"", base:12000, cat:"clean", piecesLabel:"", opts:[] },
  entretien: { nom:"Entretien régulier", ic:"", base:6000, cat:"clean", piecesLabel:"", opts:[] },
  placement: { nom:"Placement de personnel", ic:"", base:15000, cat:"home", piecesLabel:"", opts:[{id:'nounou',nom:"Nounou / garde d’enfant",prix:0}, {id:'perso',nom:"Personnel de maison",prix:0}, {id:'gardien',nom:"Gardien / vigile",prix:0}, {id:'aide',nom:"Aide-ménagère",prix:0}, {id:'jardinier2',nom:"Jardinier",prix:0}] },
  cours: { nom:"Cours ou formation à domicile", ic:"", base:15000, cat:"home", piecesLabel:"", opts:[{id:'college',nom:"Niveau collège",prix:5000}, {id:'lycee',nom:"Niveau lycée",prix:8000}, {id:'eleves2',nom:"2 élèves",prix:10000}, {id:'eleves3',nom:"3 élèves ou plus",prix:15000}, {id:'prof',nom:"Professeur diplômé (au lieu d’un étudiant)",prix:10000}, {id:'coach',nom:"Coach / formateur dans un domaine précis",prix:20000}, {id:'toutes',nom:"Toutes les matières (soutien général)",prix:8000}] },
  canal: { nom:"Canal+ domicile", ic:"", base:5000, cat:"home", piecesLabel:"", opts:[{id:'depannage',nom:"Dépannage décodeur / parabole",prix:5000}, {id:'placement',nom:"Placement & installation complète",prix:10000}, {id:'point2',nom:"Point TV supplémentaire",prix:5000}, {id:'renouvel',nom:"Aide au renouvellement d’abonnement",prix:2000}, {id:'assistance',nom:"Assistance & réglages (parabole, chaînes)",prix:3000}] }
};
/* 🧹 options « ménage » (les mêmes prix que l'application cliente) */
const TARIF_EXTRAS_DEF = [
  {id:'frigo',   ic:'🧊', nom:'Intérieur du frigo',   desc:'Vidange + nettoyage', prix:1500},
  {id:'linge',   ic:'🧺', nom:'Linge & repassage',    desc:'1 panier',            prix:2500},
  {id:'rideaux', ic:'🪟', nom:'Rideaux & tentures',   desc:'Dépoussiérage',       prix:2000},
  {id:'cour',    ic:'🌿', nom:'Cour / balcon',        desc:'Balayage + lavage',   prix:1000},
  {id:'eco',     ic:'🌱', nom:'Produits écologiques', desc:'Sans chimique',       prix:1500}
];
const TARIF_REMISES_DEF = { BIENVENUE: 0.15, KLEAN10: 0.10 };
/* 🧮 UNITÉS DE FACTURATION (administrables : le PDG peut en créer d'autres) */
const TARIF_UNITES_DEF = [
  { id: 'piece',        ic: '🔢', nom: 'par pièce',              comptable: true },
  { id: 'place',        ic: '🛋️', nom: 'par place (canapé, salle)', comptable: true },
  { id: 'personne',     ic: '👤', nom: 'par personne',           comptable: true },
  { id: 'vehicule',     ic: '🚗', nom: 'par véhicule',           comptable: true },
  { id: 'appareil',     ic: '🔌', nom: 'par appareil',           comptable: true },
  { id: 'tache',        ic: '✅', nom: 'par tâche',               comptable: true },
  { id: 'kg',           ic: '⚖️', nom: 'par kilogramme',          comptable: true },
  { id: 'tonne',        ic: '🏗️', nom: 'par tonne',               comptable: true },
  { id: 'trajet',       ic: '🛵', nom: 'par trajet',              comptable: true },
  { id: 'chambre',      ic: '🛏️', nom: 'par chambre',             comptable: true },
  { id: 'etage',        ic: '🪜', nom: 'par étage',               comptable: true },
  { id: 'm2',           ic: '📐', nom: 'au m²',                   comptable: false },
  { id: 'ml',           ic: '📏', nom: 'au mètre linéaire',       comptable: false },
  { id: 'heure',        ic: '⏱️', nom: 'à l’heure',                comptable: false },
  { id: 'jour',         ic: '📆', nom: 'à la journée',            comptable: false },
  { id: 'intervention', ic: '🛠️', nom: 'par intervention',        comptable: false },
  { id: 'forfait',      ic: '📦', nom: 'au forfait',              comptable: false }
];
/* ⚙️ COEFFICIENTS — tous réglables par le PDG (1 = aucun changement) */
const TARIF_COEFS_DEF = {
  niveau: { nom: 'Niveau d’intervention', ic: '🧽', valeurs: [
    { id: 'normal', nom: 'Normal / standard', k: 1 },
    { id: 'complet', nom: 'Complet', k: 1.3 },
    { id: 'profondeur', nom: 'Profondeur / urgence', k: 1.6 }] },
  etat: { nom: 'État des lieux', ic: '🧐', comptePour: ['clean'], valeurs: [
    { id: 'neuf', nom: 'Neuf / normal', k: 1 },
    { id: 'leger', nom: 'Légèrement sale', k: 1.1 },
    { id: 'sale', nom: 'Sale', k: 1.25 },
    { id: 'tres_sale', nom: 'Très sale', k: 1.45 },
    { id: 'extreme', nom: 'Extrêmement sale', k: 1.7 },
    { id: 'degrade', nom: 'Dégradation importante', k: 1.9 },
    { id: 'special', nom: 'Traitement spécial', k: 2.1 }] },
  difficulte: { nom: 'Difficulté', ic: '🪨', valeurs: [
    { id: 'facile', nom: 'Facile', k: 0.9 },
    { id: 'normale', nom: 'Normale', k: 1 },
    { id: 'difficile', nom: 'Difficile', k: 1.3 }] },
  urgence: { nom: 'Urgence', ic: '🚨', valeurs: [
    { id: 'normal', nom: 'Normal (au plus tard à la date choisie)', k: 1 },
    { id: 'h72', nom: 'Sous 72 h', k: 1.1 },
    { id: 'h48', nom: 'Sous 48 h', k: 1.2 },
    { id: 'h24', nom: 'Sous 24 h', k: 1.35 },
    { id: 'immediat', nom: 'Intervention immédiate', k: 1.5 }] },
  horaire: { nom: 'Horaire', ic: '🌙', valeurs: [
    { id: 'normal', nom: 'Heures normales', k: 1 },
    { id: 'nuit', nom: 'Nuit', k: 1.25 },
    { id: 'dimanche', nom: 'Dimanche', k: 1.3 },
    { id: 'ferie', nom: 'Jour férié', k: 1.4 }] },
  acces: { nom: 'Accès', ic: '🪜', valeurs: [
    { id: 'rdc', nom: 'Rez-de-chaussée', k: 1 },
    { id: 'etage', nom: 'Étage (ascenseur disponible)', k: 1.1 },
    { id: 'sans_ascenseur', nom: 'Étage sans ascenseur', k: 1.2 },
    { id: 'difficile', nom: 'Accès difficile', k: 1.25 },
    { id: 'vehicule_impossible', nom: 'Véhicule impossible', k: 1.3 },
    { id: 'manutention', nom: 'Manutention nécessaire', k: 1.35 }] },
  materiel: { nom: 'Matériel', ic: '🧰', valeurs: [
    { id: 'client', nom: 'Fourni par le client', k: 1 },
    { id: 'pro', nom: 'Fourni par le professionnel', k: 1.08 }] }
};
/* 📉 PALIERS DE QUANTITÉ — reproduisent exactement les prix actuels (1→×1, 2→×1,3, 3→×1,6, 5→×2,2) */
const TARIF_PALIERS_DEF = [{ n: 1, mult: 1 }, { n: 2, mult: 1.3 }, { n: 3, mult: 1.6 }, { n: 5, mult: 2.2 }];
/* 🛵 DÉPLACEMENT — « inclus » par défaut = le prix d'aujourd'hui. Tranches prêtes (exemple du PDG :
   0–5 km gratuit, 5–10 km 600 F), à activer d'un clic quand il le décide. */
const TARIF_DEPLACEMENT_DEF = { mode: 'inclus', km: 200, forfait: 1000, allerRetour: false,
  tranches: [{ jusqua: 5, prix: 0 }, { jusqua: 10, prix: 600 }, { jusqua: 15, prix: 900 },
             { jusqua: 25, prix: 1500 }, { jusqua: 40, prix: 2500 }, { jusqua: 100000, prix: 3500 }] };
/* 🗺️ ZONES — distances routières usuelles depuis Abidjan (km), pour que le DÉPLACEMENT repose sur
   un chiffre VÉRIFIABLE et non sur un chiffre donné par le client.
   ⚠️ RÈGLE DU PDG : « référence de marché = source + date obligatoires ». Cette table est donc marquée
   « proposition » tant que le PDG ne l'a pas validée (source + date). Tant qu'elle n'est pas validée,
   elle sert d'ESTIMATION (mode fourchette), et le mode de déplacement reste « inclus » = les prix
   d'aujourd'hui. Rien n'est facturé sans sa décision. */
const TARIF_ZONES_KM_DEF = {
  'abidjan': 10, 'plateau': 6, 'cocody': 12, 'adjame': 8, 'treichville': 7, 'marcory': 8,
  'koumassi': 11, 'port-bouet': 13, 'yopougon': 15, 'abobo': 16, 'attecoube': 9,
  'bingerville': 22, 'anyama': 24, 'songon': 30, 'grand-bassam': 40, 'dabou': 55, 'agboville': 80,
  'adzope': 100, 'aboisso': 120, 'toumodi': 200, 'divo': 200, 'abengourou': 210, 'yamoussoukro': 240,
  'gagnoa': 280, 'bouafle': 300, 'soubre': 300, 'issia': 330, 'bouake': 350, 'san-pedro': 370,
  'daloa': 380, 'vavoua': 400, 'katiola': 400, 'bondoukou': 420, 'guiglo': 450, 'touba': 500,
  'seguéla': 500, 'ferkessedougou': 500, 'tabou': 500, 'man': 580, 'korhogo': 630, 'danane': 640, 'odienne': 800
};
const TARIF_ZONES_SRC_DEF = { actif: false, source: '', sourceDate: '',
  note: 'Proposition Klean (distances routières usuelles depuis Abidjan) — à valider par le PDG : indiquez la source et la date.' };
const TARIF_SEUILS_DEF = { margeAuto: 0.05, margeIncertitude: 0.2, validationAdmin: 100000, ecartAnormal: 0.4 };
/* 🏗️ services qui se règlent SUR DEVIS (travaux : construction, rénovation, toiture, gros œuvre…) */
const TARIF_DEVIS_METIERS = ['macon', 'menuiserie', 'alu', 'soudure', 'etancheite'];
const TARIF_DEVIS_NUMS = ['7', '8', '9', '10', '24', '30', '38', '40', '42', '48'];

/* ─────────── INITIALISATION (une seule fois, ne remplace jamais ce que le PDG a réglé) ─────────── */

/* ═══════════ 📜 CONDITIONS KLEAN-SERVICES (client & professionnel) ═══════════
   Texte OFFICIEL envoyé par le PDG le 28/09/2026 — repris mot pour mot, rien d'inventé.
   · versionné : publier une nouvelle version n'efface jamais l'ancienne (une acceptation passée
     reste attachée à SA version) ;
   · chaque acceptation est une PREUVE : qui, rôle, version, date, heure, appareil, IP ;
   · le PDG exige l'acceptation (case à cocher obligatoire) — refus côté serveur si elle manque ;
   · le tableau de bord voit tout (textes, versions, acceptations, journal) et peut tout régler. */
const CONDITIONS_DEF = {
  version: 1, maj: '2026-09-28', source: 'PDG — texte officiel des conditions Klean-Services (28/09/2026)',
  exigee: true,
  client: [
  { t: 'Création de la demande', p: [
      'Je m\'engage à effectuer une demande correspondant réellement au service que je souhaite obtenir et à fournir toutes les informations nécessaires à sa compréhension.'] },
  { t: 'Informations exactes et complètes', p: [
      'Je m\'engage à fournir des informations exactes concernant notamment le lieu, la quantité, les dimensions, l\'état des biens, les difficultés particulières, la date, l\'heure et toute autre information utile à la réalisation de la prestation.'] },
  { t: 'Photos, vidéos et informations complémentaires', p: [
      'Lorsque Klean-Services ou le professionnel demande des photos, vidéos ou informations complémentaires afin d\'évaluer correctement la prestation, je m\'engage à fournir des éléments clairs, récents et pertinents.'] },
  { t: 'Mise en relation avec le professionnel', p: [
      'Je reconnais que les échanges avec le professionnel doivent se dérouler à travers les fonctionnalités prévues par Klean Service, afin de permettre le suivi et la sécurisation de la prestation qui pourrait à un appel téléphonique.'] },
  { t: 'Échanges avec le professionnel', p: [
      'Je m\'engage à communiquer au professionnel uniquement les informations nécessaires à la réalisation de la prestation et à respecter les règles de conduite de Klean-Services.'] },
  { t: 'Interdiction de contourner Klean Service', p: [
      'Je m\'engage à ne pas utiliser les échanges ou les coordonnées obtenues grâce à Klean-Services pour demander directement au professionnel une nouvelle prestation en dehors de l\'application, dans le but de contourner Klean Service ou sa procédure de réservation et de paiement.',
      'Si je souhaite faire appel de nouveau à un professionnel déjà rencontré sur Klean-Services, je dois utiliser son code unique dans l\'application, effectuer une nouvelle demande et suivre la procédure de réservation et de paiement prévue par Klean-Services.'] },
  { t: 'Évaluation et détermination du prix', p: [
      'Je reconnais que le prix peut être déterminé à partir des informations fournies, des caractéristiques de la prestation, de la quantité, de la difficulté, de la distance, des options choisies, des matériaux nécessaires ou d\'autres paramètres applicables.',
      'Je m\'engage à vérifier les informations affichées avant de poursuivre la réservation.'] },
  { t: 'Modification du prix', p: [
      'Lorsqu\'un prix définitif a été accepté, aucune modification ne doit être imposée directement par le professionnel.',
      'Toute prestation supplémentaire ou modification susceptible d\'entraîner un coût supplémentaire doit être déclarée dans l\'application et suivre la procédure de validation prévue par Klean Service.'] },
  { t: 'Réservation de la prestation', p: [
      'La prestation est considérée comme réservée lorsque les étapes requises par Klean-Services ont été correctement effectuées, notamment la validation de la demande et, lorsque cela est prévu, le paiement ou la confirmation du mode de paiement.'] },
  { t: 'Paiement', p: [
      'Je m\'engage à payer le montant convenu selon le moyen de paiement proposé et accepté dans Klean-Services.',
      'Je ne dois pas effectuer un paiement supplémentaire directement au professionnel en dehors de la procédure prévue par l\'application, sauf lorsque Klean-Services prévoit explicitement un paiement en espèces.'] },
  { t: 'Paiement en espèces', p: [
      'Lorsque le paiement en espèces est autorisé, je m\'engage à verser au professionnel le montant correspondant à la prestation validée.',
      'Après le paiement, je dois confirmer dans l\'application le montant effectivement versé.',
      'En cas de différence entre le montant prévu et le montant demandé ou reçu, je dois le signaler immédiatement à Klean Service.'] },
  { t: 'Accès au lieu de prestation', p: [
      'Je m\'engage à permettre au professionnel d\'accéder au lieu convenu et à lui fournir les conditions raisonnablement nécessaires à la réalisation du service.',
      'Je dois également signaler à l\'avance toute difficulté d\'accès ou toute circonstance particulière pouvant affecter la prestation.'] },
  { t: 'Objets fragiles, précieux ou particuliers', p: [
      'Avant le début de la prestation, je dois informer le professionnel de la présence d\'objets fragiles, précieux, dangereux ou nécessitant des précautions particulières.'] },
  { t: 'Surveillance et protection de mes biens', p: [
      'Je suis responsable de prendre les précautions nécessaires pour surveiller mes biens et mon environnement pendant l\'intervention du professionnel.',
      'Lorsque cela est possible, je suis invité à rester présent ou à désigner une personne de confiance pour superviser la prestation.',
      'Je dois notamment mettre à l\'abri mes objets de valeur, documents importants, espèces et biens personnels qui ne sont pas concernés par la prestation.'] },
  { t: 'Respect du professionnel', p: [
      'Je m\'engage à traiter le professionnel avec respect et à ne pas lui demander d\'effectuer une prestation dangereuse, illégale ou différente de celle convenue sans validation préalable.'] },
  { t: 'Annulation, retard ou absence', p: [
      'En cas d\'empêchement, de retard important ou d\'impossibilité d\'assurer ma présence lorsque celle-ci est nécessaire, je dois prévenir le professionnel et, lorsque cela est nécessaire, Klean-Services.',
      'Les éventuels frais ou conséquences liés à une annulation ou à une absence sont appliqués conformément aux règles de Klean Service.'] },
  { t: 'Fin de la prestation', p: [
      'À la fin de la prestation, je dois vérifier le service réalisé et signaler rapidement toute anomalie constatée à travers les fonctionnalités prévues par Klean-Services.',
      'Lorsque le système prévoit une confirmation de fin de prestation, je dois l\'effectuer après vérification.'] },
  { t: 'Litiges et réclamations', p: [
      'En cas de problème, de désaccord concernant le service, le prix, le paiement ou le comportement du professionnel, je dois utiliser les fonctionnalités de réclamation ou de signalement de Klean-Services.',
      'Je peux être invité à fournir des photos, messages, preuves de paiement ou tout autre élément permettant d\'examiner la situation.'] },
  { t: 'Fraude et fausses déclarations', p: [
      'Il est interdit de fournir volontairement de fausses informations, de simuler un paiement, de créer de fausses demandes, de manipuler les évaluations ou d\'utiliser Klean-Services dans le but d\'escroquer, de tromper, de harceler ou de nuire à un professionnel ou à la plateforme.'] },
  { t: 'Compte personnel et sécurité', p: [
      'Je suis responsable de la sécurité de mon compte Klean-Services et je m\'engage à ne pas partager mes identifiants, codes de connexion ou moyens d\'accès avec des tiers.'] },
  { t: 'Blocage, suspension ou suppression du compte', p: [
      'En cas de non-respect des présentes conditions, de fraude, de tentative de contournement de Klean-Services, de comportement abusif ou de violation grave des règles de la plateforme, le compte du client peut être bloqué, suspendu ou supprimé, conformément aux procédures et règles applicables de Klean Service.'] },
  { t: 'Acceptation des conditions', p: [
      'En acceptant les conditions établies par Klean-Services, j\'accepte de devenir un client Klean pour le bon déroulement des prestations.'] }
],
  pro: [
  { t: 'Inscription et informations professionnelles', p: [
      'Je m\'engage à fournir des informations exactes, complètes et à jour concernant mon identité, mon entreprise lorsqu\'il y a lieu, mes coordonnées, mes compétences, mes services, ma zone d\'intervention et toute information demandée par Klean Service.'] },
  { t: 'Vérification du profil', p: [
      'Je reconnais que Klean-Services peut demander des informations ou documents permettant de vérifier mon identité, mon activité, mes compétences ou les informations fournies.',
      'Je m\'engage à fournir des documents authentiques et valides lorsque ceux-ci sont demandés.'] },
  { t: 'Présentation de mes services', p: [
      'Je m\'engage à présenter uniquement les services que je suis réellement capable de réaliser et à ne pas déclarer de fausses compétences, qualifications, expériences ou disponibilités.'] },
  { t: 'Réception d\'une demande client', p: [
      'Lorsque je reçois une demande, je dois examiner attentivement les informations fournies par le client avant d\'accepter la prestation.',
      'Si des informations sont insuffisantes, je peux demander les précisions nécessaires à travers Klean-Services.'] },
  { t: 'Échanges avec le client', p: [
      'Les échanges relatifs à la prestation doivent être effectués à travers les fonctionnalités prévues par Klean-Services afin de permettre le suivi et la sécurisation de la prestation.',
      'Je m\'engage à rester respectueux, professionnel et clair dans mes communications avec le client.'] },
  { t: 'Photos, vidéos et informations complémentaires', p: [
      'Lorsque cela est nécessaire pour évaluer correctement la prestation, je peux demander au client des photos, vidéos ou informations complémentaires à travers Klean-Services.',
      'Je m\'engage à utiliser ces éléments uniquement dans le cadre de la prestation et conformément aux règles de la plateforme.'] },
  { t: 'Évaluation de la prestation', p: [
      'Je m\'engage à examiner objectivement les caractéristiques de la prestation avant de confirmer mon intervention, notamment la quantité, les dimensions, l\'état des biens, la difficulté, l\'accessibilité, la distance, les matériaux nécessaires et toute autre circonstance pouvant avoir une incidence sur le travail.'] },
  { t: 'Prix et devis', p: [
      'Je m\'engage à respecter le système de tarification de Klean Service lorsqu\'il est applicable.',
      'Lorsque je suis autorisé à proposer ou à modifier un prix, je dois fournir un montant correspondant réellement à la prestation demandée et respecter les limites, règles et procédures définies par Klean-Services.',
      'Pour les prestations nécessitant un devis, celui-ci doit être suffisamment clair pour permettre au client de comprendre ce qui est inclus dans le prix.'] },
  { t: 'Interdiction des frais cachés', p: [
      'Je ne dois pas demander au client de frais supplémentaires qui n\'ont pas été prévus ou validés.',
      'Toute prestation supplémentaire ou modification entraînant un coût supplémentaire doit être déclarée dans Klean-Services et suivre la procédure de validation prévue par la plateforme.'] },
  { t: 'Acceptation de la prestation', p: [
      'Je ne dois accepter une prestation que si je suis réellement en mesure de la réaliser dans les conditions convenues.',
      'Après acceptation, je m\'engage à respecter les informations, le prix, la date, l\'heure, le lieu et les caractéristiques de la prestation validés dans Klean-Services.'] },
  { t: 'Interdiction de contourner Klean Service', p: [
      'Je m\'engage à ne pas utiliser les coordonnées ou informations obtenues grâce à Klean Service pour proposer ou réaliser directement avec le client une prestation en dehors de l\'application dans le but de contourner Klean-Services, sa réservation, son suivi ou son système de paiement.',
      'Si un client souhaite faire appel de nouveau à mes services, il doit utiliser mon code professionnel dans l\'application et effectuer une nouvelle demande selon la procédure prévue par Klean Service.',
      'Je m\'engage à ne pas encourager ou accepter le contournement de cette procédure.'] },
  { t: 'Déplacement vers le lieu de prestation', p: [
      'Je m\'engage à me rendre au lieu convenu dans les conditions prévues.',
      'En cas de retard important, d\'empêchement ou d\'impossibilité de me déplacer, je dois prévenir rapidement le client et Klean-Services lorsque cela est nécessaire.'] },
  { t: 'Réalisation de la prestation', p: [
      'Je m\'engage à réaliser uniquement le travail convenu et à respecter les caractéristiques de la prestation validée.',
      'Je ne dois pas effectuer volontairement un travail différent de celui accepté sans accord préalable du client et, lorsque nécessaire, validation dans Klean-Services.'] },
  { t: 'Matériel, équipements et produits', p: [
      'Je suis responsable de disposer des outils, équipements et produits nécessaires lorsque ceux-ci sont à ma charge selon les conditions de la prestation.',
      'Je dois utiliser un matériel adapté et prendre les précautions nécessaires pour éviter les dommages aux biens du client.'] },
  { t: 'Sécurité pendant l\'intervention', p: [
      'Je m\'engage à respecter les règles de sécurité applicables à mon activité et à ne pas effectuer volontairement une opération présentant un risque injustifié pour le client, ses biens, moi-même ou les autres personnes présentes.',
      'Lorsque les conditions de travail sont dangereuses ou ne permettent pas une intervention normale, je dois le signaler au client et, si nécessaire, à Klean-Services.'] },
  { t: 'Respect des biens du client', p: [
      'Je m\'engage à respecter les biens, équipements, locaux et objets appartenant au client.',
      'Je ne dois pas déplacer, utiliser, prendre ou emporter un bien du client sans autorisation lorsque cela n\'est pas nécessaire à la prestation.'] },
  { t: 'Paiement', p: [
      'Je m\'engage à respecter le mode de paiement prévu par Klean-Services.',
      'Je ne dois pas demander au client de payer un montant différent du montant validé sans passer par la procédure de modification prévue par Klean-Services.'] },
  { t: 'Paiement en espèces', p: [
      'Lorsque le paiement en espèces est autorisé, je m\'engage à recevoir uniquement le montant correspondant à la prestation validée ou au montant supplémentaire officiellement accepté.',
      'Je dois confirmer honnêtement dans l\'application le montant effectivement reçu.',
      'Il est interdit de déclarer un montant différent de celui réellement payé.'] },
  { t: 'Preuve et confirmation de la prestation', p: [
      'Lorsque Klean-Services demande une confirmation, une preuve, une photo ou toute autre information concernant la réalisation de la prestation, je m\'engage à fournir des éléments exacts et pertinents.',
      'Je ne dois pas déclarer une prestation comme terminée si elle n\'a pas réellement été réalisée.'] },
  { t: 'Fin de prestation', p: [
      'À la fin de l\'intervention, je dois permettre au client de vérifier le travail réalisé et signaler dans Klean-Services toute information nécessaire à la clôture de la prestation.'] },
  { t: 'Annulation ou impossibilité d\'intervenir', p: [
      'Si je ne peux plus assurer une prestation acceptée, je dois prévenir le client et Klean-Services le plus rapidement possible.',
      'Les conséquences éventuelles d\'une annulation injustifiée, répétée ou tardive sont appliquées conformément aux règles de Klean-Services.'] },
  { t: 'Réclamations et litiges', p: [
      'En cas de désaccord avec un client concernant le travail, le prix, le paiement, les biens ou tout autre élément de la prestation, je m\'engage à utiliser la procédure de réclamation ou de résolution des litiges prévue par Klean-Services.',
      'Je m\'engage à fournir les éléments permettant d\'examiner la situation : messages, photos, preuves de paiement, informations sur la prestation ou tout autre élément pertinent.'] },
  { t: 'Interdiction de fraude et de fausses déclarations', p: [
      'Il est interdit de fournir de faux documents, de fausses informations, de fausses preuves de prestation ou de paiement, de manipuler les évaluations, de créer de faux comptes ou d\'utiliser Klean-Services pour escroquer, tromper, harceler ou nuire à un client ou à la plateforme.'] },
  { t: 'Compte professionnel', p: [
      'Je suis responsable de la sécurité de mon compte professionnel.',
      'Je m\'engage à ne pas partager mes identifiants, codes de connexion ou moyens d\'accès avec une personne non autorisée.',
      'Pour une entreprise, les accès accordés à ses employés ou représentants doivent être gérés de manière sécurisée et conformément aux fonctionnalités prévues par Klean-Services.'] },
  { t: 'Responsabilité professionnelle', p: [
      'Je reconnais être responsable des actes que j\'accomplis dans le cadre de mes prestations et je m\'engage à respecter les obligations légales, professionnelles et de sécurité applicables à mon activité.'] },
  { t: 'Respect des règles de Klean-Services', p: [
      'Je m\'engage à respecter les règles, procédures, fonctionnalités et mécanismes de sécurité mis en place par Klean-Services, notamment ceux concernant les réservations, les paiements, les réclamations, les évaluations et la communication avec les clients.'] },
  { t: 'Blocage, suspension ou suppression du compte', p: [
      'En cas de non-respect des présentes conditions, de fraude, de contournement de Klean-Services, de fausses déclarations, de comportement abusif, de mise en danger d\'un client ou de violation grave des règles de la plateforme, le compte professionnel peut être bloqué, suspendu ou supprimé définitivement, conformément aux procédures et règles applicables de Klean-Services.'] },
  { t: 'Acceptation des conditions', p: [
      'En acceptant les conditions établies par Klean-Services pour le bon déroulement des prestations, je deviens un Klean professionnel et je m\'engage à les respecter.'] }
]
};
function conditionsEnsure() {
  const C = db.conditions;
  if (!C || typeof C !== 'object') { db.conditions = JSON.parse(JSON.stringify(CONDITIONS_DEF)); db.conditions.versions = [{ n: 1, at: nowISO(), par: 'PDG', note: CONDITIONS_DEF.source }]; db.conditions.acceptations = []; db.conditions.journal = []; return; }
  if (!Array.isArray(C.client) || !C.client.length) C.client = JSON.parse(JSON.stringify(CONDITIONS_DEF.client));
  if (!Array.isArray(C.pro) || !C.pro.length) C.pro = JSON.parse(JSON.stringify(CONDITIONS_DEF.pro));
  if (!Array.isArray(C.versions)) C.versions = [{ n: Number(C.version) || 1, at: nowISO(), par: 'PDG', note: C.source || '' }];
  if (!Array.isArray(C.acceptations)) C.acceptations = [];
  if (!Array.isArray(C.journal)) C.journal = [];
  if (typeof C.version !== 'number') C.version = 1;
  if (C.exigee === undefined) C.exigee = true;
}
const conditionsRole = r => (String(r || '').toLowerCase() === 'pro' ? 'pro' : 'client');
function conditionsPub(role) {
  conditionsEnsure();
  const C = db.conditions, r = conditionsRole(role);
  return { ok: true, role: r, version: C.version, maj: C.maj || '', source: C.source || '', exigee: C.exigee !== false,
    titre: (r === 'pro' ? 'CONDITIONS PROFESSIONNEL — KLEAN-SERVICES' : 'CONDITIONS CLIENT — KLEAN-SERVICES CI'),
    intro: (r === 'pro' ? 'En utilisant Klean Service en tant que professionnel particulier ou entreprise, je reconnais et accepte les conditions suivantes :'
                       : 'En utilisant Klean-Services en tant que client, je reconnais et accepte les conditions suivantes :'),
    articles: C[r].map((a, i) => ({ n: i + 1, t: a.t, p: a.p })),
    nbAcceptations: (C.acceptations || []).filter(a => a.role === r).length,
    nbAcceptationsVersion: (C.acceptations || []).filter(a => a.role === r && a.version === C.version).length };
}
/* 🔎 l'acceptation d'UNE personne (par téléphone) pour la version courante */
function conditionsEtat(role, tel) {
  conditionsEnsure();
  const C = db.conditions, r = conditionsRole(role), t = String(tel || '').replace(/\D/g, '');
  const miennes = (C.acceptations || []).filter(a => a.role === r && (!t || a.tel === t));
  const derniere = miennes.length ? miennes[miennes.length - 1] : null;
  return { ok: true, role: r, version: C.version, exigee: C.exigee !== false,
    accepte: !!(derniere && derniere.version === C.version),
    accepteVersion: derniere ? derniere.version : 0, accepteLe: derniere ? derniere.at : '',
    aRelire: !!(derniere && derniere.version !== C.version), nbAcceptations: miennes.length };
}
/* ✍️ enregistre l'acceptation (preuve) — refuse une version périmée : on n'accepte QUE ce qu'on a lu */
function conditionsAccepter(role, qui, tel, extra) {
  conditionsEnsure();
  const C = db.conditions, r = conditionsRole(role);
  const a = { at: nowISO(), role: r, version: C.version, qui: String(qui || '').slice(0, 80),
    tel: String(tel || '').replace(/\D/g, '').slice(0, 20), appareil: String((extra && extra.ua) || '').slice(0, 120),
    ip: String((extra && extra.ip) || '').slice(0, 60), source: String((extra && extra.source) || 'application').slice(0, 40),
    texte: 'v' + C.version + ' du ' + (C.maj || '') };
  C.acceptations.push(a);
  if (C.acceptations.length > 5000) C.acceptations = C.acceptations.slice(-4000);
  return a;
}


/* ═══════════ 🤝 MISE EN RELATION CLIENT ↔ PROFESSIONNEL (lot 118) ═══════════
   Règle du PDG : UNE DEMANDE → PROFESSIONNEL 1 → (s'il refuse) PROFESSIONNEL 2 → FIN.
   · 2 professionnels maximum par demande et par jour, jamais de 3ᵉ mise en relation automatique ;
   · après le 2ᵉ refus : la demande se met en pause et ne se reprend que LE JOUR SUIVANT ;
   · la conversation ne s'ouvre qu'avec une vraie mise en relation, et reste COURTE (nombre de
     messages, caractères, cadence limités) — pas un WhatsApp ;
   · le prix passe par la BULLE « PRIX » (le devis du lot 109) : séparé des messages ordinaires,
     verrouillé dès que le client l'accepte ; un nouveau montant = nouvelle proposition à accepter ;
   · tout est tracé (qui, quoi, quand) et consultable par les gestionnaires ;
   · la protection contre le contournement surveille chaque message : numéros, liens, e-mails,
     réseaux sociaux, invitation à sortir de Klean. Trois manquements → relation arrêtée et
     signalement aux gestionnaires (jamais un blocage définitif automatique : le PDG décide).
   ═══════════════════════════════════════════════════════════════════════════ */
const REL_DEF = {
  version: 1, maxProsParTour: 2, maxProsParJour: 2, repriseHeures: 12,
  msgMaxParCote: 8, msgMaxCar: 240, msgMinIntervalSec: 3,
  anti: { actif: true, bloquer: true, signalerApres: 3 },
  rapides: {
    pro: ['J’accepte la demande.', 'Je suis disponible.', 'J’ai besoin d’une précision.', 'Voici le prix pour ce devis.'],
    client: ['J’accepte le prix.', 'Je refuse le prix.', 'J’ai une précision à ajouter.', 'Modifier ma demande.', 'Annuler.']
  }
};
const REL_ETATS = {
  attente_pro1: 'En attente du professionnel 1', pro1_accepte: 'Professionnel 1 accepté',
  pro1_refuse: 'Professionnel 1 refusé / non disponible', attente_pro2: 'En attente du professionnel 2',
  pro2_accepte: 'Professionnel 2 accepté', aucun_pro: 'Aucun professionnel disponible', annulee: 'Demande annulée'
};
function relConfig() {
  if (!db.rel || typeof db.rel !== 'object') db.rel = JSON.parse(JSON.stringify(REL_DEF));
  const R = db.rel;
  ['maxProsParTour', 'maxProsParJour', 'repriseHeures', 'msgMaxParCote', 'msgMaxCar', 'msgMinIntervalSec'].forEach(k => { if (typeof R[k] !== 'number') R[k] = REL_DEF[k]; });
  if (!R.anti || typeof R.anti !== 'object') R.anti = JSON.parse(JSON.stringify(REL_DEF.anti));
  if (!R.rapides || typeof R.rapides !== 'object') R.rapides = JSON.parse(JSON.stringify(REL_DEF.rapides));
  if (!Array.isArray(R.rapides.pro)) R.rapides.pro = REL_DEF.rapides.pro.slice();
  if (!Array.isArray(R.rapides.client)) R.rapides.client = REL_DEF.rapides.client.slice();
  if (typeof R.version !== 'number') R.version = 1;
  if (!db.contournements) db.contournements = [];
  return R;
}
function relNorm(texte) {
  return String(texte == null ? '' : texte).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2019']/g, ' ').replace(/\s+/g, ' ').trim();
}
/* 🗣️ LE LANGAGE DU REFUS — ce que veut dire un professionnel (ou un client), même écrit vite ou mal */
const REL_MOTS = {
  refuse: ['je refuse', 'refuse la demande', 'je ne peux pas', 'je ne peut pas', 'je peux pas', 'pas possible', 'impossible',
    'pas disponible', 'pas dispo', 'non disponible', 'indisponible', 'je ne suis pas disponible', 'je suis occupe', 'suis occupe', 'occupe',
    'desole', 'trop loin', 'hors de ma zone', 'hors zone', 'je ne fais pas', 'pas dans mes competences', 'pas ma competence',
    'je passe', 'non merci', 'je decline', 'je ne suis pas libre', 'pas libre', 'je ne pourrai pas', 'je ne serai pas disponible',
    'je ne serai pas la', 'pas aujourd hui', 'une autre fois', 'plus tard peut etre', 'demain peut etre', 'annule', 'annuler',
    'je me retire', 'je laisse tomber', 'je ne suis pas interesse', 'pas interesse', 'je ne prends pas', 'j abandonne'],
  accepte: ['j accepte', 'accepte la demande', 'jaccepte', 'je suis disponible', 'je suis dispo', 'je suis libre', 'je peux',
    'oui je peux', 'je peux le faire', 'je peux venir', 'je viens', 'j arrive', 'd accord', 'ok', 'okay', 'je prends',
    'c est bon', 'ca marche', 'je confirme', 'je valide', 'disponible', 'je suis la', 'present', 'je suis interesse'],
  precision: ['besoin d une precision', 'j ai besoin d une precision', 'une precision', 'un detail', 'des details', 'j ai une question',
    'question sur', 'expliquez', 'precisez', 'pouvez vous me dire', 'je veux comprendre', 'c est quoi'],
  prix: ['voici le prix', 'mon prix', 'prix pour ce devis', 'mon tarif', 'voici mon tarif', 'je propose', 'mon devis', 'le prix est']
};
/* sens reconnu par ordre de priorité : refus explicite d'abord (un refus ne doit jamais être pris pour un oui) */
function relSens(texte) {
  const t = relNorm(texte);
  if (!t) return 'inconnu';
  const contient = (liste) => liste.some(m => t.indexOf(m) >= 0);
  if (contient(REL_MOTS.refuse)) return 'refuse';
  if (/\bnon\b/.test(t) && !/\bnon\s*(,| )?\s*(probleme|souci)\b/.test(t)) return 'refuse';
  if (contient(REL_MOTS.prix)) return 'prix';
  if (contient(REL_MOTS.precision)) return 'precision';
  if (contient(REL_MOTS.accepte)) return 'accepte';
  return 'inconnu';
}
function relSensTxt(s) {
  return { accepte: '✅ acceptation', refuse: '❌ refus', precision: '❓ demande de précision', prix: '💰 prix', inconnu: '💬 message' }[s] || '💬 message';
}
/* 🛡️ PROTECTION CONTRE LE CONTOURNEMENT — détecte ce qui sert à sortir de Klean */
function relContournement(texte) {
  const brut = String(texte == null ? '' : texte);
  /* ① on neutralise d'abord les MONTANTS (« 8 000 F », « 12.500 FCFA ») : un prix n'est pas un numéro */
  let t = brut.replace(/\b\d{1,3}(?:[ .\u00a0\u202f]\d{3})+(?:\s*(?:f|fcfa|francs?|cfa))?\b/gi, ' MONTANT ')
              .replace(/\b\d+\s*(?:f\b|fcfa|francs?|cfa)/gi, ' MONTANT ');
  const n = relNorm(brut);                                   /* minuscules, sans accents, espaces conservés */
  const motifs = [], fort = [];
  if (/\+?225\d{8,}/.test(t.replace(/[^0-9+]/g, '')) || /\d{8,}/.test(t.replace(/[^0-9]/g, ''))) { motifs.push('numéro de téléphone'); fort.push(1); }
  if (/(https?:|www\.|\.(com|net|org|ci|fr|io|me)\b|t\.me|wa\.me|bit\.ly)/i.test(brut)) motifs.push('lien externe');
  if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(brut)) { motifs.push('adresse e-mail'); fort.push(1); }
  if (/\b(whatsapp|whatsap|watsap|ouatsap|telegram|instagram|facebook|tiktok|snapchat|messenger|viber)\b/.test(n)
      || /\bimo\b/.test(n) || /(^|\s)@[a-z0-9_.]{3,}/.test(n)) motifs.push('réseau social / messagerie externe');
  if (/(appelle moi|appel moi|appelle-moi|ton numero|votre numero|mon numero|mon contact|mon tel|mon telephone|mes coordonnees|mes contacts|mon adresse|envoie moi ton|envoyer ton|donne moi ton|donner ton|mon whatsapp|mon mail|hors application|hors de l application|en dehors de l application|sans l application|sans passer par|directement avec moi|en direct|en cash|contourn|on regle ca ensemble|on s arrange|je t explique au tel|je te explique au tel|appelle|appelez)/.test(n)) motifs.push('volonté de sortir de Klean');
  return { contourne: motifs.length > 0, motifs, gravite: fort.length ? 2 : (motifs.length ? 1 : 0) };
}
function relDe(m) {
  if (!m.rel) m.rel = { tour: 1, pros: [], actuel: null, etat: 'attente_pro1', msgs: [], hist: [], signale: false, ouvertLe: nowISO() };
  const r = m.rel;
  if (!Array.isArray(r.pros)) r.pros = [];
  if (!Array.isArray(r.msgs)) r.msgs = [];
  if (!Array.isArray(r.hist)) r.hist = [];
  if (typeof r.tour !== 'number') r.tour = 1;
  if (!Array.isArray(r.etatHisto)) r.etatHisto = [];
  if (!r.etat || !REL_ETATS[r.etat]) r.etat = 'attente_pro1';
  return r;
}
function relSetEtat(r, etat, quoi) {                    /* chaque état traversé est conservé (traçabilité) */
  r.etat = etat;
  if (!Array.isArray(r.etatHisto)) r.etatHisto = [];
  r.etatHisto.push({ at: nowISO(), etat: etat, txt: REL_ETATS[etat] || etat, quoi: String(quoi || '').slice(0, 120) });
  if (r.etatHisto.length > 60) r.etatHisto = r.etatHisto.slice(-50);
}
function relJournal(r, quoi, qui, role, detail) {
  r.hist.push({ at: nowISO(), quoi: quoi, qui: String(qui || '').slice(0, 60), role: role || 'systeme', detail: String(detail || '').slice(0, 300) });
  if (r.hist.length > 400) r.hist = r.hist.slice(-350);
}
function relMsgsys(r, texte, type) {
  r.msgs.push({ at: nowISO(), de: 'Klean', role: 'systeme', type: type || 'systeme', texte: String(texte).slice(0, 400) });
  if (r.msgs.length > 120) r.msgs = r.msgs.slice(-100);
}
/* ⏰ après le 2ᵉ refus : la demande ne reprend que LE JOUR SUIVANT */
function relRepriseISO(C) {
  const d = new Date(Date.now() + Math.max(1, Number((C || relConfig()).repriseHeures) || 12) * 3600 * 1000);
  d.setHours(Math.max(6, d.getHours()), 0, 0, 0);
  return d.toISOString();
}
function relEtape(m) {                       /* l'étape affichée : prix proposé → prix accepté → paiement → prestation */
  if (!m) return 'attente';
  if (m.status === 'annulee') return 'annulee';
  if (m.status === 'terminee') return 'prestation_terminee';
  if (['enroute', 'arrive', 'encours'].indexOf(m.status) >= 0) return 'prestation';
  const r = m.rel || {};
  if (m.prixVerrouille && m.prixVerrouille.montant > 0) return (r.payeAt ? 'prestation' : 'paiement');
  if (m.devis && m.devis.version) return m.devis.statut === 'accepte' ? 'prix_accepte' : 'devis';
  return 'attente';
}
/* combien de professionnels contactés AUJOURD'HUI pour CETTE demande (le plafond est par demande) */
function relProsAujourdHui(m) {
  const j = String(nowISO()).slice(0, 10);
  const r = m.rel || {};
  return (r.pros || []).filter(p => String(p.at || '').slice(0, 10) === j).length;
}
/* 🤝 ouvrir une relation avec UN professionnel (1ᵉʳ ou 2ᵉ, jamais un 3ᵉ) */
function relOuvrir(m, ag, source, silencieux) {
  const C = relConfig(), r = relDe(m);
  if (!ag) return { ok: false, error: 'Professionnel introuvable' };
  if (r.pros.some(p => p.proId === ag.id))
    return { ok: false, error: 'Ce professionnel a déjà été contacté pour cette demande', deja: true };
  const duTour = r.pros.filter(p => (p.tour || 1) === (r.tour || 1)).length;
  if (duTour >= C.maxProsParTour)
    return { ok: false, error: 'RÈGLE KLEAN : ' + C.maxProsParTour + ' professionnels maximum par demande. Après le 2ᵉ, la recherche s’arrête — reprenez cette demande demain.', limite: true };
  const dejaJour = relProsAujourdHui(m);
  if (dejaJour >= C.maxProsParJour)
    return { ok: false, error: 'Plafond du jour atteint : ' + C.maxProsParJour + ' mises en relation par jour. Reprenez demain — c’est la règle pour protéger les professionnels.', limite: true };
  const rang = r.pros.length + 1;
  r.pros.push({ proId: ag.id, nom: ag.nom, numPro: ag.numPro || '', rang: rang, tour: r.tour || 1, at: nowISO(), sens: 'en_attente', source: source || 'systeme' });
  r.actuel = ag.id; r.actuelNom = ag.nom;
  relSetEtat(r, rang === 1 ? 'attente_pro1' : 'attente_pro2', 'professionnel ' + rang + ' sollicité : ' + ag.nom);
  r.prochaineLe = null;
  m.cible = ag.id; m.cibleNom = ag.nom; m.matchScope = 'cible'; m.agentId = null; m.status = 'pending';
  relJournal(r, 'mise_en_relation', 'système', 'systeme', 'professionnel ' + rang + ' : ' + ag.nom + (source === 'cible' ? ' (choisi par le client)' : ''));
  relMsgsys(r, '🤝 Mise en relation avec le professionnel ' + rang + ' : ' + ag.nom + '. Vous pouvez échanger ici, brièvement.');
  saveDb();
  if (!silencieux) { try { broadcastMissionCiblee(m); } catch (e) { } }
  try { emitAdmin('relation', '🤝 ' + m.id + ' — professionnel ' + rang + ' sollicité : ' + ag.nom); } catch (e) { }
  return { ok: true, rang: rang, etat: r.etat };
}
/* 🔎 proposer le professionnel suivant (jamais un 3ᵉ : la règle est dans relOuvrir) */
function relProposerSuivant(m) {
  const r = relDe(m);
  const deja = r.pros.map(p => p.proId);
  const cands = (db.agents || []).filter(a => a && (a.status || 'approved') === 'approved' && !a.blocked && deja.indexOf(a.id) < 0
    && (m.exclAg || []).indexOf(a.id) < 0 && (m.service === 'custom' || agentHasService(a, m.service)));
  if (!cands.length) return { ok: false, aucun: true };
  cands.sort((a, b) => ((b.online ? 1 : 0) - (a.online ? 1 : 0)) || ((agentStats(b).rating || 0) - (agentStats(a).rating || 0)));
  const o = relOuvrir(m, cands[0], 'systeme');
  return o.ok ? { ok: true, pro: cands[0].nom, rang: o.rang, etat: o.etat } : { ok: false, error: o.error, limite: !!o.limite, aucun: true };
}
/* ✅/❌ la réponse du professionnel (mot reconnu par le langage du refus) */
function relReponse(m, ag, sens, texte) {
  const C = relConfig(), r = relDe(m);
  const p = r.pros.slice().reverse().find(x => x.proId === ag.id);
  if (!p) return { ok: false, error: 'Vous n’êtes pas le professionnel en relation sur cette demande' };
  if (p.sens === 'refuse') return { ok: false, error: 'Vous avez déjà répondu à cette demande' };
  const s = (sens && sens !== 'auto') ? sens : relSens(texte);
  const mot = String(texte || '').slice(0, 200);
  if (s === 'accepte') {
    p.sens = 'accepte'; p.reponseAt = nowISO();
    relSetEtat(r, p.rang === 1 ? 'pro1_accepte' : 'pro2_accepte', ag.nom + ' accepte');
    r.derniereReponse = 'accepte';
    m.status = 'accepted'; m.agentId = ag.id;
    const premier = !m.dist; if (premier) m.dist = distMissionPro(m, ag);
    relJournal(r, 'reponse_pro', ag.nom, 'pro', 'accepte la demande' + (mot ? ' — « ' + mot + ' »' : ''));
    relMsgsys(r, '✅ ' + ag.nom + ' accepte la demande. Prochaine étape : son PRIX, puis votre validation.');
    saveDb();
    try { emitAdmin('accept', '✅ ' + ag.nom + ' accepte la demande ' + m.id + (p.rang === 2 ? ' (professionnel 2)' : '')); } catch (e) { }
    return { ok: true, etat: r.etat, sens: 'accepte' };
  }
  if (s === 'refuse') {
    relJournal(r, 'reponse_pro', ag.nom, 'pro', 'refus / non disponible' + (mot ? ' — « ' + mot + ' »' : ''));
    relMsgsys(r, (p.rang === 1 ? '❌ Le professionnel 1 n’est pas disponible' : '❌ Le professionnel 2 n’est pas disponible')
      + (mot ? ' · « ' + mot.slice(0, 120) + ' »' : '') + '.', 'refus');
    const e = relApresEchec(m, ag.id, mot || 'refus du professionnel', 'refus');
    return { ok: true, etat: e.etat, sens: 'refuse', suivant: e.suivant };
  }
  /* ni oui ni non : le professionnel pose une question → simple message (compte dans les limites) */
  if (mot) { const w = relMsg(m, 'pro', ag.nom, mot, { rapide: false }); if (w.bloque) return w; }
  relJournal(r, 'question_pro', ag.nom, 'pro', mot);
  saveDb();
  return { ok: true, etat: r.etat, sens: 'precision' };
}
/* ❌ un professionnel sort du jeu (refus, non disponible, ou prix refusé par le client) :
   on marque, on prévient, et on propose LE SUIVANT — jamais un 3ᵉ, et pause jusqu'au lendemain après le 2ᵉ. */
function relApresEchec(m, proId, motif, cause) {
  const C = relConfig(), r = relDe(m);
  const p = r.pros.find(x => x.proId === proId);
  const rang = p ? p.rang : r.pros.length;
  if (p && p.sens !== 'refuse') { p.sens = 'refuse'; p.reponseAt = nowISO(); p.motif = String(motif || '').slice(0, 200); p.cause = cause || ''; }
  const autres = r.pros.filter(x => x.sens === 'accepte');
  if (!autres.length) { m.agentId = null; m.status = 'pending'; }
  r.derniereReponse = 'refuse';
  relSetEtat(r, rang === 1 ? 'pro1_refuse' : 'aucun_pro', (p && p.nom ? p.nom : 'professionnel ' + rang) + ' : ' + String(motif || cause || '').slice(0, 80));
  let suivant = null;
  if (!autres.length) {
    if (r.pros.filter(x => (x.tour || 1) === (r.tour || 1)).length < C.maxProsParTour) {
      suivant = relProposerSuivant(m);
      if (!suivant.ok) {
        relSetEtat(r, 'aucun_pro', 'aucun professionnel disponible'); r.prochaineLe = relRepriseISO(C);
        relMsgsys(r, '⏸️ Aucun professionnel disponible maintenant. Vous pourrez reprendre cette demande demain.', 'alerte');
      }
    } else {
      relSetEtat(r, 'aucun_pro', 'fin de recherche : 2 professionnels atteints'); r.prochaineLe = relRepriseISO(C);
      relMsgsys(r, '⏸️ Après ' + C.maxProsParTour + ' professionnels, la recherche s’arrête : vous pourrez reprendre cette demande demain (jamais de 3ᵉ professionnel automatique).', 'alerte');
    }
  }
  saveDb();
  try { emitAdmin('relation', (rang === 1 ? '🔁' : '⏹️') + ' ' + m.id + ' — professionnel ' + rang + ' hors jeu (' + (cause || motif || '') + ')'
    + (suivant && suivant.ok ? ' → professionnel 2 : ' + suivant.pro : ' → fin de recherche, reprise possible demain')); } catch (e) { }
  return { etat: r.etat, suivant: suivant && suivant.ok ? suivant.rang : null };
}

/* 💬 un message (court, limité, surveillé) — refusé s'il sert à contourner Klean */
function relMsg(m, role, qui, texte, opts) {
  const C = relConfig(), r = relDe(m);
  const t = String(texte == null ? '' : texte).trim();
  if (!t) return { ok: false, error: 'Message vide' };
  if (r.etat === 'annulee') return { ok: false, error: 'Cette demande est annulée : la conversation est fermée' };
  if (t.length > C.msgMaxCar) return { ok: false, error: 'Message trop long (maximum ' + C.msgMaxCar + ' caractères) — soyez bref, c’est une conversation de travail' };
  const miens = r.msgs.filter(x => x.role === role && x.type !== 'systeme').length;
  if (miens >= C.msgMaxParCote) return { ok: false, error: 'Limite atteinte : ' + C.msgMaxParCote + ' messages maximum par personne et par demande. Utilisez les réponses rapides ou le bouton PRIX.', limite: true };
  const derniers = r.msgs.filter(x => x.role === role).map(x => x.at).sort();
  if (derniers.length) {
    const dt = (Date.now() - new Date(derniers[derniers.length - 1]).getTime()) / 1000;
    if (dt < C.msgMinIntervalSec) return { ok: false, error: 'Doucement : patientez quelques secondes entre deux messages' };
  }
  /* 🛡️ contrôle anti-contournement */
  const ctl = C.anti.actif ? relContournement(t) : { contourne: false, motifs: [], gravite: 0 };
  if (ctl.contourne && C.anti.bloquer) {
    db.contournements.push({ id: uid('CT'), at: nowISO(), missionId: m.id, role: role, qui: String(qui || '').slice(0, 60),
      motifs: ctl.motifs, gravite: ctl.gravite, extrait: t.slice(0, 160), action: 'message bloqué' });
    if (db.contournements.length > 2000) db.contournements = db.contournements.slice(-1500);
    const combien = db.contournements.filter(x => x.missionId === m.id && x.qui === qui).length;
    relJournal(r, 'contournement_bloque', qui, role, ctl.motifs.join(' · '));
    relMsgsys(r, '🛡️ Message bloqué : il contient ' + ctl.motifs.join(', ') + '. Klean protège la prestation : tout se passe ici. (manquement ' + combien + ')', 'alerte');
    let action = 'message bloqué + avertissement';
    if (combien >= (C.anti.signalerApres || 3)) {
      relSetEtat(r, 'annulee', 'contournement répété — signalé aux gestionnaires'); r.signale = true; m.status = 'annulee';
      action = 'relation arrêtée + signalement aux gestionnaires';
      relMsgsys(r, '⛔ Trop de tentatives de sortir de Klean : la relation est ARRÊTÉE et signalée aux gestionnaires.', 'alerte');
    }
    db.contournements[db.contournements.length - 1].action = action;
    saveDb();
    try { emitAdmin('contournement', '🛡️ ' + m.id + ' — ' + qui + ' (' + role + ') : ' + ctl.motifs.join(' · ') + ' → ' + action); } catch (e) { }
    return { ok: false, bloque: true, error: 'Message bloqué : ' + ctl.motifs.join(', ') + ' — la prestation et le paiement passent par Klean.', motifs: ctl.motifs, etat: r.etat };
  }
  r.msgs.push({ at: nowISO(), de: String(qui || '').slice(0, 60), role: role, type: opts && opts.rapide ? 'rapide' : 'texte', texte: t.slice(0, C.msgMaxCar) });
  if (r.msgs.length > 120) r.msgs = r.msgs.slice(-100);
  relJournal(r, 'message', qui, role, t.slice(0, 160));
  saveDb();
  try { emitToMission(m, { type: 'rel_message', missionId: m.id, role: role, de: qui, texte: t.slice(0, C.msgMaxCar) }); } catch (e) { }
  return { ok: true, restants: C.msgMaxParCote - (miens + 1) };
}
/* ce que le client et le pro voient (aucune donnée cachée, rien d'inventé) */
function relDemandePublique(m) {              /* ✍️ lot 112 : l'état de la demande et son historique, jamais perdu */
  const d = m.demandeModif || null;
  return { version: Number(m.demandeVersion || 1),
    modif: d ? { statut: d.statut, at: d.at, par: d.par, version: d.version, motif: d.motif || '',
      champs: d.champs || [], decideAt: d.decideAt || null } : null,
    hist: (m.demandeHist || []).slice(-6).map(h => ({ at: h.at, version: h.version, par: h.par, motif: h.motif,
      champs: Object.keys(h.apres || {}), avant: h.avant, apres: h.apres })) };
}
function relPublique(m) {
  const C = relConfig(), r = relDe(m);
  const role = (m.status || '') === '' ? 'client' : 'client';
  return {
    ok: true, missionId: m.id, etat: r.etat, etatTxt: REL_ETATS[r.etat] || r.etat, etape: relEtape(m),
    pros: r.pros.map(p => ({ proId: p.proId, rang: p.rang, tour: p.tour || 1, nom: p.nom, numPro: p.numPro, at: p.at, sens: p.sens, motif: p.motif || '' })),
    actuel: r.actuel ? { id: r.actuel, nom: r.actuelNom || '' } : null,
    prochaineLe: r.prochaineLe || null, signale: !!r.signale,
    etatHisto: (r.etatHisto || []).slice(-12),
    msgs: r.msgs.slice(-40), hist: r.hist.slice(-60),
    limites: { msgMaxParCote: C.msgMaxParCote, msgMaxCar: C.msgMaxCar, maxProsParTour: C.maxProsParTour, maxProsParJour: C.maxProsParJour },
    rapides: C.rapides, antiActif: !!C.anti.actif,
    prix: m.devis ? { version: m.devis.version, total: m.devis.total, statut: m.devis.statut, par: m.devis.par, at: m.devis.at,
      lignes: m.devis.lignes, motif: m.devis.motif || '', estModification: !!m.devis.estModification,
      marche: m.devis.marche || null, inhabituelMarche: !!m.devis.inhabituelMarche } : null,
    prixVerrouille: m.prixVerrouille || null,
    prixEnVigueur: m.prixVerrouille ? m.prixVerrouille.montant : (m.prixTotal || 0),
    demande: relDemandePublique(m),            /* ✍️ lot 112 : version des modifications, historique — jamais perdu */
    service: m.service, quartier: m.quartier, ville: m.ville || '', desc: m.desc || '', pieces: parseInt(m.pieces) || 1,
    date: m.date || '', time: m.time || '', adresse: m.adresse || '',
    tarif: m.tarif ? { mode: m.tarif.mode, total: m.tarif.total, fourchette: m.tarif.fourchette,
      unite: m.tarif.unite || '', quantite: m.tarif.quantite || 1,
      reponses: (m.tarif.reponses || []).slice(0, 20), questions: m.tarif.questions || 0 } : null
  };
}

function tarifEnsure() {
  if (!db.tarif) db.tarif = {};
  const T = db.tarif;
  if (typeof T.version !== 'number') T.version = 1;
  if (!Array.isArray(T.versions) || !T.versions.length)
    T.versions = [{ n: T.version, at: nowISO(), par: 'Klean', note: 'Version de départ — prix actuels des services, recopiés sans modification' }];
  if (!Array.isArray(T.journal)) T.journal = [];
  if (!Array.isArray(T.unites) || !T.unites.length) T.unites = TARIF_UNITES_DEF.map(x => Object.assign({}, x));
  if (!T.coefs) T.coefs = JSON.parse(JSON.stringify(TARIF_COEFS_DEF));
  if (!Array.isArray(T.paliers) || !T.paliers.length) T.paliers = TARIF_PALIERS_DEF.map(x => Object.assign({}, x));
  if (!T.deplacement) T.deplacement = JSON.parse(JSON.stringify(TARIF_DEPLACEMENT_DEF));
  if (!T.seuils) T.seuils = Object.assign({}, TARIF_SEUILS_DEF);
  if (!Array.isArray(T.questions) || !T.questions.length) T.questions = TARIF_QUESTIONS_DEF.map(x => JSON.parse(JSON.stringify(x)));
  if (!T.zones || typeof T.zones !== 'object') T.zones = {};
  if (!T.zonesSrc || typeof T.zonesSrc !== 'object') T.zonesSrc = JSON.parse(JSON.stringify(TARIF_ZONES_SRC_DEF));
  /* 🗺️ les zones connues sont créées UNE fois, avec k = 1 (donc AUCUN changement de prix) et leur
     distance estimée. Si le PDG règle une zone, sa valeur n'est jamais écrasée. */
  for (const zv in TARIF_ZONES_KM_DEF) {
    if (!T.zones[zv]) T.zones[zv] = { nom: zv.charAt(0).toUpperCase() + zv.slice(1), k: 1, km: TARIF_ZONES_KM_DEF[zv] };
    else if (typeof T.zones[zv].km !== 'number') T.zones[zv].km = TARIF_ZONES_KM_DEF[zv];
  }
  if (!Array.isArray(T.refs)) T.refs = [];                       /* 🏷️ prix du marché (sourcés) — voir lot 112 */
  /* 🏷️ référence de MARCHÉ pour le déplacement, avec source ET date (règle du PDG). Elle ne change
     AUCUN prix : elle sert uniquement à SIGNALER un montant inhabituel (jamais à le corriger). */
  if (!T.refs.some(x => x && x.id === 'deplacement'))
    T.refs.push({ id: 'deplacement', nom: 'Déplacement d’un professionnel (Abidjan)', min: 5000, max: 15000,
      unite: 'intervention', source: 'Yemba Plomberie — grille publiée (Abidjan)', date: '27/09/2026',
      note: 'Fourchette constatée pour un déplacement de professionnel à Abidjan. À confirmer/compléter par le PDG.' });
  if (!T.remises || typeof T.remises !== 'object') T.remises = Object.assign({}, TARIF_REMISES_DEF);
  if (!T.svc || typeof T.svc !== 'object') T.svc = {};
  const unitOf = id => T.unites.find(u => u.id === id) || T.unites[0];
  /* ① les MÉTIERS de l'application (prix actuels) */
  for (const id in TARIF_PRIX_DEF) {
    if (T.svc[id]) continue;                                     /* ⚠️ jamais écraser un réglage du PDG */
    const d = TARIF_PRIX_DEF[id];
    const cat = svcCat(id) || SVC_NOUVEAUX[id] || {};
    const comptable = (d.cat === 'clean' || !!d.piecesLabel);
    const unite = d.piecesLabel ? (String(d.piecesLabel).match(/véhicule/i) ? 'vehicule' : 'piece')
      : (comptable ? 'piece' : 'intervention');
    T.svc[id] = {
      id, nom: d.nom || cat.nom || id, ic: cat.ic || '🛠️', type: 'metier',
      cat: d.cat || '', unite, ref: d.base || 0,
      min: Math.round((d.base || 0) * 0.75), max: Math.round((d.base || 0) * 1.5),
      comptable, devis: false, etatCompte: d.cat === 'clean',
      photos: 'conseillees', photosMin: 2, materielPrix: 0, off: false,
      opts: (d.opts || []).map(o => Object.assign({}, o)), cree: false
    };
  }
  /* ② les SERVICES du catalogue national (4 niveaux) : ils prennent le prix de leur métier */
  let arbre = null; try { arbre = catalogueNational(); } catch (e) { arbre = null; }
  if (arbre && Array.isArray(arbre.services)) {
    for (const s of arbre.services) {
      const num = String(s.num);
      if (T.svc[num]) continue;
      const metier = svcCanon(s.metier) || s.metier || '';
      const base = T.svc[metier] || null;
      const tarifsSvc = catNatTarifs(num).map(x => x.id);
      const unite = tarifsSvc.indexOf('m2') >= 0 ? 'm2' : (tarifsSvc.indexOf('horaire') >= 0 ? 'heure'
        : (tarifsSvc.indexOf('journalier') >= 0 ? 'jour' : (tarifsSvc.indexOf('tache') >= 0 ? 'tache'
        : (tarifsSvc.indexOf('fixe') >= 0 ? 'forfait' : (base ? base.unite : 'intervention')))));
      const uniteFin = base ? base.unite : unite;          /* ⚠️ le PRIX vient du métier : son unité aussi */
      const u = unitOf(uniteFin);
      const devis = TARIF_DEVIS_NUMS.indexOf(num) >= 0
        || TARIF_DEVIS_METIERS.indexOf(metier) >= 0
        || (tarifsSvc.length === 1 && tarifsSvc[0] === 'devis');
      const ref = base ? base.ref : 0;
      T.svc[num] = {
        id: num, num, nom: s.nom, ic: s.ic || '🛠️', type: 'catalogue', metier,
        cat: base ? base.cat : '', unite: uniteFin, uniteNom: u.nom, comptable: !!(u && u.comptable),
        ref, min: Math.round(ref * 0.75), max: Math.round(ref * 1.5),
        devis, etatCompte: base ? !!base.etatCompte : false,
        photos: 'conseillees', photosMin: 2, materielPrix: 0, off: false,
        tarifs: tarifsSvc, fam: s.famille || '', opts: base ? base.opts.map(o => Object.assign({}, o)) : [], cree: false
      };
      /* lignes de facturation d'un service déjà tarifé : on garde une trace (traçabilité) */
    }
  }
  T.maj = T.maj || nowISO();
  return T;
}
function tarifVersion() { tarifEnsure(); return db.tarif.version || 1; }
/* 📚 VERSIONNAGE : chaque changement de tarif produit une NOUVELLE version, datée et signée.
   Une mission garde la version de son jour : on ne recalcule jamais une ancienne commande. */
function tarifBump(action, quoi, avant, apres, motif, par) {
  tarifEnsure();
  const T = db.tarif;
  T.version = (Number(T.version) || 1) + 1;
  T.maj = nowISO();
  T.versions.unshift({ n: T.version, at: T.maj, par: par || 'PDG', action: String(action || ''),
    note: String(motif || '').slice(0, 200) || (quoi ? (quoi + ' : ' + String(avant) + ' → ' + String(apres)) : '') });
  if (T.versions.length > 200) T.versions = T.versions.slice(0, 200);
  tarifJournal(action, quoi, avant, apres, motif, par);
  return T.version;
}
function tarifJournal(action, quoi, avant, apres, motif) {
  tarifEnsure();
  const T = db.tarif;
  T.journal.unshift({ at: nowISO(), par: (arguments.length > 5 ? arguments[5] : '') || 'PDG', action: String(action || '').slice(0, 40),
    quoi: String(quoi || '').slice(0, 80), avant: (avant === undefined ? '' : String(avant).slice(0, 120)),
    apres: (apres === undefined ? '' : String(apres).slice(0, 120)), motif: String(motif || '').slice(0, 160), version: T.version });
  if (T.journal.length > 400) T.journal = T.journal.slice(0, 400);
  try { auditLog('tarif_' + String(action || '').slice(0, 30), { quoi, avant, apres, motif, version: T.version }); } catch (e) {}
}
/* 🔎 RÉSOUDRE UN SERVICE : identifiant de métier, numéro du catalogue national, ou nom */
function tarifSvc(id) {
  tarifEnsure();
  const key = String(id == null ? '' : id).trim();
  if (!key) return null;
  const T = db.tarif;
  /* ⚠️ un tarif « désactivé » (off) n'est plus proposé au public, mais son PRIX reste calculable :
     une commande passée ou un service déjà connu ne doit jamais perdre son prix. */
  if (T.svc[key]) return T.svc[key];
  const canon = (() => { try { return svcCanon(key); } catch (e) { return key; } })();
  if (canon && T.svc[canon] && !T.svc[canon].off) return T.svc[canon];
  const n = normFr(key);
  for (const k in T.svc) { const s = T.svc[k]; if (normFr(s.nom) === n) return s; }
  /* le client peut écrire « Canapés » : on accepte un nom partiel (jamais un mot trop court) */
  if (n.length >= 5) for (const k in T.svc) { const s = T.svc[k]; if (nfSvc(s).indexOf(n) === 0) return s; }
  if (n.length >= 6) for (const k in T.svc) { const s = T.svc[k]; if (nfSvc(s).indexOf(n) > 0) return s; }
  for (const k in T.svc) { const s = T.svc[k]; if (!s.off && s.metier && s.metier === key) return s; }
  return null;
}
/* ═══════════════════════════════════════════════════════════════════════════
   ❓ LOT 108 — LES QUESTIONS DYNAMIQUES ET LES PHOTOS
   Règle du PDG : « jamais de question inutile », « Je ne sais pas » toujours accepté,
   « on n'invente jamais une information » (dimensions, poids, matière → photo possible).

   • Chaque question est ADMINISTRABLE au tableau de bord (ajouter, modifier, désactiver, réordonner).
   • Une question est posée SEULEMENT si elle est utile à ce service (cible : métier, catégorie,
     unité, ou « tous »). Aucune question décorative.
   • Les réponses ne créent PAS un deuxième système de prix : elles remplissent exactement les
     coefficients déjà en place (état, difficulté, urgence, horaire, accès, matériel) ou une ligne
     de supplément. Le calcul reste le même, côté serveur.
   • « Je ne sais pas » est toujours proposé : le moteur donne alors une FOURCHETTE (jamais un
     prix définitif inventé) — sauf si le PDG déclare la question obligatoire : le prix reste
     une estimation jusqu'à la confirmation du professionnel.
   ═══════════════════════════════════════════════════════════════════════════ */
const TARIF_QUESTIONS_DEF = [
  { id: 'photos', ordre: 5, type: 'photo', min: 2, cible: { tous: true }, jeNeSaisPas: false,
    q: 'Pouvez-vous ajouter des photos ?',
    aide: 'Une photo évite les erreurs : nous ne devinons jamais une dimension, un poids ou une matière. Ce n’est pas obligatoire pour recevoir un prix.' },
  { id: 'etat_lieux', ordre: 10, type: 'choix', coef: 'etat', cible: { etatCompte: true },
    q: 'Dans quel état se trouve l’endroit ?',
    aide: 'Choisissez ce qui ressemble le plus à la réalité. Si vous n’êtes pas sûr, répondez « Je ne sais pas » : le prix deviendra une estimation.' },
  { id: 'acces', ordre: 20, type: 'choix', coef: 'acces', cible: { tous: true },
    q: 'Comment se passe l’accès sur place ?',
    aide: 'Étage, ascenseur, escalier étroit, véhicule impossible… cela change le temps de travail.' },
  { id: 'urgence', ordre: 30, type: 'choix', coef: 'urgence', cible: { tous: true },
    q: 'Quand souhaitez-vous l’intervention ?',
    aide: 'Plus c’est urgent, plus le prix peut augmenter — vous le voyez ligne par ligne avant de confirmer.' },
  { id: 'horaire', ordre: 40, type: 'choix', coef: 'horaire', cible: { tous: true },
    q: 'À quel moment de la journée ?' },
  { id: 'materiel', ordre: 50, type: 'choix', coef: 'materiel', cible: { tous: true },
    q: 'Qui fournit le matériel et les produits ?' },
  { id: 'difficulte', ordre: 60, type: 'choix', coef: 'difficulte', cible: { cat: ['tech'] },
    q: 'Le travail vous paraît-il simple ou compliqué ?',
    aide: 'Votre réponse est une indication : le professionnel confirme toujours avant de commencer.' },
  { id: 'surface', ordre: 70, type: 'nombre', unite: 'm2', cible: { unite: ['m2'] }, prixUnite: 0,
    q: 'Quelle surface, approximativement (en m²) ?',
    aide: 'Si vous ne savez pas, répondez « Je ne sais pas » : le professionnel mesurera sur place.' },
  { id: 'nb_elements', ordre: 75, type: 'nombre', unite: 'unite', cible: { unite: ['appareil', 'vehicule', 'tache'] }, prixUnite: 0,
    q: 'Combien d’éléments au total ?',
    aide: 'Exemple : nombre d’appareils, de véhicules ou de tâches à traiter.' },
  { id: 'matiere', ordre: 80, type: 'choix', cible: { tous: true }, valeurs: [
      { id: 'tissu', nom: 'Tissu / textile' }, { id: 'cuir', nom: 'Cuir' }, { id: 'bois', nom: 'Bois' },
      { id: 'metal', nom: 'Métal' }, { id: 'verre', nom: 'Verre' }, { id: 'macon', nom: 'Maçonnerie / ciment' },
      { id: 'plastique', nom: 'Plastique / PVC' }, { id: 'autre', nom: 'Autre / je ne sais pas' }],
    q: 'En quelle matière est la chose à traiter ?',
    aide: 'Si vous ne savez pas, répondez « Autre / je ne sais pas » ou envoyez une photo : nous n’inventons jamais une matière.' }
];
/* 🔎 QUELLES QUESTIONS POUR CE SERVICE ? (aucune question inutile) */
function tarifCibleOk(cible, svc) {
  if (!cible) return true;
  if (cible.tous) return true;
  if (cible.etatCompte && !svc.etatCompte) return false;
  if (cible.cat && (cible.cat || []).indexOf(svc.cat) < 0) return false;
  if (cible.metier && (cible.metier || []).indexOf(svc.metier || svc.id) < 0) return false;
  if (cible.unite && (cible.unite || []).indexOf(svc.unite) < 0) return false;
  if (cible.svc && (cible.svc || []).map(String).indexOf(String(svc.id)) < 0) return false;
  return true;
}
function tarifQuestionsToutes() {
  tarifEnsure();
  const T = db.tarif;
  if (!Array.isArray(T.questions) || !T.questions.length) T.questions = TARIF_QUESTIONS_DEF.map(x => JSON.parse(JSON.stringify(x)));
  T.questions.forEach(q => { if (typeof q.off === 'undefined') q.off = false; if (!q.ordre) q.ordre = 50; });
  return T.questions;
}
function tarifQuestionAdmin(q) {                 /* ❓ ce que le PDG voit d'une question du moteur */
  const T = db.tarif, c = q.cible || {}, B = q.coef ? ((T.coefs || {})[q.coef] || null) : null;
  const qui = c.tous ? 'tous les services'
    : (c.etatCompte ? 'services avec état des lieux'
      : (c.cat ? 'catégorie : ' + (c.cat || []).join(', ')
        : (c.metier ? 'métier : ' + (c.metier || []).join(', ')
          : (c.unite ? 'unité : ' + (c.unite || []).join(', ')
            : (c.svc ? 'service n° ' + (c.svc || []).join(', ') : 'tous les services')))));
  return { id: q.id, q: q.q, type: q.type, aide: q.aide || '', ordre: q.ordre || 50, qui: qui,
    coef: q.coef || null, coefNom: B ? B.nom : '', valeurs: B ? (B.valeurs || []).map(v => v.nom).slice(0, 10) : [],
    obligatoire: !!q.obligatoire, jeNeSaisPas: q.jeNeSaisPas !== false, off: !!q.off,
    unite: q.unite || '', prixUnite: q.prixUnite || 0, min: q.min || 0, cree: !!q.cree };
}
function tarifQuestionsDe(svc, avecPhotos) {
  if (!svc) return [];
  const qs = tarifQuestionsToutes().filter(q => !q.off && tarifCibleOk(q.cible, svc));
  return qs.filter(q => q.type !== 'photo' || avecPhotos !== false).sort((a, b) => (a.ordre || 50) - (b.ordre || 50));
}
/* une question publique : ce que le client voit (le calcul reste interne) */
function tarifQuestionPublique(q) {
  const T = db.tarif;
  const out = { id: q.id, q: q.q, type: q.type, aide: q.aide || '', ordre: q.ordre || 50,
    jeNeSaisPas: q.jeNeSaisPas !== false, obligatoire: !!q.obligatoire, unite: q.unite || '', min: q.min || 0 };
  if (q.type === 'choix') {
    if (q.coef && T.coefs[q.coef]) {
      const B = T.coefs[q.coef];
      out.bloc = q.coef; out.blocNom = B.nom; out.ic = B.ic || '⚙️';
      out.valeurs = (B.valeurs || []).map(v => ({ id: v.id, nom: v.nom, k: v.k }));
    } else out.valeurs = (q.valeurs || []).map(v => ({ id: v.id, nom: v.nom, k: null }));
  }
  return out;
}
/* 📥 ce que le client répond arrive sous la forme { questionId: valeur } */
function tarifReponsesTexte(rep) {
  if (!rep || typeof rep !== 'object') return '';
  return Object.keys(rep).slice(0, 20).map(k => k + ':' + String(rep[k]).slice(0, 40)).join(' | ');
}

/* 📉 quantité → multiplicateur (paliers, interpolation entre deux paliers, prolongement au-delà) */
function tarifMultQuantite(svc, n) {
  const q = Math.max(1, parseInt(n, 10) || 1);
  if (!svc || !svc.comptable) return q;                          /* m², heure, jour… : linéaire */
  const pal = (db.tarif.paliers || []).slice().sort((a, b) => a.n - b.n);
  if (!pal.length) return q;
  const ex = pal.find(p => p.n === q); if (ex) return ex.mult;
  const av = pal.filter(p => p.n < q).pop(), ap = pal.find(p => p.n > q);
  if (av && ap) { const t = (q - av.n) / (ap.n - av.n); return Math.round((av.mult + (ap.mult - av.mult) * t) * 1000) / 1000; }
  if (!av) return pal[0].mult;
  const last = pal[pal.length - 1], prev = pal[pal.length - 2] || { n: Math.max(1, last.n - 1), mult: 0 };
  const pente = (last.mult - prev.mult) / Math.max(1, last.n - prev.n);
  return Math.round((last.mult + (q - last.n) * pente) * 1000) / 1000;
}
function nfSvc(s) { return normFr(s && s.nom || ''); }
/* 🔎 retrouver la valeur d'un coefficient même si le client répond avec un mot (« normal », « Sale »…)
   plutôt qu'avec l'identifiant technique : on n'oblige jamais le client à parler notre langue. */
function tarifValeurTrouve(blocId, brut) {
  const B = db.tarif.coefs && db.tarif.coefs[blocId];
  if (!B || !Array.isArray(B.valeurs)) return null;
  const k = String(brut == null ? '' : brut).trim();
  if (!k) return null;
  const exact = B.valeurs.find(v => v.id === k) || B.valeurs.find(v => normFr(v.id) === normFr(k));
  if (exact) return exact;
  const nk = normFr(k);
  const parNom = B.valeurs.find(v => normFr(v.nom) === nk);
  if (parNom) return parNom;
  if (nk.length >= 3) {
    const debut = B.valeurs.find(v => normFr(v.nom).indexOf(nk) === 0);
    if (debut) return debut;
    const dedans = B.valeurs.find(v => normFr(v.nom).indexOf(nk) > 0);
    if (dedans) return dedans;
  }
  return null;
}
function tarifCoefTrouve(blocId, valId) {
  const b = db.tarif.coefs && db.tarif.coefs[blocId];
  if (!b || !Array.isArray(b.valeurs)) return null;
  return b.valeurs.find(v => v.id === valId) || null;
}
function tarifOptionsDe(entry) {
  if (!entry) return [];
  if (entry.opts && entry.opts.length) return entry.opts;
  if (entry.cat === 'clean') return (db.tarif.extras || TARIF_EXTRAS_DEF);
  return [];
}
/* 📍 quelle zone pour le lieu de prestation ? On regarde la ville PUIS le quartier (une commune
   d'Abidjan citée comme quartier prend le pas). Aucun chiffre fourni par le client n'est utilisé. */
function tarifZoneDe(ville, quartier) {
  const T = db.tarif, essais = [normVille(quartier || ''), normVille(ville || '')];
  for (const k of essais) {
    if (k && T.zones[k] && typeof T.zones[k].km === 'number') return { id: k, nom: T.zones[k].nom || k, km: T.zones[k].km, k: T.zones[k].k };
  }
  /* la ville n'est pas dans la table : on cherche une zone dont le nom ressemble (ex. « Cocody ») */
  for (const k of essais) {
    if (!k) continue;
    for (const zid in T.zones) if (k.indexOf(zid) >= 0 || zid.indexOf(k) >= 0)
      return { id: zid, nom: T.zones[zid].nom || zid, km: T.zones[zid].km, k: T.zones[zid].k };
  }
  return null;
}
function tarifDeplacement(km) {
  const d = db.tarif.deplacement || {};
  if (!km || !isFinite(km) || km <= 0) return null;
  if (d.mode !== 'km' && d.mode !== 'tranches' && d.mode !== 'forfait') return null;   /* « inclus » = prix actuel */
  let prix = 0;
  if (d.mode === 'km') prix = Math.round(km * (Number(d.km) || 200));
  else if (d.mode === 'forfait') prix = Math.round(Number(d.forfait) || 0);
  else {
    const tr = (d.tranches || []).slice().sort((a, b) => a.jusqua - b.jusqua);
    const t = tr.find(x => km <= x.jusqua);
    prix = t ? t.prix : (tr.length ? tr[tr.length - 1].prix : 0);
  }
  if (d.allerRetour) prix = prix * 2;
  return { prix: Math.round(prix), km: Math.round(km * 10) / 10 };
}
/* 🧾 LE CALCUL DÉTAILLÉ — une ligne par élément, jamais un prix global sorti de nulle part. */

/* ═══════════ 🏷️ BASE DE RÉFÉRENCES MARCHÉ + STATISTIQUES (lot 112) ═══════════
   Règles du PDG, appliquées à la lettre :
     · un prix de référence n'existe QUE s'il a une SOURCE et une DATE (sinon il est refusé) ;
     · on n'INVENTE jamais un prix : ce qui vient du marché est daté, ce qui manque est DIT comme manquant ;
     · ces références ne changent AUCUN prix : elles servent à BORNER et à SIGNALER un montant
       inhabituel — un prix hors fourchette est conservé tel quel, jamais supprimé automatiquement ;
     · les statistiques viennent des prix RÉELLEMENT acceptés (jamais des propositions) et ne
       deviennent une référence qu'après VALIDATION du PDG (aucun changement automatique) ;
     · rien n'est rétroactif : un prix déjà accepté garde son montant, même si la base évolue ;
     · tout est journalisé (qui, quoi, avant, après, quand, pourquoi) et versionné.
   ════════════════════════════════════════════════════════════════════════════ */
const TARIF_MARCHE_DEF = [
  { id: 'canape-2-3', service: 'canapes', nom: 'Canapé 2-3 places (nettoyage complet)', unite: 'place', min: 20000, max: 20000, ville: 'Abidjan', source: 'Elyone Pressing — tarif publié (Cocody)', date: '27/09/2026' },
  { id: 'canape-4', service: 'canapes', nom: 'Canapé 4 places (nettoyage complet)', unite: 'place', min: 25000, max: 25000, ville: 'Abidjan', source: 'Elyone Pressing — tarif publié (Cocody)', date: '27/09/2026' },
  { id: 'canape-5-6', service: 'canapes', nom: 'Canapé 5-6 places (nettoyage complet)', unite: 'place', min: 30000, max: 30000, ville: 'Abidjan', source: 'Elyone Pressing — tarif publié (Cocody)', date: '27/09/2026' },
  { id: 'canape-7', service: 'canapes', nom: 'Canapé 7 places et plus (nettoyage complet)', unite: 'place', min: 35000, max: 35000, ville: 'Abidjan', source: 'Elyone Pressing — tarif publié (Cocody)', date: '27/09/2026' },
  { id: 'fauteuil-cleanride', service: 'canapes', nom: 'Fauteuil (nettoyage à domicile)', unite: 'place', min: 9000, max: 9000, ville: 'Abidjan', source: 'CleanRide — tarif publié (Abidjan)', date: '27/09/2026' },
  { id: 'canape-cleanride', service: 'canapes', nom: 'Canapé (nettoyage à domicile)', unite: 'place', min: 10000, max: 22000, ville: 'Abidjan', source: 'CleanRide — tarif publié (Abidjan)', date: '27/09/2026' },
  { id: 'plomb-deplacement', service: 'plomberie', nom: 'Déplacement d’un plombier', unite: 'intervention', min: 5000, max: 15000, ville: 'Abidjan', source: 'Yemba Plomberie — grille publiée', date: '27/09/2026' },
  { id: 'plomb-fuite', service: 'plomberie', nom: 'Réparation d’une fuite simple', unite: 'intervention', min: 10000, max: 25000, ville: 'Abidjan', source: 'Yemba Plomberie — grille publiée', date: '27/09/2026' },
  { id: 'plomb-complexe', service: 'plomberie', nom: 'Réparation complexe (réseau, colonne)', unite: 'intervention', min: 20000, max: 50000, ville: 'Abidjan', source: 'Yemba Plomberie — grille publiée', date: '27/09/2026' },
  { id: 'plomb-wc', service: 'plomberie', nom: 'WC / chasse d’eau (réparation)', unite: 'intervention', min: 10000, max: 30000, ville: 'Abidjan', source: 'Yemba Plomberie — grille publiée', date: '27/09/2026' },
  { id: 'plomb-robinet', service: 'plomberie', nom: 'Pose / remplacement d’un robinet', unite: 'intervention', min: 25000, max: 25000, ville: 'Abidjan', source: 'Le Plombier CI — tarif publié', date: '27/09/2026' },
  { id: 'clim-entretien-split', service: 'clim', nom: 'Entretien climatiseur split (habitation)', unite: 'appareil', min: 10000, max: 18000, ville: 'Abidjan', source: 'CIP SARL — tarif publié (Abidjan)', date: '27/09/2026' },
  { id: 'clim-entretien-entreprise', service: 'clim', nom: 'Entretien climatiseur split (entreprise / immeuble)', unite: 'appareil', min: 15000, max: 25000, ville: 'Abidjan', source: 'CIP SARL — tarif publié (Abidjan)', date: '27/09/2026' },
  { id: 'clim-gaz', service: 'clim', nom: 'Recharge de gaz (climatiseur)', unite: 'appareil', min: 20000, max: 45000, ville: 'Abidjan', source: 'CIP SARL — tarif publié (Abidjan)', date: '27/09/2026' },
  { id: 'clim-fuite-gaz', service: 'clim', nom: 'Recherche de fuite + recharge de gaz', unite: 'appareil', min: 35000, max: 80000, ville: 'Abidjan', source: 'CIP SARL — tarif publié (Abidjan)', date: '27/09/2026' },
  { id: 'clim-bureaux', service: 'clim', nom: 'Entretien climatisation de bureaux', unite: 'appareil', min: 20000, max: 40000, ville: 'Abidjan', source: 'CIP SARL — tarif publié (Abidjan)', date: '27/09/2026' },
  { id: 'menage-mois', service: 'entretien', nom: 'Ménage régulier (contrat au mois)', unite: 'mois', min: 20000, max: 80000, ville: 'Abidjan', source: 'Abidjan.net — annonces ménage (fourchette constatée)', date: '27/09/2026' },
  { id: 'carrelage-m2', service: '', nom: 'Pose de carrelage (au m², fourni posé)', unite: 'm2', min: 14900, max: 15250, ville: 'Abidjan', source: 'CYPE CI — bordereau publié', date: '27/09/2026', note: 'À rattacher à un service par le PDG (aucun service Klean ne correspond encore exactement).' },
  { id: 'platre-m2', service: '', nom: 'Pose de plâtre / faux plafond (au m²)', unite: 'm2', min: 7700, max: 7700, ville: 'Abidjan', source: 'CYPE CI — bordereau publié', date: '27/09/2026', note: 'À rattacher à un service par le PDG.' },
  { id: 'mo-carreleur', service: '', nom: 'Main-d’œuvre carreleur (à l’heure)', unite: 'heure', min: 1200, max: 1900, ville: 'Abidjan', source: 'CYPE CI — bordereau publié', date: '27/09/2026', note: 'À rattacher à un service par le PDG.' }
];
/* Ce qu'on n'a PAS trouvé sur le marché : on le DIT, on ne l'invente pas. Le PDG complète quand il veut. */
const TARIF_MARCHE_MANQUE = ['Maçonnerie', 'Peinture', 'Électricité', 'Menuiserie', 'Soudure', 'Déménagement',
  'Garde d’enfants', 'Coiffure / beauté', 'Cours et formations', 'Vitres & baies', 'Jardinage', 'Lavage auto',
  'Serrurerie', 'Électroménager', 'Bricolage & montage', 'Cuisinier à domicile', 'Placement de personnel', 'Canal+'];
const TARIF_MARCHE_STATUTS = { a_confirmer: 'à confirmer par le PDG', confirmee: 'confirmée', desactivee: 'désactivée (conservée)' };
function marcheEnsure() {
  tarifEnsure();
  const T = db.tarif;
  if (!Array.isArray(T.refs)) T.refs = [];
  /* ① les références de la veille marché (sourcées et datées) — jamais écrasées si le PDG les a modifiées */
  TARIF_MARCHE_DEF.forEach(d => {
    const ex = T.refs.find(x => x && x.id === d.id);
    if (!ex) T.refs.push(Object.assign({}, d, { type: 'marche', origine: 'veille', statut: 'a_confirmer', at: nowISO(), par: 'Klean (veille marché)' }));
    else if (!ex.type) { ex.type = 'marche'; ex.origine = ex.origine || 'veille'; ex.statut = ex.statut || 'a_confirmer'; }
  });
  /* ② l'ancienne référence « déplacement » (lot 109) est conservée : on la complète, on ne la supprime pas */
  const dep = T.refs.find(x => x && x.id === 'deplacement');
  if (dep) { if (!dep.type) dep.type = 'marche'; if (!dep.statut) dep.statut = 'a_confirmer'; if (!dep.origine) dep.origine = 'veille'; if (!dep.service) dep.service = ''; }
  /* ③ les références ajoutées par le PDG (service + montant) entrent dans le même moule */
  T.refs.forEach(r => {
    if (!r || typeof r !== 'object') return;
    if (r.type === 'marche') return;
    r.type = 'marche'; r.origine = r.origine || 'pdg'; r.statut = r.statut || 'confirmee';
    if (r.montant && !r.min) { r.min = r.montant; r.max = r.montant; }
  });
  if (!T.marcheStats || typeof T.marcheStats !== 'object') T.marcheStats = { maj: nowISO(), parService: {} };
  if (!T.marcheStatsValidees || typeof T.marcheStatsValidees !== 'object') T.marcheStatsValidees = {};
  if (!T.marcheManque) T.marcheManque = TARIF_MARCHE_MANQUE.slice();
  return T;
}
function marcheRefValide(r) {
  const motifs = [];
  if (!r || typeof r !== 'object') return { ok: false, motifs: ['référence vide'] };
  if (!String(r.nom || '').trim()) motifs.push('nom manquant');
  if (!String(r.source || '').trim() || String(r.source).trim().length < 3) motifs.push('source manquante (obligatoire)');
  if (!String(r.date || '').trim() || String(r.date).trim().length < 4) motifs.push('date manquante (obligatoire)');
  const mn = Number(r.min), mx = Number(r.max);
  if (!(mn >= 0) || !(mx >= 0)) motifs.push('montants manquants');
  else if (mx < mn) motifs.push('maximum inférieur au minimum');
  return { ok: motifs.length === 0, motifs: motifs };
}
function marcheRefsActives() { const T = marcheEnsure(); return (T.refs || []).filter(r => r && r.type === 'marche' && r.statut !== 'desactivee'); }
function marcheRefsPour(service) {
  const svc = String(service || '');
  if (!svc) return [];
  const nomSvc = (db.tarif.svc[svc] || {}).nom || '';
  const n = relNorm(nomSvc);
  return marcheRefsActives().filter(r => {
    if (r.service === svc) return true;
    if (!r.service && nomSvc) {                       /* référence non rattachée : on la rapproche par le nom */
      const lib = relNorm(r.nom || '');
      return n && (lib.indexOf(n) >= 0 || n.indexOf(lib) >= 0) && n.length > 3;
    }
    return false;
  });
}
/* 🏷️ BORNE OBJECTIVE : dans la fourchette ? sinon de combien, en % (jamais un refus, jamais une suppression) */
function marcheCompare(service, montant, opts) {
  marcheEnsure();
  const refs = marcheRefsPour(service);
  const m = Math.round(Number(montant) || 0);
  if (!refs.length) return { trouve: false, refs: [], min: 0, max: 0, dans: true, ecartPct: 0, inhabituel: false,
    message: 'Aucune référence de marché enregistrée pour ce service : aucun jugement n’est porté sur ce montant (le PDG peut ajouter la référence : source + date obligatoires).' };
  const min = Math.min.apply(null, refs.map(r => Number(r.min) || 0));
  const max = Math.max.apply(null, refs.map(r => Number(r.max) || 0));
  const dans = m >= min && m <= max;
  let ecartPct = 0;
  if (m > max && max > 0) ecartPct = Math.round(((m / max) - 1) * 100);
  else if (m < min && m > 0) ecartPct = -Math.round((1 - (m / min)) * 100);
  const abs = Math.abs(ecartPct);
  const srcs = [];
  refs.forEach(r => { if (srcs.indexOf(r.source) < 0) srcs.push(r.source); });
  return { trouve: true, refs: refs.map(r => ({ id: r.id, nom: r.nom, unite: r.unite, min: r.min, max: r.max, source: r.source, date: r.date, statut: r.statut })),
    min: min, max: max, dans: dans, ecartPct: ecartPct, sources: srcs,
    inhabituel: !dans && abs >= 50,            /* écart ≥ 50 % → inhabituel, SIGNALÉ (conservé) */
    tresInhabituel: !dans && abs >= 150,       /* écart ≥ 150 % → contrôle gestionnaire demandé */
    message: dans ? 'Dans la fourchette du marché (' + min.toLocaleString('fr-FR') + ' – ' + max.toLocaleString('fr-FR') + ' F)'
      : (m > max ? 'Au-dessus de la fourchette du marché (' + max.toLocaleString('fr-FR') + ' F maximum constaté) : +' + ecartPct + ' %'
                 : 'En dessous de la fourchette du marché (' + min.toLocaleString('fr-FR') + ' F minimum constaté) : ' + ecartPct + ' %') };
}
/* 📊 STATISTIQUES — calculées sur les prix RÉELLEMENT ACCEPTÉS (jamais les propositions) */
function marcheStatsCalcul() {
  const par = {};
  (db.missions || []).forEach(m => {
    const v = m.prixVerrouille;
    if (!v || !(Number(v.montant) > 0)) return;
    const s = m.service || 'autre';
    const x = par[s] = par[s] || { service: s, n: 0, montants: [], villes: {}, premier: '', dernier: '', sources: 0 };
    x.n++; x.montants.push(Number(v.montant));
    if (m.ville) x.villes[m.ville] = (x.villes[m.ville] || 0) + 1;
    const d = String(v.date || m.createdAt || '');
    if (!x.premier || d < x.premier) x.premier = d;
    if (!x.dernier || d > x.dernier) x.dernier = d;
  });
  const res = {};
  Object.keys(par).forEach(k => {
    const x = par[k], tri = x.montants.slice().sort((a, b) => a - b);
    const med = tri.length % 2 ? tri[(tri.length - 1) / 2] : Math.round((tri[tri.length / 2 - 1] + tri[tri.length / 2]) / 2);
    const villes = Object.keys(x.villes).sort((a, b) => x.villes[b] - x.villes[a]);
    res[k] = { service: k, n: x.n, min: tri[0], max: tri[tri.length - 1], mediane: med,
      moyenne: Math.round(tri.reduce((a, b) => a + b, 0) / tri.length), ville: villes[0] || '', periode: { de: String(x.premier).slice(0, 10), a: String(x.dernier).slice(0, 10) } };
  });
  return res;
}
function marcheStatsMaj() {
  const T = marcheEnsure();
  T.marcheStats = { maj: nowISO(), parService: marcheStatsCalcul() };
  saveDb();
  return T.marcheStats;
}
/* une statistique n'est servie que si le PDG l'a VALIDÉE — et elle ne rejoue jamais le passé */
function marcheStatsValidees() { const T = marcheEnsure(); return T.marcheStatsValidees; }
function marcheStatsPubliques() {
  const V = marcheStatsValidees(), res = {};
  Object.keys(V).forEach(k => { if (V[k] && V[k].statut !== 'rejetee') res[k] = V[k]; });
  return res;
}

function tarifCalculer(id, o) {
  o = o || {};
  tarifEnsure();
  const T = db.tarif;
  const svc = tarifSvc(id);
  const version = T.version;
  const l = (cle, nom, montant, detail) => ({ cle, nom, montant: Math.round(montant), detail: detail || '' });
  if (!svc) {
    return { ok: true, mode: 'devis', total: 0, min: 0, max: 0, fourchette: [0, 0], lignes: [],
      manque: ['service'], service: null, serviceId: String(id || ''), version,
      texte: 'Ce service se règle sur devis : décrivez votre besoin, le professionnel vous répond avec un prix détaillé.' };
  }
  const u = (T.unites || []).find(x => x.id === svc.unite) || { nom: svc.unite, comptable: !!svc.comptable };
  const optDispo = tarifOptionsDe(svc);
  const demandees = Array.isArray(o.options) ? o.options.map(String)
    : Object.keys(o.options || {}).filter(k => o.options[k]);
  const options = optDispo.filter(x => demandees.indexOf(String(x.id)) >= 0);
  const manque = [];
  if (svc.devis) {
    return { ok: true, mode: 'devis', total: 0, min: 0, max: 0, fourchette: [0, 0], lignes: [],
      manque: ['devis'], service: tarifSvcPublic(svc), serviceId: svc.id, version, unite: svc.unite,
      texte: 'Prix sur devis : pour ce type de travaux, le professionnel examine votre demande et vous envoie un prix détaillé (main-d’œuvre, matériel, déplacement). Vous l’acceptez ou le refusez, sans engagement.' };
  }
  /* ⚠️ un service sans prix de référence n'a pas de prix inventé : il passe en DEVIS,
     et le PDG peut lui donner un prix au tableau de bord (« à tarifer »). */
  if (!(svc.ref > 0)) {
    return { ok: true, mode: 'devis', total: 0, min: 0, max: 0, fourchette: [0, 0], lignes: [],
      manque: ['prix'], service: tarifSvcPublic(svc), serviceId: svc.id, version, unite: svc.unite,
      aTarifer: true,
      texte: 'Ce service n’a pas encore de prix de référence : le professionnel vous répond avec un prix détaillé (main-d’œuvre, matériel, déplacement). Vous l’acceptez ou le refusez, sans engagement.' };
  }
  const q = Math.max(1, parseInt(o.quantite, 10) || 1);
  if (svc.comptable && !o.quantite && !o.sansQuantite) manque.push('quantite');
  /* ❓ LES RÉPONSES AUX QUESTIONS (lot 108) — elles remplissent les MÊMES coefficients que le moteur
     utilise déjà : aucun second système de prix. « Je ne sais pas » ne bloque rien : le prix
     devient une fourchette, et on ne devine JAMAIS (dimensions, poids, matière). */
  const reponses = (o.reponses && typeof o.reponses === 'object') ? o.reponses : {};
  const questions = tarifQuestionsDe(svc);
  const suplTxt = [], supLignes = [];
  let nbPhotosFournies = parseInt(o.photos, 10) || 0;
  for (const Q of questions) {
    const brute = reponses[Q.id];
    const vide = (brute === undefined || brute === null || brute === '' || brute === 'je_ne_sais_pas' || brute === 'sais_pas');
    const saisPas = (brute === 'je_ne_sais_pas' || brute === 'sais_pas');
    if (vide) { if (Q.obligatoire) manque.push(Q.id); continue; }
    if (Q.type === 'photo') { const n2 = parseInt(brute, 10) || 0; if (n2 > nbPhotosFournies) nbPhotosFournies = n2; continue; }
    if (Q.type === 'choix' && Q.coef) {
      const v = tarifValeurTrouve(Q.coef, String(brute));
      if (v) { if (!o[Q.coef]) o[Q.coef] = v.id; }             /* même chemin que les coefficients */
      continue;
    }
    if (Q.type === 'nombre') {
      const val = parseFloat(String(brute).replace(',', '.'));
      if (!isFinite(val) || val <= 0) { if (Q.obligatoire) manque.push(Q.id); continue; }
      suplTxt.push(Q.q.replace(/\(.*?\)/, '').trim() + ' : ' + (Math.round(val * 100) / 100) + (Q.unite === 'm2' ? ' m²' : ''));
      if (Q.prixUnite > 0) supLignes.push(l('q_' + Q.id, '📐 ' + Q.q.replace(/\(.*?\)/, '').trim(), Math.round(val * Q.prixUnite),
        (Math.round(val * 100) / 100) + (Q.unite === 'm2' ? ' m²' : '') + ' × ' + (Q.prixUnite) + ' F'));
      continue;
    }
    if (Q.type === 'choix') {                                  /* précision utile (matière, type…) sans prix */
      const v = (Q.valeurs || []).find(x => x.id === String(brute));
      if (v) suplTxt.push(Q.q.replace(/\(.*?\)/, '').trim() + ' : ' + v.nom);
    }
  }
  /* les photos demandées par le PDG pour CE service (obligatoires ⇒ sans photo, point de prix ferme) */
  if (svc.photos === 'obligatoires' && nbPhotosFournies < (svc.photosMin || 2)) manque.push('photos');
  const mult = tarifMultQuantite(svc, q);
  const lignes = [];
  const base = Math.round((svc.ref || 0) * mult);
  lignes.push(l('base', 'Prestation — ' + svc.nom, base,
    q + ' ' + (u.nom || svc.unite) + (mult !== q && svc.comptable ? (' · palier ×' + String(mult).replace('.', ',')) : '')));
  let total = base;
  /* coefficients, dans l'ordre, chacun ajouté en ligne (transparence totale) */
  for (const bloc of ['niveau', 'etat', 'difficulte', 'urgence', 'horaire', 'acces']) {
    const B = T.coefs[bloc]; if (!B || B.actif === false) continue;
    const valId = o[bloc];
    if (!valId) { if (bloc === 'etat' && svc.etatCompte) manque.push('etat'); continue; }
    const v = tarifValeurTrouve(bloc, valId); if (!v) continue;
    if (bloc === 'etat' && !svc.etatCompte) continue;
    /* 🪜 ACCÈS : si le PDG a réglé un MONTANT réel pour ce cas (ex. « Étage sans ascenseur : 1 500 F »),
       c'est ce montant qui s'applique, affiché en clair — au lieu du pourcentage. Sans montant réglé,
       le pourcentage actuel s'applique : rien ne change tout seul. */
    if (bloc === 'acces' && Number(v.montant) > 0) {
      const d = Math.round(Number(v.montant)); total += d;
      lignes.push(l(bloc, B.ic + ' ' + B.nom + ' : ' + v.nom, d, 'montant réglé par le PDG'));
      continue;
    }
    if (v.k !== 1) { const d = Math.round(total * (v.k - 1)); total += d;
      lignes.push(l(bloc, B.ic + ' ' + B.nom + ' : ' + v.nom, d, '+' + Math.round((v.k - 1) * 100) + ' %')); }
  }
  /* matériel fourni par le professionnel */
  const mat = String(o.materiel || '');
  if (mat && mat !== 'client') {
    const v = tarifCoefTrouve('materiel', mat);
    const B = T.coefs.materiel || {};
    if (v && v.k !== 1) { const d = Math.round(total * (v.k - 1)); total += d;
      lignes.push(l('materiel', (B.ic || '🧰') + ' Matériel : ' + v.nom, d, '+' + Math.round((v.k - 1) * 100) + ' %')); }
    if (svc.materielPrix > 0) { total += svc.materielPrix;
      lignes.push(l('materiel', '🧰 Fournitures apportées par le pro', svc.materielPrix, 'forfait')); }
  }
  /* suppléments issus des questions (surface × prix au m², etc.) — 0 par défaut, rien d'inventé */
  for (const l2 of supLignes) { total += l2.montant; lignes.push(l2); }
  /* options choisies */
  for (const op of options) { total += (op.prix || 0);
    lignes.push(l('option:' + op.id, (op.ic || '🔹') + ' ' + op.nom, op.prix || 0, 'option')); }
  /* 🛵 DÉPLACEMENT — 0 par défaut (« inclus », comme aujourd'hui). Quand le PDG l'active, la distance
     vient de LA ZONE DU LIEU DE PRESTATION, calculée par le serveur : un chiffre envoyé par le client
     ne sert que si la zone est inconnue, et il est alors ANNONCÉ comme estimation (jamais caché). */
  const zoneP = tarifZoneDe(o.ville, o.quartier);
  let kmInfo = null;
  if (zoneP) kmInfo = { km: zoneP.km, src: 'zone ' + zoneP.nom, estimation: !(T.zonesSrc && T.zonesSrc.actif) };
  else if (isFinite(Number(o.distanceKm)) && Number(o.distanceKm) > 0) kmInfo = { km: Number(o.distanceKm), src: 'distance annoncée', estimation: true };
  const dep = tarifDeplacement(kmInfo && kmInfo.km);
  let depInclus = true;
  if (dep && dep.prix > 0) {
    total += dep.prix; depInclus = false;
    lignes.push(l('deplacement', '🛵 Déplacement', dep.prix,
      dep.km + ' km' + (kmInfo ? ' · ' + kmInfo.src : '') + (kmInfo && kmInfo.estimation ? ' · estimation à confirmer' : '')
      + (T.deplacement.allerRetour ? ' · aller-retour' : '')));
  }
  /* zone (coefficient par ville, réglable — 1 par défaut).
     ⚠️ on réutilise LA MÊME résolution que la distance (tarifZoneDe) : le quartier d'abord.
     Deux résolutions différentes donneraient deux vérités — le client verrait un prix incohérent. */
  const z = zoneP || (o.ville ? T.zones[normVille(o.ville)] : null);
  if (z && Number(z.k) !== 1) { const d = Math.round(total * (Number(z.k) - 1)); total += d;
    lignes.push(l('zone', '📍 Zone ' + (z.nom || o.ville), d, '+' + Math.round((Number(z.k) - 1) * 100) + ' %')); }
  /* remise (code promo) */
  const promo = String(o.promo || '').toUpperCase();
  let remise = 0;
  if (promo && T.remises[promo]) { remise = Math.round(total * Number(T.remises[promo])); total -= remise;
    lignes.push(l('remise', '🎉 Code ' + promo, -remise, '−' + Math.round(Number(T.remises[promo]) * 100) + ' %')); }
  total = Math.max(0, Math.round(total));
  const mode = manque.length ? 'fourchette' : 'auto';
  const marge = manque.length ? Number(T.seuils.margeIncertitude || 0.2) : Number(T.seuils.margeAuto || 0.05);
  const min = Math.max(0, Math.round(total * (1 - marge)));
  const max = Math.round(total * (1 + marge));
  const seuil = Number(T.seuils.validationAdmin) || 0;
  const haut = seuil > 0 && total >= seuil;
  const texte = mode === 'auto'
    ? 'Prix calculé à partir des prix actuels de ' + svc.nom + ' et de vos réponses. Il reste confirmé par le professionnel avant le début de la prestation.'
    : 'Estimation : certaines informations manquent encore (' + manque.map(tarifManqueTxt).join(', ') + '). Cette estimation n’est pas encore le prix définitif — les professionnels disponibles confirmeront leur tarif après analyse de votre demande.';
  return {
    ok: true, mode, total, min, max, fourchette: [min, max], lignes, manque, off: !!svc.off,
    service: tarifSvcPublic(svc), serviceId: svc.id, version, unite: svc.unite, uniteNom: u.nom,
    quantite: q, multiplicateur: mult, ref: svc.ref, remise,
    deplacement: dep ? dep.prix : 0,
    /* 🛵 information transparente : d'où vient la distance, et si le déplacement est inclus */
    deplacementInfo: { inclus: depInclus, mode: (db.tarif.deplacement || {}).mode || 'inclus',
      km: kmInfo ? kmInfo.km : null, source: kmInfo ? kmInfo.src : '', estimation: !!(kmInfo && kmInfo.estimation) },
    zoneDe: zoneP ? { id: zoneP.id, nom: zoneP.nom, km: zoneP.km, k: zoneP.k } : null,
    options: options.map(x => ({ id: x.id, nom: x.nom, prix: x.prix })),
    validationAdmin: haut, seuilValidation: seuil, texte,
    reponses: Object.keys(reponses).slice(0, 20).map(k => ({ q: k, v: String(reponses[k]).slice(0, 60) })),
    questions: questions.map(tarifQuestionPublique),
    precisions: suplTxt.slice(0, 10),
    photos: nbPhotosFournies, photosMin: svc.photosMin || 0, photosObligatoires: svc.photos === 'obligatoires',
    resume: tarifResume(svc, o, q, u)
  };
}
/* 📍 distance réelle client ↔ professionnel (GPS des deux côtés) ; null si on ne la connaît pas.
   On n'invente JAMAIS une distance : sans position vérifiable, on affiche la ville. */
function distMissionPro(m, ag) {
  try {
    const a = (m && typeof m.lat === 'number' && typeof m.lng === 'number' && m.lat !== null) ? { lat: m.lat, lng: m.lng } : null;
    const p = ag && ag.pos;
    const b = (p && typeof p.lat === 'number' && typeof p.lng === 'number' && typeof posUsable === 'function' && posUsable(ag)) ? { lat: p.lat, lng: p.lng } : null;
    if (!a || !b) return null;
    return Math.round(haversineKm(a.lat, a.lng, b.lat, b.lng) * 10) / 10;
  } catch (e) { return null; }
}
function tarifManqueTxt(k) {
  return { quantite: 'la quantité', etat: 'l’état des lieux', photos: 'les photos', service: 'le service',
    devis: 'le devis du professionnel', prix: 'le prix de référence (à régler au tableau de bord)' }[k] || k;
}
function tarifResume(svc, o, q, u) {
  const bouts = [svc.nom];
  if (svc.comptable) bouts.push('quantité ' + q);
  if (o.etat) { const v = tarifCoefTrouve('etat', o.etat); if (v && svc.etatCompte) bouts.push('état : ' + v.nom.toLowerCase()); }
  if (o.niveau) { const v = tarifCoefTrouve('niveau', o.niveau); if (v && v.k !== 1) bouts.push(v.nom.toLowerCase()); }
  if (o.urgence) { const v = tarifCoefTrouve('urgence', o.urgence); if (v && v.k !== 1) bouts.push('urgence : ' + v.nom.toLowerCase()); }
  return bouts.join(' · ');
}
/* ce que le client/le pro a le droit de voir d'un service tarifé */
function tarifSvcPublic(s) {
  if (!s) return null;
  return { id: s.id, nom: s.nom, ic: s.ic, unite: s.unite, uniteNom: (s.uniteNom || ((db.tarif.unites || []).find(u => u.id === s.unite) || {}).nom || ''),
    ref: s.ref, min: s.min, max: s.max, devis: !!s.devis, comptable: !!s.comptable,
    etatCompte: !!s.etatCompte, photos: s.photos, photosMin: s.photosMin, metier: s.metier || s.id,
    options: tarifOptionsDe(s).map(o => ({ id: o.id, ic: o.ic || '🔹', nom: o.nom, desc: o.desc || '', prix: o.prix || 0 })) };
}
/* 🏷️ la liste publique des prix (le client peut tout voir ; rien n'est secret) */
function tarifPublicList() {
  tarifEnsure();
  const T = db.tarif;
  const out = [];
  for (const k in T.svc) { const s = T.svc[k]; if (s.off) continue; out.push(tarifSvcPublic(s)); }
  out.sort((a, b) => String(a.id).localeCompare(String(b.id), 'fr', { numeric: true }));
  return { version: T.version, unites: T.unites, coefs: T.coefs, paliers: T.paliers,
    deplacement: T.deplacement, seuils: T.seuils, remises: T.remises, services: out };
}

function catNatLieux(num) {
  const reg = catNatReglages();
  const perso = (reg.lieux || {})[num];
  const d = CAT_LIEUX_DEF[String(num)] || ['domicile'];
  return (perso && perso.length ? perso : d).map(id => CAT_LIEUX.find(x => x.id === id)).filter(Boolean);
}
function catNatTarifs(num) {
  const reg = catNatReglages();
  const perso = (reg.tarifs || {})[num];
  const d = CAT_TARIFS_DEF[String(num)] || ['devis'];
  return (perso && perso.length ? perso : d).map(id => CAT_TARIFS.find(x => x.id === id)).filter(Boolean);
}
const SVC_FAM_GROUPE_NAT = { 'maison': 'clean', 'agri': 'home' };
for (const [id, s2] of Object.entries(SVC_NAT)) SVC_CAT.push({ id, nom: s2.nom, ic: s2.ic, base: s2.base, desc: s2.desc || '', famille: s2.famille, mots: s2.mots });
const SVC_MOTS_IDX = SVC_CAT.map(c => ({ id: c.id, set: new Set(c.mots.split(' ')) }));
function svcCat(id) { return SVC_CAT.find(x => x.id === id) || null; }

/* ═══════════ 🔗 FUSION DES MÉTIERS SEMBLABLES ═══════════
   Le catalogue national a fait apparaître des spécialités (« Grand ménage », « Salles de bains »,
   « Canapés & fauteuils », « Vitres & baies », « Nettoyage bureaux », « Après déménagement »,
   « Désinfection », « Entretien régulier ») qui sont LE MÊME MÉTIER que « Nettoyage maison » :
   même geste, même savoir-faire, seuls le lieu ou l'objet changent. Idem pour l'informatique,
   les appareils électroniques, la plâtrerie/étanchéité.
   On ne SUPPRIME jamais un métier (d'anciennes commandes et des pros y sont rattachés) :
   on le FUSIONNE. L'identifiant reste valable partout (historique, recherche, pros, missions),
   mais il ne désigne plus qu'un seul métier :
     · une seule ligne dans les listes (l'ancien nom n'apparaît plus comme un métier à part),
     · un seul paquet de professionnels (le pro de « Grand ménage » reçoit les demandes de ménage),
     · les tâches du catalogue restent précises (« nettoyage de canapé », « grand ménage »…).
   ⚠️ Pour défaire une fusion : retirer la ligne ici — rien d'autre à toucher. */
const SVC_FUSION = {
  /* 🧹 le nettoyage : un seul métier, plusieurs spécialités */
  canapes:     'maison',
  vitres:      'maison',
  sdb:         'maison',
  grand:       'maison',
  entretien:   'maison',
  desinfection:'maison',
  demenagement:'maison',
  bureaux:     'maison',
  /* 🏗️ le bâtiment : plâtrerie et étanchéité sont des travaux du bâtiment */
  plafond:     'macon',
  etancheite:  'macon',
  /* 💻 l'informatique et le réseau : un seul métier */
  internet:    'ordinateur',
  /* 🔌 les appareils électroniques (téléphone, ordinateur, décodeur, télé) : un seul métier */
  canal:       'telephone',
  /* 🚗 la voiture : le mécanicien fait aussi le lavage (c'était déjà lui qui recevait ces tâches) */
  lavageauto:  'meca_auto'
};
function svcCanon(id) {
  let i = String(id == null ? '' : id);
  for (let n2 = 0; n2 < 8 && SVC_FUSION[i]; n2++) i = SVC_FUSION[i];
  return i;
}
function svcFusionne(id) { return SVC_FUSION[String(id || '')] || ''; }
/* les métiers absorbés par celui-ci (« regroupe ») */
function svcRegroupe(id) {
  const c = svcCanon(id);
  return Object.keys(SVC_FUSION).filter(k => SVC_FUSION[k] === c);
}
/* le nom de la spécialité, gardé pour l'explication (« fusionné dans Nettoyage maison ») */
function svcNomBrut(id) { const c = svcCat(id); return c ? c.nom : (SVC_NAMES[id] || String(id || '')); }

/* 🧩 LE CATALOGUE COMPLET — 44 métiers = les 22 d'origine + les 22 ajoutés au lot 102.
   Une création du PDG (db.catalog) passe devant un métier du code qui porterait le même nom.
   `cat` range le métier dans un groupe d'affichage de l'application :
     clean (ménage) · tech (dépannage) · home (extérieur & maison) · travaux (bâtiment)
     demarches (papiers, conseil, immobilier) · personne (beauté, photo, couture) · transport
   `builtin: true` = métier livré avec KLEAN (donc à ne pas confondre avec une création du PDG). */
const SVC_CAT_GROUPE = { 'bâtiment': 'travaux', 'réparation': 'tech', 'installation': 'tech', 'services': 'demarches', 'personne': 'personne', 'transport': 'transport' };
/* 🔎 les 22 métiers d'origine gardent EXACTEMENT le rangement de l'application
   (relevé dans index.html) : rien ne change de place à l'écran. */
const SVC_GROUPE_ORIG = {
  'maison': 'clean',
  'bureaux': 'clean',
  'canapes': 'clean',
  'vitres': 'clean',
  'demenagement': 'clean',
  'sdb': 'clean',
  'grand': 'clean',
  'plomberie': 'tech',
  'electricite': 'tech',
  'clim': 'tech',
  'serrurerie': 'tech',
  'electro': 'tech',
  'jardinage': 'home',
  'lavageauto': 'home',
  'bricolage': 'home',
  'demen': 'home',
  'cuisine': 'home',
  'evenement': 'clean',
  'entretien': 'clean',
  'placement': 'home',
  'cours': 'home',
  'canal': 'home'
};
function catalogueComplet() {
  const vus = new Set(); const out = [];
  for (const s of (db.catalog || [])) {
    if (!s || !s.id || vus.has(s.id)) continue;
    vus.add(s.id);
    out.push({ id: s.id, ic: s.ic || '🛠️', nom: s.nom || s.id, desc: s.desc || '', base: s.base || 5000,
               cat: (s.cat === 'clean' || s.cat === 'tech' || s.cat === 'home' || s.cat === 'travaux' || s.cat === 'demarches' || s.cat === 'personne' || s.cat === 'transport') ? s.cat : (svcCat(s.id) ? svcGroupe(svcCat(s.id)) : 'home'),
               opts: s.opts || [], builtin: false, creePar: s.creePar || '' });
  }
  for (const c of SVC_CAT) {
    if (vus.has(c.id)) continue;
    vus.add(c.id);
    out.push({ id: c.id, ic: c.ic, nom: c.nom, desc: c.desc || '', base: c.base, cat: svcGroupe(c), opts: [], builtin: true,
      fusionne: svcFusionne(c.id), fusionneNom: svcFusionne(c.id) ? svcNomBrut(svcFusionne(c.id)) : '',
      regroupe: svcRegroupe(c.id).map(k => ({ id: k, nom: svcNomBrut(k) })) });
  }
  return out;
}
function svcGroupe(c) { return SVC_GROUPE_ORIG[c.id] || SVC_CAT_GROUPE[c.famille] || SVC_FAM_GROUPE_NAT[c.famille] || 'home'; }
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
  + 'quelqu un quelque chose nouveau nouvelle svp aide aider aidez moi meme domicile a-domicile').split(' '));


/* ═══════════════════════════════════════════════════════════════════════════════
   📚 LOT « KLEAN SERVICE » — LE CATALOGUE NATIONAL DANS LE MOTEUR DE RECHERCHE
   Chaîne : CATÉGORIE → SERVICE → SOUS-SERVICE → TÂCHE → MÉTIER → PROFESSIONNELS
   · chaque tâche du catalogue est cherchable (768 tâches)
   · le métier qui intervient est résolu pour chaque niveau (service, sous-service, tâche)
   · le PDG peut renommer, ajouter des mots-clés, ajouter/retirer — JAMAIS supprimer en dur
   ═══════════════════════════════════════════════════════════════════════════════ */
function catNatReglages() {
  db.catNat = Object.assign({ off: [], noms: {}, mots: {}, plus: [], suggestions: [], svcPlus: [] }, db.catNat || {});
  ['off', 'plus', 'suggestions', 'svcPlus'].forEach(k => { if (!Array.isArray(db.catNat[k])) db.catNat[k] = []; });
  ['noms', 'mots', 'lieux', 'tarifs', 'icones'].forEach(k => { if (!db.catNat[k] || typeof db.catNat[k] !== 'object') db.catNat[k] = {}; });
  /* 🗂️ les CATÉGORIES s'administrent aussi : nom, icône, désactivation, nouvelle catégorie, rangement des services */
  db.catNat.fam = Object.assign({ noms: {}, icones: {}, off: [], plus: [], svc: {} }, db.catNat.fam || {});
  ['off', 'plus'].forEach(k => { if (!Array.isArray(db.catNat.fam[k])) db.catNat.fam[k] = []; });
  ['noms', 'icones', 'svc'].forEach(k => { if (!db.catNat.fam[k] || typeof db.catNat.fam[k] !== 'object') db.catNat.fam[k] = {}; });
  return db.catNat;
}
function catNatSig() {
  /* ⚠️ la signature doit contenir TOUT ce que le PDG peut changer (noms, icônes, mots, lieux,
     tarifs, ajouts, désactivations) : sinon l'application garderait une ancienne version en mémoire. */
  const c = catNatReglages();
  return JSON.stringify([c.off, c.noms, c.mots, c.icones, c.lieux, c.tarifs, c.plus, c.fam, c.svcPlus, db.catalogVersion || 1]);
}
function catNatOff(num) { return catNatReglages().off.indexOf(String(num)) >= 0; }
function catNatNom(num, defaut) { return catNatReglages().noms[num] || defaut; }
function catNatIcone(num, defaut) { return catNatReglages().icones[num] || defaut; }
/* ⚡ disponible tout de suite (urgence) ou 📅 sur rendez-vous */
function catNatDispo(num) { return String(num) === '43' ? 'immediat' : 'rdv'; }
function catNatMots(num) { return String(catNatReglages().mots[num] || ''); }
/* 🗂️ la catégorie effective d'un service : le rangement décidé au HQ gagne, sinon le rangement national.
   Une catégorie peut être renommée, changer d'icône, être désactivée, ou être créée par le PDG. */
function catNatFamille(numService, force) {
  const reg = catNatReglages();
  const base = CAT_NAT_FAM.find(f => f.services.indexOf(String(numService)) >= 0);
  const id = force || reg.fam.svc[String(numService)] || (base && base.id) || 'autre';
  const def = CAT_NAT_FAM.find(f => f.id === id) || reg.fam.plus.find(f => f.id === id) || { id: 'autre', ic: '🛠️', nom: 'Autres services', populaire: false };
  return { id, ic: reg.fam.icones[id] || def.ic, nom: reg.fam.noms[id] || def.nom, populaire: !!def.populaire };
}
function catNatFamOff(id) { return catNatReglages().fam.off.indexOf(String(id)) >= 0; }
/* la liste des catégories, dans l'ordre : celles du catalogue national, puis celles créées par le PDG */
function catNatFamillesDef() {
  const reg = catNatReglages();
  return CAT_NAT_FAM.concat(reg.fam.plus.filter(p => !CAT_NAT_FAM.some(f => f.id === p.id)));
}
/* les services créés par le PDG se glissent dans le même arbre (mêmes règles, mêmes recherches) */
function catNatTousServices() {
  const plus = catNatReglages().svcPlus.map(p => ({
    num: p.id, nom: p.nom, ic: p.ic || '🛠️', ajout: true, familleForcee: p.fam || '',
    sous: [{ num: p.id + '.1', nom: p.sousNom || 'Prestations', taches: (Array.isArray(p.taches) && p.taches.length ? p.taches : [p.nom]).join('|') }],
    cat: p.metier || ''
  }));
  return CAT_NAT.concat(plus);
}
function catNatMetier(numService, numSous, tache) {
  if (tache && CAT_METIER_TACHE[tache]) return CAT_METIER_TACHE[tache];
  if (numSous && CAT_METIER_SS[numSous]) return CAT_METIER_SS[numSous];
  return CAT_METIER[numService] || '';
}
/* 🔑 pour le tableau de bord : la même arborescence mais SANS filtre — le PDG doit voir
   ce qui est désactivé pour pouvoir le rallumer (on ne supprime jamais une entrée). */
/* 🩺 l'IA ne connaît pas la médecine : ces demandes sont traitées à part, jamais publiées telles quelles */
function estDemandeReglementee(texte) {
  const r = reglementePour('', [], texte);
  return r ? reglementeIdx(r) : null;
}
function catNatIconeHQ(num, defaut) { return catNatReglages().icones[num] || defaut; }
function catalogueNationalHQ() {
  const reg = catNatReglages();
  const plusiers = (niveau, parent) => reg.plus.filter(p => p.niveau === niveau && String(p.parent) === String(parent));
  /* 🔎 la recherche du langage doit aussi trouver les services créés par le PDG */

  return catNatTousServices().map(s => {
    const fam = catNatFamille(s.num);
    return { num: s.num, nom: catNatNom(s.num, s.nom), ic: catNatIcone(s.num, s.ic), off: catNatOff(s.num), ajout: false,
      metier: (s.cat || CAT_METIER[s.num] || ''), metierCanon: svcCanon(s.cat || CAT_METIER[s.num] || ''),
      mots: catNatMots(s.num), famille: fam.id, familleNom: fam.nom,
      lieux: catNatLieux(s.num).map(x => x.id), tarifs: catNatTarifs(s.num).map(x => x.id), dispo: catNatDispo(s.num),
      reglemente: reglementePour(s.num, s.sous.reduce((a, x) => a.concat(String(x.taches || '').split('|')), [])),
      sous: s.sous.map(ss => ({ num: ss.num, nom: catNatNom(ss.num, ss.nom), off: catNatOff(ss.num), ajout: false,
        metier: catNatMetier(s.num, ss.num), mots: catNatMots(ss.num),
        taches: String(ss.taches || '').split('|').filter(Boolean).map(t => ({ num: ss.num + '|' + t, nom: catNatNom(ss.num + '|' + t, t), off: catNatOff(ss.num + '|' + t), ajout: false }))
          .concat(plusiers('tache', ss.num).map(p => ({ num: p.id, nom: catNatNom(p.id, p.nom), off: catNatOff(p.id), ajout: true }))) }))
        .concat(plusiers('sous', s.num).map(p => ({ num: p.id, nom: catNatNom(p.id, p.nom), off: catNatOff(p.id), ajout: true,
          metier: p.metier || s.cat || CAT_METIER[s.num] || '', mots: '', taches: [] }))) };
  });
}
function catNatFamillesHQ() {
  const tous = catalogueNationalHQ();
  return catNatFamillesDef().map(f => {
    const eff = catNatFamille('', f.id);
    const svcs = tous.filter(s => s.famille === f.id);
    return { id: f.id, ic: eff.ic, nom: eff.nom, populaire: !!eff.populaire, off: catNatFamOff(f.id),
      cree: !CAT_NAT_FAM.some(x => x.id === f.id),
      nb: svcs.filter(s => !s.off).length, nbOff: svcs.filter(s => s.off).length,
      nbSous: svcs.reduce((a, x) => a + x.sous.length, 0),
      nbTaches: svcs.reduce((a, x) => a + x.sous.reduce((b, y) => b + y.taches.length, 0), 0) };
  });
}
/* 📤 la réponse complète du catalogue au tableau de bord (une seule fois, pour ne rien oublier) */
function catNatReponse() {
  const reg = catNatReglages();
  return Object.assign({}, catalogueNational(), {
    servicesHQ: catalogueNationalHQ(),
    famillesHQ: catNatFamillesHQ(),
    off: reg.off, noms: reg.noms, mots: reg.mots, plus: reg.plus, icones: reg.icones,
    fam: reg.fam, svcPlus: reg.svcPlus,
    lieuxRef: CAT_LIEUX, tarifsRef: CAT_TARIFS, disposRef: CAT_DISPO, reglementes: CAT_REGLEMENTE,
    pros: (db.agents || []).filter(a => !a.blocked && (a.status || 'approved') === 'approved').slice(0, 400)
      .map(a => ({ id: a.id, nom: a.nom, numPro: a.numPro || '', ville: a.ville || a.villeIci || '',
        habilitations: a.habilitations || [], habilVu: a.habilVu || {} })),
    suggestions: (reg.suggestions || []).slice(-80).reverse(),
    nbSuggestions: (reg.suggestions || []).filter(x => !x.vu).length,
    metiers: SVC_CAT.map(c => ({ id: c.id, nom: c.nom, ic: c.ic, base: c.base, desc: c.desc || '',
      famille: c.famille || 'historique', groupe: svcGroupe(c), natif: true,
      fusionne: svcFusionne(c.id), fusionneNom: svcFusionne(c.id) ? svcNomBrut(svcFusionne(c.id)) : '',
      regroupe: svcRegroupe(c.id).map(k => ({ id: k, nom: svcNomBrut(k) })) }))
      .concat((db.catalog || []).map(x => ({ id: x.id, nom: x.nom, ic: x.ic || '🛠️', base: x.base || 0, desc: x.desc || '', famille: 'créé par le PDG', groupe: 'home', natif: false })))
  });
}
/* l'arborescence vivante : le catalogue de base + les ajouts du PDG − les entrées désactivées */
let _catNatArbre = null, _catNatArbreSig = '';
function catalogueNational() {
  const sig = catNatSig();
  if (_catNatArbre && _catNatArbreSig === sig) return _catNatArbre;
  const plus = catNatReglages().plus;
  const services = [];
  for (const s of catNatTousServices()) {
    if (catNatOff(s.num)) continue;
    const sous = [];
    for (const ss of s.sous) {
      if (catNatOff(ss.num)) continue;
      const taches = String(ss.taches || '').split('|').filter(Boolean).filter(t => !catNatOff(ss.num + '|' + t));
      const extra = plus.filter(p => p.niveau === 'tache' && String(p.parent) === String(ss.num) && !catNatOff(p.id))
        .map(p => ({ num: p.id, nom: catNatNom(p.id, p.nom), ajout: true }));
      if (!taches.length && !extra.length) continue;
      sous.push({ num: ss.num, nom: catNatNom(ss.num, ss.nom),
        taches: taches.map(t => ({ num: ss.num + '|' + t, nom: catNatNom(ss.num + '|' + t, t), base: t,
          regle: reglementePour(s.num, [t]) })).concat(extra),
        metier: (s.cat || catNatMetier(s.num, ss.num, null) || ''), mots: catNatMots(ss.num),
        reglemente: reglementePour(s.num, taches) });
    }
    const sExt = plus.filter(p => p.niveau === 'sous' && String(p.parent) === String(s.num) && !catNatOff(p.id));
    sExt.forEach(p => sous.push({ num: p.id, nom: catNatNom(p.id, p.nom), taches: [], metier: p.metier || s.cat || CAT_METIER[s.num] || '', mots: '', ajout: true }));
    if (!sous.length) continue;
    const metierBrut = (s.cat || CAT_METIER[s.num] || '');
    services.push({ num: s.num, nom: catNatNom(s.num, s.nom), ic: catNatIcone(s.num, s.ic),
      metier: metierBrut, metierCanon: svcCanon(metierBrut) || metierBrut,
      famille: catNatFamille(s.num, s.familleForcee).id, ajout: !!s.ajout, sous,
      lieux: catNatLieux(s.num).map(x => x.id), tarifs: catNatTarifs(s.num).map(x => x.id),
      dispo: catNatDispo(s.num), reglemente: reglementePour(s.num, sous.reduce((a, x) => a.concat(x.taches.map(t => t.nom)), [])) });
  }
  /* 🗂️ les catégories : nom, icône et rangement EFFECTIFS (les services déplacés suivent) */
  const ordre = catNatFamillesDef().map(f => f.id);
  services.forEach(s => { if (ordre.indexOf(s.famille) < 0) ordre.push(s.famille); });
  const familles = ordre.filter(id => !catNatFamOff(id)).map(id => {
    const def = catNatFamille('', id);
    const liste = services.filter(s => s.famille === id);
    return { id, ic: def.ic, nom: def.nom, populaire: def.populaire,
      nb: liste.length,
      nbSous: liste.reduce((a, s) => a + s.sous.length, 0),
      nbTaches: liste.reduce((a, s) => a + s.sous.reduce((b, x) => b + x.taches.length, 0), 0) };
  }).filter(f => f.nb > 0);
  const out = {
    familles, services,
    nbServices: services.length,
    nbSous: services.reduce((a, s) => a + s.sous.length, 0),
    nbTaches: services.reduce((a, s) => a + s.sous.reduce((b, x) => b + x.taches.length, 0), 0),
    nbMetiers: SVC_CAT.length
  };
  _catNatArbre = out; _catNatArbreSig = sig;
  return out;
}
/* 🔤 RADICAL : « nettoyer », « nettoyage », « nettoyé » doivent se reconnaître.
   On enlève la fin des mots (le français ajoute beaucoup de suffixes) et on ramène les
   mots populaires à leur forme savante (« clim » → « climatiseur », « frigo » → « réfrigérateur »). */
const LANG_SYN = { clim: 'climatiseur', climatisation: 'climatiseur', split: 'climatiseur', splits: 'climatiseur',
  frigo: 'refrigerateur', fridge: 'refrigerateur', refrigerateur: 'refrigerateur', congelo: 'congelateur',
  tele: 'television', tv: 'television', portable: 'telephone', gsm: 'telephone', tel: 'telephone',
  bagnole: 'voiture', caisse: 'voiture', auto: 'voiture', engin: 'moto', 'mecano': 'mecanicien',
  menage: 'menage', menagere: 'menage', plombier: 'plomberie', electricien: 'electricite', clims: 'climatiseur' };
function langRacine(w) {
  let m = String(w || '');
  if (LANG_SYN[m]) m = LANG_SYN[m];
  if (m.length > 5) {
    m = m.replace(/(issements|issement|ations|ation|ements|ement|ages|age|ures|ure|eurs|eur|euses|euse|iers|ier|ables|able|istes|iste|iques|ique|es|s)$/, '');
  } else if (m.length > 3) m = m.replace(/s$/, '');
  return m.length >= 3 ? m : String(w || '');
}
function motsCles(t) {
  return normFr(String(t || '')).split(' ')
    /* ⚠️ « tv » ne fait que 2 lettres : on garde les mots courts SEULEMENT s'ils sont des
       mots populaires connus (tv, frigo, clim…) — les petits mots de liaison restent ignorés. */
    .filter(w => !FR_VIDES.has(w) && (w.length > 2 || !!LANG_SYN[w]))
    .map(langRacine)
    .filter(w => w && w.length > 2 && !FR_VIDES.has(w));
}
let _catNatIdx = null, _catNatIdxSig = '';
function catNatIndex() {
  const sig = catNatSig();
  if (_catNatIdx && _catNatIdxSig === sig) return _catNatIdx;
  const arbre = catalogueNational();
  const idx = { taches: [], sous: [], services: [] };
  for (const s of arbre.services) {
    /* 🗂️ la catégorie EFFECTIVE (celle de l'arbre : les services déplacés et les catégories créées suivent) */
    const f = catNatFamille('', s.famille);
    idx.services.push({ num: s.num, nom: s.nom, mots: motsCles(s.nom + ' ' + catNatMots(s.num)), metier: s.metier, fam: f.nom, famId: f.id });
    for (const ss of s.sous) {
      const metier = ss.metier || s.metier;
      idx.sous.push({ num: ss.num, nom: ss.nom, mots: motsCles(ss.nom + ' ' + (ss.mots || '')), metier,
        service: s.num, serviceNom: s.nom, fam: f.nom, famId: f.id });
      for (const t of ss.taches) {
        idx.taches.push({ num: t.num, nom: t.nom, mots: motsCles(t.nom + ' ' + (t.base || '') + ' ' + (ss.mots || '')),
          /* ⚠️ l'ordre compte : la TÂCHE précise d'abord (« nettoyage de canapé » → canapés),
             sinon le sous-service, sinon le service, sinon le métier du service créé par le PDG */
          metier: (catNatMetier(s.num, ss.num, t.base || t.nom) || ss.metier || s.metier),
          service: s.num, sous: ss.num, serviceNom: s.nom, sousNom: ss.nom, fam: f.nom, famId: f.id });
      }
    }
  }
  _catNatIdx = idx; _catNatIdxSig = sig;
  return idx;
}
/* 🎯 « fuite de robinet » → tâche du catalogue + métier qui intervient */
function catNatChercher(mots) {
  if (!mots || !mots.length) return [];
  const idx = catNatIndex();
  const ens = new Set(mots);
  const best = {};
  const noter = (e, poids, niveau) => {
    let inter = 0;
    for (const w of e.mots) if (ens.has(w)) inter++;
    if (!inter) return;
    /* on accepte un mot fort trouvé seul quand la tâche est courte (« nettoyage de canapé »),
       et on exige plus quand le nom de la tâche est long (évite les faux positifs) */
    if (inter < 1) return;
    if (e.mots.length >= 4 && inter < 2 && (inter / e.mots.length) < 0.5) return;
    if (!e.metier) return;
    /* un mot qui couvre presque tout le nom de la tâche est plus précis qu'un mot noyé
       dans un nom long : « télévision » doit viser « réparation télévision » plutôt que « meuble TV ». */
    const sc = Math.round(poids * inter) + Math.round((inter / Math.max(1, e.mots.length)) * 3);
    const prev = best[e.metier];
    if (!prev || sc > prev.sc) {
      best[e.metier] = { metier: e.metier, sc: Math.min(22, sc), nom: e.nom, niveau,
        chaine: { categorie: e.fam, famille: e.famId, service: e.serviceNom || e.nom, sous: e.sousNom || (niveau === 'sous' ? e.nom : ''), tache: niveau === 'tache' ? e.nom : '' } };
    }
  };
  for (const e of idx.taches) noter(e, 7, 'tache');
  /* 📌 le métier se résout aussi par le nom d'origine et le nom affiché de chaque tâche */
  for (const e of idx.sous) noter(e, 8, 'sous');
  for (const e of idx.services) noter(e, 9, 'service');
  return Object.values(best).sort((a, b) => b.sc - a.sc);
}
/* la plus parlante des entrées du catalogue pour un métier (tâche > sous-service > service) */
let _catNatParMetier = null, _catNatParMetierSig = '';
function catNatChainePour(metier) {
  if (!metier) return null;
  const sig = catNatSig();
  if (!_catNatParMetier || _catNatParMetierSig !== sig) {
    const idx = catNatIndex(); const m = {};
    const poser = (e, niveau) => {
      if (!e.metier) return;
      const note = niveau === 'tache' ? 3 : (niveau === 'sous' ? 2 : 1);
      if (!m[e.metier] || note > m[e.metier].note) {
        m[e.metier] = { note, chaine: { categorie: e.fam, famille: e.famId, service: e.serviceNom || e.nom,
          sous: e.sousNom || (niveau === 'sous' ? e.nom : ''), tache: niveau === 'tache' ? e.nom : '' } };
      }
    };
    for (const e of idx.taches) poser(e, 'tache');
    for (const e of idx.sous) poser(e, 'sous');
    for (const e of idx.services) poser(e, 'service');
    _catNatParMetier = m; _catNatParMetierSig = sig;
  }
  return _catNatParMetier[metier] || null;
}
function catNatParNumero(num) {
  const arbre = catalogueNational();
  for (const s of arbre.services) {
    if (String(s.num) === String(num)) return { niveau: 'service', service: s, nom: s.nom };
    for (const ss of s.sous) {
      if (String(ss.num) === String(num)) return { niveau: 'sous', service: s, sous: ss, nom: ss.nom };
      for (const t of ss.taches) if (String(t.num) === String(num)) return { niveau: 'tache', service: s, sous: ss, tache: t, nom: t.nom };
    }
  }
  return null;
}
/* ═══════════════════════════════════════════════════════════════════════════════
   🗣️ MOTEUR « LANGAGE SIMPLE » — le client écrit comme il parle, KLEAN comprend.

   Chaîne : PROBLÈME DU CLIENT → INTENTION → CATÉGORIE → SERVICE → TÂCHE → PROS.
   Le client n'a JAMAIS besoin de connaître le nom professionnel du métier :
   « mon frigo ne fait plus froid », « sa robe est trop grande », « j'ai crevé »…
   fautes comprises (« plomblier », « eletricien », « coifeuse »).

   Les expressions sont écrites DÉJÀ normalisées (sans accents, sans apostrophes)
   car c'est ainsi que le texte du client arrive ici (normFr).
   ═══════════════════════════════════════════════════════════════════════════════ */
const LANG_SIMPLE = [
  ['demenagement', 'Après déménagement', 'nettoyage apres demenagement|menage apres demenagement|apres demenagement|nettoyage avant emmenagement|menage avant emmenagement|etat des lieux avant emmenagement'],
  ['peinture', 'Peinture', 'je cherche un peintre|un peintre|peintre en batiment|peintre pour ma maison|qui peut peindre|peinture de ma maison'],
  ['macon', 'Maçonnerie', 'je cherche un macon|un macon|macon pour construire|qui peut construire un mur|macons pour ma maison'],
  ['carrelage', 'Pose', 'je cherche un carreleur|un carreleur|carreleur pour ma maison|poser du carrelage|qui pose du carrelage'],
  ['plomberie', 'Dépannage', 'je cherche un plombier|un plombier|plombier pour ma maison|qui peut reparer la plomberie'],
  ['electricite', 'Dépannage', 'je cherche un electricien|un electricien|electricien pour ma maison|qui peut reparer l electricite'],
  ['menuiserie', 'Fabrication', 'je cherche un menuisier|un menuisier|menuisier pour mes meubles|qui fait des meubles en bois'],
  ['soudure', 'Fabrication', 'je cherche un soudeur|un soudeur|soudeur pour mon portail|qui peut souder'],
  ['meca_auto', 'Mécanique', 'je cherche un mecanicien|un mecanicien|mecano pour ma voiture|mecanicien auto'],
  ['coiffure', 'Soins', 'je cherche un coiffeur|un coiffeur|coiffeur a domicile|qui peut me coiffer'],
  ['couture', 'Confection', 'je cherche un couturier|un couturier|une couturiere|couturier pour mes habits'],
  ['jardinage', 'Entretien', 'je cherche un jardinier|un jardinier|jardinier pour mon jardin|qui peut entretenir mon jardin'],
  ['alu', 'Installation', 'je cherche un vitrier|un vitrier|vitrier pour mes fenetres|posera des vitres'],
  ['demen', 'Déménagement', 'je cherche un demenageur|un demenageur|des demenageurs|demenageurs pour mes affaires'],
  ['chauffeur', 'Conduite', 'je cherche un chauffeur|un chauffeur|chauffeur pour mes deplacements|qui peut me conduire'],
  ['cours', 'Cours', 'je cherche un professeur|un professeur particulier|un repetiteur|professeur pour mon enfant'],
  ['ordinateur', 'Dépannage', 'je cherche un informaticien|un informaticien|informaticien pour mon ordinateur|technicien informatique'],
  ['canapes', 'Nettoyage', 'nettoyer mon canape|nettoyer le canape|laver mon canape|mon canape est sale|mon canape est tache|canape tache|canape qui sent mauvais|nettoyer mes fauteuils|nettoyer mon matelas|laver mon tapis|nettoyer ma moquette'],
  ['desinfection', 'Désinfection', 'il y a des cafards|des cafards chez moi|j ai des cafards|il y a des rats|j ai des rats|des souris chez moi|il y a des moustiques|des moustiques chez moi|il y a des punaises|des punaises de lit|il y a des termites|des fourmis chez moi|desinsectiser|desinfecter ma maison|desinfecter mon bureau'],
  ['blanchisserie', 'Blanchisserie', 'laver mes habits|laver mon linge|laver mes vetements|repasser mes habits|repasser mes vetements|faire mon repassage|repasser mes chemises|laver mes draps|laver mes couvertures|laver mon linge de maison|nettoyage a sec|aller au pressing|mon costume doit etre nettoye'],
  ['bienetre', 'Soins', 'massage a domicile|je veux un massage|massage relaxant|massage sportif|soins spa|faire du yoga a la maison|cours de yoga|coaching bien etre|relaxation'],
  ['sport', 'Cours', 'coach sportif|coach personnel|entraineur personnel|je veux un coach pour le sport|preparation physique|remise en forme|entrainement a domicile|cours de fitness'],
  ['piscine', 'Entretien', 'entretien de piscine|nettoyer ma piscine|entretien piscine|pompe de piscine|traitement de piscine|ma piscine est verte'],
  ['securite', 'Garde', 'agent de securite|gardien de nuit|vigile|gardiennage|surveiller ma maison|surveillance de chantier|gardien pour mon commerce'],
  ['alu', 'Installation', 'poser une fenetre en aluminium|porte en aluminium|veranda|baie vitree|garde corps en aluminium|vitrine de magasin'],
  ['plafond', 'Installation', 'poser un plafond|plafond en pvc|faux plafond|plafond en staff|reparer mon plafond|plafond qui tombe'],
  ['etancheite', 'Travaux', 'reparer ma toiture|ma toiture fuit|infiltration d eau au plafond|etancheite de la terrasse|ma terrasse prend l eau|refaire la toiture'],
  ['detartrage', 'Entretien', 'detartrer ma salle de bain|detartrage|la douche est entartree|ma douche est bouchée par le calcaire'],
  ['repassage', 'Blanchisserie', 'repasser du linge|repassage a domicile|repasser mes robes|repasser mes pantalons'],
  ['ordinateur', 'Dépannage', 'mon ordinateur est lent|mon ordinateur ne demarre plus|il faut installer windows|reparer mon ordinateur|mon pc est en panne|virus sur mon ordinateur|changer mon disque dur'],
  ['internet', 'Installation', 'installer la wifi|la wifi ne marche pas|ma connexion est lente|configurer ma box|le reseau ne marche pas'],
  ['camera', 'Installation', 'installer des cameras|poser des cameras|installer une alarme|camera de surveillance|interphone qui ne marche pas'],
  ['agriculture', 'Travaux', 'labourer mon champ|preparer mon champ|semer mon champ|cultiver mon terrain|entretien de ma plantation|recolte de mon champ'],
  ['elevage', 'Soins', 's occuper de mes animaux|nourrir mes animaux|nettoyer l enclos|toiletter mon chien|promener mon chien|garde de mon animal'],
  ['funeraire', 'Événement', 'organisation d un deces|pompes funebres|ceremonie funeraire|faire part de deces|transport d un defunt'],
  ['immobilier', 'Recherche', 'je cherche une maison a louer|trouver un appartement|recherche de terrain|je veux acheter une maison|visiter une maison|estimer mon loyer'],
  ['fixation', 'Travaux', 'accrocher un tableau|fixer une etagere|installer un ventilateur au plafond|poser un portemanteau|fixer une tv au mur'],
  ['soudure', 'Fabrication', 'souder mon portail|souder un portail|souder|portail casse|reparer mon portail|ma grille est cassee|grille cassee|ferronnerie|travaux de fer'],
  /* ── 🧹 NETTOYAGE ── */
  ['maison', 'Nettoyage', 'nettoyer ma maison|nettoyer la maison|nettoyer chez moi|faire le menage|femme de menage|menagere|une femme de menage|quelqu un pour nettoyer|quelqu un pour le menage|personne pour nettoyer|ma maison est sale|maison est sale|nettoyer mon salon|nettoyer ma chambre|nettoyer ma cuisine|nettoyer mes toilettes|nettoyer ma salle de bain|nettoyer toute la maison|je viens de demenager|nettoyer avant de rentrer|besoin de menage|je veux faire nettoyer'],
  ['canapes', 'Nettoyage', 'canape est sale|canape sale|laver mon canape|qui lave les canapes|nettoyage canape|faire nettoyer mon canape|nettoyer mon canape|nettoyer les canapes|nettoyer mon fauteuil|mon tapis est sale|nettoyer mon tapis'],
  ['vitres', 'Nettoyage', 'mes vitres sont sales|vitres sont sales|laver mes vitres|nettoyer mes fenetres|nettoyage vitre|laver les fenetres|ma vitre est sale|nettoyer les baies'],
  ['grand', 'Nettoyage', 'un grand menage|menage complet|de fond en comble|remise a neuf'],
  ['sdb', 'Nettoyage', 'detartrer|les joints de la douche|nettoyer la douche|nettoyer le wc|nettoyer les toilettes|laver la salle de bain'],
  ['bureaux', 'Nettoyage', 'nettoyer les bureaux|nettoyer mon bureau|nettoyer des bureaux|nettoyer ma boutique|nettoyer le magasin|nettoyer mon commerce|menage des bureaux|menage au bureau'],
  ['entretien', 'Entretien régulier', 'menage chaque semaine|entretien regulier|femme de menage chaque semaine|abonnement menage|menage tous les jours'],

  /* ── 🔧 PLOMBERIE ── */
  ['plomberie', 'Dépannage', 'mon robinet coule|robinet coule|robinet qui coule|robinet fuit|mon robinet fuit|l eau coule du robinet|eau coule du robinet|j ai une fuite|fuite d eau|une fuite d eau|eau sort du tuyau|mon tuyau fuit|tuyau fuit|tuyau perce|il y a de l eau partout|de l eau partout|ma douche fuit|ma douche coule|mon wc fuit|mon evier fuit|l eau coule sous l evier|eau coule sous l evier|l eau ne descend pas|l eau reste dans l evier|je n arrive pas a faire partir l eau|mon wc est bouche|mes toilettes sont bouchees|wc bouche|mon evier est bouche|ma douche est bouchee|le lavabo est bouche|canalisation bouchee|deboucher les canalisations|ma chasse d eau ne marche plus|la chasse d eau|remplir la chasse|ma pompe a eau|le surpresseur|mon chauffe eau ne marche plus|pas d eau au robinet|je n ai plus d eau|j ai un probleme d eau'],
  ['plomberie', 'Installation', 'installer un robinet|installer une douche|mettre une douche|installer un wc|installer un evier|mettre un chauffe eau|installer un chauffe eau|installer un reservoir|un reservoir d eau|installer une pompe|pose de plomberie'],

  /* ── 💡 ÉLECTRICITÉ ── */
  ['electricite', 'Dépannage', 'je n ai plus de courant|plus de courant chez moi|le courant ne marche pas|ma maison n a plus d electricite|mon courant coupe|le disjoncteur saute|ca fait disjoncter|j ai un probleme de courant|probleme de courant|une prise ne marche plus|ma prise ne fonctionne pas|prise ne marche pas|l interrupteur ne marche plus|ma lumiere ne s allume plus|la lumiere ne marche plus|plus de lumiere|une ampoule grillee|il y a des etincelles|le cable a brule|odeur de brule|panne d electricite|le compteur'],
  ['electricite', 'Installation', 'installer une prise|mettre une lumiere|installer un ventilateur|installer une television au mur|la television au mur|faire l electricite de ma maison|tirer des cables|cablage electrique'],

  /* ── ❄️ CLIMATISATION ── */
  ['clim', 'Dépannage', 'ma clim ne marche plus|ma clim ne refroidit plus|ma clim ne fait plus de froid|ma clim coule|ma clim fait du bruit|ma clim est gatee|ma clim est en panne|ma clim ne fonctionne plus|ma clim ne donne plus de froid|ma clim chauffe|mon climatiseur ne fonctionne plus|mon climatiseur ne refroidit plus|reparer ma clim|panne de clim|mon split ne refroidit plus'],
  ['clim', 'Entretien', 'laver ma clim|nettoyer ma clim|entretenir ma clim|entretien de ma clim|recharge de gaz|recharger le gaz de la clim|manque de gaz'],
  ['clim', 'Installation', 'installer une clim|poser une clim|installer un climatiseur|installer un split'],

  /* ── 🔌 ÉLECTROMÉNAGER ── */
  ['electro', 'Dépannage', 'mon frigo ne fait plus froid|frigo ne fait plus froid|mon frigo ne refroidit plus|mon frigo est en panne|mon frigo est casse|frigo casse|mon frigo coule|mon frigo fait trop de bruit|reparer mon frigo|qui repare les frigos|mon congelateur ne congele plus|mon congelateur est en panne|mon refrigerateur est casse|reparer mon congelateur|ma machine a laver ne marche plus|ma machine ne lave plus|ma machine fait du bruit|ma machine ne demarre pas|reparer ma machine|mon four ne chauffe plus|mon micro ondes ne marche plus|mon fer a repasser ne chauffe plus|mon ventilateur ne marche plus|reparer mon appareil|reparer un appareil menager|mon refrigerateur ne fait plus de froid'],

  /* ── 🔑 SERRURERIE ── */
  ['serrurerie', 'Dépannage', 'ma porte est bloquee|je n arrive pas a ouvrir ma porte|j ai perdu ma cle|j ai perdu mes cles|ma serrure est cassee|changer ma serrure|mettre une nouvelle serrure|quelqu un pour ouvrir ma porte|mon cadenas est bloque|une cle cassee dans la serrure|ma porte a claque|je suis enferme dehors|ouvrir une porte fermee'],

  /* ── 🪛 PETITS TRAVAUX ── */
  ['bricolage', 'Travaux', 'quelqu un pour reparer|un gars pour reparer|venir reparer|reparer ca|reparer quelque chose|reparer a la maison|quelqu un qui peut reparer|qui peut venir reparer|besoin de quelqu un pour reparer|j ai quelque chose a reparer|bricoler|un homme a tout faire|accrocher ma tele|accrocher une tele|mettre une etagere|accrocher un miroir|installer un rideau|monter un meuble|fixer quelque chose au mur|deplacer un meuble|reparer une porte|changer une ampoule|changer une prise|installer quelque chose chez moi|j ai un petit probleme chez moi|petit probleme chez moi|des petits travaux|un coup de main pour bricoler'],

  /* ── 🌿 JARDIN & COUR ── */
  ['jardinage', 'Entretien', 'mon herbe est trop grande|l herbe est trop grande|couper l herbe|couper la pelouse|tondre la pelouse|tondre|nettoyer mon jardin|mon jardin est sale|quelqu un pour mon jardin|planter des fleurs|planter du gazon|mettre du gazon|couper un arbre|tailler mes arbres|taille des arbres|enlever les mauvaises herbes|desherber|nettoyer ma cour|ma cour est sale|enlever les herbes|nettoyer devant ma maison'],
  ['macon', 'Travaux', 'construire une cloture|reparer ma cloture|ma cloture est cassee|faire un portail|changer un portail|monter un mur|crepir un mur|couler une dalle|faire une dalle|un muret|travaux de maconnerie'],

  /* ── 🎨 PEINTURE / CARRELAGE / MENUISERIE / VITRERIE ── */
  ['peinture', 'Travaux', 'peindre ma maison|je veux peindre|repeindre ma chambre|repeindre mon salon|mes murs sont sales|changer la couleur de ma maison|qui peut peindre chez moi|faire la peinture|peindre mon portail|peinture de la maison|peinture des murs|un coup de peinture'],
  ['carrelage', 'Travaux', 'mettre du carrelage|carreler ma maison|carreler|mon carrelage est casse|un carreau est casse|changer mon carrelage|poser le carrelage|carrelage dans ma salle de bain|carrelage au sol|carrelage mural|la faience'],
  ['menuiserie', 'Fabrication', 'fabriquer une table|fabriquer un lit|fabriquer une armoire|faire un placard|une cuisine en bois|reparer ma porte|ma porte est cassee|mon meuble est casse|fabriquer un meuble|un meuble sur mesure|ma porte grince|changer les charnieres|travailler le bois'],
  ['vitrerie', 'Travaux', 'ma vitre est cassee|ma fenetre est cassee|changer ma vitre|reparer ma vitre|mettre une vitre|mon miroir est casse|faire un miroir|un verre casse|remplacer une vitre'],

  /* ── 📦 TRANSPORT / LIVRAISON ── */
  ['demen', 'Transport', 'je veux demenager|je cherche quelqu un pour demenager|je dois deplacer mes affaires|deplacer mes affaires|transporter mes meubles|deplacer mon lit|deplacer mon armoire|j ai beaucoup de choses a transporter|une voiture pour demenager|des personnes pour m aider a demenager|m aider a demenager|charger mes affaires|decharger mes affaires|deménagement'],
  ['livraison', 'Livraison', 'envoyer un colis|je veux envoyer un colis|quelqu un pour livrer|faire livrer ca|envoyer ca a quelqu un|qui peut me livrer ca|envoyer un document|envoyer un vetement|faire une livraison|j ai besoin d un livreur|qu on recupere un colis pour moi|recuperer un colis|envoyer un paquet|transport de marchandises'],
  ['chauffeur', 'Transport', 'cherche un chauffeur|un chauffeur pour la journee|me conduire a|faire un deplacement en voiture'],

  /* ── 🚗 MÉCANIQUE AUTO / MOTO ── */
  ['meca_auto', 'Dépannage', 'ma voiture est en panne|voiture en panne|ma voiture ne demarre plus|ma voiture ne veut pas demarrer|ma voiture fait un bruit|ma voiture chauffe|ma voiture fume|j ai un probleme avec ma voiture|ma batterie est morte|la batterie est morte|j ai besoin d une batterie|venez m aider a demarrer ma voiture|ma voiture ne demarre pas a cause de la batterie|j ai creve|mon pneu est creve|probleme de pneu|changer mon pneu|reparer mon pneu|je veux faire la vidange|faire la vidange|reparer mes freins|mes freins grincent|faire controler ma voiture|la courroie|le moteur fait un bruit|la climatisation de ma voiture'],
  ['meca_moto', 'Dépannage', 'ma moto est en panne|ma moto ne demarre plus|ma moto fait du bruit|ma moto ne marche plus|reparer ma moto|un mecanicien moto|vidange de ma moto|ma moto perd de l huile|chaine de moto'],
  ['lavageauto', 'Nettoyage', 'laver ma voiture|nettoyer ma voiture|laver ma moto|nettoyer ma moto|faire laver ma voiture|un lavage auto|laver mon vehicule'],

  /* ── 📱 INFORMATIQUE ── */
  ['telephone', 'Dépannage', 'mon telephone est casse|mon ecran est casse|l ecran de mon telephone|mon telephone est tombe|je veux changer l ecran|ma batterie ne tient plus|mon telephone ne charge plus|mon telephone ne s allume plus|mon telephone chauffe|mon telephone est lent|reparer mon telephone|un reparateur de telephone|un reparateur telephone|mon telephone est bloque'],
  ['ordinateur', 'Dépannage', 'mon ordinateur ne marche plus|mon ordinateur est lent|mon ordinateur ne s allume plus|mon ordinateur fait du bruit|reparer mon ordinateur|installer windows|installer un logiciel|recuperer mes fichiers|mon pc ne demarre plus|mon imprimante ne marche plus|un informaticien|nettoyer mon ordinateur'],
  ['internet', 'Travaux', 'mon wifi ne marche pas|mon wifi est lent|internet ne marche pas|ma connexion est lente|installer le wifi|installer internet|mon routeur ne marche plus|regler mon wifi|ma box ne marche plus|probleme de connexion'],
  ['camera', 'Installation', 'je veux mettre des cameras|installer une camera|surveiller ma maison|des cameras chez moi|ma camera ne marche plus|reparer ma camera|installer une alarme|securiser ma maison|videosurveillance|une alarme de maison'],

  /* ── 💈 COIFFURE / BEAUTÉ ── */
  ['coiffure', 'Soins', 'je veux me couper les cheveux|me couper les cheveux|un coiffeur|un coiffeur a domicile|je veux faire un degrade|faire un degrade|couper ma barbe|ma barbe|je veux me raser|me faire raser|je veux me coiffer|faire des tresses|faire des nattes|poser une perruque|je veux faire mes cheveux|une coiffeuse|une coiffeuse a domicile|me faire coiffer a la maison|tresses a domicile'],
  ['beaute', 'Soins', 'je veux faire mes ongles|faire mes ongles|quelqu un pour mes ongles|je veux me maquiller|une maquilleuse|je veux faire mes pieds|une pedicure|une manucure|un soin du visage|de la pose d ongles|du maquillage'],

  /* ── 👶 ENFANTS ── */
  ['placement', 'Garde', 'quelqu un pour garder mon enfant|garder mon enfant|je veux une nounou|une nounou|qui peut garder mon bebe|garder mon bebe|j ai besoin d une personne pour garder mon enfant|une baby sitter|quelqu un pour accompagner mon enfant a l ecole|accompagner mon enfant a l ecole|garde d enfants a domicile|gardienne d enfants'],

  /* ── 📚 COURS ── */
  ['cours', 'Cours', 'je cherche un professeur|je veux un repetiteur|un repetiteur|quelqu un pour aider mon enfant|mon enfant a besoin de cours|je veux des cours d anglais|cours d anglais|je veux des cours de maths|cours de maths|je veux des cours a domicile|cours a domicile|un professeur a domicile|je veux preparer le bac|preparer le bepc|je veux preparer un concours|du soutien scolaire|des lecons de musique|apprendre la guitare|apprendre le piano|un cours d informatique'],

  /* ── 🍳 CUISINE / ÉVÉNEMENTS / PHOTO ── */
  ['cuisine', 'Repas', 'quelqu un pour cuisiner|je cherche quelqu un pour cuisiner|un cuisinier a domicile|je veux preparer une fete|un traiteur|je veux faire un gateau|quelqu un pour faire mon gateau|je veux preparer un anniversaire|je veux commander des repas|commander des repas|un cuisinier pour un evenement'],
  ['evenement', 'Événement', 'je prepare mon mariage|je cherche quelqu un pour decorer mon mariage|decorer mon mariage|je veux decorer une salle|decorer une salle|je prepare un anniversaire|je cherche un dj|un dj pour ma fete|quelqu un pour la sono|la sono de la fete|je veux louer des chaises|louer des chaises|je veux louer des tables|louer des tables|decorer ma fete|de la decoration de fete|un organisateur de fete'],
  ['photo', 'Photo', 'je cherche un photographe|je veux faire des photos|je veux des photos pour mon mariage|des photos de mariage|je veux faire une video|je cherche quelqu un pour filmer|je veux faire des photos professionnelles|je veux modifier une photo|je veux monter une video|un videaste|un cameraman|monter un film'],

  /* ── 🧵 COUTURE / CHAUSSURES / SACS ── */
  ['couture', 'Couture', 'je cherche un couturier|je veux coudre une tenue|coudre une tenue|je veux faire une robe|je veux faire une chemise|je veux faire un pantalon|ma robe est trop grande|je veux retrecir ma robe|je veux reparer mon vetement|ma fermeture est cassee|une tenue sur mesure|un tailleur|une couturiere|des retouches de vetement|reparer un pantalon'],
  ['cordonnerie', 'Réparation', 'mes chaussures sont cassees|je veux reparer mes chaussures|reparer mes chaussures|je veux laver mes chaussures|je veux reparer mon sac|mon sac est dechire|un cordonnier|remplacer un talon|ma chaussure est dechiree'],

  /* ── 🖨️ DOCUMENTS / CONSEIL / IMMOBILIER ── */
  ['documents', 'Documents', 'je veux faire mon cv|je cherche quelqu un pour faire mon cv|faire mon cv|je veux imprimer un document|imprimer un document|je veux photocopier|une photocopie|je veux scanner un document|je veux taper un document|je veux imprimer des photos|je veux faire une affiche|je veux faire un flyer|je veux creer un logo|creer un logo|un carton d invitation|une brochure'],
  ['conseil', 'Conseil', 'je cherche un comptable|quelqu un pour ma comptabilite|je veux creer mon entreprise|creer mon entreprise|je veux faire un business plan|un business plan|quelqu un pour m aider dans mon entreprise|je veux faire une etude de marche|quelqu un pour gerer ma page facebook|gerer ma page facebook|je veux faire de la publicite|un community manager|de la publicite en ligne|un conseiller pour mon entreprise'],
  ['immobilier', 'Recherche', 'je cherche une maison|je cherche une chambre|je cherche un appartement|je cherche un terrain|je veux louer une maison|louer une maison|je veux vendre ma maison|vendre ma maison|je veux vendre mon terrain|vendre mon terrain|quelqu un pour gerer ma maison|je veux faire visiter ma maison|faire visiter ma maison|un agent immobilier|trouver un locataire'],

  /* ── 📡 CANAL+ (existant, conservé) ── */
  ['canal', 'Travaux', 'le signal est perdu|la parabole a bouge|j ai perdu le signal|nouveau decodeur a installer|installer une parabole|installer canal|l abonnement canal|antenne tv'],
];
/* quelques expressions d'urgence : elles ne changent pas le métier, elles changent la PRIORITÉ */
const LANG_URGENCE = /\b(urgent|urgence|urgemment|tout de suite|maintenant|immediatement|au plus vite|le plus vite possible|des que possible|ce soir|aujourd hui)\b/;

/* ── une question = une réponse simple : « Je ne sais pas ce que ça s'appelle » ── */
const LANG_AIDE = 'Décrivez le problème avec vos mots (ex. « il y a de l’eau qui sort sous mon évier ») : KLEAN trouve le métier. Vous pouvez aussi ajouter une photo ou parler au micro.';

/* ─────────────── 🧠 COMPRÉHENSION : mots, fautes, intentions ───────────────
   Étape 1 : on corrige les fautes de frappe simples en comparant chaque mot à un
             vocabulaire connu (« plomblier » → « plombier », « eletricien » → « electricien »).
   Étape 2 : on cherche les PHRASES (« mon frigo ne fait plus froid ») — la plus longue gagne.
   Étape 3 : sinon, on retombe sur les mots-clés du catalogue (un seul mot : « plombier »).
   Résultat : service + TÂCHE + (correcteur affiché au client) + alternatives. */
let _LANG_VOCAB = null;
function langVocab() {
  if (_LANG_VOCAB) return _LANG_VOCAB;
  const v = new Set();
  const add = t => String(t || '').split(/[\s|]+/).forEach(w => { if (w.length > 2 && !FR_VIDES.has(w)) v.add(w); });
  for (const e of LANG_SIMPLE) add(e[2]);
  for (const c of SVC_CAT) { add(c.nom); add(c.mots); }
  for (const [id, s] of Object.entries(SVC_NOUVEAUX)) { add(s.nom); add(s.mots); add(id); }
  _LANG_VOCAB = [...v];
  return _LANG_VOCAB;
}
/* distance d'édition bornée (on s'arrête dès que ça dépasse) */
function langDist(a, b, max) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= n; j++) {
      const c = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur[j] = c; if (c < best) best = c;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[n];
}
/* correction des fautes : un mot inconnu → le mot du vocabulaire le plus proche (≤1 ou ≤2 lettres) */
function langCorriger(texte) {
  const vocab = langVocab(); const connu = new Set(vocab); const corriges = {};
  const mots = String(texte || '').split(' ').filter(Boolean).map(mot => {
    /* ⚠️ on ne touche jamais à un mot court ni à un mot connu : « pour », « fait », « est »
       sont de vrais mots français — les « corriger » casserait des phrases entières. */
    if (mot.length < 5 || connu.has(mot)) return mot;
    const max = mot.length >= 8 ? 2 : 1;
    let best = '', bestD = max + 1;
    for (const v of vocab) {
      if (Math.abs(v.length - mot.length) > max) continue;
      if (v.slice(0, 2) !== mot.slice(0, 2)) continue;      /* une faute de frappe garde le début du mot */
      const d = langDist(mot, v, max);
      if (d <= max && d < bestD) { bestD = d; best = v; if (d === 1) break; }
    }
    if (best) { corriges[mot] = best; return best; }
    return mot;
  });
  return { texte: mots.join(' '), corriges };
}
/* la TÂCHE dit ce que le client veut faire : dépannage, installation, entretien, fabrication… */
function langScore(c) {
  if (!c) return -1;
  return c.hits.reduce((n, h) => n + h.sc, 0) + Object.values(c.parMot).reduce((a, b) => a + b, 0)
    + (c.nat || []).reduce((n, x) => n + x.sc, 0);
}
function langLire(texte) {
  const urgence = LANG_URGENCE.test(texte);
  const hits = [];
  for (const e of LANG_SIMPLE) {
    let meilleur = 0;
    for (const m of String(e[2]).split('|')) {
      const mm = m.trim();
      if (mm && mm.length > meilleur && texte.indexOf(mm) >= 0) meilleur = mm.length;
    }
    if (meilleur) hits.push({ id: e[0], tache: e[1], sc: 40 + meilleur * 2 });
  }
  /* mots-clés du catalogue (repli + confirmation) */
  /* ⚠️ on garde aussi les mots courts très courants (« tv ») : sinon « tv » ne trouve rien */
  const mots = texte.split(' ').filter(w => !FR_VIDES.has(w) && (w.length > 2 || !!LANG_SYN[w]));
  const parMot = {};
  for (const c of SVC_CAT) {
    const idx = SVC_MOTS_IDX.find(x => x.id === c.id);
    const nomN = normFr(c.nom).split(' ').filter(w => w.length > 2 && !FR_VIDES.has(w));
    let sc = 0;
    for (const w of mots) {
      if (idx && idx.set.has(w)) sc += 4;
      if (nomN.includes(w)) sc += 3;
    }
    if (sc) parMot[c.id] = (parMot[c.id] || 0) + sc;
  }
  /* ⚠️ les 21 nouveaux métiers sont DÉJÀ dans SVC_CAT (poussés au chargement) :
     on ne les recompte pas ici, sinon ils marquaient double et volaient la place de métiers
     plus justes (ex. « reparateur frigo » partait en Réparation téléphone). */
  /* 📚 le catalogue national : la tâche précise et le métier qui intervient */
  const nat = catNatChercher(mots.map(langRacine));
  return { ok: hits.length > 0 || Object.keys(parMot).length > 0 || nat.length > 0, texte, corriges: {}, urgence, hits, mots, parMot, nat };
}
/* 🧠 DEUX LECTURES, LA MEILLEURE GAGNE :
   ① le texte tel que le client l'a écrit (les mots français valides restent intacts)
   ② le texte avec les fautes réparées (« plomblier » → « plombier »)
   On ne retient la correction que si elle fait MIEUX comprendre la demande. */
function langComprendre(q) {
  const brut = String(q || '').trim();
  if (!brut) return { ok: false, type: 'vide', texte: '', corriges: {}, urgence: false, hits: [], mots: [] };
  const base = normFr(brut);
  const cor = langCorriger(base);
  const l1 = langLire(base);
  const l2 = (cor.texte !== base) ? langLire(cor.texte) : l1;
  const garde = (langScore(l2) > langScore(l1)) ? l2 : l1;
  const corriges = (garde === l2) ? cor.corriges : {};
  return { ok: garde.ok, texte: garde.texte, corriges, urgence: garde.urgence, hits: garde.hits, mots: garde.mots, parMot: garde.parMot, nat: garde.nat || [] };
}
/* 🔗 un seul classement : les phrases pèsent plus que les mots isolés */
function langClasser(c) {
  if (!c || !c.ok) return [];
  const sc = {};
  const tache = {};
  for (const h of c.hits) {
    sc[h.id] = (sc[h.id] || 0) + h.sc;
    if (!tache[h.id] || h.sc > (tache[h.id].sc || 0)) tache[h.id] = { tache: h.tache, sc: h.sc };
  }
  for (const id of Object.keys(c.parMot)) sc[id] = (sc[id] || 0) + c.parMot[id];
  /* 📚 tâches du catalogue national : poids modéré, elles complètent sans écraser les phrases */
  for (const x of (c.nat || [])) sc[x.metier] = (sc[x.metier] || 0) + x.sc;
  return Object.keys(sc).map(id => ({ id, sc: sc[id], tache: (tache[id] || {}).tache || '' }))
    .sort((a, b) => b.sc - a.sc);
}
/* 🧭 LA fonction appelée par la recherche : renvoie tout ce que le client doit voir */
function comprendreDemande(q) {
  const brut = String(q || '').trim();
  const kp = codeKpDe(brut);
  if (kp) return { type: 'kp', code: kp, compris: 'Code professionnel ' + kp, ids: [], tache: '', corriges: {}, urgence: false };
  /* 🩺 AVANT toute autre analyse : une demande qui touche un acte médical, vétérinaire, du gaz,
     de la sécurité privée… est traitée à part (jamais comme un service ordinaire, jamais « inconnue »). */
  const rglAvant = estDemandeReglementee(brut);
  if (rglAvant) return { type: 'reglemente', reglemente: rglAvant, principal: '', ids: [], compris: rglAvant.nom,
    tache: '', corriges: {}, urgence: false, suggestions: [], alternatives: [], aide: rglAvant.exige };
  const c = langComprendre(brut);
  if (!c.ok) return { type: 'inconnu', ids: [], principal: '', compris: '', tache: '', corriges: c.corriges, urgence: c.urgence, suggestions: [], aide: LANG_AIDE };
  const cl = langClasser(c);
  const principal = cl[0];
  const alt = cl.filter(x => x.id !== principal.id).slice(0, 2);
  /* 🎯 Le métier compris d'abord, puis les métiers VOISINS qui ont vraiment marqué des points
     (union bornée à 3). Les mots purement descriptifs (« domicile », « chez moi »…) sont neutres,
     pour qu'une phrase comme « cours à domicile » ne ramène pas des laveurs de voiture. */
  const idsCherches = [principal.id].concat(cl.filter(x => x.id !== principal.id && x.sc >= 4).slice(0, 2).map(x => x.id));
  const nm = id => svcNomP(id);
  const ic = id => { const s = svcCat(id); return s ? s.ic : (SVC_NOUVEAUX[id] ? SVC_NOUVEAUX[id].ic : '🛠️'); };
  /* 📚 la chaîne CATÉGORIE → SERVICE → SOUS-SERVICE → TÂCHE : on la donne dès qu'on la connaît,
     même si c'est le dictionnaire de phrases qui a reconnu le métier. */
  /* 🩺 actes médicaux, vétérinaires, sécurité privée, gaz… : on répond franchement au client.
     Ces prestations sont séparées et réservées aux professionnels légalement habilités. */
  const rgl = estDemandeReglementee(brut) || (principal ? reglementeIdx(reglementePour(String((svcCat(principal.id) || {}).num || ''), [], brut)) : null);
  if (rgl) return {
    type: 'reglemente', reglemente: rgl, principal: principal.id, ids: [principal.id],
    compris: rgl.nom, tache: principal.tache || '', corriges: c.corriges, urgence: c.urgence, alternatives: [],
    aide: rgl.exige
  };
  const natX = (c.nat || []).find(x => x.metier === principal.id) || catNatChainePour(principal.id);
  return {
    type: 'service',
    chaine: natX ? (natX.chaine || natX) : null,
    ids: idsCherches,
    principal: principal.id,
    tache: principal.tache || '',
    categorie: (svcCat(principal.id) || SVC_NOUVEAUX[principal.id] || {}).famille || '',
    compris: nm(principal.id),
    comprisLong: ic(principal.id) + ' ' + nm(principal.id) + (principal.tache ? (' · ' + principal.tache) : ''),
    corriges: c.corriges,
    urgence: c.urgence,
    alternatives: alt.map(x => ({ id: x.id, nom: nm(x.id), ic: ic(x.id), tache: x.tache || '' })),
    suggestions: alt.map(x => x.id)
  };
}

/* 🧠 COMPRÉHENSION : « cours à domicile » → métier « cours ».
   Score = mots du NOM du métier retrouvés dans la demande (+ le nom entier = très fort)
         + mots-clés spécifiques. Union bornée à 3 métiers, avec un seuil de pertinence. */
/* 🧠 POINT D'ENTRÉE UNIQUE de la compréhension.
   Il renvoie TOUJOURS la même forme qu'avant (type / ids / compris / suggestions) et
   AJOUTE ce que le client doit voir : la tâche, les fautes corrigées, l'urgence, les alternatives. */
function resoudreRecherche(q) {
  const c = comprendreDemande(q);
  if (c.type === 'kp') return { type: 'kp', code: c.code, compris: c.compris };
  if (c.type === 'vide') return { type: 'vide', ids: [], compris: '' };
  if (c.type === 'inconnu')
    return { type: 'inconnu', ids: [], compris: '', suggestions: [], corriges: c.corriges, urgence: c.urgence, aide: c.aide };
  return {
    type: 'service', ids: c.ids, principal: c.principal,
    compris: c.compris, comprisLong: c.comprisLong, tache: c.tache, categorie: c.categorie,
    corriges: c.corriges, urgence: c.urgence,
    alternatives: c.alternatives, suggestions: c.suggestions
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
/* ✅ le pro a coché les tâches qu'il maîtrise ; si sa liste est vide, on ne le pénalise pas
   (les professionnels déjà inscrits continuent de recevoir leur métier comme avant). */
function agentMaitrise(ag, taches) {
  const dem = (Array.isArray(taches) ? taches : []).map(t => normFr(t)).filter(Boolean);
  if (!dem.length) return true;
  const sait = (Array.isArray(ag.taches) ? ag.taches : []).map(t => normFr(t)).filter(Boolean);
  if (!sait.length) return true;
  return dem.every(t => sait.indexOf(t) >= 0);
}
/* 🩺 prestation réglementée : seuls les pros habilités peuvent recevoir et accepter la mission */
function agentHabilite(ag, reg) { return !reg || (Array.isArray(ag.habilitations) && ag.habilitations.indexOf(reg) >= 0); }
function agentHasService(ag, svc) {
  if (!svc) return true;
  const list = Array.isArray(ag.services) ? ag.services : [];
  if (!list.length) return true;
  /* 🔗 FUSION : « Grand ménage » et « Nettoyage maison » sont le même métier — le pro de l'un
     reçoit les demandes de l'autre (et de toutes les spécialités fusionnées). */
  const cible = svcCanon(svc);
  return list.some(x => svcCanon(x) === cible);
}
/* ⚠️ MÉTIERS VOISINS (union bornée à 3) : eux sont comparés à l'IDENTIQUE.
   Exemple : pour « clim », le moteur devine aussi « Électricité » et « Nettoyage de bureaux »
   (ils ont des tâches autour du climatiseur). Sans cette règle, l'équivalence de fusion
   (« grand ménage » = « nettoyage maison ») ferait remonter un pro du ménage sur une demande
   de climatisation — le client verrait un professionnel hors sujet. */
function agentHasServiceVo (ag, svc) {
  if (!svc) return true;
  const list = Array.isArray(ag.services) ? ag.services : [];
  if (!list.length) return true;
  return list.indexOf(svc) >= 0;
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
/* 🔒 `mint` : le jeton est FABRIQUÉ au premier envoi du téléphone (écriture) — une simple LECTURE
   ne doit jamais en fabriquer un en douce, sinon le téléphone du pro se retrouve bloqué (401)
   parce qu'un inconnu a ouvert une liste avec son identifiant. */
function agentJetonOk(req, ag, body, mint) {
  const h = (req.headers && (req.headers['x-agent-token'] || req.headers['X-Agent-Token'])) || '';
  const tok = String(h || (body && body.jeton) || '').trim();
  if (!ag.jeton) {
    if (mint === false) return { ok: true, nouveau: false, legacy: true };
    issueAgentJeton(ag); return { ok: true, nouveau: true, legacy: true };
  }
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
  /* ⚠️ le métier choisi EXPLICITEMENT par le client (`?service=…`) est toujours le premier :
     la phrase comprise peut ajouter des voisins, jamais rétrograder son choix. Exemple : l'app
     demande « maison » et le moteur lit « maison » → Immobilier — le métier du catalogue
     (« Nettoyage maison ») doit rester la demande principale. */
  if (svc && svc !== 'custom' && svcIds[0] !== svc) svcIds = [svc, ...svcIds.filter(x => x !== svc)].slice(0, 3);
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
    /* 🔗 le 1er métier = celui que le client a vraiment demandé (ou le ?service= explicite) → fusion OK.
       Les suivants = voisins devinés par le moteur → comparaison à l'identique (voir agentHasServiceVo). */
    let metierFait = svcIds.length
      ? svcIds.filter((id, i) => (i === 0 ? agentHasService(ag, id) : agentHasServiceVo(ag, id)))
      : [];
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
    /* 🚨 URGENCE : quand le client dit « c'est urgent », un pro EN LIGNE et LIBRE est vraiment mieux placé.
       Le critère n'existe que si la demande est urgente → aucun ancien résultat ne bouge. */
    const pUrg = (o.urgence && online && dispo === 'libre') ? 5 : 0;
    const obtenu = (pDist * w.distance) + (pDispo * w.dispo) + (pNote * w.note) + (pMissions * w.missions)
      + (pVerif * w.verif) + (pPrix * w.prix) + (pZone * w.zone) + (pComp * w.competences)
      + (o.urgence ? pUrg * 1.2 : 0);
    const maxPoids = (40 * w.distance) + (25 * w.dispo) + (15 * w.note) + (10 * w.missions)
      + (5 * w.verif) + (5 * w.prix) + (10 * w.zone) + (5 * w.competences)
      + (o.urgence ? 6 : 0);
    const score = maxPoids > 0 ? Math.round(obtenu / maxPoids * 10000) / 100 : 0;   // 0–100, comparable entre pros

    const card = fichePublique(ag, o);
    if (o.tache) card.tacheComprise = String(o.tache).slice(0, 40);   /* ce que le client a décrit */
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
    if (!agentMaitrise(ag, m.taches)) continue;
    if (!agentHabilite(ag, m.reglemente)) continue;
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
/* ═══════════════════════════════════════════════════════════════════════════
   🛡️ BOUCLIER KLEAN — RÈGLES FIXÉES PAR LE PDG (26/09/2026)
   · une adresse IP NORMALE est TOUJOURS autorisée : « inconnue » n'est PAS un motif ;
   · une adresse PARTAGÉE (cybercafé, hôtel, entreprise, réseau mobile ivoirien) n'est
     JAMAIS bloquée automatiquement — elle est seulement RALENTIE (429) pour protéger
     le serveur : bloquer une IP partagée punirait des clients honnêtes ;
   · le blocage automatique n'existe QUE sur un comportement réellement suspect :
     sondage de fichiers réservés, injection dans l'adresse, rafale de requêtes ;
   · tout blocage automatique est TEMPORAIRE : 15 min → 1 h → 6 h → 24 h au maximum ;
   · la RAISON du blocage et sa DURÉE sont écrites en français, visibles dans le tableau
     de bord, et rappelées au client bloqué (avec le temps restant).
   ═══════════════════════════════════════════════════════════════════════════ */
const SHIELD_DUREES = [15, 60, 360, 1440];              // minutes (palier 1 → 4, plafond 24 h)
const SHIELD_MOTIFS = {
  scan: 'sondage de fichiers réservés (.env, wp-admin, .git…)',
  injection: 'tentative d’injection dans l’adresse',
  flood: 'rafale de requêtes (trop de demandes en quelques secondes)',
  'kp-inconnu': 'code professionnel inconnu (erreur normale : jamais bloquante)',
  'fiche-inconnue': 'fiche professionnelle inexistante (erreur normale : jamais bloquante)',
  'pdg-recale': 'blocage décidé par le PDG',
  'pdg-aneanti': 'accès coupé définitivement par le PDG'
};
const SHIELD_SERIEUX = 18;                              // en dessous : curiosité/erreur, aucun poids
/* 🔒 réseaux privés et locaux : par nature PARTAGÉS (bureau, cybercafé, la machine elle-même).
   On les ralentit si besoin, mais on ne les bloque jamais tout seuls. */
function ipPartagee(ip) {
  const s = String(ip || '');
  return s === '::1' || s === 'localhost' || /^127\./.test(s) || /^10\./.test(s)
    || /^192\.168\./.test(s) || /^172\.(1[6-9]|2\d|3[01])\./.test(s) || /^169\.254\./.test(s);
}
let _shieldMigre = false;
function shieldEnsure() {
  db.shield = db.shield || { events: [], ips: {} };
  if (!Array.isArray(db.shield.events)) db.shield.events = [];
  if (!db.shield.ips) db.shield.ips = {};
  /* 🔓 LES ANCIENS BLOCAGES AUTOMATIQUES SANS DURÉE SONT ROUVERTS (une seule fois) :
     le bouclier v1 bloquait pour toujours dès 50 points, y compris une IP partagée qui
     accumulait de simples codes inconnus. Cette façon de faire est terminée. */
  if (!_shieldMigre) {
    _shieldMigre = true;
    let n = 0;
    for (const ip of Object.keys(db.shield.ips)) {
      const r = db.shield.ips[ip];
      if (r && r.blocked && !r.annihilated && !r.blockedUntil) {
        r.blocked = false; r.blockBy = ''; r.blockReason = ''; r.legacyReouvert = true;
        r.last = nowISO(); n++;
        db.shield.events.unshift({ id: uid('SH'), at: nowISO(), ip, kind: 'reouverture', path: '/hq',
          detail: 'ancien blocage automatique sans durée rouvert (il ne respectait pas la nouvelle règle)',
          score: r.score || 0, action: 'reouverture', raison: 'ancien blocage sans durée', minutes: 0 });
      }
    }
    if (db.shield.events.length > 250) db.shield.events = db.shield.events.slice(0, 250);
    if (n) { try { saveDb(); } catch (e) {} console.log('🛡️ ' + n + ' ancien(s) blocage(s) sans durée rouvert(s)'); }
  }
}
/* ⏳ le score fond quand l'IP se calme (demi-vie : 10 minutes) : une IP partagée qui reçoit
   des erreurs normales de clients ne peut plus « s'accumuler » jusqu'à un blocage. */
function shieldDecay(rec) {
  const t0 = Number(rec.scoreAt) || Date.now();
  const k = Math.pow(0.5, Math.max(0, Date.now() - t0) / (10 * 60 * 1000));
  if (k < 1) { rec.score = Math.round((Number(rec.score) || 0) * k * 100) / 100; rec.scoreAt = Date.now(); }
  return rec;
}
function shieldLog(ip, kind, path, detail, score) {
  shieldEnsure();
  const rec = db.shield.ips[ip] || { score: 0, hits: 0, blocked: false, annihilated: false,
    firstSeen: nowISO(), last: nowISO(), kind, bloqueCount: 0, serieux: 0 };
  shieldDecay(rec);
  rec.hits += 1;
  rec.score = Math.round(((Number(rec.score) || 0) + score) * 100) / 100;
  rec.scoreAt = Date.now();
  rec.last = nowISO();
  rec.kind = kind;
  const grave = score >= SHIELD_SERIEUX;                      // vraie attaque / abus
  if (grave) rec.serieux = (Number(rec.serieux) || 0) + 1;
  let action = 'veille', minutes = 0;
  if (rec.annihilated) action = 'aneanti';
  else if (rec.blocked) action = 'deja-bloque';
  else if (grave && rec.serieux >= 2 && rec.score >= 50) {
    /* ⚠️ deux signaux graves au moins, et JAMAIS sur une adresse partagée ou la machine elle-même */
    /* une adresse PARTAGÉE n'est jamais bloquée automatiquement… sauf si le PDG l'a explicitement demandé */
    if (ipPartagee(ip) && !(db.config && db.config.shieldPartagees)) action = 'surveille';
    else {
      minutes = SHIELD_DUREES[Math.min(Number(rec.bloqueCount) || 0, SHIELD_DUREES.length - 1)];
      db.shield.ips[ip] = rec;
      shieldBloquer(ip, kind, minutes, 'auto');
      action = 'auto-blocage';
    }
  }
  db.shield.ips[ip] = rec;
  db.shield.events.unshift({ id: uid('SH'), at: nowISO(), ip, kind, path: String(path || '').slice(0, 180),
    detail: String(detail || '').slice(0, 160), score: rec.score, action,
    raison: SHIELD_MOTIFS[kind] || 'comportement suspect', minutes: minutes || (rec.blocked ? (rec.blockMinutes || 0) : 0) });
  if (db.shield.events.length > 250) db.shield.events = db.shield.events.slice(0, 250);
  if (action !== 'veille' && action !== 'surveille') try { saveDb(); } catch (e) {}
  return rec;
}
/* 🚫 BLOQUER — toujours AVEC une durée et une raison écrites (jamais d'IP « recalée » muette). */
function shieldBloquer(ip, kind, minutes, par) {
  shieldEnsure();
  const rec = db.shield.ips[ip] || (db.shield.ips[ip] = { score: 0, hits: 0, firstSeen: nowISO(), serieux: 0, bloqueCount: 0 });
  const duree = Math.max(1, Math.min(43200, parseInt(minutes, 10) || SHIELD_DUREES[0]));
  rec.blocked = true;
  rec.annihilated = !!rec.annihilated && par !== 'debloque';
  rec.blockBy = par === 'pdg' ? 'pdg' : 'auto';
  rec.blockKind = kind || rec.blockKind || 'scan';
  rec.blockReason = SHIELD_MOTIFS[rec.blockKind] || 'comportement suspect';
  rec.blockedAt = nowISO();
  rec.blockMinutes = duree;
  rec.blockedUntil = new Date(Date.now() + duree * 60000).toISOString();
  if (par !== 'pdg-aneanti') rec.bloqueCount = (Number(rec.bloqueCount) || 0) + 1;
  rec.last = nowISO();
  db.shield.ips[ip] = rec;
  try { shieldKickIp(ip); } catch (e) {}
  try { saveDb(); } catch (e) {}
  /* 🔔 le PDG voit le blocage arriver en direct dans ses alertes (avec la raison et la durée) */
  if (par === 'auto') { try { emitAdmin('bouclier', '🛡️ Adresse ' + ip + ' bloquée ' + duree + ' min — ' + rec.blockReason); } catch (e) {} }
  return rec;
}
/* ⏰ L'ÉTAT RÉEL D'UNE IP — un blocage temporaire se lève TOUT SEUL quand sa durée est passée. */
function shieldEtat(ip) {
  shieldEnsure();
  const rec = db.shield.ips[ip];
  if (!rec) return null;
  if (rec.blocked && !rec.annihilated && rec.blockedUntil && Date.parse(rec.blockedUntil) <= Date.now()) {
    rec.blocked = false;
    rec.last = nowISO();
    db.shield.events.unshift({ id: uid('SH'), at: nowISO(), ip, kind: 'fin-blocage', path: '/',
      detail: 'durée écoulée (' + (rec.blockMinutes || 0) + ' min) — adresse de nouveau autorisée',
      score: rec.score || 0, action: 'debloque', raison: 'durée de blocage écoulée', minutes: 0 });
    if (db.shield.events.length > 250) db.shield.events = db.shield.events.slice(0, 250);
    try { saveDb(); } catch (e) {}
  }
  return rec;
}
function shieldBloque(ip) { const r = shieldEtat(ip); return !!(r && (r.annihilated || r.blocked)); }
function shieldResteMin(rec) {
  if (!rec || !rec.blocked || !rec.blockedUntil) return 0;
  return Math.max(0, Math.ceil((Date.parse(rec.blockedUntil) - Date.now()) / 60000));
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
/* 🚪 LE PASSAGE OBLIGÉ DE TOUTE REQUÊTE : c'est ici que le bouclier décide — et il dit POURQUOI. */
function shieldGate(req, res, p) {
  const ip = clientIp(req);
  req._ip = ip;
  const rec = shieldEtat(ip);
  const hq = (() => { try { return hqIdentity(req); } catch (e) { return null; } })();
  const estPdg = !!(hq && hq.role === 'pdg');
  /* 🚫 une IP bloquée reçoit la raison ET le temps restant (le PDG peut toujours passer) */
  if (rec && !estPdg) {
    if (rec.annihilated)
      return (sendJson(res, 403, { ok: false, code: 'bouclier', error: 'Accès coupé par le PDG (décision définitive)',
        raison: SHIELD_MOTIFS['pdg-aneanti'], par: 'PDG', definitive: true }), true);
    if (rec.blocked) {
      const reste = shieldResteMin(rec);
      try { res.setHeader('Retry-After', String(Math.max(1, reste) * 60)); } catch (e) {}
      return (sendJson(res, 403, { ok: false, code: 'bouclier',
        error: 'Accès temporairement bloqué (' + reste + ' min) — ' + (rec.blockReason || 'comportement suspect'),
        raison: rec.blockReason || 'comportement suspect', resteMin: reste, fin: rec.blockedUntil,
        par: rec.blockBy === 'pdg' ? 'PDG' : 'automatique',
        aide: 'Ce blocage se lève tout seul à la fin du temps indiqué. Si c’est une erreur : « Contactez Klean-Service ».' }), true);
    }
  }
  if (_SCAN.test(p) || _SCAN.test(req.url || '')) {
    shieldLog(ip, 'scan', p, 'sonde (cms/env/git)', 28);
    sendJson(res, 404, { error: 'introuvable' });
    return true;
  }
  if (_INJECT.test(req.url || '')) {
    const r2 = shieldLog(ip, 'injection', p, 'charge dans l’URL', 22);
    if (r2.blocked && !estPdg && !r2.annihilated) {
      const reste = shieldResteMin(r2);
      sendJson(res, 403, { ok: false, code: 'bouclier', error: 'Accès temporairement bloqué (' + reste + ' min) — ' + r2.blockReason,
        raison: r2.blockReason, resteMin: reste, fin: r2.blockedUntil, par: 'automatique' });
      return true;
    }
  }
  /* 🚦 TROP DE REQUÊTES : on RALENTIT d'abord (le client réessaie), on ne bloque pas d'emblée.
     Le blocage temporaire n'arrive que si la rafale continue (3 fois de suite). */
  const now = Date.now();
  const h = _hitMap.get(ip) || { t: now, n: 0 };
  if (now - h.t > 10000) { h.t = now; h.n = 0; }
  h.n += 1;
  _hitMap.set(ip, h);
  if (h.n > 160) {
    const rec2 = shieldLog(ip, 'flood', p, h.n + ' req / 10 s', 18);
    const reste = rec2.blocked ? shieldResteMin(rec2) : 0;
    try { res.setHeader('Retry-After', '10'); } catch (e) {}
    sendJson(res, 429, { ok: false, code: rec2.blocked ? 'bouclier' : 'limite',
      error: rec2.blocked
        ? ('Accès temporairement bloqué (' + reste + ' min) — ' + rec2.blockReason)
        : ('Trop de requêtes : ' + h.n + ' en 10 secondes — patientez un instant'),
      raison: rec2.blocked ? rec2.blockReason : 'trop de requêtes en quelques secondes',
      resteMin: reste, fin: rec2.blocked ? rec2.blockedUntil : null,
      par: rec2.blocked ? 'automatique' : '' });
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

/* ═══════════════════════════════════════════════════════════════════════════
   🖼️ LOT 100 — LES MÉDIAS DE PUBLICITÉ NE SE PERDENT PLUS
   Le fichier est écrit sur le disque (rapide, mis en cache par le navigateur) ET conservé
   dans la base. Au démarrage, tout média manquant est réécrit sur le disque : une image
   envoyée depuis le HQ survit donc à un redéploiement de l'hébergeur.
   ═══════════════════════════════════════════════════════════════════════════ */
const PUB_MEDIA_GARDES = 4;            // on garde les 4 médias les plus récents (+ ceux encore utilisés)
function pubMediasUtilises() {
  const u = [db.ad && db.ad.mediaUrl, db.flip && db.flip.mediaUrl, db.flip && db.flip.videoUrl, db.annonce && db.annonce.mediaUrl];
  (db.recompenses || []).forEach(r => u.push(r && r.mediaUrl));
  (db.quizBank && db.quizBank.questions || []).forEach(q => u.push(q && q.mediaUrl));
  return u.filter(Boolean).map(x => String(x).replace(/^\/pub\//, ''));
}
function pubMediaMemoriser(nom, buf) {
  try {
    if (!/^[A-Za-z0-9_.-]{3,80}$/.test(String(nom))) return;
    db.pubFiles = db.pubFiles || {};
    db.pubFiles[nom] = { b64: Buffer.from(buf).toString('base64'), at: nowISO(), octets: buf.length };
    const utilises = pubMediasUtilises();
    const cles = Object.keys(db.pubFiles);
    if (cles.length > PUB_MEDIA_GARDES) {
      cles.filter(k => utilises.indexOf(k) < 0)
        .sort((a, b) => String((db.pubFiles[a] || {}).at || '').localeCompare(String((db.pubFiles[b] || {}).at || '')))
        .slice(0, Math.max(0, cles.length - PUB_MEDIA_GARDES))
        .forEach(k => { delete db.pubFiles[k]; });
    }
    saveDb();
  } catch (e) { }
}
function pubMediaRestaurer() {
  try {
    db.pubFiles = db.pubFiles || {};
    /* 🛟 les médias déjà en place AVANT ce correctif sont récupérés automatiquement :
       le fichier existe sur le disque → on en garde une copie dans la base (plus jamais perdu). */
    let recup = 0;
    pubMediasUtilises().forEach(nom => {
      if (!/^[A-Za-z0-9_.-]{3,80}$/.test(nom) || db.pubFiles[nom]) return;
      const fp = path.join(PUB_DIR, nom);
      if (path.dirname(fp) !== PUB_DIR || !fs.existsSync(fp)) return;
      try {
        const buf = fs.readFileSync(fp);
        if (buf && buf.length && buf.length < 13 * 1024 * 1024) { db.pubFiles[nom] = { b64: buf.toString('base64'), at: nowISO(), octets: buf.length, recupere: true }; recup++; }
      } catch (e) { }
    });
    if (recup) { saveDb(); console.log('  🛟 ' + recup + ' média(s) existant(s) mis à l’abri dans la base (ils survivront aux redéploiements)'); }
    /* ⚠️ média perdu avant le correctif : on le signale clairement dans les logs */
    pubMediasUtilises().forEach(nom => {
      if (!nom || db.pubFiles[nom]) return;
      try { if (!fs.existsSync(path.join(PUB_DIR, nom))) console.log('  ⚠️  Média manquant : /pub/' + nom + ' — renvoyez l’image depuis le HQ (Publicité)'); } catch (e) { }
    });
    let n = 0;
    for (const nom of Object.keys(db.pubFiles)) {
      if (!/^[A-Za-z0-9_.-]{3,80}$/.test(nom)) continue;
      const fp = path.join(PUB_DIR, nom);
      if (path.dirname(fp) !== PUB_DIR) continue;
      if (fs.existsSync(fp)) continue;
      const rec = db.pubFiles[nom] || {};
      if (!rec.b64) continue;
      fs.writeFileSync(fp, Buffer.from(String(rec.b64), 'base64'));
      n++;
    }
    if (n) console.log('  🖼️  ' + n + ' média(s) de publicité restauré(s) depuis la base (disque vidé par un redéploiement)');
  } catch (e) { }
}
/* le fichier est-il bien là ? (sert à prévenir le PDG quand un média a été perdu) */
function pubFichierPresent(url) {
  const u = String(url || '');
  if (!u) return true;                                    // aucun média demandé : rien à vérifier
  const nom = u.replace(/^\/pub\//, '');
  if (!/^[A-Za-z0-9_.-]{3,80}$/.test(nom)) return false;
  try { return fs.existsSync(path.join(PUB_DIR, nom)); } catch (e) { return false; }
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
  pubMediaMemoriser(nom, buf);          /* 🖼️ copie dans la base : survit au redéploiement */
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


/* ═══════════ 💾 SAUVEGARDES & RESTAURATION DE LA BASE (lot 98) ═══════════
   · stockage permanent = Postgres/Neon (DATABASE_URL) ; sinon fichier db.json (temporaire sur Render)
   · historique automatique : les 10 dernières versions conservées dans Neon (table klean_backups)
   · téléchargement et restauration : réservés au compte principal (PDG)                     */
let SAUV = { at: null, taille: 0, auto: 0, err: '' };
const _dbTaille = () => { try { return JSON.stringify(db).length; } catch (e) { return 0; } };
const _nbDossiers = () => (db.agents || []).length + (db.clients || []).length + (db.missions || []).length;
function stockageInfo() {
  return {
    permanent: !!pgClient,
    type: pgClient ? 'Postgres (Neon)' : 'fichier db.json (local)',
    dossier: __dirname,
    taille: _dbTaille(),
    dossiers: _nbDossiers(),
    dernierEnvoi: SAUV.at,
    auto: SAUV.auto || 0,
    erreur: SAUV.err || '',
    conseil: pgClient ? '' : 'Chez un hébergeur (Render), le disque est vidé à chaque redéploiement : ajoutez la variable DATABASE_URL (Neon, gratuit) pour rendre les données permanentes. Les boutons ci-dessous restent votre filet de sécurité.'
  };
}
let _sauvDernier = 0;
/* une sauvegarde automatique au maximum toutes les 30 minutes (ou forcée à la demande) */
async function sauvegardeAuto(force) {
  if (!pgClient) return { ok: false, raison: 'sans-postgres' };
  const t = Date.now();
  if (!force && t - _sauvDernier < 30 * 60 * 1000) return { ok: false, raison: 'recent' };
  _sauvDernier = t;
  try {
    const snap = JSON.stringify(db);
    await pgClient.query('CREATE TABLE IF NOT EXISTS klean_backups (id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), dossiers int NOT NULL DEFAULT 0, taille int NOT NULL DEFAULT 0, data jsonb NOT NULL)');
    await pgClient.query('INSERT INTO klean_backups (dossiers, taille, data) VALUES ($1,$2,$3)', [_nbDossiers(), snap.length, JSON.parse(snap)]);
    await pgClient.query('DELETE FROM klean_backups WHERE id NOT IN (SELECT id FROM klean_backups ORDER BY at DESC LIMIT 10)');
    SAUV = { at: nowISO(), taille: snap.length, auto: (SAUV.auto || 0) + 1, err: '' };
    return { ok: true };
  } catch (e) { SAUV.err = String(e.message || e).slice(0, 160); return { ok: false, raison: SAUV.err }; }
}
async function sauvegardesListe() {
  if (!pgClient) return [];
  try {
    const r = await pgClient.query('SELECT id, at, dossiers, taille FROM klean_backups ORDER BY at DESC LIMIT 10');
    return r.rows.map(x => ({ id: x.id, at: x.at, dossiers: x.dossiers, taille: x.taille }));
  } catch (e) { return []; }
}
/* 🛡️ une sauvegarde n'est appliquée que si elle a la forme d'une base KLEAN */
function dbInvalide(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'Fichier illisible : ce n’est pas une sauvegarde KLEAN';
  if (!Array.isArray(d.agents) || !Array.isArray(d.clients) || !Array.isArray(d.missions)) return 'Ce fichier n’est pas une sauvegarde KLEAN (les listes clients, professionnels et missions sont absentes)';
  return '';
}
function copieAvantRestauration() {
  try { fs.writeFileSync(DB_FILE + '.avant-restauration.json', JSON.stringify(db)); } catch (e) { }
}


/* ═══════════ 🟠 LITIGES & REMBOURSEMENTS (lot 99) ═══════════
   Un dossier = une mission + un motif + une discussion + une décision.
   🔒 Aucun argent n'est déplacé par le logiciel : la décision est enregistrée, le versement
      est fait par le PDG (Wave / Orange / Moov / espèces / CinetPay) puis marqué « payé ».           */
const LITIGE_MOTIFS = {
  travail_non_fait: 'Travail non fait',
  travail_incomplet: 'Travail incomplet',
  retard: 'Retard important',
  degat: 'Dégât ou casse',
  montant: 'Désaccord sur le montant',
  autre: 'Autre problème'
};
const LITIGE_MOYENS = { wave: 'Wave', om: 'Orange Money', moov: 'Moov Money', cinetpay: 'CinetPay / carte', especes: 'Espèces' };
const LITIGE_STATUS = { ouvert: 'Ouvert', en_cours: 'En cours d’examen', rembourse: 'Remboursement accepté', refuse: 'Refusé', regle: 'Remboursement versé' };
function litigePublic(l) {
  return {
    id: l.id, missionId: l.missionId, service: l.service, serviceNom: l.serviceNom || l.service,
    prixTotal: l.prixTotal || 0, motif: l.motif, motifTxt: LITIGE_MOTIFS[l.motif] || l.motif,
    texte: l.texte || '', montantSouhaite: l.montantSouhaite || 0,
    status: l.status, statusTxt: LITIGE_STATUS[l.status] || l.status,
    at: l.at, majAt: l.majAt || l.at, motifRefus: l.motifRefus || '',
    remboursement: l.remboursement ? Object.assign({}, l.remboursement, { moyenTxt: LITIGE_MOYENS[l.remboursement.moyen] || l.remboursement.moyen }) : null,
    hist: (l.hist || []).filter(h => !h.interne).slice(-40)
  };
}
/* message déposé dans la messagerie du client (aucun nouveau système de messagerie) */
function litigeMessageClient(l, texte) {
  db.supportMsgs.push({ id: uid('SR'), role: 'client', uid: l.clientId, nom: l.clientNom, from: 'hq', par: 'KLEAN', text: texte, at: nowISO(), readHQ: true, readUser: false });
}


/* ═══════════════════════════════════════════════════════════════════════════════
   🎮 LOT 101 — JEUX EN DIRECT (élimination progressive) + génération de questions
   · une « partie » réunit des participants connectés en même temps ;
   · le SERVEUR est seul maître du temps et des éliminations (aucune confiance au téléphone) ;
   · une mauvaise réponse OU une réponse trop tardive élimine ;
   · les questions montent en difficulté si l'administrateur coche « difficulté progressive ».
   ═══════════════════════════════════════════════════════════════════════════════ */
const JEU_REST = ['all', 'done', 'none'];                       /* le MÊME système que le quiz */
const JEU_PLACEMENTS = { accueil: 'Page d’accueil', profils: 'Profil / espace Compte', autres: 'Autres emplacements (rubrique Jeux)' };
const JEU_NIVEAUX = { 1: 'facile', 2: 'moyen', 3: 'difficile' };
function jeuRestOk(rule, done) { return rule === 'all' ? true : rule === 'done' ? !!done : rule === 'none' ? !done : true; }
function jeuPeutJouer(player, jeu) {
  const r = (jeu && jeu.rest) || { clients: 'all', pros: 'all' };
  if (player.role === 'client') return jeuRestOk(r.clients, player.done);
  if (player.role === 'agent') return jeuRestOk(r.pros, player.done);
  return jeuRestOk(r.clients, false);
}
function jeuInfo(jeu) {
  const q = (jeu.questions || []);
  return {
    id: jeu.id, nom: jeu.nom, theme: jeu.theme || '', actif: !!jeu.actif,
    placement: jeu.placement || { accueil: true, profils: false, autres: true },
    rest: jeu.rest || { clients: 'all', pros: 'all' },
    debutAt: jeu.debutAt || null, inscriptionFinAt: jeu.inscriptionFinAt || null,
    dureeQuestion: jeu.dureeQuestion || 20, progresDifficulte: !!jeu.progresDifficulte,
    nbQuestions: q.length, niveaux: q.map(x => x.niveau || 1),
    ia: jeu.ia || null, creeAt: jeu.creeAt || null
  };
}
function jeuPublic(jeu, player, partie) {
  const r = jeuInfo(jeu);
  r.inscriptionOuverte = jeuInscriptionOuverte(jeu);
  r.peutJouer = jeuPeutJouer(player, jeu);
  if (partie) r.partie = { id: partie.id, status: partie.status };
  return r;
}
function jeuInscriptionOuverte(jeu) {
  if (!jeu || !jeu.actif) return false;
  if (jeu.inscriptionFinAt && Date.now() > new Date(jeu.inscriptionFinAt).getTime()) return false;   /* ⏰ retardataires refusés */
  return true;
}
function jeuQuestion(j, i) {
  const q = ((j && j.questions) || [])[i]; if (!q) return null;
  return { i, q: q.q, choix: (q.choix || []).slice(0, 4), niveau: q.niveau || 1, duree: j.dureeQuestion || 20, bonne: q.bonne };
}
/* 🎯 difficulté progressive : on choisit la question dont le niveau colle au stade de la partie,
   en tenant aussi compte du nombre de participants encore en course. */
function jeuChoisirSuivante(jeu, session) {
  const reste = (jeu.questions || []).map((q, i) => ({ q, i })).filter(x => !(session.utilisees || []).includes(x.i));
  if (!reste.length) return -1;
  if (!jeu.progresDifficulte) return reste[0].i;
  const total = Math.max(1, (jeu.questions || []).length);
  const avancement = Math.min(1, (session.utilisees || []).length / Math.max(1, total - 1));
  const vivants = session.participants.filter(p => !p.elimine).length;
  const serrage = (session.participants.length > 1 && vivants <= session.participants.length / 3) ? 1 : 0;
  const cible = Math.max(1, Math.min(3, 1 + Math.round(2 * avancement) + serrage));
  let best = reste[0], ecart = 9;
  for (const x of reste) { const d = Math.abs((x.q.niveau || 1) - cible); if (d < ecart) { ecart = d; best = x; } }
  return best.i;
}
function jeuxTrouverPartie(id) { return (db.jeuxParties || []).find(p => p.id === id) || null; }
function jeuxTrouverJeu(id) { return (db.jeux || []).find(j => j.id === id) || null; }
function jeuxPartieActive(id) {
  const list = (db.jeuxParties || []).filter(p => p.jeuId === id && p.status !== 'termine');
  return list.length ? list[list.length - 1] : null;
}
/* ouvre la question suivante ; désigne les gagnants quand la partie est finie */
function jeuxOuvrirQuestion(session, jeu, raison) {
  const vivants = session.participants.filter(p => !p.elimine);
  if (!session.participants.length) {
    /* 🕐 personne encore inscrit : la partie ATTEND (l'organisateur a lancé, les joueurs arrivent) */
    session.status = 'inscription'; saveDb(); return { fin: false, attente: true };
  }
  if (!vivants.length) { jeuxTerminer(session, jeu, 'plus aucun participant'); return { fin: true }; }
  if (vivants.length === 1) { jeuxTerminer(session, jeu, 'dernier participant en course'); return { fin: true }; }
  const i = jeuChoisirSuivante(jeu, session);
  if (i < 0) { jeuxTerminer(session, jeu, 'toutes les questions ont été posées'); return { fin: true }; }
  const q = jeu.questions[i];
  session.utilisees = (session.utilisees || []).concat([i]);
  session.qi = i;
  session.status = 'en_cours';
  session.qAt = nowISO();
  session.qFinAt = new Date(Date.now() + (jeu.dureeQuestion || 20) * 1000).toISOString();
  session.reponses = {};
  session.participants.forEach(p => { p.repondu = false; p.derniereReponse = null; });
  session.raison = raison || '';
  saveDb();
  emitAdmin('jeu', '🎮 ' + session.nom + ' — question ' + (session.utilisees.length) + '/' + (jeu.questions || []).length + ' · ' + session.participants.filter(p => !p.elimine).length + ' en course');
  return { fin: false, i };
}
function jeuxEliminerNonRepondants(session) {
  const fin = Date.parse(session.qFinAt || 0);
  if (!fin || Date.now() < fin) return 0;
  let n = 0;
  session.participants.forEach(p => { if (!p.elimine && !p.repondu) { p.elimine = true; p.motif = 'temps écoulé'; n++; } });
  return n;
}
function jeuxTerminer(session, jeu, raison) {
  let vivants = session.participants.filter(p => !p.elimine);
  let r = raison || '';
  if (!vivants.length && session.participants.length) {
    /* 🏆 dernier tour fatal pour tout le monde : le meilleur score est retenu (le jeu a toujours un gagnant) */
    const max = Math.max.apply(null, session.participants.map(p => p.bon || 0));
    vivants = session.participants.filter(p => (p.bon || 0) === max)
      .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
      .slice(0, 1);
    r = (raison || '') + ' — aucun survivant : le meilleur score est retenu';
  }
  session.status = 'termine';
  session.finAt = nowISO();
  session.raisonFin = r;
  session.gagnants = vivants.map(p => ({ uid: p.uid, nom: p.nom, bon: p.bon || 0, photo: p.photo || '' }));
  session.qi = -1;
  saveDb();
  if (session.gagnants.length) {
    emitAdmin('jeu', '🏆 ' + session.nom + ' : gagnant' + (session.gagnants.length > 1 ? 's' : '') + ' — ' + session.gagnants.map(g => g.nom).join(', '));
    /* les points Klean Points sont ajoutés par le jeu, jamais de l'argent liquide */
    session.gagnants.forEach(g => {
      try { ptsMouvement(g.uid, Math.max(0, parseInt(session.pointsGagnant, 10) || 0), 'Victoire au jeu « ' + session.nom + ' »', session.id); } catch (e) {}
    });
  } else {
    emitAdmin('jeu', '🎮 ' + session.nom + ' : aucun survivant (' + (raison || '') + ')');
  }
  return session;
}
/* appelée à chaque lecture : fait avancer la partie sans horloge serveur dédiée */
function jeuxTick(session) {
  if (!session || session.status === 'termine') return session;
  const jeu = jeuxTrouverJeu(session.jeuId); if (!jeu) return session;
  if (session.status === 'inscription') {
    const heureOk = !jeu.debutAt || Date.now() >= new Date(jeu.debutAt).getTime();
    if (heureOk && session.participants.length) jeuxOuvrirQuestion(session, jeu, 'début du jeu');
    return session;
  }
  if (session.status === 'en_cours') {
    jeuxEliminerNonRepondants(session);
    const vivants = session.participants.filter(p => !p.elimine);
    const toutRepondu = session.participants.filter(p => !p.elimine).every(p => p.repondu);
    if (vivants.length === 0 || vivants.length === 1 || toutRepondu) jeuxOuvrirQuestion(session, jeu, toutRepondu ? 'tout le monde a répondu' : 'survivants');
    else saveDb();
  }
  return session;
}
/* ============================ 🧠 GÉNÉRATEUR DE QUESTIONS ============================
   Deux modes : « banque » (l'administrateur écrit/importe) et « automatique ».
   Le mode automatique fonctionne par DÉFAUT sans aucune clé (générateur intégré, thèmes vérifiés) ;
   si vous fournissez une clé (KLEAN_IA_KEY), il utilise l'IA et retombe sur le générateur en cas d'échec. */
const JEU_THEMES = {
  maths: 'Calcul & logique', culture_ci: 'Côte d’Ivoire', klean: 'Klean Service', francais: 'Langue française', sciences: 'Découverte & sciences'
};
let _jeuRand = null;
function jeuAleatoire(max) { return Math.floor(Math.random() * max); }
function jeuMelanger(a) { const t = a.slice(); for (let i = t.length - 1; i > 0; i--) { const j = jeuAleatoire(i + 1); const x = t[i]; t[i] = t[j]; t[j] = x; } return t; }
function jeuQCM(q, bonne, faux, niveau) {
  /* on garantit 4 propositions DIFFÉRENTES (sinon on complète par des écarts) */
  const vus = [];
  const ajouter = v => { const t = String(v); if (vus.indexOf(t) < 0) vus.push(t); };
  ajouter(bonne); (faux || []).forEach(ajouter);
  let k = 1;
  while (vus.length < 4 && k < 30) { ajouter(Number(bonne) ? Number(bonne) + k : bonne + ' (variante ' + k + ')'); k++; }
  const choix = jeuMelanger(vus.slice(0, 4));
  return { q, choix, bonne: choix.indexOf(String(bonne)), niveau: niveau || 1 };
}
/* ═══════════════════════════════════════════════════════════════════════════════
   📚 BANQUE DE QUESTIONS INTÉGRÉE (60→120) — 3 niveaux × 8 questions par thème.
   Format : [question, bonne réponse, [mauvaises réponses], niveau]
   Le générateur « banque » pioche ici sans jamais répéter une question tant que le
   stock du thème le permet (le calcul « maths » est généré à la volée, à l'infini).
   ═══════════════════════════════════════════════════════════════════════════════ */
const JEU_BANQUE = {
  culture_ci: [
    /* — niveau 1 : facile — */
    ['Quelle est la capitale politique de la Côte d’Ivoire ?', 'Yamoussoukro', ['Abidjan', 'Bouaké', 'Korhogo'], 1],
    ['Quelle monnaie utilise-t-on en Côte d’Ivoire ?', 'Le franc CFA (XOF)', ['Le naira', 'Le cédi', 'Le dirham'], 1],
    ['Quelle est la plus grande ville de Côte d’Ivoire ?', 'Abidjan', ['Bouaké', 'Yamoussoukro', 'San Pedro'], 1],
    ['Quelle est la langue officielle de la Côte d’Ivoire ?', 'Le français', ['L’anglais', 'L’espagnol', 'Le portugais'], 1],
    ['De combien de bandes de couleur le drapeau ivoirien est-il fait ?', 'Trois (orange, blanc, vert)', ['Deux', 'Quatre', 'Cinq'], 1],
    ['Quel océan borde la Côte d’Ivoire ?', 'L’océan Atlantique', ['La Méditerranée', 'L’océan Indien', 'La mer Rouge'], 1],
    ['Quel plat ivoirien est fait de banane plantain frite ?', 'L’alloco', ['L’attiéké', 'Le placali', 'Le riz gras'], 1],
    ['Quel pays est voisin de la Côte d’Ivoire ?', 'Le Ghana', ['Le Togo', 'Le Sénégal', 'Le Niger'], 1],
    /* — niveau 2 : moyen — */
    ['Dans quelle région se trouve la ville de Bouaké ?', 'Le Gbêkê (Vallée du Bandama)', ['Le Bas-Sassandra', 'Les Lagunes', 'Le Zanzan'], 2],
    ['Quel fleuve traverse la Côte d’Ivoire ?', 'Le Bandama', ['Le Niger', 'Le Sénégal', 'Le Congo'], 2],
    ['Quelle est la capitale économique de la Côte d’Ivoire ?', 'Abidjan', ['Yamoussoukro', 'Bouaké', 'Man'], 2],
    ['Quelle ville balnéaire, ancienne capitale coloniale, est classée au patrimoine mondial ?', 'Grand-Bassam', ['San Pedro', 'Grand-Lahou', 'Sassandra'], 2],
    ['De quel produit la Côte d’Ivoire est-elle le premier producteur mondial ?', 'Le cacao', ['Le blé', 'Le maïs', 'L’arachide'], 2],
    ['Quelle spécialité ivoirienne est faite à partir de manioc râpé ?', 'L’attiéké', ['L’alloco', 'L’igname pilée', 'Le foutou banane'], 2],
    ['Dans quelle ville se trouve le stade Félix Houphouët-Boigny ?', 'Abidjan', ['Bouaké', 'Yamoussoukro', 'San Pedro'], 2],
    ['En quelle année la Côte d’Ivoire est-elle devenue indépendante ?', '1960', ['1956', '1962', '1968'], 2],
    /* — niveau 3 : difficile — */
    ['Quel est le plus haut sommet de la Côte d’Ivoire ?', 'Le mont Nimba', ['Le mont Tonkoui', 'Le mont Korhogo', 'Le mont Abidjan'], 3],
    ['Quel est le plus long fleuve entièrement ivoirien ?', 'Le Bandama', ['Le Cavally', 'La Comoé', 'Le Sassandra'], 3],
    ['Quel parc national du NORD-EST de la Côte d’Ivoire est classé au patrimoine mondial ?', 'Le parc national de la Comoé', ['Le parc de Taï', 'Le parc du Banco', 'Le parc de la Marahoué'], 3],
    ['Sur quel fleuve se trouve le barrage de Kossou ?', 'Le Bandama', ['Le Sassandra', 'La Comoé', 'Le Cavally'], 3],
    ['Quelle est la plus ancienne université du pays, à Abidjan-Cocody ?', 'L’université Félix Houphouët-Boigny', ['L’université Alassane Ouattara', 'L’université de Man', 'L’INP-HB de Yamoussoukro'], 3],
    ['Quel pays partage la plus longue frontière terrestre avec la Côte d’Ivoire ?', 'Le Liberia', ['Le Ghana', 'La Guinée', 'Le Burkina Faso'], 3],
    ['Dans quelle ville se trouve le siège de la Banque africaine de développement (BAD) ?', 'Abidjan', ['Yamoussoukro', 'Bouaké', 'Grand-Bassam'], 3],
    ['Quel pays n’a AUCUNE frontière avec la Côte d’Ivoire ?', 'Le Togo', ['Le Mali', 'La Guinée', 'Le Liberia'], 3]
  ],
  klean: [
    /* — niveau 1 — */
    ['Comment s’appelle le numéro professionnel d’un pro KLEAN ?', 'Un code KP- suivi de 6 chiffres', ['Un numéro de compte bancaire', 'Un code postal', 'Un code promo'], 1],
    ['Que faire si aucun professionnel n’est disponible autour de vous ?', 'Déposer une demande ou élargir la recherche', ['Payer d’avance', 'Abandonner', 'Attendre une semaine'], 1],
    ['Les Klean Points peuvent-ils être convertis en argent liquide ?', 'Non, jamais', ['Oui, en espèces', 'Oui, à la banque', 'Seulement le week-end'], 1],
    ['Qui valide définitivement un remboursement ?', 'Le compte principal (PDG)', ['Le professionnel', 'Le gestionnaire', 'Le client'], 1],
    ['Que se passe-t-il si vous ne donnez pas l’autorisation GPS ?', 'Vous pouvez chercher par quartier ou par ville', ['L’application se ferme', 'Rien n’est possible', 'Le compte est bloqué'], 1],
    ['KLEAN sert à trouver des professionnels pour… ?', 'Le nettoyage, les cours, la beauté et bien d’autres services', ['Uniquement le ménage', 'Uniquement la plomberie', 'Uniquement les livraisons'], 1],
    ['Le numéro personnel d’un professionnel est… ?', 'Jamais affiché aux clients', ['Toujours affiché', 'Affiché après paiement', 'Affiché le week-end'], 1],
    ['Comment signaler un problème après une mission ?', 'Avec « Signaler un problème » sur la mission terminée', ['En appelant la police', 'En envoyant un SMS', 'Ce n’est pas possible'], 1],
    /* — niveau 2 — */
    ['À quoi servent les Klean Points ?', 'À obtenir des récompenses et des parties gratuites', ['À payer les missions', 'À retirer de l’argent au guichet', 'À acheter du carburant'], 2],
    ['Qui instruit un dossier de litige ?', 'Le gestionnaire (la décision finale reste au PDG)', ['Le professionnel', 'Le client', 'Personne'], 2],
    ['Que se passe-t-il si un professionnel refuse une mission ?', 'KLEAN propose un autre professionnel disponible', ['Le client doit payer plus cher', 'La mission est annulée', 'Il faut rappeler demain'], 2],
    ['À quoi sert le suivi en direct d’une mission ?', 'À voir l’avancement et l’arrivée du professionnel', ['À regarder un film', 'À participer à une réunion', 'À lire le journal'], 2],
    ['Avant de payer, que devez-vous faire ?', 'Vérifier le prix proposé et accepter le devis', ['Payer tout de suite', 'Envoyer votre mot de passe', 'Rien du tout'], 2],
    ['Le numéro d’appel d’un pro KLEAN est-il son numéro personnel ?', 'Non : c’est un numéro professionnel distinct', ['Oui, exactement le même', 'Oui, mais masqué', 'Cela dépend du jour'], 2],
    ['Un dossier de litige est possible… ?', 'Sur une mission terminée', ['Sur une mission en cours', 'Sur n’importe quelle recherche', 'Jamais'], 2],
    ['La photo du gagnant d’un jeu KLEAN est… ?', 'Facultative : la victoire est validée sans photo', ['Obligatoire', 'Payante', 'Interdite'], 2],
    /* — niveau 3 — */
    ['Que se passe-t-il si vous ne répondez pas à une question de jeu à temps ?', 'Vous êtes éliminé', ['Vous perdez 1 point seulement', 'Rien du tout', 'Vous gagnez du temps'], 3],
    ['Dans un jeu en direct KLEAN, qui corrige les réponses ?', 'Le serveur : la bonne réponse n’est donnée qu’après le vote', ['Le joueur le plus rapide', 'Le PDG à la main', 'Personne'], 3],
    ['Combien de gagnants un jeu en direct désigne-t-il ?', 'Au moins un : le dernier en course (ou le meilleur score)', ['Aucun', 'Toujours trois', 'Dix au maximum'], 3],
    ['Votre position exacte sur KLEAN… ?', 'N’est jamais publique : elle sert seulement à trouver un pro proche', ['Est publique', 'Est vendue à des partenaires', 'Est cachée à vous-même'], 3],
    ['Comment le rayon de recherche est-il réglé ?', 'Par le PDG : il peut couvrir toute la Côte d’Ivoire', ['Il est fixé à 1 km', 'Il est fixé à 5 km', 'Il n’existe pas'], 3],
    ['Que veut dire le code « KP- » sur la fiche d’un professionnel ?', 'Son numéro professionnel KLEAN', ['Son âge', 'Son prix', 'Sa note'], 3],
    ['Où consulter l’historique de vos missions ?', 'Dans « Mes réservations »', ['Dans les informations personnelles', 'Dans le quiz', 'Nulle part'], 3],
    ['Un professionnel peut-il voir votre numéro personnel ?', 'Non : la demande passe par l’application', ['Oui, toujours', 'Oui, après le paiement', 'Oui, la nuit seulement'], 3]
  ],
  francais: [
    /* — niveau 1 — */
    ['Quel est le pluriel de « cheval » ?', 'chevaux', ['chevals', 'chevales', 'chevaus'], 1],
    ['Complétez : « Je … à Bouaké. »', 'vais', ['va', 'vas', 'allons'], 1],
    ['Quel est le contraire de « rapide » ?', 'lent', ['vite', 'pressé', 'fort'], 1],
    ['Quel est le pluriel de « journal » ?', 'journaux', ['journals', 'journale', 'journales'], 1],
    ['Complétez : « … école de mon quartier est grande. »', 'L’', ['Le', 'La', 'Les'], 1],
    ['Complétez : « Ils … arrivés hier. »', 'sont', ['est', 'ont', 'seront'], 1],
    ['Quel est le féminin de « acteur » ?', 'actrice', ['acteure', 'acteuse', 'acteuresse'], 1],
    ['Quel est le contraire de « propre » ?', 'sale', ['net', 'lavé', 'rangé'], 1],
    /* — niveau 2 — */
    ['Quel mot est un synonyme de « travailler » ?', 'œuvrer', ['chômer', 'dormir', 'jouer'], 2],
    ['Complétez : « Nous … prêts. »', 'sommes', ['sont', 'êtes', 'est'], 2],
    ['Quel est le pluriel de « travail » ?', 'travaux', ['travails', 'travaus', 'travailes'], 2],
    ['Complétez : « Elle … au marché chaque samedi. »', 'va', ['vas', 'aller', 'vont'], 2],
    ['Quel mot est un adverbe ?', 'rapidement', ['rapide', 'rapidité', 'rapider'], 2],
    ['Complétez : « Ils ont … leurs devoirs. »', 'fini', ['finis', 'finies', 'finir'], 2],
    ['Quel est le pluriel de « un chou » ?', 'des choux', ['des chous', 'des choues', 'des chouxs'], 2],
    ['Quel mot signifie « très grand » ?', 'immense', ['minuscule', 'étroit', 'court'], 2],
    /* — niveau 3 — */
    ['Quel est le participe passé du verbe « prendre » ?', 'pris', ['prendu', 'prenu', 'prendé'], 3],
    ['Quelle phrase est correcte ?', 'Je me suis lavé les mains.', ['Je me suis lavé les main.', 'Je m’ai lavé les mains.', 'Je suis lavé mes mains.'], 3],
    ['Les mots « cour » et « cours » sont… ?', 'des homophones', ['des synonymes', 'des antonymes', 'des contraires'], 3],
    ['Quel mot est un synonyme de « difficile » ?', 'ardue', ['facile', 'simple', 'aisée'], 3],
    ['Complétez : « Bien qu’il … fatigué, il continue à travailler. »', 'soit', ['est', 'était', 'sera'], 3],
    ['Quel est le contraire de « souvent » ?', 'rarement', ['toujours', 'chaque jour', 'le matin'], 3],
    ['Comment appelle-t-on une personne qui écrit des livres ?', 'un écrivain', ['un libraire', 'un lecteur', 'un éditeur'], 3],
    ['Combien de « s » compte le mot « poisson » ?', 'deux', ['un', 'trois', 'aucun'], 3]
  ],
  sciences: [
    /* — niveau 1 — */
    ['Combien de pattes a une araignée ?', '8', ['6', '10', '4'], 1],
    ['Quelle partie du corps pompe le sang ?', 'Le cœur', ['Le foie', 'Le poumon', 'L’estomac'], 1],
    ['Combien de pattes a un chien ?', '4', ['2', '6', '8'], 1],
    ['À quelle température l’eau gèle-t-elle ?', '0 °C', ['10 °C', '100 °C', '−10 °C'], 1],
    ['À quelle température l’eau bout-elle (au niveau de la mer) ?', '100 °C', ['50 °C', '80 °C', '200 °C'], 1],
    ['Quel animal respire avec des branchies ?', 'Le poisson', ['Le dauphin', 'La baleine', 'Le crocodile'], 1],
    ['De quoi une plante a-t-elle besoin pour grandir ?', 'De lumière et d’eau', ['Seulement de sable', 'Seulement de vent', 'De rien du tout'], 1],
    ['Combien de doigts avons-nous sur les deux mains ?', '10', ['8', '12', '14'], 1],
    /* — niveau 2 — */
    ['Quel est le plus grand océan du monde ?', 'Le Pacifique', ['L’Atlantique', 'L’océan Indien', 'L’Arctique'], 2],
    ['Quel gaz les plantes absorbent-elles pour se nourrir ?', 'Le dioxyde de carbone', ['L’azote', 'L’hélium', 'Le méthane'], 2],
    ['Quel gaz est indispensable à notre respiration ?', 'L’oxygène', ['L’azote', 'Le méthane', 'L’hydrogène'], 2],
    ['En combien de temps la Terre fait-elle le tour du Soleil ?', 'Environ 365 jours', ['24 heures', '30 jours', '10 ans'], 2],
    ['Quel organe filtre le sang ?', 'Les reins', ['Le cœur', 'Les poumons', 'L’estomac'], 2],
    ['Où se passe la photosynthèse chez une plante ?', 'Dans les feuilles', ['Dans les racines', 'Dans les fleurs', 'Dans les fruits'], 2],
    ['Combien d’os compte environ le corps d’un adulte ?', 'Environ 206', ['Environ 33', 'Environ 500', 'Environ 1000'], 2],
    ['Pourquoi l’eau de mer est-elle salée ?', 'À cause du sel dissous', ['À cause du sable', 'À cause des poissons', 'À cause de l’air'], 2],
    /* — niveau 3 — */
    ['Quelle planète est la plus proche du Soleil ?', 'Mercure', ['Vénus', 'La Terre', 'Mars'], 3],
    ['Quelle est l’unité de la force ?', 'Le newton', ['Le volt', 'Le litre', 'Le degré'], 3],
    ['Quelle est la vitesse de la lumière (arrondie) ?', 'Environ 300 000 km/s', ['Environ 300 km/s', 'Environ 3 000 km/s', 'Environ 30 km/s'], 3],
    ['Par où le sang quitte-t-il le cœur pour aller vers le corps ?', 'Par les artères', ['Par les os', 'Par les nerfs', 'Par les poumons'], 3],
    ['Quel est le plus grand organe du corps humain ?', 'La peau', ['Le foie', 'Le cerveau', 'Les intestins'], 3],
    ['Où se trouve l’ADN dans une cellule ?', 'Dans le noyau', ['Dans l’estomac', 'Dans le plasma seul', 'Dans les os'], 3],
    ['Qu’est-ce qui provoque principalement l’effet de serre ?', 'Certains gaz comme le dioxyde de carbone', ['La pluie', 'Le vent', 'Les arbres'], 3],
    ['Que mesure une année-lumière ?', 'Une distance', ['Un temps', 'Une masse', 'Une température'], 3]
  ]
};

/* une question par « recette », du plus facile au plus difficile */
/* une question tirée dans la banque du thème (calcul généré à la volée) */
function jeuQuestionIntegree(theme, niveau, dejaVues) {
  const N = niveau || 1;
  const vu = dejaVues || {};
  if (theme === 'maths') {
    /* le calcul est généré : on retire tant que la question est déjà tombée */
    for (let essai = 0; essai < 40; essai++) {
      let q;
      if (N === 1) { const a = 2 + jeuAleatoire(9), b = 2 + jeuAleatoire(9); q = jeuQCM(a + ' + ' + b + ' = ?', String(a + b), [String(a + b + 1), String(a + b - 2), String(a + b + 10)], 1); }
      else if (N === 2) { const a = 3 + jeuAleatoire(9), b = 3 + jeuAleatoire(9); q = jeuQCM(a + ' × ' + b + ' = ?', String(a * b), [String(a * b + a), String(a * b - b), String(a * b + 10)], 2); }
      else { const a = 12 + jeuAleatoire(18), b = 4 + jeuAleatoire(6), r = Math.floor(a / b), reste = a % b;
             q = jeuQCM(a + ' ÷ ' + b + ' = ? (arrondi entier)', r + ' reste ' + reste, [String(r + 1), String(r - 1), String(r + 2)], 3); }
      if (!vu[q.q]) return q;
    }
    return jeuQCM('Combien font 100 − 25 ?', '75', ['70', '85', '65'], 1);
  }
  const liste = JEU_BANQUE[theme] || JEU_BANQUE.francais;
  let dispo = liste.filter(x => (x[3] || 1) === N && !vu[x[0]]);
  if (!dispo.length) dispo = liste.filter(x => !vu[x[0]]);       /* ce niveau est épuisé : on élargit */
  if (!dispo.length) dispo = liste;                              /* thème entièrement épuisé : on réutilise */
  const c = dispo[jeuAleatoire(dispo.length)];
  return jeuQCM(c[0], c[1], c[2], c[3]);
}
function jeuGenererIntegre(opt) {
  const nb = Math.max(3, Math.min(30, parseInt(opt.nb, 10) || 8));
  const theme = JEU_THEMES[opt.theme] ? opt.theme : 'francais';
  const progression = opt.progression !== false;
  const base = ['none', 'all', 'done'].includes(opt.type) ? 'all' : String(opt.type || 'qcm');
  const out = [], dejaVues = {};
  for (let i = 0; i < nb; i++) {
    let niv = progression ? (1 + Math.round((i / Math.max(1, nb - 1)) * 2)) : (parseInt(opt.niveau, 10) || 1);
    niv = Math.max(1, Math.min(3, niv));
    /* 🚫 pas de question en double : on retire tant qu'on tombe sur une question déjà posée */
    const q0 = jeuQuestionIntegree(theme, niv, dejaVues);
    let q = q0;
    dejaVues[q.q] = 1;
    if (base === 'vraifaux') q = { q: q.q + ' — Vrai ou faux ?', choix: [q.choix[q.bonne], 'Faux'], bonne: 0, niveau: niv };
    out.push({ q: q.q, choix: q.choix, bonne: q.bonne, niveau: q.niveau, source: 'générateur intégré' });
  }
  return out;
}
/* 🤖 si une clé IA est configurée, on l'utilise ; sinon on garde le générateur intégré */
async function jeuGenererIA(opt) {
  const cle = process.env.KLEAN_IA_KEY || process.env.OPENAI_API_KEY || '';
  if (!cle) return { questions: jeuGenererIntegre(opt), mode: 'integre' };
  try {
    const url = process.env.KLEAN_IA_URL || 'https://api.openai.com/v1/chat/completions';
    const modele = process.env.KLEAN_IA_MODEL || 'gpt-4o-mini';
    const prompt = 'Génère ' + (parseInt(opt.nb, 10) || 8) + ' questions de quiz en ' + (opt.langue || 'français')
      + ' sur le thème « ' + (JEU_THEMES[opt.theme] || opt.theme || 'culture générale') + ' »'
      + ', difficulté ' + (JEU_NIVEAUX[opt.niveau] || 'moyen') + (opt.progression !== false ? ' et croissante du plus facile au plus difficile' : '')
      + '. Réponds UNIQUEMENT par un tableau JSON d’objets {"q": "...", "choix": ["...","...","...","..."], "bonne": 0, "niveau": 1|2|3}.';
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cle },
      body: JSON.stringify({ model: modele, temperature: 0.7, messages: [{ role: 'user', content: prompt }] }) });
    if (!r.ok) throw new Error('IA ' + r.status);
    const d = await r.json();
    const txt = (((d.choices || [])[0] || {}).message || {}).content || '';
    const m = txt.match(/\[[\s\S]*\]/); if (!m) throw new Error('réponse illisible');
    const arr = JSON.parse(m[0]);
    const qs = arr.filter(x => x && x.q && Array.isArray(x.choix) && x.choix.length >= 2)
      .map(x => ({ q: String(x.q).slice(0, 200), choix: x.choix.slice(0, 4).map(c => String(c).slice(0, 80)), bonne: Math.max(0, Math.min(x.choix.length - 1, parseInt(x.bonne, 10) || 0)), niveau: Math.max(1, Math.min(3, parseInt(x.niveau, 10) || 2)), source: 'IA' }));
    if (qs.length < 3) throw new Error('trop peu de questions');
    return { questions: qs, mode: 'ia' };
  } catch (e) {
    console.log('  ⚠️  Génération IA indisponible (' + e.message + ') → générateur intégré');
    return { questions: jeuGenererIntegre(opt), mode: 'integre', erreur: String(e.message || e) };
  }
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
    const jtV = agentJetonOk(req, ag, { jeton: url.searchParams.get('jeton') }, false);   // 🔒 veille de SON téléphone
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
    /* 🛠️ PLUSIEURS métiers à la fois (jamais un seul) */
    if (Array.isArray(b.services)) {
      const liste = b.services.map(x => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 30);
      const garde = liste.filter(id => svcCat(id) || SVC_NOUVEAUX[id] || (db.catalog || []).some(s => s.id === id));
      if (garde.length) ag.services = garde;      /* on ne garde que des métiers qui existent vraiment */
    }
    /* ✅ PLUSIEURS tâches maîtrisées (elles viennent du catalogue national) */
    if (Array.isArray(b.taches)) ag.taches = b.taches.map(x => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 400);
    ensureNumPro(ag);
    saveDb();
    return sendJson(res, 200, {
      ok: true, villeService: ag.villeService || ag.ville || '', numPro: ag.numPro,
      zoneKm: zoneOfAgent(ag).km, privacy: privacyOf(ag), telPro: ag.telPro || '', pause: !!ag.pause,
      services: ag.services || [], taches: ag.taches || [], habilitations: ag.habilitations || [],
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
  /* 🗣️ « De quoi avez-vous besoin ? » — le SERVEUR dit ce qu'il a compris AVANT de chercher.
     Aucun professionnel n'est mobilisé : c'est un simple contrôle, le client peut corriger. */
  if (p === '/api/comprendre' && req.method === 'GET') {
    const cli = findClientByToken(req);
    const ip = req.socket.remoteAddress || '?';
    const cle = (cli && cli.id) || ip;
    /* le plafond reste (protection anti-abus) mais large : cette route est légère et appelée
       pendant que le client écrit sa phrase, elle ne doit jamais le bloquer. */
    if (!recherchePlafond('c:' + cle, (matchCfg().maxRecherchesMin || 20) * 30))
      return sendJson(res, 429, { error: 'Doucement 🙂 réessayez dans un instant', code: 'plafond' });
    const q = String(url.searchParams.get('q') || '').slice(0, 160);
    const c = comprendreDemande(q);
    if (c.type === 'kp') return sendJson(res, 200, { ok: true, mode: 'kp', code: c.code, compris: c.compris, comprisLong: '🎫 ' + c.compris });
    if (c.type === 'vide') return sendJson(res, 200, { ok: true, mode: 'vide', compris: '', aide: LANG_AIDE });
    if (c.type === 'reglemente') return sendJson(res, 200, { ok: true, mode: 'reglemente', compris: c.compris,
      comprisLong: (c.reglemente.ic || '🩺') + ' ' + c.compris, reglemente: c.reglemente, aide: c.reglemente.exige, tache: '', corriges: {} });
    if (c.type === 'inconnu')
      return sendJson(res, 200, { ok: true, mode: 'inconnu', compris: '', corriges: c.corriges || {}, urgence: !!c.urgence, aide: LANG_AIDE, suggestions: [] });
    if (url.searchParams.get('debug') === '1') {
      const cc = langComprendre(q);
      return sendJson(res, 200, { ok: true, debug: { texte: cc.texte, corriges: cc.corriges, hits: cc.hits, classement: langClasser(cc).slice(0, 4), urgence: cc.urgence } });
    }
    return sendJson(res, 200, {
      ok: true, mode: 'service', principal: c.principal, service: c.compris, compris: c.compris,
      comprisLong: c.comprisLong, tache: c.tache, categorie: c.categorie, urgence: !!c.urgence,
      /* 📚 la chaîne du catalogue national (catégorie → service → sous-service → tâche) :
         c'est elle qui permet à l'app d'afficher la tâche précise au client */
      chaine: c.chaine || null, reglemente: c.reglemente || null,
      corriges: c.corriges, alternatives: c.alternatives || [], suggestions: c.suggestions || []
    });
  }
  /* 📷 RECHERCHE PAR PHOTO (lot 102) — le client montre, KLEAN propose une catégorie,
     le client CONFIRME ou MODIFIE. On ne devine jamais à sa place.
     ⚠️ HONNÊTETÉ : la lecture automatique de l'image (IA de vision) n'est pas branchée.
     Tant qu'aucun service d'analyse d'image n'est configuré, la proposition vient des MOTS
     du client ; sinon on lui présente les métiers fréquents à confirmer. La réponse le dit. */
  if (p === '/api/comprendre/photo' && req.method === 'POST') {
    const cli = findClientByToken(req);
    const ip = req.socket.remoteAddress || '?';
    const cle = (cli && cli.id) || ip;
    if (!recherchePlafond('ph:' + cle, (matchCfg().maxRecherchesMin || 20) * 6))
      return sendJson(res, 429, { error: 'Doucement 🙂 réessayez dans un instant', code: 'plafond' });
    const b = await readBody(req);
    const img = typeof b.image === 'string' ? b.image : '';
    if (!/^data:image\/(png|jpeg|jpg|webp);base64,/.test(img))
      return sendJson(res, 400, { error: 'Photo non reconnue — utilisez une photo JPEG, PNG ou WEBP' });
    if (img.length > 1.2e6)
      return sendJson(res, 413, { error: 'Photo trop lourde — reprenez-la (elle est réduite automatiquement)' });
    const texte = String(b.texte || '').slice(0, 160);
    const c = texte ? comprendreDemande(texte) : { type: 'vide' };
    const frequents = ['maison', 'plomberie', 'electricite', 'clim', 'electro', 'serrurerie', 'menuiserie', 'jardinage']
      .map(id => svcCat(id)).filter(Boolean);
    const candidats = frequents.map(s2 => ({ id: s2.id, nom: s2.nom, ic: s2.ic }));
    const iaDispo = false;   /* ← true le jour où un service d'analyse d'image est branché */
    let propose = null;
    if (c.type === 'service' && c.principal && svcCat(c.principal)) {
      const s2 = svcCat(c.principal);
      propose = { id: s2.id, nom: s2.nom, ic: s2.ic, tache: c.tache || '' };
    }
    auditLog('photo_comprendre', { par: cli ? cli.nom : 'visiteur', texte, propose: propose ? propose.id : '', ia: iaDispo });
    return sendJson(res, 200, {
      ok: true, iaDispo, propose, candidats, tache: (propose && propose.tache) || '',
      source: propose ? 'mots' : 'liste',
      message: !iaDispo
        ? (propose
          ? 'Nous avons lu ce que vous avez écrit à côté de la photo. Confirmez la catégorie, ou changez-la — c’est vous qui décidez.'
          : 'La lecture automatique des photos n’est pas encore activée. Choisissez la catégorie qui ressemble le plus (ou écrivez quelques mots), et nous cherchons les professionnels.')
        : 'Nous avons regardé votre photo : voici ce que nous comprenons.'
    });
  }

  if (p === '/api/recherche' && req.method === 'GET') {
    const cfg = matchCfg();
    const cli = findClientByToken(req);
    const ip = req.socket.remoteAddress || '?';
    const cle = (cli && cli.id) || ip;
    if (!recherchePlafond('r:' + cle, cfg.maxRecherchesMin))
      return sendJson(res, 429, { error: 'Trop de recherches en une minute — patientez un instant', code: 'plafond' });
    const service = String(url.searchParams.get('service') || '').slice(0, 40);
    const q = String(url.searchParams.get('q') || '').slice(0, 120);
    /* 📋 plusieurs tâches demandées d'un coup — chacune doit être maîtrisée par le pro choisi */
    const taches = String(url.searchParams.get('taches') || '').split('|').map(x => x.trim()).filter(Boolean).slice(0, 8).map(x => x.slice(0, 80));
    const reglemente = reglementePour(service, taches, q);
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
        corriges: comp.corriges || {}, urgence: !!comp.urgence,
        suggestions: (comp.suggestions || []).length ? comp.suggestions : ['maison', 'clim', 'plomberie', 'cours'],
        aide: comp.aide || 'Décrivez le problème avec vos mots (ex. « il y a de l’eau qui sort sous mon évier ») : KLEAN trouve le métier. Vous pouvez aussi ajouter une photo ou parler au micro.' });
    }
    const resu = recherchePro(Object.assign({}, geo, {
      service: service || '', services: (comp.ids && comp.ids.length) ? comp.ids : undefined,
      inclureHorsLigne: horsLigne, limit: lim, zoneElargie, q,
      /* 🕒 « Quand ? = maintenant » (choisi par le client dans l'app) compte comme URGENCE,
         même s'il n'a pas écrit le mot « urgent » : c'est sa priorité, pas un mot magique. */
      urgence: !!(comp.urgence || url.searchParams.get('urgent') === '1'), tache: comp.tache || ''
    }));
    resu.mode = 'service';
    resu.compris = comp.compris || '';
    /* 🗣️ ce que le client voit : « Nous avons compris que vous cherchez … » + ce qui a été corrigé */
    resu.comprisLong = comp.comprisLong || comp.compris || '';
    resu.tache = comp.tache || '';
    resu.categorie = comp.categorie || '';
    resu.corriges = comp.corriges || {};
    resu.urgence = !!(comp.urgence || url.searchParams.get('urgent') === '1');
    resu.alternatives = comp.alternatives || [];
    resu.q = q;
    resu.posSource = posSource;
    resu.lieuTxt = lieuTxtFinal;
    resu.lieuOk = !(lieuMode === 'autre' && !(prest && prest.ok));
    resu.lieu = prest && prest.ok ? { ville: prest.ville, quartier: prest.quartier, precis: !!prest.precis, texte: prest.texte } : null;
    resu.zoneElargie = zoneElargie;
    resu.suggestions = comp.suggestions || [];
      resu.taches = taches;
      resu.reglemente = reglemente ? { id: reglemente, ...(reglementeIdx(reglemente) || {}) } : null;
    resu.quartier = resu.quartier || quartierR;
    resu.client = cli ? { id: cli.id, nom: cli.nom } : null;
    return sendJson(res, 200, resu);
  }

  /* ═══════════════ 💰 MOTEUR DE TARIFICATION (client) ═══════════════ */
  /* tout est public côté prix : le client a le droit de voir les prix et leur détail */
  if (p === '/api/tarif' && req.method === 'GET') {
    const t = tarifPublicList();
    return sendJson(res, 200, Object.assign({ ok: true, nb: t.services.length }, t));
  }
  /* ❓ les questions à poser pour un service (aucune question inutile) */
  /* 🗺️ ZONES & DÉPLACEMENT — lecture publique (le client a le droit de savoir sur quoi repose son prix) */
  /* 📜 CONDITIONS — lecture publique (tout le monde a le droit de lire ce qu'il signe) */
  if (p === '/api/conditions' && req.method === 'GET') {
    try { return sendJson(res, 200, conditionsPub(url.searchParams.get('role'))); }
    catch (e) { return sendJson(res, 500, { error: 'Conditions indisponibles', detail: e.message }); }
  }
  /* 🔎 « ai-je accepté la version en vigueur ? » — client (jeton client) ou pro (jeton pro) */
  if (p === '/api/conditions/etat' && req.method === 'GET') {
    const role = conditionsRole(url.searchParams.get('role'));
    let tel = String(url.searchParams.get('tel') || '');
    try {
      if (role === 'client') {
        const cl = findClientByToken(req);            /* aucune confiance au téléphone annoncé */
        if (cl) tel = cl.tel;
      } else {
        const jt = (req.headers && req.headers['x-agent-token']) || '';
        const ag = jt ? db.agents.find(a => a.jeton && a.jeton === jt) : null;
        if (ag) tel = ag.tel;
      }
    } catch (e) { }
    return sendJson(res, 200, conditionsEtat(role, tel));
  }
  /* ✍️ ACCEPTER — la preuve est enregistrée (qui, version, date, heure, appareil, IP) */
  if (p === '/api/conditions/accepter' && req.method === 'POST') {
    const b = await readBody(req);
    conditionsEnsure();
    const role = conditionsRole(b.role);
    if (Number(b.version) !== Number(db.conditions.version))
      return sendJson(res, 409, { error: 'Le texte a changé : relisez la version ' + db.conditions.version + ' avant d’accepter',
        conseil: 'rechargez les conditions à l’écran, puis acceptez la version en vigueur.', version: db.conditions.version });
    let tel = '', qui = '';
    if (role === 'client') { const cl = findClientByToken(req); if (cl) { tel = cl.tel; qui = cl.nom; } }
    else { const jt = (req.headers && req.headers['x-agent-token']) || ''; const ag = jt ? db.agents.find(a => a.jeton && a.jeton === jt) : null; if (ag) { tel = ag.tel; qui = ag.nom; } }
    if (!tel) { tel = String(b.tel || '').replace(/\D/g, ''); qui = String(b.nom || qui || ''); }
    if (tel.length < 8) return sendJson(res, 400, { error: 'Connectez-vous (ou indiquez votre numéro) pour que l’acceptation soit nominative' });
    const a = conditionsAccepter(role, qui || b.nom || '', tel, { ua: req.headers['user-agent'], ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress, source: b.source || 'application' });
    if (role === 'client') { const cl = db.clients.find(x => x.tel === tel); if (cl) { cl.conditionsVersion = a.version; cl.conditionsAt = a.at; } }
    else { const ag = db.agents.find(x => x.tel === tel); if (ag) { ag.conditionsVersion = a.version; ag.conditionsAt = a.at; } }
    saveDb();
    auditLog('conditions_acceptees', { role, qui: qui || tel, version: a.version, source: a.source });
    console.log('✍️  Conditions v' + a.version + ' acceptées par ' + (qui || tel) + ' (' + role + ')');
    return sendJson(res, 200, { ok: true, acceptation: { role, version: a.version, at: a.at, qui: a.qui } });
  }

  if (p === '/api/tarif/zones' && req.method === 'GET') {
    tarifEnsure();
    const T = db.tarif, src = T.zonesSrc || {}, dep = T.deplacement || {};
    const ref = (T.refs || []).find(x => x && x.id === 'deplacement') || null;
    const zones = Object.keys(T.zones).map(k => ({ id: k, nom: T.zones[k].nom || k,
      k: Number(T.zones[k].k) || 1, km: typeof T.zones[k].km === 'number' ? T.zones[k].km : null }))
      .sort((a, b) => (a.km || 0) - (b.km || 0));
    return sendJson(res, 200, { ok: true,
      zones, zoneProposee: Object.assign({}, TARIF_ZONES_KM_DEF),
      source: { actif: !!src.actif, source: src.source || '', date: src.sourceDate || '', note: src.note || '' },
      deplacement: { mode: dep.mode || 'inclus', km: dep.km, forfait: dep.forfait, allerRetour: !!dep.allerRetour,
        tranches: (dep.tranches || []).map(t => ({ jusqua: t.jusqua, prix: t.prix })),
        source: dep.source || '', date: dep.sourceDate || '', note: dep.note || '' },
      reference: ref ? { min: ref.min, max: ref.max, source: ref.source, date: ref.date } : null,
      regle: 'Le déplacement est « inclus » (prix d’aujourd’hui) tant que le PDG ne l’active pas. '
           + 'Activer un mode payant exige une SOURCE et une DATE : une référence de marché sans source n’est pas une référence.' });
  }

  if (p === '/api/tarif/questions' && req.method === 'GET') {
    const svc = tarifSvc(url.searchParams.get('service'));
    if (!svc) return sendJson(res, 404, { error: 'Service inconnu du moteur de tarification' });
    const qs = tarifQuestionsDe(svc).map(tarifQuestionPublique);
    return sendJson(res, 200, { ok: true, service: tarifSvcPublic(svc), questions: qs, nb: qs.length,
      regle: 'Aucune question n’est posée si elle n’est pas utile à ce service. « Je ne sais pas » est toujours accepté : le prix devient alors une estimation, jamais un prix définitif inventé. Vos réponses remplissent les mêmes coefficients que le calcul officiel (aucun second système de prix).' });
  }

  /* 🧾 le calcul détaillé : une ligne par élément (le téléphone ne calcule plus rien) */
  if (p === '/api/tarif/devis' && req.method === 'GET') {
    const ip = clientIp(req);
    if (!recherchePlafond('tarif:' + ip, 240))
      return sendJson(res, 429, { error: 'Trop de calculs en une minute — patientez un instant', code: 'plafond' });
    const qp = url.searchParams;
    const o = {
      quantite: qp.get('quantite'), niveau: qp.get('niveau'), etat: qp.get('etat'),
      difficulte: qp.get('difficulte'), urgence: qp.get('urgence'), horaire: qp.get('horaire'),
      acces: qp.get('acces'), materiel: qp.get('materiel'),
      options: String(qp.get('options') || '').split('|').filter(Boolean).slice(0, 30),
      distanceKm: parseFloat(qp.get('distanceKm')), ville: qp.get('ville') || '', quartier: qp.get('quartier') || '',
      promo: qp.get('promo') || '', photos: parseInt(qp.get('photos'), 10) || 0,
      reponses: (() => { const r = {}; String(qp.get('reponses') || '').split('|').filter(Boolean).slice(0, 20)
        .forEach(x => { const i = x.indexOf(':'); if (i > 0) r[x.slice(0, i)] = x.slice(i + 1); }); return r; })()
    };
    const tar = tarifCalculer(qp.get('service'), o);
    return sendJson(res, 200, { ok: true, tarif: tar, version: tarifVersion() });
  }

  /* ═══════════════ 📚 CATALOGUE NATIONAL (client) ═══════════════ */
  if (p === '/api/catalogue' && req.method === 'GET') {
    const arbre = catalogueNational();
    const q = normFr(String(url.searchParams.get('q') || '')).trim();
    const fam = String(url.searchParams.get('fam') || '');
    const svc = String(url.searchParams.get('service') || '');
    let services = arbre.services;
    if (fam) services = services.filter(s => s.famille === fam);
    if (svc) services = services.filter(s => String(s.num) === svc);
    if (q) {
      services = services.map(s => {
        const gardeSous = s.sous.map(ss => {
          /* ⚠️ une tâche est un objet { num, nom } : on cherche sur son NOM (et sur son nom d'origine,
             pour qu'un renommage du PDG ne casse pas les habitudes du client) */
          const taches = ss.taches.filter(t => normFr(t.nom).indexOf(q) >= 0 || normFr(t.base || '').indexOf(q) >= 0);
          const lui = normFr(ss.nom).indexOf(q) >= 0;
          return (lui || taches.length) ? { num: ss.num, nom: ss.nom, metier: ss.metier, taches: lui ? ss.taches : taches } : null;
        }).filter(Boolean);
        const lui = normFr(s.nom).indexOf(q) >= 0;
        return (lui || gardeSous.length) ? { num: s.num, nom: s.nom, ic: s.ic, metier: s.metier, famille: s.famille, sous: lui ? s.sous : gardeSous } : null;
      }).filter(Boolean);
    }
    return sendJson(res, 200, {
      ok: true, q, fam, services,
      familles: arbre.familles, accueil: arbre.familles.filter(f => f.populaire),
      lieux: CAT_LIEUX, tarifs: CAT_TARIFS, dispos: CAT_DISPO, reglementes: CAT_REGLEMENTE,
      nbServices: arbre.nbServices, nbSous: arbre.nbSous, nbTaches: arbre.nbTaches, nbMetiers: arbre.nbMetiers
    });
  }
  /* 🎯 « Voici mon besoin » → la chaîne complète comprise (4 niveaux + métier) */
  if (p === '/api/catalogue/recherche' && req.method === 'GET') {
    const q = String(url.searchParams.get('q') || '').slice(0, 160);
    const c = comprendreDemande(q);
    const arbre = catalogueNational();
    const nat = (c.type === 'service' && c.chaine) ? c.chaine : null;
    /* les tâches voisines, pour aider le client à préciser sans connaître le métier */
    const idx = catNatIndex();
    const mots = motsCles(q);
    const proches = mots.length ? idx.taches.filter(t => t.metier === c.principal && t.mots.some(w => mots.indexOf(w) >= 0)).slice(0, 8)
      .map(t => ({ nom: t.nom, sous: t.sousNom, service: t.serviceNom })) : [];
    return sendJson(res, 200, {
      ok: true, question: q, mode: c.type, principal: c.principal || '', compris: c.compris || '',
      tache: c.tache || '', corriges: c.corriges || {}, urgence: !!c.urgence,
      chaine: nat || null, proches,
      metier: c.principal ? { id: c.principal, nom: c.compris, ic: (svcCat(c.principal) || {}).ic || '🛠️' } : null,
      alternatives: c.alternatives || [], aide: c.aide || '',
      reglemente: c.reglemente || null,
      catalogue: { nbServices: arbre.nbServices, nbSous: arbre.nbSous, nbTaches: arbre.nbTaches, nbMetiers: arbre.nbMetiers }
    });
  }
  /* 🙋 §48/§55 — « je ne trouve pas mon service » : le client décrit, on garde pour le PDG */
  if (p === '/api/catalogue/idee' && req.method === 'POST') {
    const b = await readBody(req);
    const texte = String(b.texte || '').slice(0, 300).trim();
    if (texte.length < 5) return sendJson(res, 400, { error: 'Décrivez votre besoin en quelques mots' });
    const cli = findClientByToken(req);
    const reg = catNatReglages();
    const deja = reg.suggestions.find(x => normFr(x.texte) === normFr(texte));
    if (deja) { deja.n = (deja.n || 1) + 1; deja.dernier = nowISO(); }
    else reg.suggestions.push({ id: uid('ID'), texte, at: nowISO(), par: cli ? (cli.nom || cli.id) : 'visiteur', n: 1, vu: false });
    if (reg.suggestions.length > 500) reg.suggestions = reg.suggestions.slice(-400);
    saveDb();
    emitAdmin('catalogue', '🙋 Nouvelle demande hors catalogue : « ' + texte.slice(0, 60) + ' »');
    /* on répond quand même avec la meilleure piste trouvée — le client n'est jamais laissé sans rien */
    const c = comprendreDemande(texte);
    return sendJson(res, 200, { ok: true, message: 'Merci ! Votre demande est transmise à KLEAN. Nous vous rappelons quelle catégorie s’en rapproche le plus.',
      mode: c.type, principal: c.principal || '', compris: c.compris || '', comprisLong: c.comprisLong || '', tache: c.tache || '', alternatives: c.alternatives || [] });
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

  /* ✅ ce que le pro peut cocher : les tâches de ses métiers, avec le libellé simple du catalogue */
  if (p === '/api/pros/taches' && req.method === 'GET') {
    const ag = db.agents.find(a => a.id === String(url.searchParams.get('agentId') || ''));
    if (!ag) return sendJson(res, 404, { error: 'pro introuvable' });
    const jt = agentJetonOk(req, ag, url.searchParams, false);   /* lecture : jamais de jeton fabriqué ici */
    if (!jt.ok) return sendJson(res, 401, { error: 'Jeton du professionnel requis', code: 'jeton' });
    const arbre = catalogueNational();
    /* 🔗 FUSION : « Grand ménage » voit les tâches de « Nettoyage maison » (même métier) */
    const mes = [...new Set((Array.isArray(ag.services) ? ag.services : []).map(svcCanon).filter(Boolean))];
    const out = [];
    for (const s of arbre.services) {
      for (const ss of s.sous) {
        const metier = ss.metier || s.metier;
        if (mes.length && mes.indexOf(svcCanon(metier)) < 0) continue;
        for (const t of ss.taches) {
          if (out.some(x => x.nom === t.nom)) continue;
          if (ss.reglemente && !agentHabilite(ag, ss.reglemente)) continue;   /* 🩺 réservé aux habilités */
          out.push({ nom: t.nom, service: s.nom, sous: ss.nom, metier, reglemente: ss.reglemente || '' });
        }
      }
    }
    if (!out.length) for (const s of arbre.services) for (const ss of s.sous) for (const t of ss.taches)
      if (!out.some(x => x.nom === t.nom)) out.push({ nom: t.nom, service: s.nom, sous: ss.nom, metier: ss.metier || s.metier, reglemente: ss.reglemente || '' });
    return sendJson(res, 200, {
      ok: true, metiers: (ag.services || []).map(id => ({ id, nom: svcNomP(id), ic: (svcCat(id) || SVC_NOUVEAUX[id] || {}).ic || '🛠️' })),
      habilitations: ag.habilitations || [], taches: out.slice(0, 900), choisies: ag.taches || []
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
    /* 💰 LE PRIX EST CALCULÉ PAR LE SERVEUR (le téléphone ne décide plus du prix).
       · application à jour (b.detail = true) → le serveur IMPOSE son prix détaillé ;
       · ancien appel qui envoie encore « prixTotal » (application déjà installée) → le prix est
         accepté mais MARQUÉ « à vérifier » avec l'écart, pour que le PDG le voie. */
    const tQ = {
      quantite: b.pieces, niveau: b.depth, etat: b.etat, difficulte: b.difficulte,
      urgence: (b.urgence === true || b.urgence === 'immediat' || b.time === 'maintenant') ? 'immediat' : b.urgence,
      horaire: b.horaire, acces: b.acces, materiel: b.materiel, options: b.extras || {},
      photos: Array.isArray(b.photos) ? b.photos.length : (parseInt(b.photos, 10) || 0),
      distanceKm: b.distanceKm, ville: b.ville || b.cityNom || b.city || '', promo: b.promo,
      reponses: (b.reponses && typeof b.reponses === 'object') ? b.reponses : undefined   /* ❓ lot 108 */
    };
    const tar = (b.service === 'custom')
      ? { mode: 'devis', total: 0, min: 0, max: 0, fourchette: [0, 0], lignes: [], manque: ['service'], version: tarifVersion(),
          texte: 'Demande sur mesure : décrivez votre besoin, le professionnel vous répond avec un prix.' }
      : tarifCalculer(b.service, tQ);
    const duMoteur = (b.detail === true || !!b.reponses);
    const prixAnnonce = Math.max(0, Math.round(b.prixTotal || 0));
    const prixFinal = duMoteur ? (tar.mode === 'devis' ? 0 : tar.total) : prixAnnonce;
    const ecartPct = (tar.total > 0 && prixAnnonce > 0) ? Math.round(((prixAnnonce - tar.total) / tar.total) * 1000) / 10 : 0;
    const ecartAnormal = Math.abs(ecartPct) > (Number((db.tarif.seuils || {}).ecartAnormal || 0.4) * 100);
    const m = {
      id: uid('KN'), service: b.service, pieces: b.pieces || 2, depth: b.depth || 'normal',
      extras: b.extras || {}, prixTotal: prixFinal, promo: b.promo || '',
      date: b.date || '', time: b.time || '', quartier: b.quartier || '', adresse: b.adresse || '',
      paiement: b.paiement || 'cash',
      desc: (typeof b.desc === 'string' ? b.desc : '').slice(0, 280),
      photos: Array.isArray(b.photos) ? b.photos.filter(x => typeof x === 'string' && x.length < 600000).slice(0, 3) : [],
      budget: Math.max(0, parseInt(b.budget) || 0),
      quote: !!(b.quote || b.service === 'custom' || tar.mode === 'devis'),
      /* 📚 la chaîne comprise (catégorie → service → sous-service → tâche) et les tâches multiples */
      taches: Array.isArray(b.taches) ? b.taches.filter(x => typeof x === 'string' && x).slice(0, 8).map(x => x.slice(0, 80)) : [],
      chaine: (b.chaine && typeof b.chaine === 'object') ? { categorie: String(b.chaine.categorie || '').slice(0, 60),
        service: String(b.chaine.service || '').slice(0, 80), sous: String(b.chaine.sous || '').slice(0, 80), tache: String(b.chaine.tache || '').slice(0, 80) } : null,
      reglemente: reglementePour(b.service, b.taches, b.desc || ''),
      lat: typeof b.lat === 'number' ? b.lat : null,
      lng: typeof b.lng === 'number' ? b.lng : null,
      ville: String(b.ville || b.cityNom || b.city || '').slice(0, 60),
      client: { nom: b.nom, tel: b.tel || '', deviceId: b.deviceId || '' },
      dist: null,                       /* 📍 jamais inventée : remplie avec la distance RÉELLE dès qu'un pro accepte */
      status: 'pending', agentId: null, createdAt: nowISO(), finishedAt: null, note: 0,
      matchScope: 'all'
    };
    /* 🧾 la trace du calcul : version, mode, lignes, fourchette, ce qui manquait, qui a fixé le prix */
    m.tarif = {
      version: tar.version, mode: tar.mode, lignes: (tar.lignes || []).slice(0, 20), total: tar.total || 0,
      fourchette: tar.fourchette || [tar.min || 0, tar.max || 0], manque: tar.manque || [],
      unite: tar.unite || '', ref: tar.ref || 0, quantite: tar.quantite || 1,
      source: duMoteur ? 'moteur' : 'declare', ecartPct: ecartPct, aVerifier: duMoteur ? false : ecartAnormal,
      texte: tar.texte || '',
      reponses: tar.reponses || [], precisions: tar.precisions || [], manque: tar.manque || [],
      questions: duMoteur ? (tar.questions || []).length : 0
    };
    if (m.tarif.aVerifier) try { emitAdmin('tarif', '🏷️ Prix à vérifier sur ' + m.id + ' : annoncé ' + prixFinal.toLocaleString('fr-FR') + ' F, calculé ' + (tar.total || 0).toLocaleString('fr-FR') + ' F (' + ecartPct + ' %)'); } catch (e) {}

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
    /* 🤝 lot 118 : un professionnel précis est visé → c'est LE PROFESSIONNEL 1 de la mise en relation */
    if (m.cible) {
      const agC1 = db.agents.find(a => a.id === m.cible);
      if (agC1) { try { relOuvrir(m, agC1, 'cible', true); } catch (e) { } }
    }
    return sendJson(res, 201, { id: m.id, dist: m.dist });
  }

  /* ═══════════════════════════════════════════════════════════════════════════════════════════
     💰 LOT 109 — DEVIS STRUCTURÉ, PRIX VERROUILLÉ, MODIFICATION MOTIVÉE
     ───────────────────────────────────────────────────────────────────────────────────────────
     Un seul document fait foi : le devis de la mission (`m.devis`). Il est structuré
     (main-d'œuvre, matériel, déplacement, autres frais, remise, délai, durée, conditions),
     et son total est TOUJOURS recalculé ici, à partir des lignes — jamais fourni par l'appareil.

     · Le client ACCEPTE → le prix est VERROUILLÉ (`m.prixVerrouille`) : c'est lui qui fait foi.
     · Le client REFUSE → le devis est refusé ; s'il y avait un prix déjà accepté, il reste en vigueur.
     · Après acceptation, PERSONNE ne peut changer le prix en silence : ni le PDG, ni le
       gestionnaire, ni le professionnel. Toute modification doit porter un MOTIF, crée une
       NOUVELLE VERSION (v2, v3…) proposée au client, et le prix reste celui qu'il a accepté
       tant qu'il n'a pas accepté la nouvelle version.
     · L'imprévu du professionnel passe par le même chemin (motif obligatoire).
     · Tout est journalisé : qui, quoi, avant, après, quand, pourquoi (db.devisJournal).
     · Rien n'est supprimé : chaque version et chaque verrou restent dans l'historique.
     ═══════════════════════════════════════════════════════════════════════════════════════════ */
  const DEVIS_TYPES = { main_oeuvre: 'Main-d’œuvre', materiel: 'Matériel & produits', deplacement: 'Déplacement', autre: 'Autres frais' };

  function devisJournaliser(m, action, avant, apres, motif, par) {
    db.devisJournal = db.devisJournal || [];
    db.devisJournal.push({ at: nowISO(), par: par || 'inconnu', missionId: m.id, action: action,
      version: (m.devis && m.devis.version) || 0, avant: avant || null, apres: apres || null, motif: motif || '' });
    if (db.devisJournal.length > 3000) db.devisJournal = db.devisJournal.slice(-3000);
  }
  /* les lignes sont nettoyées puis le total est calculé ICI (jamais repris du téléphone) */
  function devisLignesNettoyer(brut) {
    const out = [];
    (Array.isArray(brut) ? brut : []).slice(0, 40).forEach(l => {
      if (!l || typeof l !== 'object') return;
      const type = DEVIS_TYPES[l.type] ? l.type : 'autre';
      const libelle = String(l.libelle || DEVIS_TYPES[type]).trim().slice(0, 140) || DEVIS_TYPES[type];
      const qte = Math.max(0, Math.min(9999, Number(l.qte) || 1));
      const pu = Math.max(0, Math.min(50000000, Math.round(Number(l.pu) || Number(l.montant) || 0)));
      const montant = Math.round(qte * pu);
      if (montant > 0) out.push({ type: type, typeNom: DEVIS_TYPES[type], libelle: libelle, qte: qte, pu: pu, montant: montant });
    });
    return out;
  }
  function devisTotaux(lignes, remiseBrute, m) {
    const brut = lignes.reduce((a, l) => a + l.montant, 0);
    const parType = { main_oeuvre: 0, materiel: 0, deplacement: 0, autre: 0 };
    lignes.forEach(l => { parType[l.type] += l.montant; });
    let remise = Math.max(0, Math.round(Number(remiseBrute) || 0));
    if (remise > Math.round(brut * 0.5)) remise = Math.round(brut * 0.5);      /* on ne « remise » pas plus de la moitié */
    const total = Math.max(0, brut - remise);
    /* 📊 comparaison objective avec l'estimation du moteur : un prix inhabituel est SIGNALÉ, jamais supprimé */
    let estimation = null, inhabituel = false;
    try {
      if (typeof tarifCalculer === 'function') {
        const c = m || {};
        const t = tarifCalculer(c.service, { quantite: c.pieces, niveau: c.depth, extras: c.extras,
          urgence: c.urgence, photos: Array.isArray(c.photos) ? c.photos.length : 0, promo: c.promo, ville: c.ville });
        if (t && t.mode !== 'devis' && t.total > 0) {
          estimation = { total: t.total, mode: t.mode, version: t.version };
          inhabituel = (total > t.total * 1.5 || total < t.total * 0.5);
        }
      }
    } catch (e) {}
    /* 🏷️ lot 112 : le montant est aussi comparé à la BASE MARCHÉ du service (source + date).
       Un prix hors fourchette est SIGNALÉ (écart en %), JAMAIS refusé ni supprimé automatiquement. */
    let marche = null;
    try { if (typeof marcheCompare === 'function') marche = marcheCompare((m || {}).service, total); } catch (e) { }
    return { brut: brut, remise: remise, total: total, parType: parType, estimation: estimation, inhabituel: inhabituel, marche: marche,
      inhabituelMarche: !!(marche && marche.trouve && !marche.dans) };   /* hors fourchette sourcée = signalé (le montant reste intact) */
  }
  function devisNettoyerChamp(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 300); }
  /* création d'une version (v1 ou modification motivée) */
  function devisCreer(m, b, par, estModification) {
    const lignes = devisLignesNettoyer(b.lignes);
    if (!lignes.length) return { error: 'Un devis doit contenir au moins une ligne (main-d’œuvre, matériel, déplacement…)' };
    const t = devisTotaux(lignes, b.remise, m);
    if (t.total < 500) return { error: 'Le total du devis est trop faible (minimum 500 F)' };
    const motif = devisNettoyerChamp(b.motif, 400);
    const avaitDevis = !!(m.devis && m.devis.version);
    if (estModification && !motif) return { error: 'Une modification doit être motivée : dites au client POURQUOI (panne imprévue, matériel en plus, accès difficile…)' };
    if (!estModification && avaitDevis && !motif) return { error: 'Le devis existe déjà : envoyez une modification motivée (le client doit savoir pourquoi)' };
    const version = ((m.devis && m.devis.version) || 0) + 1;
    if (m.devis) { (m.devisHisto = m.devisHisto || []).push(m.devis); if (m.devisHisto.length > 30) m.devisHisto = m.devisHisto.slice(-30); }
    const avant = m.devis ? { version: m.devis.version, total: m.devis.total, statut: m.devis.statut } : null;
    m.devis = {
      version: version, statut: 'envoye',
      lignes: lignes, parType: t.parType, totalAvantRemise: t.brut, remise: t.remise, total: t.total,
      delai: devisNettoyerChamp(b.delai, 60), duree: devisNettoyerChamp(b.duree, 60),
      conditions: devisNettoyerChamp(b.conditions, 600),
      motif: motif, estModification: !!estModification,
      par: par, at: nowISO(),
      estimation: t.estimation, inhabituel: t.inhabituel,
      marche: t.marche || null, inhabituelMarche: !!t.inhabituelMarche,
      remplaceVersion: estModification ? version - 1 : null
    };
    if (m.prixVerrouille) m.devis.enAttenteSurPrixVerrouille = { montant: m.prixVerrouille.montant, version: m.prixVerrouille.version };
    devisJournaliser(m, estModification ? 'modification_proposee' : 'devis_envoye', avant,
      { version: version, total: t.total, lignes: lignes.length, inhabituel: t.inhabituel,
        marche: t.marche ? { min: t.marche.min, max: t.marche.max, ecartPct: t.marche.ecartPct, sources: t.marche.sources || [], date: (t.marche.refs[0] || {}).date } : null,
        inhabituelMarche: !!t.inhabituelMarche }, motif, par);
    /* 🏷️ un prix TRÈS inhabituel (écart ≥ 150 %) est porté à la connaissance des gestionnaires — il reste en place */
    try { if (t.marche && t.marche.tresInhabituel) emitAdmin('prix', '🏷️ ' + m.id + ' — prix ' + t.total.toLocaleString('fr-FR') + ' F ' + t.marche.message + ' (conservé, contrôle gestionnaire demandé)'); } catch (e) { }
    saveDb();
    emitToMission(m, { type: 'devis', missionId: m.id, version: version, total: t.total, statut: 'envoye',
      motif: motif, prixVerrouille: m.prixVerrouille ? m.prixVerrouille.montant : null });
    try { emitAdmin('devis', '🧾 ' + par + ' a envoyé le devis v' + version + ' (' + t.total.toLocaleString('fr-FR') + ' F) pour ' + m.id + (motif ? ' — motif : ' + motif : '')); } catch (e) {}
    return { ok: true, devis: m.devis };
  }
  function devisAccepter(m, par) {
    if (!m.devis || !m.devis.version) return { error: 'Aucun devis à accepter' };
    if (m.devis.statut === 'accepte') return { error: 'Ce devis est déjà accepté' };
    if (m.devis.statut === 'refuse') return { error: 'Ce devis a été refusé : demandez un nouveau devis' };
    const avant = { prixTotal: m.prixTotal || 0, verrou: m.prixVerrouille || null };
    m.devis.statut = 'accepte'; m.devis.accepteAt = nowISO(); m.devis.acceptePar = par;
    (m.verrousHisto = m.verrousHisto || []);
    if (m.prixVerrouille) m.verrousHisto.push(Object.assign({}, m.prixVerrouille, { remplaceAt: nowISO(), remplacePar: par }));
    m.prixVerrouille = { montant: m.devis.total, version: m.devis.version, date: nowISO(), par: par };
    m.prixTotal = m.devis.total;                     /* 🔒 le prix accepté devient LE prix de la mission */
    m.quote = false;
    if (m.status === 'quoted') m.status = 'pending';
    devisJournaliser(m, 'devis_accepte', avant, { version: m.devis.version, total: m.devis.total, verrouille: true }, '', par);
    saveDb();
    emitToMission(m, { type: 'mission_update', status: m.status, missionId: m.id, prixTotal: m.prixTotal,
      verrouille: true, devisVersion: m.devis.version });
    try { emitAdmin('devis', '🔒 ' + par + ' a accepté le devis v' + m.devis.version + ' — prix verrouillé à ' + m.devis.total.toLocaleString('fr-FR') + ' F (' + m.id + ')'); } catch (e) {}
    return { ok: true, prixTotal: m.prixTotal, verrouille: m.prixVerrouille };
  }
  function devisRefuser(m, motif, par) {
    if (!m.devis || !m.devis.version) return { error: 'Aucun devis à refuser' };
    const avant = { statut: m.devis.statut, version: m.devis.version, total: m.devis.total };
    m.devis.statut = 'refuse'; m.devis.refuseAt = nowISO(); m.devis.refusePar = par; m.devis.refuseMotif = devisNettoyerChamp(motif, 300);
    if (m.prixVerrouille) m.devis.enAttenteSurPrixVerrouille = { montant: m.prixVerrouille.montant, version: m.prixVerrouille.version };
    devisJournaliser(m, 'devis_refuse', avant, { statut: 'refuse', prixVerrouilleConserve: m.prixVerrouille ? m.prixVerrouille.montant : null }, m.devis.refuseMotif, par);
    saveDb();
    emitToMission(m, { type: 'devis', missionId: m.id, version: m.devis.version, total: m.devis.total, statut: 'refuse',
      motif: m.devis.refuseMotif, prixVerrouille: m.prixVerrouille ? m.prixVerrouille.montant : null });
    try { emitAdmin('devis', '🚫 ' + par + ' a refusé le devis v' + m.devis.version + ' (' + m.id + ')' + (m.prixVerrouille ? ' — le prix accepté reste en vigueur' : '')); } catch (e) {}
    return { ok: true, statut: 'refuse', prixEnVigueur: m.prixVerrouille ? m.prixVerrouille.montant : (m.prixTotal || 0) };
  }
  /* ce qui est montré au client : le devis, l'historique, le prix verrouillé, et si un changement attend SA réponse */
  function devisPublique(m) {
    if (!m || (!m.devis && !m.devisHisto)) return null;
    return {
      devis: m.devis || null,
      historique: (m.devisHisto || []).map(d => ({ version: d.version, total: d.total, statut: d.statut, par: d.par, at: d.at, motif: d.motif || '' })),
      verrou: m.prixVerrouille || null,
      verrousPrecedents: (m.verrousHisto || []).slice(-5),
      enAttenteDeVotreReponse: !!(m.devis && m.devis.statut === 'envoye'),
      prixEnVigueur: m.prixVerrouille ? m.prixVerrouille.montant : (m.prixTotal || 0)
    };
  }

  /* 💰 BULLE « PRIX » — le professionnel transmet son prix : il devient un DEVIS (lot 109), affiché
     séparément des messages. Le client accepte (verrou) ou refuse (→ droit au 2ᵉ professionnel). */
  function relPrix(m, ag, montant, libelle) {
    const r = relDe(m);
    if (!ag || m.agentId !== ag.id) return { error: 'Vous n’êtes pas le professionnel en relation sur cette demande' };
    if (r.etat !== 'pro1_accepte' && r.etat !== 'pro2_accepte') return { error: 'Acceptez d’abord la demande, puis envoyez votre prix' };
    const total = Math.max(500, Math.round(Number(montant) || 0));
    const lignes = [{ type: 'autre', libelle: String(libelle || 'Montant proposé pour la prestation').slice(0, 80), qte: 1, pu: total }];
    const avait = !!(m.devis && m.devis.version);
    const rr = devisCreer(m, { lignes: lignes, conditions: 'Proposition du professionnel',
      motif: avait ? 'nouveau prix proposé par le professionnel' : '' }, ag.nom, avait);
    if (rr.error) return rr;
    const d = m.devis;
    /* 🏷️ lot 112 : on dit au professionnel où se situe son prix par rapport au marché (source + date) */
    if (d.marche && d.marche.trouve && !d.marche.dans) {
      relMsgsys(r, '🏷️ Information marché : ' + d.marche.message + ' — référence(s) : ' + (d.marche.sources || []).join(', ')
        + ' (' + ((d.marche.refs[0] || {}).date || '') + '). Votre prix est conservé : aucune modification automatique.', 'alerte');
    }
    r.msgs.push({ at: nowISO(), de: ag.nom, role: 'pro', type: 'prix', montant: d.total, devisVersion: d.version, texte: 'PRIX' });
    relJournal(r, avait ? 'prix_repropose' : 'prix_propose', ag.nom, 'pro', 'devis v' + d.version + ' · ' + d.total + ' F');
    relMsgsys(r, '💰 ' + ag.nom + ' propose un prix : ' + d.total.toLocaleString('fr-FR') + ' F (devis v' + d.version + '). En attente de la décision du client.');
    saveDb();
    try { emitToMission(m, { type: 'devis', missionId: m.id, version: d.version, total: d.total, statut: 'envoye' }); } catch (e) { }
    try { emitAdmin('prix', '💰 ' + m.id + ' — ' + ag.nom + ' propose ' + d.total.toLocaleString('fr-FR') + ' F (v' + d.version + ')'); } catch (e) { }
    return { ok: true, devis: d };
  }
  /* ✅ / ✕ / ↩ la décision du CLIENT sur le prix */
  function relPrixDecision(m, decision, motif) {
    const r = relDe(m);
    if (!m.devis || !m.devis.version) return { error: 'Aucun prix n’a encore été proposé par le professionnel' };
    if (decision === 'accepter') {
      const a = devisAccepter(m, 'client');
      if (a.error) return a;
      const montant = m.prixVerrouille.montant;
      r.msgs.push({ at: nowISO(), de: 'Client', role: 'client', type: 'prix', montant: montant, devisVersion: m.devis.version, texte: 'PRIX ACCEPTÉ', decision: 'accepte' });
      relJournal(r, 'prix_accepte', 'client', 'client', 'devis v' + m.devis.version + ' · ' + montant + ' F — montant officiel verrouillé');
      relMsgsys(r, '✅ Prix accepté : ' + montant.toLocaleString('fr-FR') + ' F. C’est le montant officiel de la prestation. Étape suivante : le paiement.');
      saveDb();
      try { emitToMission(m, { type: 'mission_update', status: m.status, missionId: m.id, prixTotal: m.prixTotal, verrouille: true, etape: 'paiement' }); } catch (e) { }
      try { emitAdmin('prix', '🔒 ' + m.id + ' — prix accepté ' + montant.toLocaleString('fr-FR') + ' F → étape paiement'); } catch (e) { }
      return { ok: true, etape: 'paiement', prixVerrouille: m.prixVerrouille };
    }
    if (decision === 'refuser') {
      const d = devisRefuser(m, motif || 'prix refusé par le client', 'client');
      if (d.error) return d;
      r.msgs.push({ at: nowISO(), de: 'Client', role: 'client', type: 'prix', montant: m.devis.total, devisVersion: m.devis.version,
        texte: 'PRIX REFUSÉ', decision: 'refuse', motif: String(motif || '').slice(0, 160) });
      relJournal(r, 'prix_refuse', 'client', 'client', 'devis v' + m.devis.version + ' · ' + m.devis.total + ' F' + (motif ? ' — ' + motif : ''));
      relMsgsys(r, '❌ Le client refuse ce prix.' + (motif ? ' Motif : « ' + String(motif).slice(0, 120) + ' ».' : ''));
      relMsgsys(r, '🔎 Le client a droit à un DEUXIÈME professionnel dans le même domaine.', 'alerte');
      const e = relApresEchec(m, m.agentId, motif || 'prix refusé par le client', 'prix refusé');
      return { ok: true, etat: e.etat, suivant: e.suivant };
    }
    return { error: 'Décision inconnue (accepter / refuser)' };
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
    /* 🩺 prestation réglementée : seuls les professionnels HABILITÉS (diplôme/agrément vérifié) peuvent accepter */
    if (m.reglemente) {
      const habil = (ag.habilitations || []);
      if (habil.indexOf(m.reglemente) < 0) {
        const r = reglementeIdx(m.reglemente) || {};
        return sendJson(res, 403, { error: 'Prestation réglementée (' + (r.nom || m.reglemente) + ') : réservée aux professionnels habilités. Envoyez votre diplôme ou agrément au HQ pour être vérifié.', reglemente: m.reglemente, habilitationRequise: r.exige || '' });
      }
    }
    /* 🤝 lot 118 : la règle des 2 professionnels maximum s'applique aussi ici (jamais de 3ᵉ) */
    const rel0 = relDe(m);
    const dejaContacte = (rel0.pros || []).some(p => p.proId === ag.id);
    if (!dejaContacte && (rel0.pros || []).filter(p => (p.tour || 1) === (rel0.tour || 1)).length >= relConfig().maxProsParTour)
      return sendJson(res, 409, { error: 'RÈGLE KLEAN : 2 professionnels maximum par demande. Cette demande est en pause — le client peut la reprendre demain.' });
    m.status = 'accepted'; m.agentId = ag.id; m.dist = distMissionPro(m, ag); invaliderStats(ag.id);
    if (!dejaContacte) {
      const o = relOuvrir(m, ag, 'pro-libre', true);
      if (!o.ok) { m.status = 'pending'; m.agentId = null; return sendJson(res, 409, { error: o.error }); }
      relReponse(m, ag, 'accepte', '');
    } else {
      const p0 = rel0.pros.find(p => p.proId === ag.id);
      if (p0 && p0.sens !== 'accepte') relReponse(m, ag, 'accepte', '');
    }
    saveDb();
    // informer les autres agents que la mission est prise
    broadcast(onlineAgents().filter(s => s.meta.agentId !== ag.id), { type: 'mission_taken', missionId: m.id });
    emitToMission(m, { type: 'mission_update', status: 'accepted', missionId: m.id,
      agent: { nom: ag.nom, note: agentStats(ag).rating, missions: agentStats(ag).missionsDone, tel: ag.tel, photo: ag.photo || '' },
      dist: m.dist, agentPos: ag.pos || null, lat: m.lat, lng: m.lng });
    console.log(`✅ ${ag.nom} a accepté ${m.id}`);
    emitAdmin('accept', `✅ ${ag.nom} a accepté la mission ${m.id} (${m.prixTotal.toLocaleString('fr-FR')} F)`);
    return sendJson(res, 200, { ok: true, missionId: m.id, clientTel: m.client.tel });
  }

  /* 🧾 LOT 109 — le devis structuré d'une mission */
  const mDevis = p.match(/^\/api\/missions\/([^/]+)\/devis$/);
  if (mDevis) {
    const m = db.missions.find(x => x.id === mDevis[1]);
    if (!m) return sendJson(res, 404, { error: 'Mission introuvable' });
    const cli = findClientByToken(req);
    const jetonAgent = (req.headers && req.headers['x-agent-token']) || '';
    const agAppelant = jetonAgent ? db.agents.find(a => a.jeton && a.jeton === jetonAgent) : null;
    const estClient = !!(cli && cli.id === m.clientId);
    const estPro = !!(agAppelant && m.agentId === agAppelant.id);
    if (req.method === 'GET') {
      if (!(isAdminReq(req) || estClient || estPro)) return sendJson(res, 403, { error: 'Ce devis ne vous appartient pas' });
      return sendJson(res, 200, Object.assign({ ok: true, missionId: m.id }, devisPublique(m) || { devis: null, historique: [], verrou: null, prixEnVigueur: m.prixTotal || 0 }));
    }
    if (req.method === 'POST') {
      /* ⛔ le client ne crée pas de devis : il accepte ou il refuse (routes dédiées) */
      if (estClient && !isAdminReq(req) && !estPro) return sendJson(res, 403, { error: 'C’est le professionnel qui établit le devis — vous pouvez l’accepter ou le refuser' });
      if (!(isAdminReq(req) || estPro)) return sendJson(res, 401, { error: 'non autorisé' });
      const b = await readBody(req);
      const par = estPro ? (agAppelant.nom || 'professionnel') : act(req);
      const r = devisCreer(m, b, par, false);
      if (r.error) return sendJson(res, 400, { error: r.error });
      return sendJson(res, 200, r);
    }
  }
  const mDevisMod = p.match(/^\/api\/missions\/([^/]+)\/devis\/(modifier|accepter|refuser)$/);
  if (mDevisMod && req.method === 'POST') {
    const m = db.missions.find(x => x.id === mDevisMod[1]);
    if (!m) return sendJson(res, 404, { error: 'Mission introuvable' });
    const quoi = mDevisMod[2];
    const b = await readBody(req);
    const cli = findClientByToken(req);
    const jetonAgent = (req.headers && req.headers['x-agent-token']) || '';
    const agAppelant = jetonAgent ? db.agents.find(a => a.jeton && a.jeton === jetonAgent) : null;
    const estClient = !!(cli && cli.id === m.clientId);
    const estPro = !!(agAppelant && m.agentId === agAppelant.id);
    if (quoi === 'accepter') {
      /* seul le client de la mission peut verrouiller le prix */
      if (!estClient) return sendJson(res, 403, { error: 'Seul le client de la mission peut accepter le devis' });
      /* 🤝 lot 118 : la carte devis et la bulle PRIX suivent EXACTEMENT la même règle (un seul comportement) */
      if (m.rel) {
        const r2 = relPrixDecision(m, 'accepter', '');
        if (r2.error) return sendJson(res, 400, { error: r2.error });
        return sendJson(res, 200, { ok: true, prixTotal: m.prixTotal, verrouille: m.prixVerrouille, etape: r2.etape, rel: m.rel.etat });
      }
      const r = devisAccepter(m, 'client');
      if (r.error) return sendJson(res, 400, { error: r.error });
      return sendJson(res, 200, r);
    }
    if (quoi === 'refuser') {
      if (!(estClient || estPro || isAdminReq(req))) return sendJson(res, 403, { error: 'non autorisé' });
      const par = estClient ? 'client' : (estPro ? (agAppelant.nom || 'professionnel') : act(req));
      /* 🤝 lot 118 : un refus du CLIENT (pas du pro, pas de l'admin) ouvre le droit au 2ᵉ professionnel */
      if (estClient && m.rel && !isAdminReq(req)) {
        const r2 = relPrixDecision(m, 'refuser', b.motif);
        if (r2.error) return sendJson(res, 400, { error: r2.error });
        return sendJson(res, 200, { ok: true, prixEnVigueur: m.prixVerrouille ? m.prixVerrouille.montant : 0, rel: m.rel.etat, suivant: r2.suivant || null });
      }
      const r = devisRefuser(m, b.motif, par);
      if (r.error) return sendJson(res, 400, { error: r.error });
      return sendJson(res, 200, r);
    }
    /* modifier : niveau professionnel / PDG / gestionnaire — TOUJOURS motivé, jamais silencieux */
    if (estClient && !isAdminReq(req)) return sendJson(res, 403, { error: 'Le client ne modifie pas le devis : il l’accepte ou le refuse' });
    if (!(isAdminReq(req) || estPro)) return sendJson(res, 401, { error: 'non autorisé' });
    const par = estPro ? (agAppelant.nom || 'professionnel') : act(req);
    if (!devisNettoyerChamp(b.motif, 400)) return sendJson(res, 400, {
      error: 'Une modification doit être MOTIVÉE : écrivez POURQUOI (panne imprévue, matériel en plus, accès difficile…) — le client doit le savoir avant d’accepter. On n’invente jamais un motif.' });
    const r = devisCreer(m, b, par, true);
    if (r.error) return sendJson(res, 400, { error: r.error });
    return sendJson(res, 200, r);
  }
  /* 🧾 journal des devis (PDG) : qui, quoi, avant, après, quand, pourquoi */
  if (p === '/api/admin/devis/journal' && req.method === 'GET') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const j = (db.devisJournal || []).slice(-200).reverse();
    return sendJson(res, 200, { ok: true, n: j.length, journal: j,
      verrous: db.missions.filter(m => m.prixVerrouille).length,
      enAttente: db.missions.filter(m => m.devis && m.devis.statut === 'envoye').length });
  }

  /* ═══════════ 🤝 LOT 118 — MISE EN RELATION (client & professionnel) ═══════════ */
  /* qui parle : jeton CLIENT ou jeton PRO — jamais un numéro annoncé par l'appareil */
  function relQui(req, m) {
    const cl = findClientByToken(req);
    if (cl && m.clientId === cl.id) return { role: 'client', qui: cl.nom, id: cl.id };
    const jt = (req.headers && req.headers['x-agent-token']) || '';
    const ag = jt ? db.agents.find(a => a.jeton && a.jeton === jt) : null;
    if (ag && (m.agentId === ag.id || m.cible === ag.id || (m.rel && (m.rel.pros || []).some(p => p.proId === ag.id))))
      return { role: 'pro', qui: ag.nom, id: ag.id, ag: ag };
    return null;
  }
  const mRel = p.match(/^\/api\/missions\/([^/]+)\/rel$/);
  if (mRel && req.method === 'GET') {
    const m = db.missions.find(x => x.id === mRel[1]);
    if (!m) return sendJson(res, 404, { error: 'Demande introuvable' });
    const qui = relQui(req, m);
    if (!qui) return sendJson(res, 401, { error: 'Connectez-vous (compte client ou professionnel concerné)' });
    return sendJson(res, 200, Object.assign(relPublique(m), { vous: { role: qui.role, nom: qui.qui } }));
  }
  const mRelMsg = p.match(/^\/api\/missions\/([^/]+)\/rel\/message$/);
  if (mRelMsg && req.method === 'POST') {
    const m = db.missions.find(x => x.id === mRelMsg[1]);
    if (!m) return sendJson(res, 404, { error: 'Demande introuvable' });
    const qui = relQui(req, m);
    if (!qui) return sendJson(res, 401, { error: 'Connectez-vous (compte client ou professionnel concerné)' });
    const b = await readBody(req);
    const w = relMsg(m, qui.role, qui.qui, b.texte, { rapide: !!b.rapide });
    if (w.bloque) return sendJson(res, 403, w);
    if (!w.ok) return sendJson(res, /Limite|Doucement/.test(w.error || '') ? 429 : 400, w);
    return sendJson(res, 200, Object.assign(w, { rel: relPublique(m) }));
  }
  const mRelRep = p.match(/^\/api\/missions\/([^/]+)\/rel\/reponse$/);
  if (mRelRep && req.method === 'POST') {
    const m = db.missions.find(x => x.id === mRelRep[1]);
    if (!m) return sendJson(res, 404, { error: 'Demande introuvable' });
    const qui = relQui(req, m);
    if (!qui || qui.role !== 'pro') return sendJson(res, 403, { error: 'Réservé au professionnel en relation sur cette demande' });
    const b = await readBody(req);
    const rp = relReponse(m, qui.ag, b.sens || 'auto', b.texte);
    if (!rp.ok) return sendJson(res, 400, rp);
    return sendJson(res, 200, Object.assign(rp, { rel: relPublique(m) }));
  }
  const mRelPrix = p.match(/^\/api\/missions\/([^/]+)\/rel\/prix$/);
  if (mRelPrix && req.method === 'POST') {
    const m = db.missions.find(x => x.id === mRelPrix[1]);
    if (!m) return sendJson(res, 404, { error: 'Demande introuvable' });
    const qui = relQui(req, m);
    if (!qui || qui.role !== 'pro') return sendJson(res, 403, { error: 'Réservé au professionnel en relation sur cette demande' });
    const b = await readBody(req);
    const px = relPrix(m, qui.ag, b.montant, b.libelle);
    if (px.error) return sendJson(res, 400, px);
    if (m.demandeModif && m.demandeModif.statut === 'en_attente_nouveau_prix') {   /* ✍️ lot 112 : la demande modifiée a sa nouvelle proposition */
      m.demandeModif.statut = 'nouvelle_proposition'; m.demandeModif.proposeeAt = nowISO();
      try { relMsgsys(relDe(m), '💰 Nouveau prix proposé pour la demande modifiée (v' + Number(m.demandeVersion || 1) + ') — il n\'est officiel qu\'après VOTRE acceptation explicite.'); } catch (e) { }
      try { relJournal(relDe(m), 'demande-nouveau-prix', qui.qui, 'pro', 'v' + Number(m.demandeVersion || 1) + ' · ' + (parseInt(b.montant) || 0) + ' F — à accepter explicitement'); } catch (e) { }
    }
    return sendJson(res, 200, Object.assign(px, { rel: relPublique(m) }));
  }
  const mRelDec = p.match(/^\/api\/missions\/([^/]+)\/rel\/prix-decision$/);
  if (mRelDec && req.method === 'POST') {
    const m = db.missions.find(x => x.id === mRelDec[1]);
    if (!m) return sendJson(res, 404, { error: 'Demande introuvable' });
    const qui = relQui(req, m);
    if (!qui || qui.role !== 'client') return sendJson(res, 403, { error: 'Réservé au client de cette demande' });
    const b = await readBody(req);
    const dec = String(b.decision || '');
    if (['accepter', 'refuser'].indexOf(dec) < 0) return sendJson(res, 400, { error: 'Décision inconnue (accepter / refuser)' });
    const dv = relPrixDecision(m, dec, b.motif);
    if (dv.error) return sendJson(res, 400, dv);
    if (m.demandeModif && m.demandeModif.statut === 'nouvelle_proposition') {      /* ✍️ lot 112 : l'acceptation explicite clôt le cycle */
      m.demandeModif.statut = dec === 'accepter' ? 'acceptee' : 'refusee';
      m.demandeModif.decideAt = nowISO(); saveDb();
    }
    return sendJson(res, 200, Object.assign(dv, { rel: relPublique(m) }));
  }
  /* ✍️ « MODIFIER MA DEMANDE » — LOT 112 : le client corrige sa demande, rien n'est supprimé,
     tout est conservé (avant/après, qui, quand, pourquoi) et un prix déjà accepté n'est JAMAIS
     touché : une modification ouvre une NOUVELLE proposition que le client devra accepter lui-même. */
  const mDemMod = p.match(/^\/api\/missions\/([^/]+)\/demande\/modifier$/);
  if (mDemMod && req.method === 'POST') {
    const m = db.missions.find(x => x.id === mDemMod[1]);
    if (!m) return sendJson(res, 404, { error: 'Demande introuvable' });
    const qui = relQui(req, m);
    if (!qui || qui.role !== 'client') return sendJson(res, 403, { error: 'Seul le client de cette demande peut la modifier' });
    const b = await readBody(req);
    const r = relDe(m);
    const etat = String(r.etat || '');
    if (etat === 'annulee' || m.status === 'annulee') return sendJson(res, 400, { error: 'Cette demande est annulée : elle ne peut plus être modifiée' });
    if (m.status === 'done' || m.finishedAt) return sendJson(res, 400, { error: 'Cette prestation est terminée : créez une nouvelle demande si besoin' });
    const apre = {};
    [['desc', 280], ['quartier', 60], ['adresse', 160], ['date', 20], ['time', 10]].forEach(([k, max]) => {
      if (typeof b[k] === 'string' && b[k].trim() && String(m[k] || '') !== b[k].trim().slice(0, max)) apre[k] = b[k].trim().slice(0, max);
    });
    if (b.pieces !== undefined && (parseInt(b.pieces) || 1) !== (parseInt(m.pieces) || 1)) apre.pieces = Math.max(1, Math.min(20, parseInt(b.pieces) || 1));
    if (Array.isArray(b.reponses) && b.reponses.length) {
      const rep = b.reponses.filter(x => x && x.q).slice(0, 20).map(x => ({ q: String(x.q).slice(0, 60), v: String(x.v).slice(0, 60) }));
      const avant = JSON.stringify((m.tarif && m.tarif.reponses) || []);
      if (JSON.stringify(rep) !== avant) apre.reponses = rep;
    }
    if (b.service && b.service !== m.service) return sendJson(res, 400, { error: 'Le métier ne peut pas changer ici',
      conseil: 'Pour un autre métier, annulez et créez une nouvelle demande : deux professionnels différents peuvent être concernés.' });
    if (!Object.keys(apre).length) return sendJson(res, 400, { error: 'Aucun changement : précisez ce que vous voulez modifier' });
    const avant = {}; Object.keys(apre).forEach(k => avant[k] = m[k] !== undefined ? m[k] : null);
    const ancienneVersion = Number(m.demandeVersion || 1);
    Object.keys(apre).forEach(k => { if (k === 'reponses') { m.tarif = m.tarif || {}; m.tarif.reponses = apre.reponses; } else m[k] = apre[k]; });
    m.demandeVersion = ancienneVersion + 1;
    m.demandeHist = (m.demandeHist || []).concat([{ at: nowISO(), version: m.demandeVersion, par: qui.qui, role: 'client',
      motif: String(b.motif || 'modification du client').slice(0, 160), avant: avant, apres: apre }]);
    if (m.demandeHist.length > 30) m.demandeHist = m.demandeHist.slice(-25);
    const prixAccepte = !!(m.prixVerrouille && m.prixVerrouille.montant > 0) || !!(m.devis && m.devis.statut === 'accepte');
    const lib = Object.keys(apre).map(k => k === 'reponses' ? 'précisions' : k).join(', ');
    if (prixAccepte) {
      m.demandeModif = { statut: 'en_attente_nouveau_prix', at: nowISO(), par: qui.qui, version: m.demandeVersion,
        motif: String(b.motif || '').slice(0, 160), champs: Object.keys(apre) };
      relMsgsys(r, '✍️ Le client a modifié sa demande (v' + m.demandeVersion + ' : ' + lib + '). Le prix déjà accepté reste en vigueur tant qu\'un NOUVEAU prix n\'a pas été proposé puis accepté par le client.');
      try { relMsg(m, 'systeme', 'Klean', '✍️ Demande modifiée par le client — un nouveau prix est attendu (le prix accepté actuel ne change pas).', { type: 'prix' }); } catch (e) { }
    } else {
      m.demandeModif = { statut: 'prise_en_compte', at: nowISO(), par: qui.qui, version: m.demandeVersion };
      relMsgsys(r, '✍️ Demande actualisée par le client (v' + m.demandeVersion + ' : ' + lib + ').');
    }
    relJournal(r, 'demande-modifiee', qui.qui, 'client', 'v' + ancienneVersion + ' → v' + m.demandeVersion + ' · ' + lib + ' · motif : ' + String(b.motif || '').slice(0, 80)
      + (prixAccepte ? ' · prix accepté INCHANGÉ (' + (m.prixVerrouille ? m.prixVerrouille.montant : (m.devis || {}).total) + ' F) — nouvelle proposition exigée' : ''));
    saveDb();
    try { emitAdmin('relation', '✍️ ' + m.id + ' — demande modifiée par le client (v' + m.demandeVersion + ')' + (prixAccepte ? ' · prix accepté inchangé' : '')); } catch (e) { }
    try { tarifBump('demande-modifiee', { par: qui.qui, role: 'client', mission: m.id, version: m.demandeVersion, champs: Object.keys(apre) }); } catch (e) { }
    return sendJson(res, 200, { ok: true, version: m.demandeVersion, prixAccepteConserve: prixAccepte,
      message: prixAccepte ? 'Demande modifiée. Le prix déjà accepté reste en vigueur : le professionnel doit proposer un NOUVEAU prix, que vous accepterez ou refuserez explicitement.'
        : 'Demande modifiée — le professionnel est prévenu.', rel: relPublique(m), hist: m.demandeHist.slice(-5) });
  }
  const mRelAnn = p.match(/^\/api\/missions\/([^/]+)\/rel\/annuler$/);
  if (mRelAnn && req.method === 'POST') {
    const m = db.missions.find(x => x.id === mRelAnn[1]);
    if (!m) return sendJson(res, 404, { error: 'Demande introuvable' });
    const qui = relQui(req, m);
    if (!qui || qui.role !== 'client') return sendJson(res, 403, { error: 'Réservé au client de cette demande' });
    const b = await readBody(req);
    const r = relDe(m);
    relSetEtat(r, 'annulee', 'annulée par le client'); r.annuleAt = nowISO();
    relJournal(r, 'annulation', qui.qui, 'client', String(b.motif || '').slice(0, 160));
    relMsgsys(r, '⛔ Demande annulée par le client' + (b.motif ? ' — « ' + String(b.motif).slice(0, 100) + ' »' : '') + '.');
    m.status = 'annulee'; saveDb();
    try { emitAdmin('relation', '⛔ ' + m.id + ' — annulée par le client'); } catch (e) { }
    return sendJson(res, 200, { ok: true, rel: relPublique(m) });
  }
  /* 🔁 reprise du lendemain : nouveau tour de 2 professionnels pour LA MÊME demande */
  const mRelRel = p.match(/^\/api\/missions\/([^/]+)\/rel\/relancer$/);
  if (mRelRel && req.method === 'POST') {
    const m = db.missions.find(x => x.id === mRelRel[1]);
    if (!m) return sendJson(res, 404, { error: 'Demande introuvable' });
    const qui = relQui(req, m);
    if (!qui || qui.role !== 'client') return sendJson(res, 403, { error: 'Réservé au client de cette demande' });
    const C = relConfig(), r = relDe(m);
    if (r.etat !== 'aucun_pro' && !isPdg(req))
      return sendJson(res, 409, { error: 'La recherche est encore en cours : attendez la réponse du professionnel en relation.' });
    if ((r.pros || []).some(p => p.sens === 'en_attente'))
      return sendJson(res, 409, { error: 'Un professionnel doit encore répondre : laissez-lui le temps de faire son devis.' });
    if (relProsAujourdHui(m) >= C.maxProsParTour && !isPdg(req))
      return sendJson(res, 409, { error: 'RÈGLE KLEAN : ' + C.maxProsParTour + ' professionnels maximum par jour pour la même demande. La reprise est possible demain (ou par décision du PDG).',
        prochaineLe: r.prochaineLe || relRepriseISO(C) });
    if (r.prochaineLe && Date.now() < new Date(r.prochaineLe).getTime() && !isPdg(req))
      return sendJson(res, 409, { error: 'Reprise possible à partir de ' + String(r.prochaineLe).slice(0, 16).replace('T', ' ') + ' (règle : après 2 professionnels, on reprend le jour suivant).', prochaineLe: r.prochaineLe });
    r.tour = (r.tour || 1) + 1; r.prochaineLe = null; relSetEtat(r, 'attente_pro1', 'reprise du jour ' + String(nowISO()).slice(0, 10));
    relJournal(r, 'reprise', qui.qui, 'client', 'tour ' + r.tour + ' — recherche relancée');
    relMsgsys(r, '🔁 Nouvelle recherche (tour ' + r.tour + ') : jusqu’à ' + C.maxProsParTour + ' professionnels, puis pause jusqu’au lendemain.');
    saveDb();
    const su = relProposerSuivant(m);
    return sendJson(res, 200, { ok: true, tour: r.tour, suivant: su.ok ? su.rang : null, rel: relPublique(m) });
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
    /* 🔒 on ne diffuse pas la position d'un professionnel à n'importe qui : il faut être
       le client de la mission, le professionnel assigné, ou le HQ. */
    const cli = findClientByToken(req);
    const jetonAgent = req.headers['x-agent-token'] || '';
    const agAppelant = jetonAgent ? db.agents.find(a => a.jeton && a.jeton === jetonAgent) : null;
    const autorise = isAdminReq(req) || (cli && cli.id === m.clientId) || (agAppelant && m.agentId === agAppelant.id);
    if (!autorise) return sendJson(res, 403, { error: 'Cette mission ne vous appartient pas' });
    return sendJson(res, 200, { ok: true, id: m.id, status: m.status, agentId: m.agentId,
      lat: m.lat, lng: m.lng, agentPos: (ag && ag.pos) || null,
      dist: (typeof m.dist === 'number' ? m.dist : null),
      prixTotal: m.prixTotal, quote: !!m.quote, tarif: m.tarif || null,
      devis: m.devis || null, devisHisto: (m.devisHisto || []).length,
      prixVerrouille: m.prixVerrouille || null,
      ville: m.ville || '' });
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
    /* 📜 le client devient un client Klean en ACCEPTANT les conditions (règle du PDG — case obligatoire) */
    conditionsEnsure();
    if (db.conditions.exigee !== false && b.conditionsAcceptees !== true)
      return sendJson(res, 400, { error: 'Vous devez accepter les conditions Klean-Services (client) pour créer votre compte',
        conditions: conditionsPub('client').version,
        conseil: 'lisez les conditions à l’écran puis cochez « J’accepte » — aucun compte n’est créé sans cela.' });
    const salt = crypto.randomBytes(12).toString('hex');
    const cl0 = { id: uid('CL'), nom: b.nom.trim(), tel, quartier: String(b.quartier || '').slice(0, 60), ville: String(b.ville || '').slice(0, 60), mail: String(b.mail || '').slice(0, 80), salt, passHash: hashPassword(salt, b.password), createdAt: nowISO(),
      lastLogin: nowISO(), lastAppareil: String(req.headers['user-agent'] || '').slice(0, 120) };
    const cl = cl0;
    db.clients.push(cl);
    const accC = conditionsAccepter('client', cl.nom, tel, { ua: req.headers['user-agent'], ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress, source: 'inscription' });
    cl.conditionsVersion = accC.version; cl.conditionsAt = accC.at;
    saveDb();
    auditLog('conditions_acceptees', { role: 'client', qui: cl.nom, version: accC.version, source: 'inscription' });
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

  /* ═══════════════ 📚 CATALOGUE NATIONAL (tableau de bord) ═══════════════ */
  if (p === '/api/admin/catalogue' && req.method === 'GET') {
    return sendJson(res, 200, Object.assign({ ok: true }, catNatReponse()));
  }
  if (p === '/api/admin/catalogue' && req.method === 'POST') {
    const b = await readBody(req);
    const reg = catNatReglages();
    const action = String(b.action || '');
    const num = String(b.num || '');
    /* 🔁 actif / inactif — on ne supprime jamais une entrée utilisée dans d'anciennes commandes */
    if (action === 'basculer') {
      const i = reg.off.indexOf(num);
      if (i >= 0) reg.off.splice(i, 1); else reg.off.push(num);
      const quoi = catNatParNumero(num);
      auditLog('catalogue_bascule', { num, nom: quoi ? quoi.nom : num, actif: i >= 0, par: act(req) });
    }
    else if (action === 'renommer') {
      const nom = String(b.nom || '').trim().slice(0, 80);
      if (nom.length < 2) return sendJson(res, 400, { error: 'Nom trop court' });
      reg.noms[num] = nom;
      auditLog('catalogue_renomme', { num, nom, par: act(req) });
    }
    else if (action === 'mot') {
      const mot = normFr(String(b.mot || '')).slice(0, 60).trim();
      if (mot.length < 2) return sendJson(res, 400, { error: 'Mot trop court' });
      const avant = catNatMots(num);
      const liste = new Set(String(avant).split(' ').filter(Boolean));
      liste.add(mot);
      reg.mots[num] = [...liste].join(' ');
      auditLog('catalogue_mot', { num, mot, par: act(req) });
    }
    else if (action === 'ajouter') {
      const niveau = String(b.niveau || 'tache');
      const parent = String(b.parent || '');
      const nom = String(b.nom || '').trim().slice(0, 80);
      if (nom.length < 2) return sendJson(res, 400, { error: 'Nom trop court' });
      if (!['sous', 'tache'].includes(niveau)) return sendJson(res, 400, { error: 'Niveau non modifiable ici (utilisez « Ajouter un service créé »)' });
      const parentOk = niveau === 'tache' ? catalogueNational().services.some(s => s.sous.some(x => String(x.num) === parent)) : CAT_NAT.some(s => String(s.num) === parent);
      if (!parentOk) return sendJson(res, 400, { error: 'Parent introuvable' });
      reg.plus.push({ id: 'P' + Date.now().toString(36), niveau, parent, nom, at: nowISO(), par: act(req) });
      auditLog('catalogue_ajout', { niveau, parent, nom, par: act(req) });
    }
    else if (action === 'icone') {
      const ic = String(b.ic || '').trim().slice(0, 6);
      if (ic.length < 1) return sendJson(res, 400, { error: 'Choisissez une icône' });
      reg.icones[num] = ic;
      auditLog('catalogue_icone', { num, ic, par: act(req) });
    }
    /* 🗂️ LES CATÉGORIES : renommer · icône · nouvelle · désactiver · y ranger un service */
    else if (['fam-renommer', 'fam-icone', 'fam-ajouter', 'fam-service', 'fam-basculer'].includes(action)) {
      const F = reg.fam;
      const connue = id => CAT_NAT_FAM.some(f => f.id === id) || F.plus.some(f => f.id === id);
      if (action === 'fam-ajouter') {
        const nom = String(b.nom || '').trim().slice(0, 60);
        if (nom.length < 2) return sendJson(res, 400, { error: 'Nom de catégorie trop court' });
        const nid = 'f' + Date.now().toString(36);
        F.plus.push({ id: nid, ic: String(b.ic || '📂').trim().slice(0, 6) || '📂', nom, at: nowISO(), par: act(req) });
        auditLog('catalogue_fam_ajout', { id: nid, nom, par: act(req) });
        saveDb(); bcAll({ type: 'catalogue_maj', action, num: nid });
        return sendJson(res, 200, Object.assign({ ok: true, id: nid }, catNatReponse()));
      }
      const idF = String(b.id || '').trim();
      if (!connue(idF)) return sendJson(res, 404, { error: 'Catégorie introuvable' });
      if (action === 'fam-renommer') {
        const nom = String(b.nom || '').trim().slice(0, 60);
        if (nom.length < 2) return sendJson(res, 400, { error: 'Nom trop court' });
        F.noms[idF] = nom;
        auditLog('catalogue_fam_renomme', { id: idF, nom, par: act(req) });
      }
      else if (action === 'fam-icone') {
        const ic = String(b.ic || '').trim().slice(0, 6);
        if (!ic) return sendJson(res, 400, { error: 'Choisissez une icône' });
        F.icones[idF] = ic;
        auditLog('catalogue_fam_icone', { id: idF, ic, par: act(req) });
      }
      else if (action === 'fam-service') {
        const num = String(b.num || '').trim();
        const existe = catalogueNationalHQ().some(s => String(s.num) === num);
        if (!existe) return sendJson(res, 404, { error: 'Service introuvable' });
        F.svc[num] = idF;
        auditLog('catalogue_fam_service', { num, fam: idF, par: act(req) });
      }
      else {   /* fam-basculer : jamais une catégorie qui contient encore des services actifs (sinon ils disparaîtraient) */
        const svcsActifs = catalogueNational().services.filter(s => s.famille === idF).length;
        if (!catNatFamOff(idF) && svcsActifs) {
          return sendJson(res, 400, { error: 'Cette catégorie contient encore ' + svcsActifs + ' service(s) actif(s) : rangez-les ailleurs ou désactivez-les d’abord. Rien n’est supprimé.' });
        }
        const i = F.off.indexOf(idF);
        if (i >= 0) F.off.splice(i, 1); else F.off.push(idF);
        auditLog('catalogue_fam_bascule', { id: idF, actif: i >= 0, par: act(req) });
      }
      saveDb(); bcAll({ type: 'catalogue_maj', action, num: idF });
      return sendJson(res, 200, Object.assign({ ok: true }, catNatReponse()));
    }
    /* 🆕 UN SERVICE ENTIER créé par le PDG (il entre dans le même arbre, les mêmes recherches et les mêmes filtres) */
    else if (action === 'svc-ajouter') {
      const nom = String(b.nom || '').trim().slice(0, 70);
      const famId = String(b.fam || '').trim();
      if (nom.length < 2) return sendJson(res, 400, { error: 'Nom du service trop court' });
      if (!CAT_NAT_FAM.some(f => f.id === famId) && !reg.fam.plus.some(f => f.id === famId))
        return sendJson(res, 400, { error: 'Choisissez la catégorie qui contiendra ce service' });
      const metier = String(b.metier || '').trim().slice(0, 40);
      if (metier && !svcCat(metier) && !SVC_NOUVEAUX[metier] && !(db.catalog || []).some(x => x.id === metier))
        return sendJson(res, 400, { error: 'Métier inconnu — créez-le d’abord dans « Créer / déployer un service »' });
      const id = 'S' + Date.now().toString(36);
      reg.svcPlus.push({ id, nom, ic: String(b.ic || '🛠️').trim().slice(0, 6) || '🛠️', fam: famId, metier,
        sousNom: String(b.sousNom || 'Prestations').trim().slice(0, 60) || 'Prestations',
        taches: [String(b.tache || nom).trim().slice(0, 80) || nom], at: nowISO(), par: act(req) });
      auditLog('catalogue_service_ajout', { id, nom, fam: famId, metier, par: act(req) });
      saveDb(); bcAll({ type: 'catalogue_maj', action, num: id });
      return sendJson(res, 200, Object.assign({ ok: true, id }, catNatReponse()));
    }
    /* 🏠 type d'intervention : le PDG coche / décoche (les valeurs de départ restent en secours) */
    else if (action === 'lieu' || action === 'tarif') {
      const id = String(b.id || '').trim();
      const ref = action === 'lieu' ? CAT_LIEUX : CAT_TARIFS;
      if (!ref.some(x => x.id === id)) return sendJson(res, 400, { error: 'Valeur inconnue' });
      const cle = action === 'lieu' ? 'lieux' : 'tarifs';
      const def = (action === 'lieu' ? CAT_LIEUX_DEF : CAT_TARIFS_DEF)[num] || (action === 'lieu' ? ['domicile'] : ['devis']);
      /* (un service créé par le PDG n'a pas de valeurs de départ : domicile / devis) */
      const actuel = (reg[cle][num] && reg[cle][num].length) ? reg[cle][num].slice() : def.slice();
      const i = actuel.indexOf(id);
      if (i >= 0) actuel.splice(i, 1); else actuel.push(id);
      if (!actuel.length) return sendJson(res, 400, { error: 'Gardez au moins une valeur — sinon le client ne saura pas quoi choisir' });
      reg[cle][num] = actuel;
      auditLog('catalogue_' + cle, { num, id, retire: i >= 0, valeurs: actuel, par: act(req) });
    }
    /* 🩺 habiliter un professionnel (diplôme / agrément vérifié par le PDG) */
    else if (action === 'habiliter') {
      const ag = (db.agents || []).find(a => a.id === String(b.pro || ''));
      const rgl = reglementeIdx(String(b.id || ''));
      if (!ag) return sendJson(res, 404, { error: 'Professionnel introuvable' });
      if (!rgl) return sendJson(res, 400, { error: 'Prestation réglementée inconnue' });
      ag.habilitations = Array.isArray(ag.habilitations) ? ag.habilitations : [];
      ag.habilVu = ag.habilVu || {};
      const i = ag.habilitations.indexOf(rgl.id);
      if (i >= 0) { ag.habilitations.splice(i, 1); delete ag.habilVu[rgl.id]; }
      else { if (!String(b.doc || '').trim()) return sendJson(res, 400, { error: 'Indiquez la référence du document vérifié (diplôme, agrément…)' });
        ag.habilitations.push(rgl.id); ag.habilVu[rgl.id] = { doc: String(b.doc).trim().slice(0, 120), at: nowISO(), par: act(req) }; }
      auditLog('habilitation_' + (i >= 0 ? 'retiree' : 'ajoutee'), { pro: ag.nom, proId: ag.id, reglemente: rgl.id, doc: String(b.doc || '').slice(0, 120), par: act(req) });
      emitAdmin('habilitation', (i >= 0 ? '🚫 Habilitation retirée à ' : '🩺 Professionnel habilité : ') + ag.nom + ' — ' + rgl.nom);
    }
    /* ⛔ le PDG ne supprime JAMAIS une entrée : elle est utilisée dans des commandes passées */
    else if (['supprimer', 'effacer', 'delete', 'remove'].includes(action)) {
      const quoi = catNatParNumero(num);
      return sendJson(res, 400, { error: 'Une entrée ne se supprime jamais : désactivez-la (⏸). Elle disparaît chez les clients mais reste lisible dans les commandes passées, et vous pouvez la réactiver quand vous voulez.',
        conseil: 'basculer', entree: quoi ? quoi.nom : num });
    }
    else if (action === 'idee-vue' || action === 'idee-tout-vu') {
      if (action === 'idee-tout-vu') reg.suggestions.forEach(x => x.vu = true);
      else { const x = reg.suggestions.find(y => y.id === String(b.id)); if (x) x.vu = true; }
    }
    else if (action === 'idee-creer') {
      const x = reg.suggestions.find(y => y.id === String(b.id));
      if (!x) return sendJson(res, 404, { error: 'Demande introuvable' });
      const niveau = String(b.niveau || 'tache'), parent = String(b.parent || ''), nom = String(b.nom || x.texte).trim().slice(0, 80);
      reg.plus.push({ id: 'P' + Date.now().toString(36), niveau, parent, nom, at: nowISO(), par: act(req), idee: x.id });
      x.vu = true; x.creeLe = nowISO(); x.cree = { niveau, parent, nom };
      auditLog('catalogue_idee_creee', { nom, niveau, parent, par: act(req) });
    }
    else return sendJson(res, 400, { error: 'Action inconnue' });
    saveDb();
    bcAll({ type: 'catalogue_maj', action, num });
    return sendJson(res, 200, Object.assign({ ok: true }, catNatReponse()));
  }
  /* --- DOSSIERS AGENTS (candidature vérifiée par le propriétaire) --- */
  if (p === '/api/agents/apply' && req.method === 'POST') {
    const b = await readBody(req);
    /* 📜 le professionnel devient un Klean professionnel en ACCEPTANT les conditions (case obligatoire) */
    conditionsEnsure();
    if (db.conditions.exigee !== false && b.conditionsAcceptees !== true)
      return sendJson(res, 400, { error: 'Vous devez accepter les conditions Klean-Services (professionnel) avant d’envoyer votre dossier',
        conditions: conditionsPub('pro').version,
        conseil: 'lisez les conditions à l’écran puis cochez « J’accepte les conditions professionnelles » — aucun dossier n’est déposé sans cela.' });
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
    db.agents.push(ag);
    const accP = conditionsAccepter('pro', ag.nom, tel1, { ua: req.headers['user-agent'], ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress, source: 'inscription' });
    ag.conditionsVersion = accP.version; ag.conditionsAt = accP.at;
    saveDb();
    auditLog('conditions_acceptees', { role: 'pro', qui: ag.nom, version: accP.version, source: 'inscription' });
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
      at: m.createdAt,
      /* 💰 la trace du calcul : le PDG voit comment chaque prix a été fait (et pourquoi il est « à vérifier ») */
      tarif: m.tarif || null, quote: !!m.quote, ville: m.ville || '',
      /* 🧾 lot 109 : devis structuré + verrou + alerte « prix inhabituel » (signalé, jamais supprimé) */
      devis: m.devis ? { version: m.devis.version, statut: m.devis.statut, total: m.devis.total, remise: m.devis.remise,
        lignes: m.devis.lignes, parType: m.devis.parType, delai: m.devis.delai, duree: m.devis.duree,
        conditions: m.devis.conditions, motif: m.devis.motif, par: m.devis.par, at: m.devis.at,
        inhabituel: !!m.devis.inhabituel, estimation: m.devis.estimation || null } : null,
      devisHisto: (m.devisHisto || []).map(d => ({ version: d.version, total: d.total, statut: d.statut, par: d.par, at: d.at, motif: d.motif || '' })),
      prixVerrouille: m.prixVerrouille || null
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
      /* 🧾 lot 109 : le devis structuré, son historique et le verrou de prix */
      devis: m.devis || null, prixVerrouille: m.prixVerrouille || null,
      devisHisto: (m.devisHisto || []).map(d => ({ version: d.version, total: d.total, statut: d.statut, par: d.par, at: d.at, motif: d.motif || '' })),
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
    /* 🔒 lot 109 — AVANT toute autre chose : un prix déjà accepté par le client ne s'écrase pas ici.
       (Le contrôle est placé en tête pour être atteint dans TOUS les cas, même avec une demande incomplète.) */
    if (m && b.prix && m.prixVerrouille) return sendJson(res, 400, { error: 'Prix déjà accepté par le client (' +
      m.prixVerrouille.montant.toLocaleString('fr-FR') + ' F, devis v' + m.prixVerrouille.version +
      ') : envoyez une modification motivée via le devis, le client devra l’accepter.', verrouille: m.prixVerrouille });
    const ag = db.agents.find(a => a.id === b.agentId && !a.blocked);
    if (!m || !ag) return sendJson(res, 404, { error: 'Mission ou pro introuvable' });
    m.agentId = ag.id; m.status = 'accepted'; m.dist = distMissionPro(m, ag); m.assignedBy = act(req); m.assignedAt = nowISO();
    if (b.prix) {
      if (m.prixVerrouille) return sendJson(res, 400, { error: 'Prix déjà accepté par le client (' + m.prixVerrouille.montant.toLocaleString('fr-FR') +
        ' F, devis v' + m.prixVerrouille.version + ') : envoyez une modification motivée via le devis.', verrouille: m.prixVerrouille });
      m.prixTotal = Math.round(Number(b.prix) || m.prixTotal || 0); m.quote = false;
    }
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
    /* 🔒 lot 109 : si le client a déjà accepté un prix, on ne le remplace pas ici.
       Une modification doit être MOTIVÉE et repasser par le client (route …/devis/modifier). */
    if (m.prixVerrouille) return sendJson(res, 400, { error: 'Le client a déjà accepté ' + m.prixVerrouille.montant.toLocaleString('fr-FR') +
      ' F (devis v' + m.prixVerrouille.version + ', verrouillé le ' + String(m.prixVerrouille.date).slice(0, 10) +
      '). Ce prix ne peut plus être changé directement : envoyez une MODIFICATION MOTIVÉE, le client devra l’accepter.', verrouille: m.prixVerrouille });
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
      /* 🔒 lot 109 : l'ancien chemin simple (un seul montant) passe par le MÊME verrou.
         Le prix accepté est verrouillé une fois pour toutes : plus personne ne le change en silence. */
      if (!m.devis) {
        const lignes = [{ type: 'autre', libelle: 'Montant global proposé', qte: 1, pu: Math.max(500, Math.round(Number(m.quotedPrix) || Number(m.prixTotal) || 0)) }];
        const rr = devisCreer(m, { lignes: lignes, conditions: 'Montant global (devis simple)' }, 'HQ', false);
        if (rr.error) return sendJson(res, 400, { error: rr.error });
      }
      const rac = devisAccepter(m, 'client');
      if (rac.error) return sendJson(res, 400, { error: rac.error });
      m.status = 'pending';
      saveDb();
      broadcastNewMission(m);
      emitToMission(m, { type: 'mission_update', status: 'pending', missionId: m.id, prixTotal: m.prixTotal, verrouille: true });
      return sendJson(res, 200, { ok: true, prixTotal: m.prixTotal, verrouille: m.prixVerrouille });
    }
    if (m.devis) devisRefuser(m, b.motif || '', 'client');
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
      /* 🧩 on envoie TOUT le catalogue (métiers Klean + créations du PDG) : c'est ce que voient
         le client et le professionnel dans leurs listes. */
      ok: true, services: catalogueComplet(),
      version: db.catalogVersion || 1, deployAt: db.catalogDeployAt || null, deployBy: db.catalogDeployBy || '',
      dirty: !!db.catalogDirty, nbMetiers: SVC_CAT.length, nbCrees: (db.catalog || []).length
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
    /* 🧩 si le métier existe déjà dans le catalogue Klean, on le dit clairement (pas de doublon) */
    if (svcCat(id)) return sendJson(res, 409, { error: 'Ce métier existe déjà dans le catalogue Klean (' + svcNomP(id) + ')', existant: id, builtin: true });
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
  /* le HQ voit les 44 métiers (builtin) PLUS ses propres créations */
  if (p === '/api/admin/services' && req.method === 'GET')
    return sendJson(res, 200, { services: catalogueComplet(), nbMetiers: SVC_CAT.length, nbCrees: (db.catalog || []).length });
  if (p === '/api/admin/services/pros' && req.method === 'GET') {
    const sid = String(url.searchParams.get('id') || '').trim();
    const onIds = onlineAgentIds();
    const list = (db.agents || []).filter(a => !a.blocked && (a.status || 'approved') === 'approved' && (!sid || agentHasService(a, sid))).map(a => ({
      id: a.id, nom: a.nom, tel: a.tel || a.tel1 || '', ville: a.villeIci || a.ville || '', quartier: a.quartier || '',
      online: agentIsOnline(a), services: a.services || []
    }));
    return sendJson(res, 200, { ok: true, id: sid, n: list.length, pros: list });
  }
  if (p === '/api/vitesses' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, vitesses: db.vitesses || {} });
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
  /* ═══════════ 🟠 LITIGES : le client signale un problème (lot 99) ═══════════ */
  if (p === '/api/litiges' && req.method === 'POST') {
    const cli = findClientByToken(req);
    if (!cli) return sendJson(res, 401, { error: 'Connectez-vous pour signaler un problème', needLogin: true });
    if (cli.blocked) return sendJson(res, 403, { error: 'Votre compte est bloqué — contactez Klean-Service' });
    const b = await readBody(req);
    const tel = String(cli.tel || '').replace(/\D/g, '');
    const m = db.missions.find(x => x.id === String(b.missionId || '')
      && (x.clientId === cli.id || (tel && x.client && String(x.client.tel || '').replace(/\D/g, '') === tel)));
    if (!m) return sendJson(res, 404, { error: 'Mission introuvable sur votre compte' });
    if (m.status !== 'terminee')
      return sendJson(res, 400, { error: 'Un problème ne peut être signalé que sur une mission TERMINÉE (mission actuelle : ' + m.status + ')' });
    const dejaOuvert = db.litiges.find(l => l.missionId === m.id && ['ouvert', 'en_cours'].includes(l.status));
    if (dejaOuvert) return sendJson(res, 409, { error: 'Un signalement est déjà en cours pour cette mission (' + dejaOuvert.id + ')', litigeId: dejaOuvert.id });
    /* anti-abus : 5 signalements par heure et par compte */
    const heure = Date.now() - 3600000;
    if (db.litiges.filter(l => l.clientId === cli.id && Date.parse(l.at || 0) > heure).length >= 5)
      return sendJson(res, 429, { error: 'Trop de signalements en une heure — patientez ou écrivez au support' });
    const texte = String(b.texte || '').trim().slice(0, 900);
    if (texte.length < 5) return sendJson(res, 400, { error: 'Expliquez le problème en quelques mots (5 caractères minimum)' });
    const motif = LITIGE_MOTIFS[b.motif] ? b.motif : 'autre';
    const ag = m.agentId ? db.agents.find(a => a.id === m.agentId) : null;
    const it = {
      id: uid('LT'), at: nowISO(), majAt: nowISO(),
      missionId: m.id, service: m.service, serviceNom: SVC_NAMES[m.service] || m.service,
      clientId: cli.id, clientNom: cli.nom, clientTel: String(cli.tel || ''),
      proId: m.agentId || '', proNom: ag ? ag.nom : '',
      prixTotal: m.prixTotal || 0,
      motif, texte,
      montantSouhaite: Math.min(Math.max(0, parseInt(b.montantSouhaite, 10) || 0), m.prixTotal || 0),
      status: 'ouvert', prisPar: '', remboursement: null, motifRefus: '',
      hist: [{ at: nowISO(), par: cli.nom + ' (client)', action: 'ouvert', texte: LITIGE_MOTIFS[motif] + ' — ' + texte }]
    };
    db.litiges.push(it);
    if (db.litiges.length > 5000) db.litiges = db.litiges.slice(-3000);
    litigeMessageClient(it, '🟠 Signalement ' + it.id + ' — mission ' + m.id + ' (' + it.serviceNom + ') : ' + LITIGE_MOTIFS[motif] + '\n« ' + texte + ' »\nNous revenons vers vous ici même.');
    auditLog('litige_ouvert', { id: it.id, mission: m.id, client: cli.nom, motif });
    emitAdmin('litige', '🟠 Nouveau signalement ' + it.id + ' de ' + cli.nom + ' (' + LITIGE_MOTIFS[motif] + ')');
    saveDb();
    console.log('🟠 ' + it.id + ' — signalement de ' + cli.nom + ' sur ' + m.id);
    return sendJson(res, 201, { ok: true, litige: litigePublic(it), message: 'Signalement enregistré. L’équipe KLEAN vous répond ici même, dans vos messages.' });
  }
  if (p === '/api/litiges' && req.method === 'GET') {
    const cli = findClientByToken(req);
    if (!cli) return sendJson(res, 401, { error: 'Connectez-vous pour voir vos signalements', needLogin: true });
    const miens = db.litiges.filter(l => l.clientId === cli.id)
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 50)
      .map(litigePublic);
    return sendJson(res, 200, {
      ok: true, litiges: miens, total: miens.length,
      ouverts: miens.filter(l => ['ouvert', 'en_cours'].includes(l.status)).length,
      rembourses: miens.filter(l => ['rembourse', 'regle'].includes(l.status)).length
    });
  }

  /* ═══════════════ 🎮 JEUX EN DIRECT — côté joueur (lot 101) ═══════════════ */
  if (p === '/api/jeux' && req.method === 'GET') {
    const player = quizPlayerFrom(req, { accountId: url.searchParams.get('who') || '' });
    const debutat = (db.jeux || []).filter(j => j.actif);
    const liste = debutat.map(j => {
      const partie = jeuxPartieActive(j.id);
      const pub = jeuPublic(j, player, partie);
      pub.enCours = !!partie;
      pub.partieStatus = partie ? partie.status : null;
      pub.inscrit = !!(partie && partie.participants.some(x => x.uid === player.id));
      pub.dejaGagne = !!(partie && partie.status === 'termine' && (partie.gagnants || []).some(g => g.uid === player.id));
      return pub;
    }).filter(x => x.peutJouer || x.enCours);
    return sendJson(res, 200, { ok: true, jeux: liste, vitesses: db.vitesses || {}, role: player.role, restantsGlobal: 0 });
  }
  if (p === '/api/jeux/etat' && req.method === 'GET') {
    const player = quizPlayerFrom(req, { accountId: url.searchParams.get('who') || '' });
    const jeu = jeuxTrouverJeu(String(url.searchParams.get('id') || ''));
    if (!jeu) return sendJson(res, 404, { error: 'Jeu introuvable' });
    let session = jeuxPartieActive(jeu.id) || (db.jeuxParties || []).slice().reverse().find(x => x.jeuId === jeu.id && x.status === 'termine') || null;
    /* ⚠️ même sans partie lancée, l'app doit savoir si le jeu est publié pour elle
       (sinon elle croit qu'aucun jeu n'est ouvert alors que le PDG vient de le publier) */
    if (!session) return sendJson(res, 200, {
      ok: true, jeu: jeuInfo(jeu), partie: null, moi: null,
      enCours: false, inscriptionOuverte: jeuInscriptionOuverte(jeu), peutJouer: jeuPeutJouer(player, jeu)
    });
    jeuxTick(session);
    const moi = session.participants.find(x => x.uid === player.id) || null;
    const reste = Math.max(0, Math.round((Date.parse(session.qFinAt || 0) - Date.now()) / 1000));
    const q = session.status === 'en_cours' ? jeuQuestion(jeu, session.qi) : null;
    return sendJson(res, 200, {
      ok: true, jeu: jeuInfo(jeu),
      partie: {
        id: session.id, status: session.status, inscrits: session.participants.length,
        restants: session.participants.filter(x => !x.elimine).length,
        elimines: session.participants.filter(x => x.elimine).length,
        question: q ? { i: q.i, q: q.q, choix: q.choix, niveau: q.niveau } : null,
        niveauTxt: q ? (JEU_NIVEAUX[q.niveau] || '') : '',
        secondes: session.status === 'en_cours' ? reste : 0,
        debutAt: session.debutAt || null, inscriptionFinAt: session.inscriptionFinAt || null,
        gagnants: (session.gagnants || []).map(g => ({ nom: g.nom, photo: g.photo || '' })),
        raisonFin: session.raisonFin || '',
        /* 🔒 anti-triche : la bonne réponse n'est envoyée au joueur QU'APRÈS son vote (ou quand la partie est finie) */
        bonne: (q && (session.status !== 'en_cours' || (moi && moi.repondu))) ? (jeu.questions[session.qi] || {}).bonne : null
      },
      moi: moi ? { inscrit: true, elimine: !!moi.elimine, motif: moi.motif || '', repondu: !!moi.repondu, maReponse: moi.derniereReponse, bon: moi.bon || 0, gagnant: (session.gagnants || []).some(g => g.uid === player.id), photo: !!moi.photo } : { inscrit: false },
      inscriptionOuverte: jeuInscriptionOuverte(jeu),
      peutJouer: jeuPeutJouer(player, jeu)
    });
  }
  if (p === '/api/jeux/inscrire' && req.method === 'POST') {
    const b = await readBody(req);
    const player = quizPlayerFrom(req, b);
    const jeu = jeuxTrouverJeu(String(b.id || ''));
    if (!jeu) return sendJson(res, 404, { error: 'Jeu introuvable' });
    if (!jeu.actif) return sendJson(res, 403, { error: 'Ce jeu n’est pas ouvert' });
    if (!jeuPeutJouer(player, jeu)) {
      const r = (jeu.rest || {}).clients;
      const side = player.role === 'agent' ? 'professionnels' : 'clients';
      const need = (player.role === 'agent' ? (jeu.rest || {}).pros : r) === 'none'
        ? 'réservé à ceux qui n’ont pas encore de mission terminée'
        : 'réservé à ceux qui ont déjà une mission terminée (pas une mission en attente)';
      return sendJson(res, 403, { error: 'Jeu ' + need + ' (' + side + ')' });
    }
    if (!player.id) return sendJson(res, 400, { error: 'Identifiez-vous pour participer (connectez-vous à votre compte KLEAN)' });
    /* ⏰ les retardataires ne peuvent plus rejoindre */
    if (!jeuInscriptionOuverte(jeu)) {
      return sendJson(res, 409, { error: 'Inscriptions fermées : le jeu a déjà commencé ou l’heure limite est dépassée.', ferme: true });
    }
    let session = jeuxPartieActive(jeu.id);
    if (!session) {
      session = { id: uid('JP'), jeuId: jeu.id, nom: jeu.nom, at: nowISO(), par: 'inscription directe', status: 'inscription',
        debutAt: jeu.debutAt || null, inscriptionFinAt: jeu.inscriptionFinAt || null, pointsGagnant: jeu.pointsGagnant || 0,
        participants: [], utilisees: [], qi: -1, reponses: {}, gagnants: [], qFinAt: null };
      db.jeuxParties.push(session);
    }
    if (session.participants.some(x => x.uid === player.id)) return sendJson(res, 200, { ok: true, deja: true, partie: session.id });
    if (session.status === 'termine') return sendJson(res, 409, { error: 'Cette partie est terminée — le prochain jeu arrive bientôt.', ferme: true });
    session.participants.push({ uid: player.id, nom: player.nom || 'Anonyme', role: player.role, at: nowISO(), elimine: false, bon: 0, photo: '' });
    saveDb(); bcAll({ type: 'jeu_maj', at: nowISO() });
    auditLog('jeu_inscription', { jeu: jeu.id, partie: session.id, joueur: player.nom });
    return sendJson(res, 201, { ok: true, partie: session.id, inscrits: session.participants.length, message: 'Vous êtes inscrit ! Restez sur cet écran : la première question arrive.' });
  }
  if (p === '/api/jeux/repondre' && req.method === 'POST') {
    const b = await readBody(req);
    const player = quizPlayerFrom(req, b);
    const jeu = jeuxTrouverJeu(String(b.id || ''));
    if (!jeu) return sendJson(res, 404, { error: 'Jeu introuvable' });
    let session = jeuxTrouverPartie(String(b.partie || '')) || jeuxPartieActive(jeu.id);
    if (!session) return sendJson(res, 404, { error: 'Aucune partie en cours' });
    jeuxTick(session);
    const moi = session.participants.find(x => x.uid === player.id);
    if (!moi) return sendJson(res, 403, { error: 'Vous n’êtes pas inscrit à cette partie' });
    if (session.status !== 'en_cours') return sendJson(res, 409, { error: session.status === 'termine' ? 'Partie terminée' : 'La partie n’a pas encore commencé', status: session.status });
    if (moi.elimine) return sendJson(res, 403, { error: 'Vous avez été éliminé' });
    if (moi.repondu) return sendJson(res, 409, { error: 'Vous avez déjà répondu à cette question' });
    if (Date.now() > Date.parse(session.qFinAt || 0)) { jeuxTick(session); return sendJson(res, 409, { error: 'Temps écoulé pour cette question' }); }
    const q = (jeu.questions || [])[session.qi];
    if (!q) return sendJson(res, 409, { error: 'Aucune question en cours' });
    const choix = parseInt(b.choix, 10);
    moi.repondu = true; moi.derniereReponse = choix;
    const juste = (choix === q.bonne);
    if (juste) moi.bon = (moi.bon || 0) + 1;
    else { moi.elimine = true; moi.motif = 'mauvaise réponse'; }
    saveDb();
    /* tout le monde a répondu → on enchaîne tout de suite */
    const vivants = session.participants.filter(x => !x.elimine);
    const toutRepondu = vivants.every(x => x.repondu);
    if (toutRepondu || !vivants.length) jeuxTick(session);
    bcAll({ type: 'jeu_maj', at: nowISO() });
    return sendJson(res, 200, {
      ok: true, juste, bonne: q.bonne, elimine: !!moi.elimine,
      restants: session.participants.filter(x => !x.elimine).length,
      status: session.status, gagnant: (session.gagnants || []).some(g => g.uid === player.id),
      message: juste ? '✅ Bonne réponse — vous passez à la question suivante' : '✕ Mauvaise réponse — vous êtes éliminé, merci d’avoir joué !'
    });
  }
  /* 📸 photo du gagnant — TOUJOURS FACULTATIVE (la victoire est validée même sans photo) */
  if (p === '/api/jeux/photo' && req.method === 'POST') {
    const b = await readBody(req);
    const player = quizPlayerFrom(req, b);
    const session = jeuxTrouverPartie(String(b.partie || '')) || jeuxPartieActive(String(b.id || ''));
    if (!session) return sendJson(res, 404, { error: 'Aucune partie' });
    const moi = session.participants.find(x => x.uid === player.id);
    if (!moi) return sendJson(res, 403, { error: 'Vous n’êtes pas inscrit à cette partie' });
    if (!(session.gagnants || []).some(g => g.uid === player.id)) return sendJson(res, 403, { error: 'La photo est réservée au gagnant' });
    const img = String(b.photo || '');
    if (img && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]{100,}$/.test(img)) return sendJson(res, 400, { error: 'Image illisible (JPG, PNG ou WEBP)' });
    if (img.length > 900000) return sendJson(res, 413, { error: 'Photo trop lourde (maximum ~600 Ko après compression)' });
    moi.photo = img; session.gagnants.forEach(g => { if (g.uid === player.id) g.photo = img; });
    auditLog('jeu_photo', { partie: session.id, par: player.nom, avecPhoto: !!img });
    saveDb();
    return sendJson(res, 200, { ok: true, message: img ? '📸 Photo ajoutée à votre victoire' : 'Photo retirée — votre victoire reste validée' });
  }

  /* 📞 coordonnées publiques de Klean-Service — sans mot de passe (ce sont des coordonnées publiques),
     mais on n'y met JAMAIS autre chose que ce que le PDG a saisi. */
  if (p === '/api/support/infos' && req.method === 'GET') {
    const c = (db.config && db.config.contact) || {};
    return sendJson(res, 200, { ok: true, tel: String(c.tel || ''), whatsapp: String(c.whatsapp || c.tel || '') });
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
    /* 📞 coordonnées publiques : le PDG peut les renseigner (jamais modifiées par une autre voie) */
    if (b2.contactTel !== undefined || b2.contactWhatsapp !== undefined) {
      db.config.contact = db.config.contact || { tel: '', whatsapp: '' };
      const avant = JSON.stringify(db.config.contact);
      if (b2.contactTel !== undefined) db.config.contact.tel = String(b2.contactTel || '').trim().slice(0, 30);
      if (b2.contactWhatsapp !== undefined) db.config.contact.whatsapp = String(b2.contactWhatsapp || '').trim().slice(0, 30);
      auditLog('contact_modifie', { avant, apres: JSON.stringify(db.config.contact), par: act(req) });
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
    const mediaOk = !adA || pubFichierPresent(adA.mediaUrl);
    return sendJson(res, 200, {
      ad: adA ? Object.assign({}, adA, { views: undefined }) : null,
      views: adA && adA.views ? Object.keys(adA.views).length : 0,
      mediaOk,                       /* 🖼️ false = le fichier n'est plus sur le disque → renvoyer l'image */
      mediaRestaurable: !!(adA && adA.mediaUrl && db.pubFiles && db.pubFiles[String(adA.mediaUrl).replace(/^\/pub\//, '')]),
      conseilMedia: mediaOk ? '' : 'Le fichier de ce média a été perdu lors d’un redéploiement (disque vidé). Renvoyez-le depuis cette page : à partir de maintenant il est conservé dans la base.'
    });
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
    pubMediaMemoriser(nom, buf);          /* 🖼️ copie dans la base : survit au redéploiement */
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

  /* ═══════════ 💾 SAUVEGARDES & RESTAURATION (lot 98 — PDG uniquement) ═══════════ */
  if (p === '/api/admin/db/etat' && req.method === 'GET') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    return sendJson(res, 200, Object.assign({ ok: true, liste: await sauvegardesListe() }, stockageInfo()));
  }
  /* téléchargement : un fichier klean-db-AAAAMMJJ.json à garder sur votre téléphone */
  if (p === '/api/admin/db/sauvegarde' && req.method === 'GET') {
    if (!pdgOnly(req, res)) return;
    const nom = 'klean-db-' + nowISO().slice(0, 10) + '.json';
    const corps = JSON.stringify({ klean: 'sauvegarde', at: nowISO(), dossiers: _nbDossiers(), db }, null, 1);
    auditLog('sauvegarde_telechargee', { par: act(req), dossiers: _nbDossiers(), taille: corps.length });
    saveDb();
    emitAdmin('admin', '💾 Sauvegarde téléchargée par ' + act(req));
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + nom + '"',
      'Cache-Control': 'no-store'
    });
    return res.end(corps);
  }
  /* restauration depuis un fichier (le fichier téléchargé ci-dessus) */
  if (p === '/api/admin/db/restaurer' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBodyBig(req, 3e7);
    if (!b) return sendJson(res, 400, { error: 'Fichier trop lourd (maximum 30 Mo) ou illisible' });
    if (String(b.confirmation || '').trim().toUpperCase() !== 'RESTAURER')
      return sendJson(res, 400, { error: 'Pour valider, écrivez exactement RESTAURER dans la case de confirmation' });
    const data = (b.data && b.data.db) ? b.data.db : b.data;      /* accepte le fichier complet ou la base seule */
    const pb = dbInvalide(data);
    if (pb) return sendJson(res, 400, { error: pb });
    const avant = _nbDossiers();
    const vide = ((data.agents || []).length + (data.clients || []).length + (data.missions || []).length) === 0;
    if (vide && avant > 0 && !b.force)
      return sendJson(res, 409, { code: 'vide', error: 'Cette sauvegarde est VIDE alors que la base contient ' + avant + ' dossier(s). Si c’est bien ce que vous voulez, cochez « j’accepte de repartir de zéro ».' });
    await sauvegardeAuto(true);                                  /* 🛡️ garde l'état ACTUEL dans l'historique */
    copieAvantRestauration();                                    /* 🛡️ + une copie de fichier */
    const ancienAdmin = db.admin;
    db = data; poserDefauts();
    if (!db.admin && ancienAdmin) db.admin = ancienAdmin;         /* votre mot de passe HQ n'est jamais perdu */
    auditLog('base_restauree', { par: act(req), source: 'fichier', avant, apres: _nbDossiers() });
    emitAdmin('admin', '♻️ Base restaurée depuis un fichier par ' + act(req) + ' — ' + _nbDossiers() + ' dossier(s)');
    saveDbNow();
    return sendJson(res, 200, { ok: true, avant, dossiers: _nbDossiers(), message: 'Sauvegarde restaurée : ' + _nbDossiers() + ' dossier(s) en place.' });
  }
  /* restauration depuis une sauvegarde automatique (Neon) */
  if (p === '/api/admin/db/sauvegardes/restaurer' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    if (!pgClient) return sendJson(res, 400, { error: 'Aucune sauvegarde automatique : le stockage permanent (Postgres/Neon) n’est pas activé.' });
    const b = await readBody(req);
    const id = parseInt(b.id, 10) || 0;
    const r = await pgClient.query('SELECT data FROM klean_backups WHERE id=$1', [id]);
    if (!r.rows.length) return sendJson(res, 404, { error: 'Sauvegarde introuvable' });
    const data = r.rows[0].data;
    const pb = dbInvalide(data);
    if (pb) return sendJson(res, 400, { error: pb });
    const avant = _nbDossiers();
    copieAvantRestauration();
    const ancienAdmin = db.admin;
    db = data; poserDefauts();
    if (!db.admin && ancienAdmin) db.admin = ancienAdmin;
    auditLog('base_restauree', { par: act(req), source: 'neon#' + id, avant, apres: _nbDossiers() });
    emitAdmin('admin', '♻️ Base restaurée depuis une sauvegarde automatique — ' + _nbDossiers() + ' dossier(s)');
    saveDbNow();
    return sendJson(res, 200, { ok: true, avant, dossiers: _nbDossiers(), message: 'Version du ' + (r.rows[0].at ? String(r.rows[0].at).slice(0, 16).replace('T', ' · ') : '') + ' restaurée.' });
  }
  /* ═══════════ 🟠 LITIGES : instruction côté HQ (lot 99) ═══════════
     Prise en charge + réponse : PDG et gestionnaires · DÉCISION (rembourser/refuser) : PDG seul. */
  if (p === '/api/admin/litiges' && req.method === 'GET') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const liste = db.litiges.slice().sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 200).map(l => Object.assign(litigePublic(l), {
      clientNom: l.clientNom || '', clientTel: l.clientTel || '', proNom: l.proNom || '',
      prisPar: l.prisPar || '', peutDecider: isPdg(req), hist: (l.hist || []).slice(-40)
    }));
    const c = { total: liste.length, ouverts: 0, enCours: 0, aPayer: 0, regles: 0, refuses: 0, totalAccepte: 0, totalVerse: 0 };
    db.litiges.forEach(l => {
      if (l.status === 'ouvert') c.ouverts++;
      else if (l.status === 'en_cours') c.enCours++;
      else if (l.status === 'rembourse') { c.aPayer++; c.totalAccepte += (l.remboursement && l.remboursement.montant) || 0; }
      else if (l.status === 'regle') { c.regles++; c.totalVerse += (l.remboursement && l.remboursement.montant) || 0; }
      else if (l.status === 'refuse') c.refuses++;
      if (l.remboursement && l.remboursement.statut === 'paye' && l.status !== 'regle') c.totalVerse += l.remboursement.montant || 0;
    });
    c.motifs = LITIGE_MOTIFS; c.moyens = LITIGE_MOYENS;
    return sendJson(res, 200, { ok: true, liste, compteurs: c, argentDeplace: false });
  }
  /* le gestionnaire (ou le PDG) prend le dossier en charge */
  if (p === '/api/admin/litiges/prise' && req.method === 'POST') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const b = await readBody(req);
    const l = db.litiges.find(x => x.id === String(b.id || ''));
    if (!l) return sendJson(res, 404, { error: 'Dossier introuvable' });
    if (['regle', 'refuse'].includes(l.status)) return sendJson(res, 409, { error: 'Ce dossier est déjà clos (' + (LITIGE_STATUS[l.status] || l.status) + ')' });
    l.status = 'en_cours'; l.prisPar = act(req); l.majAt = nowISO();
    l.hist.push({ at: nowISO(), par: act(req), action: 'prise', texte: 'Dossier pris en charge' });
    litigeMessageClient(l, '👋 ' + act(req) + ' (KLEAN) examine votre signalement ' + l.id + '. Réponse ici même.');
    auditLog('litige_prise', { id: l.id, par: act(req) });
    emitAdmin('litige', '🟠 ' + act(req) + ' prend en charge ' + l.id);
    saveDb();
    return sendJson(res, 200, { ok: true, litige: litigePublic(l) });
  }
  /* réponse à écrire au client (elle part dans sa messagerie) */
  if (p === '/api/admin/litiges/message' && req.method === 'POST') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const b = await readBody(req);
    const l = db.litiges.find(x => x.id === String(b.id || ''));
    if (!l) return sendJson(res, 404, { error: 'Dossier introuvable' });
    const texte = String(b.texte || '').trim().slice(0, 900);
    if (texte.length < 2) return sendJson(res, 400, { error: 'Écrivez votre message' });
    const auClient = b.auClient !== false;
    l.hist.push({ at: nowISO(), par: act(req), action: auClient ? 'message' : 'note', texte, interne: !auClient });
    l.majAt = nowISO();
    if (auClient) litigeMessageClient(l, '🟠 Dossier ' + l.id + ' — ' + act(req) + ' (KLEAN) : ' + texte);
    if (l.status === 'ouvert') { l.status = 'en_cours'; l.prisPar = act(req); }
    auditLog('litige_message', { id: l.id, auClient, par: act(req) });
    saveDb();
    return sendJson(res, 200, { ok: true, litige: litigePublic(l) });
  }
  /* 🔑 LA DÉCISION — réservée au PDG : rembourser (montant) ou refuser (motif obligatoire) */
  if (p === '/api/admin/litiges/decision' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const l = db.litiges.find(x => x.id === String(b.id || ''));
    if (!l) return sendJson(res, 404, { error: 'Dossier introuvable' });
    if (['rembourse', 'regle', 'refuse'].includes(l.status))
      return sendJson(res, 409, { error: 'Ce dossier est déjà tranché (' + (LITIGE_STATUS[l.status] || l.status) + ')' });
    if (b.decision === 'rembourser') {
      const plafond = l.prixTotal || 0;
      const montant = Math.min(Math.max(0, parseInt(b.montant, 10) || 0), plafond);
      if (montant <= 0) return sendJson(res, 400, { error: 'Indiquez le montant à rembourser (entre 1 et ' + plafond.toLocaleString('fr-FR') + ' F)' });
      const moyen = LITIGE_MOYENS[b.moyen] ? b.moyen : 'especes';
      l.remboursement = { montant, moyen, statut: 'a_payer', at: nowISO(), par: act(req), ref: '', payeAt: null };
      l.status = 'rembourse'; l.majAt = nowISO();
      l.hist.push({ at: nowISO(), par: act(req), action: 'decision', texte: 'Remboursement accepté : ' + montant.toLocaleString('fr-FR') + ' F (' + LITIGE_MOYENS[moyen] + ') — versement à effectuer' });
      litigeMessageClient(l, '✅ Dossier ' + l.id + ' — décision KLEAN : remboursement de ' + montant.toLocaleString('fr-FR') + ' F accepté (' + LITIGE_MOYENS[moyen] + '). Le versement est enregistré et sera effectué sous 48 h.');
      auditLog('litige_decision', { id: l.id, decision: 'rembourser', montant, moyen, par: act(req), argentDeplace: false });
      emitAdmin('litige', '✅ Remboursement de ' + montant.toLocaleString('fr-FR') + ' F accepté sur ' + l.id + ' — à verser');
      saveDb();
      return sendJson(res, 200, { ok: true, litige: litigePublic(l), argentDeplace: false, message: 'Décision enregistrée. ⚠️ Aucun argent n’est déplacé automatiquement : faites le versement puis marquez-le « payé ».' });
    }
    if (b.decision === 'refuser') {
      const motif = String(b.motif || '').trim().slice(0, 400);
      if (motif.length < 5) return sendJson(res, 400, { error: 'Indiquez le motif du refus : le client le lira' });
      l.status = 'refuse'; l.motifRefus = motif; l.majAt = nowISO();
      l.hist.push({ at: nowISO(), par: act(req), action: 'decision', texte: 'Refusé — ' + motif });
      litigeMessageClient(l, '✕ Dossier ' + l.id + ' — décision KLEAN : aucune indemnisation.\nMotif : ' + motif + '\nVous pouvez répondre ici si vous avez de nouveaux éléments.');
      auditLog('litige_decision', { id: l.id, decision: 'refuser', motif, par: act(req) });
      emitAdmin('litige', '✕ Refus enregistré sur ' + l.id);
      saveDb();
      return sendJson(res, 200, { ok: true, litige: litigePublic(l) });
    }
    return sendJson(res, 400, { error: 'Décision inconnue (attendu : rembourser ou refuser)' });
  }
  /* 💸 le PDG a versé : on l'enregistre (aucun débit automatique n'existe) */
  if (p === '/api/admin/litiges/regle' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const l = db.litiges.find(x => x.id === String(b.id || ''));
    if (!l) return sendJson(res, 404, { error: 'Dossier introuvable' });
    if (!l.remboursement) return sendJson(res, 400, { error: 'Aucun remboursement accepté sur ce dossier' });
    if (l.remboursement.statut === 'paye') return sendJson(res, 409, { error: 'Déjà marqué payé' });
    l.remboursement.statut = 'paye'; l.remboursement.payeAt = nowISO(); l.remboursement.ref = String(b.ref || '').trim().slice(0, 60);
    l.remboursement.payePar = act(req);
    l.status = 'regle'; l.majAt = nowISO();
    l.hist.push({ at: nowISO(), par: act(req), action: 'versement', texte: 'Versement effectué (' + l.remboursement.montant.toLocaleString('fr-FR') + ' F' + (l.remboursement.ref ? ' — réf. ' + l.remboursement.ref : '') + ')' });
    litigeMessageClient(l, '💸 Dossier ' + l.id + ' — le remboursement de ' + l.remboursement.montant.toLocaleString('fr-FR') + ' F a été versé' + (l.remboursement.ref ? (' (référence ' + l.remboursement.ref + ')') : '') + '. Merci de votre confiance.');
    auditLog('litige_regle', { id: l.id, montant: l.remboursement.montant, ref: l.remboursement.ref, par: act(req) });
    emitAdmin('litige', '💸 Remboursement versé sur ' + l.id + ' (' + l.remboursement.montant.toLocaleString('fr-FR') + ' F)');
    saveDb();
    return sendJson(res, 200, { ok: true, litige: litigePublic(l) });
  }

  /* ═══════════════ 🎮 JEUX (lot 101) — création, programmation, parties en direct ═══════════════ */
  if (p === '/api/admin/jeux' && req.method === 'GET') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const parties = (db.jeuxParties || []).slice(-40).reverse().map(x => ({
      id: x.id, jeuId: x.jeuId, nom: x.nom, status: x.status, at: x.at, qi: x.qi,
      total: x.participants.length, restants: x.participants.filter(y => !y.elimine).length,
      gagnants: x.gagnants || [], raisonFin: x.raisonFin || '', debutAt: x.debutAt || null, qFinAt: x.qFinAt || null
    }));
    return sendJson(res, 200, { ok: true, jeux: (db.jeux || []).map(jeuInfo), parties, vitesses: db.vitesses || {}, themes: JEU_THEMES, placements: JEU_PLACEMENTS, niveaux: JEU_NIVEAUX });
  }
  if (p === '/api/admin/jeux' && req.method === 'POST') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const b = await readBody(req);
    const id = String(b.id || '').trim();
    let jeu = id ? jeuxTrouverJeu(id) : null;
    const neuf = !jeu;
    if (!jeu) {
      jeu = { id: uid('GX'), creeAt: nowISO(), creePar: act(req), questions: [], actif: false };
      db.jeux.push(jeu);
    }
    if (b.nom !== undefined) jeu.nom = String(b.nom || '').trim().slice(0, 60);
    if (neuf && jeu.nom.length < 3) { db.jeux = db.jeux.filter(x => x.id !== jeu.id); return sendJson(res, 400, { error: 'Donnez un nom au jeu (3 caractères minimum)' }); }
    if (b.theme !== undefined) jeu.theme = JEU_THEMES[b.theme] ? b.theme : (jeu.theme || 'francais');
    if (b.placement !== undefined && b.placement && typeof b.placement === 'object')
      jeu.placement = { accueil: !!b.placement.accueil, profils: !!b.placement.profils, autres: !!b.placement.autres };
    if (b.rest !== undefined && b.rest)
      jeu.rest = { clients: JEU_REST.includes(b.rest.clients) ? b.rest.clients : 'all', pros: JEU_REST.includes(b.rest.pros) ? b.rest.pros : 'all' };
    if (b.debutAt !== undefined) jeu.debutAt = b.debutAt ? String(b.debutAt).slice(0, 24) : null;
    if (b.inscriptionFinAt !== undefined) jeu.inscriptionFinAt = b.inscriptionFinAt ? String(b.inscriptionFinAt).slice(0, 24) : null;
    if (b.dureeQuestion !== undefined) jeu.dureeQuestion = Math.max(5, Math.min(120, parseInt(b.dureeQuestion, 10) || 20));
    if (b.progresDifficulte !== undefined) jeu.progresDifficulte = !!b.progresDifficulte;
    if (b.pointsGagnant !== undefined) jeu.pointsGagnant = Math.max(0, Math.min(1000, parseInt(b.pointsGagnant, 10) || 0));
    if (b.ia !== undefined) jeu.ia = b.ia && typeof b.ia === 'object' ? {
      actif: !!b.ia.actif, theme: JEU_THEMES[b.ia.theme] ? b.ia.theme : 'francais', nb: Math.max(3, Math.min(30, parseInt(b.ia.nb, 10) || 8)),
      niveau: Math.max(1, Math.min(3, parseInt(b.ia.niveau, 10) || 1)), langue: String(b.ia.langue || 'français').slice(0, 20),
      type: ['qcm', 'vraifaux'].includes(b.ia.type) ? b.ia.type : 'qcm', progression: b.ia.progression !== false
    } : null;
    if (Array.isArray(b.questions)) {
      jeu.questions = b.questions.filter(x => x && x.q && Array.isArray(x.choix) && x.choix.length >= 2).slice(0, 40).map(x => ({
        q: String(x.q).slice(0, 200), choix: x.choix.slice(0, 4).map(c => String(c).slice(0, 80)),
        bonne: Math.max(0, Math.min(x.choix.length - 1, parseInt(x.bonne, 10) || 0)),
        niveau: Math.max(1, Math.min(3, parseInt(x.niveau, 10) || 1)), source: String(x.source || 'administrateur').slice(0, 30)
      }));
    }
    jeu.majAt = nowISO(); jeu.majPar = act(req);
    auditLog('jeu_enregistre', { id: jeu.id, nom: jeu.nom, questions: jeu.questions.length, par: act(req) });
    emitAdmin('jeu', '🎮 Jeu « ' + jeu.nom + ' » enregistré (' + jeu.questions.length + ' question(s))');
    saveDb();
    bcAll({ type: 'jeu_maj', at: nowISO() });
    return sendJson(res, 200, { ok: true, jeu: jeuInfo(jeu), nouveau: neuf });
  }
  if (p === '/api/admin/jeux/actif' && req.method === 'POST') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const b = await readBody(req);
    const jeu = jeuxTrouverJeu(String(b.id || ''));
    if (!jeu) return sendJson(res, 404, { error: 'Jeu introuvable' });
    if (b.actif && !(jeu.questions || []).length) return sendJson(res, 400, { error: 'Ajoutez d’abord des questions (banque ou génération automatique)' });
    jeu.actif = !!b.actif; jeu.majAt = nowISO(); jeu.majPar = act(req);
    auditLog('jeu_actif', { id: jeu.id, actif: jeu.actif, par: act(req) });
    saveDb();
    bcAll({ type: 'jeu_maj', at: nowISO() });
    return sendJson(res, 200, { ok: true, jeu: jeuInfo(jeu), message: jeu.actif ? 'Jeu activé : il apparaît selon vos emplacements.' : 'Jeu désactivé : les joueurs ne le voient plus.' });
  }
  if (p === '/api/admin/jeux' && req.method === 'DELETE') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const id = String(url.searchParams.get('id') || '');
    const av = (db.jeux || []).length;
    db.jeux = (db.jeux || []).filter(x => x.id !== id);
    if (db.jeux.length === av) return sendJson(res, 404, { error: 'Jeu introuvable' });
    auditLog('jeu_supprime', { id, par: act(req) });
    saveDb();
    return sendJson(res, 200, { ok: true });
  }
  /* 🤖 génération des questions — « banque » ou « automatique » (générateur intégré / IA si une clé est fournie) */
  if (p === '/api/admin/jeux/generer' && req.method === 'POST') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const b = await readBody(req);
    const opt = b && b.ia && typeof b.ia === 'object' ? b.ia : b || {};
    const res2 = await jeuGenererIA(opt);
    const qs = res2.questions;
    auditLog('jeu_questions_generees', { mode: res2.mode, nb: qs.length, par: act(req) });
    return sendJson(res, 200, {
      ok: true, questions: qs, mode: res2.mode, erreur: res2.erreur || '',
      message: res2.mode === 'ia' ? 'Questions générées par IA — relisez-les avant de les enregistrer.' :
        'Questions proposées par le générateur intégré (aucune clé IA configurée) — relisez-les avant d’enregistrer.'
    });
  }
  /* ▶️ lancer une partie (inscriptions ouvertes maintenant, ou à l'heure programmée) */
  if (p === '/api/admin/jeux/partie/lancer' && req.method === 'POST') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const b = await readBody(req);
    const jeu = jeuxTrouverJeu(String(b.id || ''));
    if (!jeu) return sendJson(res, 404, { error: 'Jeu introuvable' });
    if (!(jeu.questions || []).length) return sendJson(res, 400, { error: 'Ce jeu n’a aucune question' });
    const deja = jeuxPartieActive(jeu.id);
    if (deja) return sendJson(res, 409, { error: 'Une partie est déjà en cours sur ce jeu (' + deja.id + ')' });
    const futur = jeu.debutAt && Date.now() < new Date(jeu.debutAt).getTime();
    const session = {
      id: uid('JP'), jeuId: jeu.id, nom: jeu.nom, at: nowISO(), par: act(req),
      status: futur ? 'inscription' : 'en_cours', debutAt: jeu.debutAt || null,
      inscriptionFinAt: jeu.inscriptionFinAt || null,
      pointsGagnant: jeu.pointsGagnant || 0,
      participants: [], utilisees: [], qi: -1, reponses: {}, gagnants: [], qFinAt: null
    };
    db.jeuxParties.push(session);
    if (db.jeuxParties.length > 200) db.jeuxParties = db.jeuxParties.slice(-120);
    if (!futur) {
      if (!session.participants.length) { session.status = 'inscription'; }
      else jeuxOuvrirQuestion(session, jeu, 'début immédiat');
    }
    auditLog('jeu_lance', { jeu: jeu.id, partie: session.id, futur, par: act(req) });
    saveDb();
    bcAll({ type: 'jeu_maj', at: nowISO() });
    return sendJson(res, 200, { ok: true, partie: session.id, status: session.status, message: futur ? ('Inscriptions ouvertes jusqu’au début du jeu (' + String(jeu.debutAt).slice(0, 16).replace('T', ' à ') + ')') : 'Partie lancée : la première question est affichée.' });
  }
  if (p === '/api/admin/jeux/partie/suivant' && req.method === 'POST') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const b = await readBody(req);
    const session = jeuxTrouverPartie(String(b.id || ''));
    if (!session) return sendJson(res, 404, { error: 'Partie introuvable' });
    if (session.status === 'termine') return sendJson(res, 409, { error: 'Cette partie est terminée' });
    const jeu = jeuxTrouverJeu(session.jeuId); if (!jeu) return sendJson(res, 404, { error: 'Jeu introuvable' });
    /* ⏱️ passer à la question suivante élimine, comme l'horloge, ceux qui n'ont pas répondu */
    session.qFinAt = new Date(Date.now() - 1000).toISOString();
    const sortis = jeuxEliminerNonRepondants(session);
    if (sortis) session.raison = sortis + ' joueur(s) éliminé(s) — temps écoulé';
    const r = jeuxOuvrirQuestion(session, jeu, 'question suivante (organisateur)');
    saveDb(); bcAll({ type: 'jeu_maj', at: nowISO() });
    return sendJson(res, 200, { ok: true, fin: !!r.fin, status: session.status, restants: session.participants.filter(p => !p.elimine).length });
  }
  if (p === '/api/admin/jeux/partie/clore' && req.method === 'POST') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const b = await readBody(req);
    const session = jeuxTrouverPartie(String(b.id || ''));
    if (!session) return sendJson(res, 404, { error: 'Partie introuvable' });
    const jeu = jeuxTrouverJeu(session.jeuId) || { nom: session.nom, questions: [] };
    if (session.status !== 'termine') jeuxTerminer(session, jeu, 'clôturée par ' + act(req));
    saveDb(); bcAll({ type: 'jeu_maj', at: nowISO() });
    return sendJson(res, 200, { ok: true, gagnants: session.gagnants || [] });
  }
  /* 📊 suivi en direct : le tableau de bord voit le nombre de survivants diminuer */
  if (p === '/api/admin/jeux/live' && req.method === 'GET') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const id = String(url.searchParams.get('id') || '');
    let session = id ? jeuxTrouverPartie(id) : null;
    if (!session) session = (db.jeuxParties || []).slice().reverse().find(x => x.status !== 'termine')
      || (db.jeuxParties || []).slice(-1)[0] || null;      /* 🏁 partie finie : le HQ garde le résultat affiché */
    if (!session) return sendJson(res, 200, { ok: true, partie: null, vide: true });
    jeuxTick(session);
    const jeu = jeuxTrouverJeu(session.jeuId);
    const reste = Math.max(0, Math.round((Date.parse(session.qFinAt || 0) - Date.now()) / 1000));
    return sendJson(res, 200, {
      ok: true,
      partie: {
        id: session.id, jeuId: session.jeuId, nom: session.nom, status: session.status, qi: session.qi,
        total: session.participants.length, restants: session.participants.filter(p => !p.elimine).length,
        elimines: session.participants.filter(p => p.elimine).length,
        question: session.status === 'en_cours' ? (jeuQuestion(jeu, session.qi) || null) : null,
        secondes: session.status === 'en_cours' ? Math.max(0, reste) : 0,
        nbQuestions: jeu ? (jeu.questions || []).length : 0, posees: (session.utilisees || []).length,
        debutAt: session.debutAt || null, gagnants: session.gagnants || [], raisonFin: session.raisonFin || '',
        participants: session.participants.map(p => ({ nom: p.nom, role: p.role, elimine: !!p.elimine, repondu: !!p.repondu, bon: p.bon || 0, motif: p.motif || '', photo: !!p.photo, inscritAt: p.at }))
      }
    });
  }
  /* ⚙️ les vitesses d'affichage (indépendantes) : Publicités, Jeux, Urgence, Informations */
  if (p === '/api/admin/vitesses' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const v = db.vitesses || {};
    ['pub', 'jeux', 'urgence', 'infos'].forEach(k => { if (b[k] !== undefined) v[k] = Math.max(0.5, Math.min(15, Number(b[k]) || 3.2)); });
    db.vitesses = v;
    auditLog('vitesses', { par: act(req), vitesses: v });
    saveDb(); bcAll({ type: 'vitesses', vitesses: v });
    return sendJson(res, 200, { ok: true, vitesses: v });
  }

  if (p === '/api/admin/whoami' && req.method === 'GET') {
    const id = hqIdentity(req);
    return sendJson(res, 200, { role: id.role, nom: id.nom, gestFrozen: !!(db.config && db.config.gestFrozen), stockage: stockageInfo() });
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

  /* ═══════════════ 💰 MOTEUR DE TARIFICATION (tableau de bord PDG) ═══════════════ */
  /* ═══════════ 🤝 MISE EN RELATION — vue des gestionnaires (traçabilité complète) ═══════════ */
  if (p === '/api/admin/rel' && req.method === 'GET') {
    if (!hqIdentity(req)) return sendJson(res, 401, { error: 'Connexion requise' });
    const C = relConfig();
    const avec = db.missions.filter(x => x.rel && (x.rel.pros || []).length);
    const liste = avec.slice(-200).reverse().map(x => {
      const r = x.rel;
      return { missionId: x.id, client: (x.client || {}).nom || (db.clients.find(c => c.id === x.clientId) || {}).nom || '—',
        service: x.service, ville: x.ville || '', etat: r.etat, etatTxt: REL_ETATS[r.etat] || r.etat, etape: relEtape(x),
        pros: (r.pros || []).map(p => ({ rang: p.rang, tour: p.tour || 1, nom: p.nom, sens: p.sens, at: p.at, motif: p.motif || '' })),
        prochaineLe: r.prochaineLe || null, signale: !!r.signale,
    etatHisto: (r.etatHisto || []).slice(-12), nbMsgs: (r.msgs || []).length,
        prix: x.devis ? { version: x.devis.version, total: x.devis.total, statut: x.devis.statut } : null,
        prixVerrouille: x.prixVerrouille || null, createdAt: x.createdAt || '' };
    });
    return sendJson(res, 200, { ok: true, config: C, relations: liste, nb: liste.length,
      contournements: (db.contournements || []).slice(-200).reverse(),
      nbContournements: (db.contournements || []).length,
      regle: 'UNE DEMANDE → PROFESSIONNEL 1 → (s’il refuse) PROFESSIONNEL 2 → FIN. Jamais de 3ᵉ mise en relation automatique ; '
           + 'après le 2ᵉ, la demande se reprend le jour suivant. Conversation courte, prix dans la bulle PRIX, verrouillé à l’acceptation.' });
  }
  if (p === '/api/admin/rel' && req.method === 'POST') {
    if (!isPdg(req)) return sendJson(res, 403, { error: 'Réglage réservé au compte principal (PDG)' });
    const b = await readBody(req);
    const C = relConfig();
    const avant = JSON.stringify({ maxProsParTour: C.maxProsParTour, maxProsParJour: C.maxProsParJour, msgMaxParCote: C.msgMaxParCote, msgMaxCar: C.msgMaxCar, repriseHeures: C.repriseHeures, anti: C.anti });
    if (b.maxProsParTour !== undefined) C.maxProsParTour = Math.max(1, Math.min(2, parseInt(b.maxProsParTour, 10) || 2));   /* jamais plus de 2 : règle du PDG */
    if (b.maxProsParJour !== undefined) C.maxProsParJour = Math.max(1, Math.min(10, parseInt(b.maxProsParJour, 10) || 2));
    if (b.msgMaxParCote !== undefined) C.msgMaxParCote = Math.max(2, Math.min(30, parseInt(b.msgMaxParCote, 10) || 8));
    if (b.msgMaxCar !== undefined) C.msgMaxCar = Math.max(80, Math.min(600, parseInt(b.msgMaxCar, 10) || 240));
    if (b.repriseHeures !== undefined) C.repriseHeures = Math.max(1, Math.min(48, parseInt(b.repriseHeures, 10) || 12));
    if (b.anti && typeof b.anti === 'object') {
      if (b.anti.actif !== undefined) C.anti.actif = !!b.anti.actif;
      if (b.anti.bloquer !== undefined) C.anti.bloquer = !!b.anti.bloquer;
      if (b.anti.signalerApres !== undefined) C.anti.signalerApres = Math.max(2, Math.min(10, parseInt(b.anti.signalerApres, 10) || 3));
    }
    if (Array.isArray(b.rapidesPro)) C.rapides.pro = b.rapidesPro.map(x => String(x).slice(0, 60)).filter(x => x).slice(0, 8);
    if (Array.isArray(b.rapidesClient)) C.rapides.client = b.rapidesClient.map(x => String(x).slice(0, 60)).filter(x => x).slice(0, 8);
    C.version = (C.version || 1) + 1;
    auditLog('relation_config', { version: C.version, par: 'PDG', avant: avant.slice(0, 300), apres: JSON.stringify({ maxProsParTour: C.maxProsParTour, maxProsParJour: C.maxProsParJour, msgMaxParCote: C.msgMaxParCote, msgMaxCar: C.msgMaxCar, anti: C.anti }).slice(0, 300) });
    saveDb();
    return sendJson(res, 200, { ok: true, config: C, version: C.version });
  }
  const mAdminRel = p.match(/^\/api\/admin\/rel\/([^/]+)$/);
  if (mAdminRel && req.method === 'GET') {                     /* 🔎 le dossier complet d'une demande (litige) */
    if (!hqIdentity(req)) return sendJson(res, 401, { error: 'Connexion requise' });
    const m = db.missions.find(x => x.id === mAdminRel[1]);
    if (!m) return sendJson(res, 404, { error: 'Demande introuvable' });
    return sendJson(res, 200, { ok: true, rel: relPublique(m), journal: (db.devisJournal || []).filter(j => j.missionId === m.id).slice(-60),
      contournements: (db.contournements || []).filter(c => c.missionId === m.id),
      paiement: { moyen: m.paiement || 'cash', verrou: m.prixVerrouille || null, dist: m.dist || null }, status: m.status });
  }
  if (p === '/api/admin/rel/fermer' && req.method === 'POST') {  /* ⛔ le gestionnaire arrête une relation à problème */
    if (!hqIdentity(req)) return sendJson(res, 401, { error: 'Connexion requise' });
    const b = await readBody(req);
    const m = db.missions.find(x => x.id === String(b.missionId || ''));
    if (!m) return sendJson(res, 404, { error: 'Demande introuvable' });
    const r = relDe(m);
    relSetEtat(r, 'annulee', 'arrêt par un gestionnaire'); r.annuleAt = nowISO(); r.signale = true;
    relJournal(r, 'arret_gestionnaire', (hqIdentity(req) || {}).nom || 'gestionnaire', 'hq', String(b.motif || '').slice(0, 200));
    relMsgsys(r, '⛔ Relation arrêtée par Klean' + (b.motif ? ' — « ' + String(b.motif).slice(0, 120) + ' »' : '') + '.', 'alerte');
    m.status = 'annulee'; saveDb();
    auditLog('relation_arret', { missionId: m.id, motif: String(b.motif || '').slice(0, 160) });
    return sendJson(res, 200, { ok: true, rel: relPublique(m) });
  }

  /* ═══════════ 📜 CONDITIONS KLEAN (tableau de bord PDG) ═══════════ */
  if (p === '/api/admin/conditions' && req.method === 'GET') {
    if (!pdgOnly(req, res)) return;
    conditionsEnsure();
    const C = db.conditions;
    const parVersion = {};
    (C.acceptations || []).forEach(a => { parVersion[a.role + ' v' + a.version] = (parVersion[a.role + ' v' + a.version] || 0) + 1; });
    return sendJson(res, 200, { ok: true, version: C.version, maj: C.maj, source: C.source, exigee: C.exigee !== false,
      client: C.client, pro: C.pro, versions: (C.versions || []).slice(-40).reverse(),
      acceptations: (C.acceptations || []).slice(-300).reverse(), nbAcceptations: (C.acceptations || []).length,
      parVersion, journal: (C.journal || []).slice(-120).reverse(),
      regle: 'Le PDG publie le texte (version + date). Un client ou un pro ne devient utilisateur qu’en ACCEPTANT la version en vigueur ; '
           + 'chaque acceptation est une preuve (qui, rôle, version, date, heure, appareil, IP). Publier une nouvelle version n’efface rien : '
           + 'les acceptations passées restent attachées à leur version, et les utilisateurs doivent relire et ré-accepter.' });
  }
  if (p === '/api/admin/conditions' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const action = String(b.action || '').slice(0, 20);
    conditionsEnsure();
    const C = db.conditions;
    const bump = (quoi, avant, apres, motif) => {
      C.version = Number(C.version || 1) + 1;
      C.versions = (C.versions || []); C.versions.push({ n: C.version, at: nowISO(), par: 'PDG', note: String(motif || quoi).slice(0, 200) });
      C.journal = (C.journal || []); C.journal.push({ at: nowISO(), action: quoi, avant: String(avant).slice(0, 300), apres: String(apres).slice(0, 300), motif: String(motif || '').slice(0, 200), version: C.version, par: 'PDG' });
      auditLog('conditions_' + quoi, { version: C.version, motif: String(motif || '').slice(0, 120) });
    };
    /* exiger (ou non) l'acceptation : jamais supprimé, seulement activé/désactivé */
    if (action === 'exigee') {
      const avant = C.exigee !== false; C.exigee = !!b.exigee;
      /* ⚠️ le TEXTE n'a pas changé : on ne crée donc PAS de nouvelle version — sinon tout le monde
         serait obligé de relire et re-signer pour un simple interrupteur (défaut évité). */
      C.journal = (C.journal || []);
      C.journal.push({ at: nowISO(), action: 'exigence', avant: avant ? 'obligatoire' : 'facultative',
        apres: C.exigee ? 'obligatoire' : 'facultative', motif: String(b.motif || 'acceptation obligatoire ou non').slice(0, 200), version: C.version, par: 'PDG' });
      auditLog('conditions_exigence', { exigee: C.exigee, version: C.version });
      saveDb();
      return sendJson(res, 200, { ok: true, exigee: C.exigee, version: C.version, texteInchange: true });
    }
    /* modifier un article (titre et/ou points) */
    if (action === 'article') {
      const role = (String(b.role) === 'pro' ? 'pro' : 'client');
      const i = parseInt(b.index, 10);
      if (!(i >= 0) || i >= C[role].length) return sendJson(res, 400, { error: 'Article inconnu', conseil: 'index de 0 à ' + (C[role].length - 1) });
      const avant = JSON.stringify({ t: C[role][i].t, p: C[role][i].p });
      if (b.titre !== undefined && String(b.titre).trim()) C[role][i].t = String(b.titre).trim().slice(0, 160);
      if (Array.isArray(b.points)) C[role][i].p = b.points.map(x => String(x).trim()).filter(x => x).slice(0, 20);
      if (!C[role][i].p.length) return sendJson(res, 400, { error: 'Un article ne peut pas rester vide' });
      bump('article', avant, JSON.stringify({ t: C[role][i].t, p: C[role][i].p }), b.motif || ('article ' + (i + 1) + ' (' + role + ')'));
      saveDb();
      return sendJson(res, 200, { ok: true, article: C[role][i], version: C.version });
    }
    /* ajouter un article */
    if (action === 'article-ajouter') {
      const role = (String(b.role) === 'pro' ? 'pro' : 'client');
      const titre = String(b.titre || '').trim();
      const points = (Array.isArray(b.points) ? b.points : []).map(x => String(x).trim()).filter(x => x);
      if (!titre || !points.length) return sendJson(res, 400, { error: 'Titre et au moins un point sont nécessaires' });
      C[role].push({ t: titre.slice(0, 160), p: points.slice(0, 20) });
      bump('article-ajoute', C[role].length - 1, titre, b.motif || ('nouvel article (' + role + ')'));
      saveDb();
      return sendJson(res, 200, { ok: true, nb: C[role].length, version: C.version });
    }
    /* publier : nouvelle version datée (le texte reste consultable, rien n'est effacé) */
    if (action === 'publier') {
      C.maj = String(b.date || new Date().toISOString().slice(0, 10)).slice(0, 20);
      C.source = String(b.source || C.source || 'PDG').slice(0, 200);
      bump('publication', 'v' + (C.version - 1), 'v' + (C.version) + ' du ' + C.maj, b.motif || 'publication des conditions');
      saveDb();
      emitAdmin && emitAdmin('info', '📜 Conditions Klean publiées : version ' + C.version + ' du ' + C.maj);
      return sendJson(res, 200, { ok: true, version: C.version, maj: C.maj, source: C.source });
    }
    return sendJson(res, 400, { error: 'Action inconnue', actions: ['exigee', 'article', 'article-ajouter', 'publier'] });
  }

  /* 🏷️ BASE MARCHÉ — lecture publique : références sourcées et datées + statistiques VALIDÉES par le PDG.
     Rien d'autre : aucune donnée interne, aucun prix inventé, aucune statistique non validée. */
  if (p === '/api/marche' && req.method === 'GET') {
    marcheEnsure();
    const url = new URL('http://x' + (req.url || '/'));
    const svc = String(url.searchParams.get('service') || '');
    const refs = (svc ? marcheRefsPour(svc) : marcheRefsActives()).filter(r => r.statut !== 'desactivee');
    const stats = marcheStatsPubliques();
    return sendJson(res, 200, { ok: true, version: db.tarif.version, maj: db.tarif.maj || '',
      service: svc || null,
      refs: refs.map(r => ({ id: r.id, nom: r.nom, service: r.service || '', unite: r.unite || '', min: r.min, max: r.max,
        source: r.source, date: r.date, ville: r.ville || '', statut: r.statut, origine: r.origine || '',
        note: r.note || '' })),
      stats: svc ? (stats[svc] || null) : stats,
      regle: 'Un prix de référence a TOUJOURS une source et une date. Une statistique n’apparaît ici qu’après validation du PDG.',
      manque: (db.tarif.marcheManque || []).slice(0, 40) });
  }
  /* 🏷️ BASE MARCHÉ — tableau de bord : tout voir, ajouter, corriger, désactiver (jamais supprimer) */
  if (p === '/api/admin/marche' && req.method === 'GET') {
    if (!hqIdentity(req)) return sendJson(res, 401, { error: 'Connexion requise' });
    marcheEnsure();
    const T = db.tarif;
    T.marcheStats = { maj: nowISO(), parService: marcheStatsCalcul() };   /* recalculé à la lecture : toujours à jour */
    const stats = Object.keys(T.marcheStats.parService).map(k => Object.assign({}, T.marcheStats.parService[k], {
      validee: T.marcheStatsValidees[k] ? (T.marcheStatsValidees[k].statut !== 'rejetee') : null,
      validation: T.marcheStatsValidees[k] || null,
      refsExistantes: marcheRefsPour(k).length,
      nomService: (T.svc[k] || {}).nom || k
    })).sort((a, b) => b.n - a.n);
    return sendJson(res, 200, { ok: true, version: T.version, maj: T.maj || '',
      refs: (T.refs || []).filter(r => r && r.type === 'marche').map(r => Object.assign({}, r, { valide: marcheRefValide(r).ok, motifs: marcheRefValide(r).motifs })),
      nbRefs: (T.refs || []).filter(r => r && r.type === 'marche' && r.statut !== 'desactivee').length,
      nbDesactivees: (T.refs || []).filter(r => r && r.type === 'marche' && r.statut === 'desactivee').length,
      stats: stats, statsMaj: T.marcheStats.maj, nbStats: stats.length,
      services: Object.keys(T.svc).map(k => ({ id: k, nom: T.svc[k].nom })).sort((a, b) => a.nom.localeCompare(b.nom, 'fr')),
      unites: T.unites, manque: T.marcheManque || [],
      journal: (T.journal || []).slice(0, 40),
      versions: (T.versions || []).slice(0, 20),
      regle: 'SOURCE + DATE obligatoires · aucune référence inventée · rien n’est supprimé (désactivation seulement) · '
           + 'les statistiques viennent des prix réellement acceptés et ne servent qu’après validation du PDG · aucun prix déjà accepté n’est recalculé.',
      calculs: { devisAvecMarche: (db.missions || []).filter(m => m.devis && m.devis.marche && m.devis.marche.trouve).length,
        devisHorsFourchette: (db.missions || []).filter(m => m.devis && m.devis.inhabituelMarche).length } });
  }
  if (p === '/api/admin/marche' && req.method === 'POST') {
    if (!isPdg(req)) return sendJson(res, 403, { error: 'Réservé au compte principal (PDG) — les gestionnaires consultent mais ne fixent pas les références' });
    const b = await readBody(req);
    const action = String(b.action || '');
    marcheEnsure();
    const T = db.tarif;
    if (action === 'ref-ajouter' || action === 'ref-modifier') {
      const r = b.ref || b;
      const id = action === 'ref-modifier' ? String(r.id || '') : String(r.id || ('MR-' + String(Date.now()).slice(-6)));
      if (action === 'ref-modifier' && !T.refs.some(x => x && x.id === id)) return sendJson(res, 404, { error: 'Référence introuvable' });
      const neuve = { id: id, type: 'marche', nom: String(r.nom || '').trim().slice(0, 140),
        service: String(r.service || '').trim().slice(0, 40), unite: String(r.unite || '').trim().slice(0, 30),
        min: Math.max(0, Math.round(Number(r.min != null ? r.min : r.montant) || 0)),
        max: Math.max(0, Math.round(Number(r.max != null ? r.max : r.montant) || 0)),
        ville: String(r.ville || '').trim().slice(0, 60), source: String(r.source || '').trim().slice(0, 160),
        date: String(r.date || '').trim().slice(0, 30), note: String(r.note || '').trim().slice(0, 300),
        statut: 'confirmee', origine: 'pdg', at: nowISO(), par: act(req) };
      if (neuve.max < neuve.min) neuve.max = neuve.min;
      const v = marcheRefValide(neuve);
      if (!v.ok) return sendJson(res, 400, { error: 'Référence INCOMPLÈTE : ' + v.motifs.join(' · '),
        conseil: 'Règle Klean : un prix sans SOURCE ni DATE n’entre pas dans la base. Indiquez d’où vient le prix et de quand il date.' });
      if (action === 'ref-modifier') {
        const i = T.refs.findIndex(x => x && x.id === id);
        const avant = Object.assign({}, T.refs[i]);
        T.refs[i] = Object.assign({}, avant, neuve, { statut: avant.statut === 'desactivee' ? 'desactivee' : 'confirmee' });
        tarifBump('ref-modifier', neuve.nom, avant.min + '–' + avant.max + ' F (' + avant.source + ')',
          neuve.min + '–' + neuve.max + ' F (' + neuve.source + ')', b.motif || 'correction d’une référence marché', act(req));
      } else {
        T.refs.push(neuve);
        tarifBump('ref-ajouter', neuve.nom, '', neuve.min + '–' + neuve.max + ' F (' + neuve.source + ', ' + neuve.date + ')', b.motif || 'nouvelle référence marché', act(req));
      }
      saveDb();
      return sendJson(res, 200, { ok: true, ref: neuve, version: T.version });
    }
    if (action === 'ref-confirmer' || action === 'ref-desactiver' || action === 'ref-reactivier') {
      const r = T.refs.find(x => x && x.id === String(b.id || ''));
      if (!r) return sendJson(res, 404, { error: 'Référence introuvable' });
      const avant = r.statut || 'a_confirmer';
      r.statut = action === 'ref-desactiver' ? 'desactivee' : 'confirmee';
      r.par = act(req); r.atStatut = nowISO();
      tarifBump(action, r.nom || r.id, avant, r.statut, b.motif || ('référence ' + r.statut), act(req));
      saveDb();
      return sendJson(res, 200, { ok: true, id: r.id, statut: r.statut, version: T.version });
    }
    /* 📊 validation d'une statistique : rien ne devient public sans cette décision */
    if (action === 'stat-valider' || action === 'stat-rejeter') {
      const svc = String(b.service || '');
      const calcul = marcheStatsCalcul()[svc];
      if (!calcul) return sendJson(res, 404, { error: 'Aucun prix accepté pour ce service : il n’y a rien à valider' });
      if (action === 'stat-rejeter') {
        T.marcheStatsValidees[svc] = { service: svc, statut: 'rejetee', rejeteeAt: nowISO(), rejeteePar: act(req), motif: String(b.motif || '').slice(0, 200), calcul: calcul };
        tarifBump('stat-rejeter', (T.svc[svc] || {}).nom || svc, calcul.n + ' prix acceptés', 'statistique rejetée', b.motif || 'statistique rejetée', act(req));
        saveDb();
        return sendJson(res, 200, { ok: true, statut: 'rejetee', version: T.version });
      }
      const avant = T.marcheStatsValidees[svc] || null;
      T.marcheStatsValidees[svc] = Object.assign({}, calcul, { statut: 'validee', valideeAt: nowISO(), valideePar: act(req),
        motif: String(b.motif || '').slice(0, 200),
        source: 'Statistiques Klean-Services — ' + calcul.n + ' prix acceptés du ' + (calcul.periode.de || '?') + ' au ' + (calcul.periode.a || '?'),
        date: String(nowISO()).slice(0, 10) });
      tarifBump('stat-valider', (T.svc[svc] || {}).nom || svc, avant ? 'validée le ' + String(avant.valideeAt).slice(0, 10) : 'non validée',
        calcul.n + ' prix acceptés · ' + calcul.min + '–' + calcul.max + ' F (médiane ' + calcul.mediane + ' F)', b.motif || 'statistique validée par le PDG', act(req));
      saveDb();
      return sendJson(res, 200, { ok: true, statut: 'validee', statistique: T.marcheStatsValidees[svc], version: T.version });
    }
    /* 📈 une statistique validée peut devenir une RÉFÉRENCE (avec sa source et sa date) — jamais en silence */
    if (action === 'stat-promouvoir') {
      const svc = String(b.service || '');
      const V = T.marcheStatsValidees[svc];
      if (!V || V.statut === 'rejetee') return sendJson(res, 400, { error: 'Validez d’abord la statistique de ce service' });
      const id = 'stats-' + svc;
      const ref = { id: id, type: 'marche', nom: 'Prix habituellement pratiqués — ' + ((T.svc[svc] || {}).nom || svc),
        service: svc, unite: String(b.unite || 'intervention').slice(0, 30), min: V.min, max: V.max,
        ville: V.ville || '', source: V.source, date: V.date, statut: 'confirmee', origine: 'stats',
        note: 'Issue des prix réellement acceptés sur Klean (' + V.n + ' prix, médiane ' + V.mediane + ' F), validée par le PDG le ' + String(V.valideeAt).slice(0, 10) + '.',
        at: nowISO(), par: act(req) };
      const i = T.refs.findIndex(x => x && x.id === id);
      if (i >= 0) { const avant = T.refs[i]; T.refs[i] = ref;
        tarifBump('stat-promouvoir', ref.nom, avant.min + '–' + avant.max + ' F', ref.min + '–' + ref.max + ' F', b.motif || 'mise à jour depuis les statistiques', act(req));
      } else { T.refs.push(ref);
        tarifBump('stat-promouvoir', ref.nom, '', ref.min + '–' + ref.max + ' F (' + ref.source + ')', b.motif || 'référence créée depuis les statistiques validées', act(req)); }
      saveDb();
      return sendJson(res, 200, { ok: true, ref: ref, version: T.version });
    }
    if (action === 'manque-ajouter' || action === 'manque-retirer') {
      T.marcheManque = T.marcheManque || [];
      const lib = String(b.libelle || '').trim().slice(0, 80);
      if (!lib) return sendJson(res, 400, { error: 'Libellé manquant' });
      if (action === 'manque-ajouter') { if (T.marcheManque.indexOf(lib) < 0) T.marcheManque.push(lib); }
      else T.marcheManque = T.marcheManque.filter(x => x !== lib);
      tarifBump(action, lib, '', action === 'manque-ajouter' ? 'ajouté à la liste à compléter' : 'retiré de la liste à compléter', b.motif || '', act(req));
      saveDb();
      return sendJson(res, 200, { ok: true, manque: T.marcheManque, version: T.version });
    }
    if (action === 'stats-recalculer') {
      const s2 = marcheStatsMaj();
      tarifBump('stats-recalculer', 'statistiques marché', '', Object.keys(s2.parService).length + ' service(s) avec des prix acceptés', b.motif || 'recalcul des statistiques', act(req));
      return sendJson(res, 200, { ok: true, stats: s2, version: T.version });
    }
    return sendJson(res, 400, { error: 'Action inconnue', actions: ['ref-ajouter', 'ref-modifier', 'ref-confirmer', 'ref-desactiver', 'ref-reactivier',
      'stat-valider', 'stat-rejeter', 'stat-promouvoir', 'manque-ajouter', 'manque-retirer', 'stats-recalculer'] });
  }

  if (p === '/api/admin/tarif' && req.method === 'GET') {
    if (!pdgOnly(req, res)) return;
    tarifEnsure();
    const T = db.tarif;
    const svcs = Object.keys(T.svc).map(k => {
      const x = T.svc[k];
      return Object.assign({}, x, {
        uniteNom: (T.unites.find(u => u.id === x.unite) || {}).nom || x.unite,
        options: tarifOptionsDe(x), prixMin: x.ref, prixMax: x.max,
        palierTxt: T.paliers.map(p => p.n + '→×' + String(p.mult).replace('.', ',')).join(' · ')
      });
    }).sort((a, b) => String(a.id).localeCompare(String(b.id), 'fr', { numeric: true }));
    return sendJson(res, 200, {
      ok: true, version: T.version, maj: T.maj, versions: T.versions.slice(0, 40),
      unites: T.unites, coefs: T.coefs, paliers: T.paliers, deplacement: T.deplacement,
      zones: T.zones, seuils: T.seuils, remises: T.remises, refs: (T.refs || []).slice(-60).reverse(),
      marche: { nbRefs: (T.refs || []).filter(r => r && r.type === 'marche' && r.statut !== 'desactivee').length,
        nbAConfirmer: (T.refs || []).filter(r => r && r.type === 'marche' && r.statut === 'a_confirmer').length,
        nbStats: Object.keys(T.marcheStatsValidees || {}).length, manque: T.marcheManque || [] },
      source: T.zonesSrc || null,
      reference: (T.refs || []).find(x => x && x.id === 'deplacement') || null,
      journal: T.journal.slice(0, 120), services: svcs,
      nbServices: svcs.length, nbDevis: svcs.filter(x => x.devis).length,
      questions: tarifQuestionsToutes().map(q => Object.assign({}, tarifQuestionAdmin(q), { nbServices: Object.keys(T.svc).filter(k => tarifCibleOk(q.cible, T.svc[k])).length })),
      nbQuestions: tarifQuestionsToutes().filter(q => !q.off).length,
      nbQuestionsOff: tarifQuestionsToutes().filter(q => q.off).length,
      nbATarifer: svcs.filter(x => !x.devis && !(x.ref > 0)).length,
      nbDesactives: svcs.filter(x => x.off).length,
      questionsPubliques: (() => { const out = {}; Object.keys(T.svc).forEach(k => { const qs = tarifQuestionsDe(T.svc[k]); if (qs.length) out[k] = qs.map(q => q.id); }); return out; })(),
      règle: 'Le calcul est détaillé et fait par le serveur : unité, quantité (paliers), niveau, état, difficulté, urgence, horaire, accès, zone, déplacement, matériel, options, remise. Les prix restent ceux d’aujourd’hui tant que vous ne les changez pas ; tout changement crée une nouvelle version datée, et aucune ancienne mission n’est recalculée. Rien ne se supprime : on désactive.'
    });
  }
  if (p === '/api/admin/tarif' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const action = String(b.action || '').slice(0, 24);
    tarifEnsure();
    const T = db.tarif;
    const svc = b.id ? T.svc[String(b.id)] : null;
    const besoinSvc = () => { if (!svc) { sendJson(res, 404, { error: 'Service inconnu du moteur de tarification', conseil: 'Choisissez un service du catalogue national' }); return false; } return true; };
    const num = (v, def) => { const x = parseFloat(v); return isFinite(x) ? Math.round(x) : def; };
    /* 🔒 SUPPRESSION : refusée — une entrée utilisée dans des commandes passées ne disparaît jamais */
    if (action === 'supprimer') {
      tarifJournal('supprimer-refuse', b.id, '', '', 'tentative de suppression');
      return sendJson(res, 400, { error: 'Rien ne se supprime : un tarif peut être désactivé (⏸), jamais effacé — les commandes passées doivent garder leur prix.',
        conseil: 'basculer' });
    }
    if (action === 'prix') {
      if (!besoinSvc()) return;
      const avant = { ref: svc.ref, min: svc.min, max: svc.max };
      if (b.ref !== undefined) svc.ref = Math.max(0, num(b.ref, svc.ref));
      if (b.min !== undefined) svc.min = Math.max(0, num(b.min, svc.min));
      if (b.max !== undefined) svc.max = Math.max(0, num(b.max, svc.max));
      if (svc.min > svc.ref) svc.min = svc.ref;
      if (svc.max < svc.ref) svc.max = svc.ref;
      if (b.nom) svc.nom = String(b.nom).slice(0, 80);
      svc.majPerso = true;
      /* 🔗 évite le doublon : régler le prix d'un MÉTIER met à jour les services du catalogue qui
         partagent ce métier, SAUF ceux que le PDG a réglés séparément (majPerso). */
      let suivis = 0;
      if (svc.type === 'metier') {
        for (const k in T.svc) {
          const x = T.svc[k];
          if (x !== svc && x.type === 'catalogue' && x.metier === svc.id && !x.majPerso) {
            x.ref = svc.ref; x.min = svc.min; x.max = svc.max; suivis++;
          }
        }
      }
      const v = tarifBump('prix', svc.nom, JSON.stringify(avant), JSON.stringify({ ref: svc.ref, min: svc.min, max: svc.max }),
        (b.motif || 'modification de prix') + (suivis ? (' · ' + suivis + ' service(s) du catalogue mis à jour') : ''));
      return sendJson(res, 200, { ok: true, service: svc, version: v, suivis });
    }
    if (action === 'unite') {
      if (!besoinSvc()) return;
      const u = T.unites.find(x => x.id === String(b.unite || ''));
      if (!u) return sendJson(res, 400, { error: 'Unité inconnue', conseil: 'Créez d’abord l’unité' });
      const avant = svc.unite;
      svc.unite = u.id; svc.comptable = !!u.comptable; svc.uniteNom = u.nom;
      const v = tarifBump('unite', svc.nom, avant, u.id, b.motif || 'changement d’unité');
      return sendJson(res, 200, { ok: true, service: svc, version: v });
    }
    if (action === 'unite-ajouter') {
      const id = normFr(String(b.nomUnite || b.nom || '')).replace(/[^a-z0-9]+/g, '_').slice(0, 24);
      if (!id) return sendJson(res, 400, { error: 'Nom d’unité requis' });
      if (T.unites.some(u => u.id === id)) return sendJson(res, 409, { error: 'Cette unité existe déjà' });
      T.unites.push({ id, ic: String(b.ic || '🔢').slice(0, 6), nom: String(b.nom || id).slice(0, 60), comptable: !!b.comptable, cree: true });
      const v = tarifBump('unite-ajouter', id, '', String(b.nom || id), b.motif || 'nouvelle unité');
      return sendJson(res, 201, { ok: true, unité: T.unites[T.unites.length - 1], version: v });
    }
    if (action === 'coef') {
      const bloc = String(b.bloc || ''); const B = T.coefs[bloc];
      if (!B) return sendJson(res, 400, { error: 'Coefficient inconnu' });
      if (b.val) {                                   /* régler une valeur : { bloc:'etat', val:'tres_sale', k:1.45 } */
        const v0 = B.valeurs.find(x => x.id === String(b.val));
        if (!v0) return sendJson(res, 404, { error: 'Valeur inconnue' });
        const avant = v0.k; v0.k = Math.max(0, Number(b.k) || 0);
        if (b.nom) v0.nom = String(b.nom).slice(0, 60);
        const v = tarifBump('coef', bloc + ' · ' + v0.nom, avant, v0.k, b.motif || 'réglage du coefficient');
        return sendJson(res, 200, { ok: true, bloc, valeur: v0, version: v });
      }
      if (b.ajouter) {                               /* ajouter une valeur : { bloc:'etat', ajouter:{ id, nom, k } } */
        const nv = b.ajouter || {};
        const id = normFr(String(nv.id || nv.nom || '')).replace(/[^a-z0-9]+/g, '_').slice(0, 24);
        if (!id) return sendJson(res, 400, { error: 'Identifiant de valeur requis' });
        if (B.valeurs.some(x => x.id === id)) return sendJson(res, 409, { error: 'Cette valeur existe déjà' });
        B.valeurs.push({ id, nom: String(nv.nom || id).slice(0, 60), k: Math.max(0, Number(nv.k) || 1), cree: true });
        const v = tarifBump('coef-ajouter', bloc + ' · ' + (nv.nom || id), '', nv.k, b.motif || 'nouvelle valeur de coefficient');
        return sendJson(res, 201, { ok: true, bloc, valeurs: B.valeurs, version: v });
      }
      if (b.actif !== undefined) { B.actif = !!b.actif;
        const v = tarifBump('coef-basculer', bloc, !B.actif, B.actif, b.motif || 'coefficient activé/désactivé');
        return sendJson(res, 200, { ok: true, bloc, actif: B.actif, version: v }); }
      return sendJson(res, 400, { error: 'Précisez la valeur à régler' });
    }
    if (action === 'palier') {
      const arr = Array.isArray(b.paliers) ? b.paliers : null;
      if (!arr) return sendJson(res, 400, { error: 'Paliers requis' });
      const avant = JSON.stringify(T.paliers);
      T.paliers = arr.map(p => ({ n: Math.max(1, parseInt(p.n, 10) || 1), mult: Math.max(0, Number(p.mult) || 1) }))
        .slice(0, 24).sort((a, b2) => a.n - b2.n);
      const v = tarifBump('palier', 'paliers de quantité', avant, JSON.stringify(T.paliers), b.motif || 'réglage des paliers');
      return sendJson(res, 200, { ok: true, paliers: T.paliers, version: v });
    }
    if (action === 'option') {
      if (!besoinSvc()) return;
      const list = svc.opts || (svc.opts = []);
      if (b.ajouter) {
        const nv = b.ajouter || {};
        const id = normFr(String(nv.id || nv.nom || '')).replace(/[^a-z0-9]+/g, '_').slice(0, 24);
        if (!id) return sendJson(res, 400, { error: 'Nom d’option requis' });
        if (list.some(o => o.id === id)) return sendJson(res, 409, { error: 'Cette option existe déjà' });
        list.push({ id, ic: String(nv.ic || '🔹').slice(0, 6), nom: String(nv.nom || id).slice(0, 60), desc: String(nv.desc || '').slice(0, 80), prix: Math.max(0, num(nv.prix, 0)) });
        const v = tarifBump('option-ajouter', svc.nom + ' · ' + (nv.nom || id), '', nv.prix, b.motif || 'nouvelle option');
        return sendJson(res, 201, { ok: true, service: svc, version: v });
      }
      const o = list.find(x => x.id === String(b.optId || ''));
      if (!o) return sendJson(res, 404, { error: 'Option inconnue' });
      const avant = { nom: o.nom, prix: o.prix };
      if (b.prix !== undefined) o.prix = Math.max(0, num(b.prix, o.prix));
      if (b.nom) o.nom = String(b.nom).slice(0, 60);
      const v = tarifBump('option', svc.nom + ' · ' + o.nom, JSON.stringify(avant), JSON.stringify({ nom: o.nom, prix: o.prix }), b.motif || 'modification d’option');
      return sendJson(res, 200, { ok: true, service: svc, version: v });
    }
    /* 🛵 DÉPLACEMENT — une seule route, enrichie au lot 111 : activer un mode payant exige une
       référence de marché (SOURCE + DATE). Sans elles, le moteur refuse — c'est la règle du PDG. */
    if (action === 'deplacement') {
      const dep0 = T.deplacement || (T.deplacement = JSON.parse(JSON.stringify(TARIF_DEPLACEMENT_DEF)));
      const avant = JSON.stringify({ mode: dep0.mode, tranches: dep0.tranches, source: dep0.source, date: dep0.sourceDate });
      const modes = ['inclus', 'km', 'tranches', 'forfait'];
      if (b.mode !== undefined) {
        const m = String(b.mode);
        if (modes.indexOf(m) < 0) return sendJson(res, 400, { error: 'Mode inconnu', conseil: modes.join(' · ') });
        const src2 = (b.source !== undefined ? String(b.source) : String(dep0.source || '')).trim();
        const dt2 = (b.sourceDate !== undefined ? String(b.sourceDate) : String(dep0.sourceDate || '')).trim();
        if (m !== 'inclus' && (!src2 || !dt2))
          return sendJson(res, 400, { error: 'Source et date obligatoires pour activer un déplacement payant',
            detail: 'Indiquez d’où vient le montant (ex. « tarif d’un prestataire à Abidjan », « grille Yemba Plomberie ») et sa date.',
            conseil: 'envoyez source + sourceDate, ou laissez le mode « inclus » (prix d’aujourd’hui, rien de facturé).' });
        dep0.mode = m;
      }
      if (b.source !== undefined) dep0.source = String(b.source).slice(0, 160);
      if (b.sourceDate !== undefined) dep0.sourceDate = String(b.sourceDate).slice(0, 40);
      if (b.note !== undefined) dep0.note = String(b.note).slice(0, 300);
      if (b.km !== undefined) T.deplacement.km = Math.max(0, num(b.km, T.deplacement.km));
      if (b.forfait !== undefined) T.deplacement.forfait = Math.max(0, num(b.forfait, T.deplacement.forfait));
      if (b.allerRetour !== undefined) T.deplacement.allerRetour = !!b.allerRetour;
      if (Array.isArray(b.tranches)) T.deplacement.tranches = b.tranches.map(x => ({ jusqua: Math.max(1, num(x.jusqua, 1)), prix: Math.max(0, num(x.prix, 0)) })).sort((x, y) => x.jusqua - y.jusqua);
      /* ⚠️ PRIX INHABITUEL : une tranche très au-dessus (ou très en dessous) de la référence sourcée
         est SIGNALÉE — jamais corrigée, jamais supprimée en douce. */
      const refD = (T.refs || []).find(x => x && x.id === 'deplacement');
      let alerte = '';
      if (refD && refD.max > 0) {
        const ecart = Number(T.seuils.ecartAnormal) || 0.4;
        const tr = T.deplacement.tranches || [];
        const txt = x => 'jusqu’à ' + x.jusqua + ' km → ' + x.prix + ' F';
        const trop = tr.filter(t => t.prix > Math.round(refD.max * (1 + ecart)));
        const bas = tr.filter(t => t.prix > 0 && t.prix < Math.round(refD.min * (1 - ecart)));
        if (trop.length) alerte = 'prix inhabituel (très ÉLEVÉ, conservé tel quel) : ' + trop.map(txt).join(' · ')
          + ' — référence ' + refD.min + '–' + refD.max + ' F' + (refD.source ? ' (' + refD.source + ', ' + refD.date + ')' : '');
        if (bas.length) alerte += (alerte ? ' | ' : '') + 'prix inhabituel (très BAS, vérifiez une erreur de saisie) : ' + bas.map(txt).join(' · ')
          + ' — référence ' + refD.min + '–' + refD.max + ' F';
      }
      const v = tarifBump('deplacement', 'frais de déplacement', avant, JSON.stringify({ mode: T.deplacement.mode, source: T.deplacement.source, date: T.deplacement.sourceDate }),
        (b.motif || 'réglage du déplacement') + (alerte ? ' · ' + alerte : ''));
      return sendJson(res, 200, { ok: true, deplacement: T.deplacement, version: v, alerte: alerte || null });
    }
    if (action === 'devis') {
      if (!besoinSvc()) return;
      const avant = !!svc.devis; svc.devis = !!b.devis;
      const v = tarifBump('devis', svc.nom, avant, svc.devis, b.motif || 'devis obligatoire ou non');
      return sendJson(res, 200, { ok: true, service: svc, version: v });
    }
    if (action === 'photos') {
      if (!besoinSvc()) return;
      const avant = svc.photos;
      if (['obligatoires', 'conseillees', 'non'].indexOf(String(b.photos)) >= 0) svc.photos = String(b.photos);
      if (b.photosMin !== undefined) svc.photosMin = Math.max(1, Math.min(10, parseInt(b.photosMin, 10) || 2));
      const v = tarifBump('photos', svc.nom, avant, svc.photos + '/' + svc.photosMin, b.motif || 'réglage des photos');
      return sendJson(res, 200, { ok: true, service: svc, version: v });
    }
    if (action === 'etat') {                          /* est-ce que l'état des lieux compte pour ce service ? */
      if (!besoinSvc()) return;
      const avant = !!svc.etatCompte; svc.etatCompte = !!b.etatCompte;
      const v = tarifBump('etat', svc.nom, avant, svc.etatCompte, b.motif || 'état pris en compte ou non');
      return sendJson(res, 200, { ok: true, service: svc, version: v });
    }
    if (action === 'basculer') {
      if (!besoinSvc()) return;
      const avant = !!svc.off; svc.off = !avant;
      const v = tarifBump('basculer', svc.nom, avant, svc.off, b.motif || (svc.off ? 'tarif désactivé' : 'tarif réactivé'));
      return sendJson(res, 200, { ok: true, service: svc, version: v });
    }
    /* 🗺️ DISTANCES DES ZONES — le PDG règle le km d'une zone, puis valide la table (source + date) */
    if (action === 'zones-km') {
      const id = normVille(String(b.zone || ''));
      if (!id) return sendJson(res, 400, { error: 'Indiquez la zone (ex. « cocody »)' });
      T.zones[id] = T.zones[id] || { nom: String(b.nom || b.zone).slice(0, 60), k: 1 };
      const avant = typeof T.zones[id].km === 'number' ? T.zones[id].km : null;
      if (b.supprimer) { delete T.zones[id].km; }
      else T.zones[id].km = Math.max(0, num(b.km, avant || 0));
      const v = tarifBump('zones-km', T.zones[id].nom || id, String(avant), String(T.zones[id].km || ''),
        b.motif || 'distance de zone');
      return sendJson(res, 200, { ok: true, zone: { id, nom: T.zones[id].nom, km: T.zones[id].km }, version: v });
    }
    if (action === 'zones-source') {
      const src2 = T.zonesSrc || (T.zonesSrc = JSON.parse(JSON.stringify(TARIF_ZONES_SRC_DEF)));
      const avant = JSON.stringify(src2);
      if (b.source !== undefined) src2.source = String(b.source).slice(0, 160);
      if (b.sourceDate !== undefined) src2.sourceDate = String(b.sourceDate).slice(0, 40);
      if (b.note !== undefined) src2.note = String(b.note).slice(0, 300);
      const veutActiver = (b.actif !== undefined) ? !!b.actif : true;
      if (veutActiver && (!src2.source.trim() || !src2.sourceDate.trim()))
        return sendJson(res, 400, { error: 'Source et date obligatoires pour valider la table des distances',
          detail: 'Ex. source « distances routières usuelles depuis Abidjan » et date « 28/09/2026 ».',
          conseil: 'la table reste une simple estimation tant qu’elle n’est pas validée.' });
      src2.actif = veutActiver;
      const v = tarifBump('zones-source', 'Table des distances', avant, JSON.stringify(src2), b.motif || 'validation de la table des distances');
      return sendJson(res, 200, { ok: true, source: src2, version: v });
    }

    /* 🪜 ACCÈS — un MONTANT réel pour un cas d'accès (remplace le pourcentage pour ce cas) */
    if (action === 'acces-montant') {
      const B = T.coefs && T.coefs.acces;
      if (!B || !Array.isArray(B.valeurs)) return sendJson(res, 400, { error: 'Bloc « accès » absent' });
      const vId = String(b.valeur || '');
      const val = B.valeurs.find(x => x.id === vId);
      if (!val) return sendJson(res, 400, { error: 'Cas d’accès inconnu', conseil: B.valeurs.map(x => x.id).join(' · ') });
      const avant = (typeof val.montant === 'number') ? val.montant : ('×' + val.k);
      if (b.montant === null || b.montant === '') delete val.montant;
      else val.montant = Math.max(0, num(b.montant, 0));
      const v = tarifBump('acces-montant', 'Accès : ' + val.nom, String(avant),
        (typeof val.montant === 'number') ? String(val.montant) : ('×' + val.k), b.motif || 'montant d’accès réglé');
      return sendJson(res, 200, { ok: true, acces: val, version: v });
    }

    /* 🧰 MATÉRIEL — le prix réel des fournitures apportées par le pro, service par service */
    if (action === 'materiel') {
      if (!besoinSvc()) return;
      const avant = svc.materielPrix || 0;
      svc.materielPrix = Math.max(0, num(b.prix, 0));
      const v = tarifBump('materiel', svc.nom, String(avant), String(svc.materielPrix), b.motif || 'prix du matériel');
      return sendJson(res, 200, { ok: true, service: svc, version: v });
    }

    if (action === 'zone') {
      const ville = normVille(b.ville || '');
      if (!ville) return sendJson(res, 400, { error: 'Ville requise' });
      const avant = JSON.stringify(T.zones[ville] || null);
      if (b.supprimer) delete T.zones[ville];
      else T.zones[ville] = { nom: String(b.nom || b.ville).slice(0, 60), k: Math.max(0.2, Number(b.k) || 1) };
      const v = tarifBump('zone', b.ville, avant, JSON.stringify(T.zones[ville] || null), b.motif || 'tarif de zone');
      return sendJson(res, 200, { ok: true, zones: T.zones, version: v });
    }
    if (action === 'seuil') {
      const avant = JSON.stringify(T.seuils);
      ['margeAuto', 'margeIncertitude'].forEach(k => { if (b[k] !== undefined) T.seuils[k] = Math.max(0, Math.min(0.9, Number(b[k]) || 0)); });
      ['validationAdmin', 'ecartAnormal'].forEach(k => { if (b[k] !== undefined) T.seuils[k] = k === 'ecartAnormal' ? Math.max(0.05, Math.min(5, Number(b[k]) || 0)) : Math.max(0, num(b[k], T.seuils[k])); });
      const v = tarifBump('seuil', 'seuils', avant, JSON.stringify(T.seuils), b.motif || 'réglage des seuils');
      return sendJson(res, 200, { ok: true, seuils: T.seuils, version: v });
    }
    if (action === 'remise') {
      const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
      if (!code) return sendJson(res, 400, { error: 'Code requis' });
      const avant = T.remises[code]; 
      if (b.taux === 0 || b.supprimer) delete T.remises[code]; else T.remises[code] = Math.max(0.01, Math.min(0.9, Number(b.taux) || 0.1));
      const v = tarifBump('remise', code, avant, b.taux, b.motif || 'code de remise');
      return sendJson(res, 200, { ok: true, remises: T.remises, version: v });
    }
    if (action === 'refs-ajouter') {                 /* 🏷️ prix du marché : SOURCE et DATE obligatoires */
      const r = b.ref || b;
      if (!r.montant || !r.source) return sendJson(res, 400, { error: 'Montant et source obligatoires', conseil: 'Un prix sans source ni date n’entre pas dans la base' });
      T.refs.push({ at: nowISO(), service: String(r.service || '').slice(0, 80), montant: Math.max(0, num(r.montant, 0)),
        unite: String(r.unite || '').slice(0, 40), source: String(r.source).slice(0, 120), date: String(r.date || '').slice(0, 30),
        ville: String(r.ville || '').slice(0, 60), conditions: String(r.conditions || '').slice(0, 160), qualite: String(r.qualite || '').slice(0, 40) });
      if (T.refs.length > 500) T.refs = T.refs.slice(-500);
      const v = tarifBump('refs-ajouter', r.service || '', '', r.montant + ' F (' + r.source + ')', 'référence de marché ajoutée');
      return sendJson(res, 201, { ok: true, refs: T.refs.slice(-20), version: v });
    }
    /* ❓ LOT 108 — LES QUESTIONS POSÉES AU CLIENT */
    if (action === 'question') {
      const Q = tarifQuestionsToutes();
      if (b.ajouter) {
        const nv = b.ajouter || {};
        const id = normFr(String(nv.id || nv.q || '')).replace(/[^a-z0-9]+/g, '_').slice(0, 24);
        if (!id || !nv.q) return sendJson(res, 400, { error: 'Identifiant et libellé de la question requis' });
        if (Q.some(x => x.id === id)) return sendJson(res, 409, { error: 'Cette question existe déjà' });
        const cible = {};
        if (nv.metier) cible.metier = [String(nv.metier)];
        else if (nv.cat) cible.cat = [String(nv.cat)];
        else if (nv.unite) cible.unite = [String(nv.unite)];
        else if (nv.svc) cible.svc = [String(nv.svc)];
        else cible.tous = true;
        const q = { id, q: String(nv.q).slice(0, 120), type: ['choix', 'nombre', 'photo'].indexOf(String(nv.type)) >= 0 ? String(nv.type) : 'choix',
          aide: String(nv.aide || '').slice(0, 300), cible, ordre: parseInt(nv.ordre, 10) || 55,
          jeNeSaisPas: nv.jeNeSaisPas !== false, obligatoire: !!nv.obligatoire, off: false,
          unite: String(nv.unite2 || '').slice(0, 20), prixUnite: Math.max(0, num(nv.prixUnite, 0)), cree: true };
        if (q.type === 'choix') { if (nv.coef && T.coefs[nv.coef]) q.coef = String(nv.coef); else q.coef = null; }
        if (q.type === 'photo') q.min = Math.max(1, parseInt(nv.min, 10) || 2);
        Q.push(q);
        const v = tarifBump('question-ajouter', q.q, '', q.id, b.motif || 'nouvelle question');
        return sendJson(res, 201, { ok: true, question: q, version: v });
      }
      const q = Q.find(x => x.id === String(b.qid || '')); 
      if (!q) return sendJson(res, 404, { error: 'Question inconnue' });
      const avant = JSON.stringify({ q: q.q, coef: q.coef, obligatoire: !!q.obligatoire, ordre: q.ordre, off: !!q.off });
      if (b.q !== undefined) q.q = String(b.q).slice(0, 120);
      if (b.aide !== undefined) q.aide = String(b.aide).slice(0, 300);
      if (b.coef !== undefined) q.coef = (b.coef && T.coefs[b.coef]) ? String(b.coef) : null;
      if (b.obligatoire !== undefined) q.obligatoire = !!b.obligatoire;
      if (b.ordre !== undefined) q.ordre = parseInt(b.ordre, 10) || q.ordre;
      if (b.prixUnite !== undefined) q.prixUnite = Math.max(0, num(b.prixUnite, q.prixUnite || 0));
      if (b.min !== undefined) q.min = Math.max(1, parseInt(b.min, 10) || 2);
      if (b.basculer) q.off = !avant.includes('"off":true');
      const v = tarifBump('question', q.q, avant, JSON.stringify({ q: q.q, coef: q.coef, obligatoire: !!q.obligatoire, ordre: q.ordre, off: !!q.off }), b.motif || 'réglage d’une question');
      return sendJson(res, 200, { ok: true, question: q, version: v });
    }
    if (action === 'publier') {                      /* une version « majeure », avec la raison du PDG */
      const v = tarifBump('publier', 'publication', '', '', b.motif || b.note || 'publication des tarifs');
      return sendJson(res, 200, { ok: true, version: v, versions: T.versions.slice(0, 20) });
    }
    return sendJson(res, 400, { error: 'Action inconnue', actions: ['prix', 'unite', 'unite-ajouter', 'coef', 'palier', 'option', 'deplacement', 'devis', 'photos', 'etat', 'basculer', 'zone', 'seuil', 'remise', 'refs-ajouter', 'publier'] });
  }

  if (p === '/api/admin/shield' && req.method === 'GET') {
    if (!pdgOnly(req, res)) return;
    shieldEnsure();
    /* 🗣️ le PDG voit, POUR CHAQUE IP : l'état en clair, la RAISON, la DURÉE et le temps restant.
       Un blocage temporaire dont la durée est écoulée est déjà rouvert (shieldEtat). */
    const ips = Object.keys(db.shield.ips).map(ip => {
      const r = shieldEtat(ip) || {};
      const resteMin = shieldResteMin(r);
      const etat = r.annihilated ? 'aneanti' : (r.blocked ? (r.blockBy === 'pdg' ? 'bloque-pdg' : 'bloque-auto')
        : ((Number(r.serieux) || 0) > 0 ? 'surveille' : 'normale'));
      const etatTxt = {
        aneanti: '⛔ Anéantie — décision du PDG, sans limite de temps',
        'bloque-pdg': '🚫 Bloquée par vous (PDG)' + (r.blockedUntil ? (' — ' + (r.blockMinutes || 0) + ' min') : ' — sans limite'),
        'bloque-auto': '⏸️ Bloquée automatiquement (' + (r.blockMinutes || 0) + ' min)',
        surveille: '👁️ Surveillée — aucune restriction en cours',
        normale: '✅ Normale — autorisée'
      }[etat];
      const raisonTxt = r.annihilated ? SHIELD_MOTIFS['pdg-aneanti']
        : r.blocked ? (SHIELD_MOTIFS[r.blockKind] || r.blockReason || 'comportement suspect')
          : ((Number(r.serieux) || 0) > 0
            ? ((SHIELD_MOTIFS[r.kind] || 'signalement passé') + ' — surveillance seulement, cette adresse n’est PAS bloquée'
              + (ipPartagee(ip) ? ' · adresse partagée (cybercafé, hôtel, entreprise, réseau local) : jamais bloquée pour cette raison' : ''))
            : 'aucune raison de bloquer (erreurs normales de clients ne comptent pas)');
      const finTxt = r.blocked && r.blockedUntil ? ('se termine ' + r.blockedUntil.slice(11, 16) + ' UTC') : '';
      return Object.assign({ ip, etat, etatTxt, raisonTxt, resteMin, finTxt,
        dureeTxt: resteMin ? (resteMin + ' min restantes') : (r.blocked ? 'sans limite (PDG)' : '—'),
        partagee: ipPartagee(ip) }, r);
    });
    const rang = { 'bloque-auto': 0, 'bloque-pdg': 1, aneanti: 2, surveille: 3, normale: 4 };
    ips.sort((a, b) => (rang[a.etat] - rang[b.etat]) || ((b.score || 0) - (a.score || 0)));
    const nBloquees = ips.filter(x => (x.etat === 'bloque-auto' || x.etat === 'bloque-pdg')).length;
    const nSurv = ips.filter(x => x.etat === 'surveille').length;
    return sendJson(res, 200, {
      ok: true,
      events: db.shield.events.slice(0, 80),
      ips: ips.slice(0, 80),
      nBlocked: nBloquees,
      nAneanti: ips.filter(x => x.etat === 'aneanti').length,
      nEvents: db.shield.events.length,
      nSurveillees: nSurv,
      durees: SHIELD_DUREES,
      bloquerPartagees: !!(db.config && db.config.shieldPartagees),
      regle: 'Une adresse inconnue ou partagée n’est jamais bloquée pour cette seule raison. Les erreurs normales des clients (code inconnu, fiche inexistante) ne comptent pas. Seuls un sondage de fichiers réservés, une tentative d’injection ou une rafale de requêtes déclenchent un blocage — toujours temporaire (15 min, puis 1 h, 6 h, 24 h au maximum) et toujours expliqué ici.',
      resume: nBloquees ? (nBloquees + ' adresse(s) bloquée(s) temporairement' + (nSurv ? (' · ' + nSurv + ' surveillée(s) sans restriction') : ''))
        : (nSurv ? ('Aucune adresse bloquée · ' + nSurv + ' surveillée(s) sans restriction') : 'Aucune adresse bloquée — tout le monde passe normalement')
    });
  }
  /* 🚫 LE PDG BLOQUE UNE ADRESSE : avec une DURÉE (minutes, plafond 24 h) — jamais un blocage muet.
     Il peut aussi viser une adresse encore inconnue du bouclier (elle est créée avec sa raison). */
  /* ⚙️ RÉGLAGE DU PDG : bloquer AUSSI les adresses partagées (cybercafé, hôtel, réseau mobile).
     Par défaut : NON — bloquer une adresse partagée punirait des inconnus honnêtes. */
  if (p === '/api/admin/shield/regle' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    db.config = db.config || {};
    db.config.shieldPartagees = !!b.bloquerPartagees;
    saveDb();
    auditLog('shield_regle', { bloquerPartagees: db.config.shieldPartagees, par: 'PDG' });
    return sendJson(res, 200, { ok: true, bloquerPartagees: db.config.shieldPartagees,
      message: db.config.shieldPartagees
        ? 'Le bouclier bloque maintenant aussi les adresses partagées (déconseillé)'
        : 'Les adresses partagées ne sont plus jamais bloquées automatiquement (règle normale)' });
  }
  if (p === '/api/admin/shield/recaler' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const ip = String(b.ip || '').slice(0, 64);
    shieldEnsure();
    if (!ip) return sendJson(res, 400, { error: 'Adresse IP requise' });
    const minutes = Math.max(1, Math.min(1440, parseInt(b.minutes, 10) || 60));
    const rec = shieldBloquer(ip, 'pdg-recale', minutes, 'pdg');
    rec.annihilated = false;
    shieldLog(ip, 'pdg-recale', '/hq', 'PDG a bloqué ' + minutes + ' min', 0);
    auditLog('shield_recale', { ip, par: 'PDG', minutes });
    return sendJson(res, 200, { ok: true, ip, minutes, jusqua: rec.blockedUntil, raison: rec.blockReason });
  }
  if (p === '/api/admin/shield/aneantir' && req.method === 'POST') {
    if (!pdgOnly(req, res)) return;
    const b = await readBody(req);
    const ip = String(b.ip || '').slice(0, 64);
    shieldEnsure();
    if (!ip) return sendJson(res, 400, { error: 'IP requise' });
    const prev = db.shield.ips[ip] || { score: 0, hits: 0 };
    db.shield.ips[ip] = Object.assign(prev, { blocked: true, annihilated: true, last: nowISO(), kind: 'pdg-aneanti',
      blockBy: 'pdg', blockKind: 'pdg-aneanti', blockReason: SHIELD_MOTIFS['pdg-aneanti'],
      blockedAt: nowISO(), blockMinutes: 0, blockedUntil: '' });
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
    if (!ip) return sendJson(res, 400, { error: 'Adresse IP requise' });
    shieldEnsure();
    if (!db.shield.ips[ip]) db.shield.ips[ip] = { score: 0, hits: 0, firstSeen: nowISO() };
    db.shield.ips[ip].blocked = false;
    db.shield.ips[ip].annihilated = false;
    db.shield.ips[ip].score = 0;
    db.shield.ips[ip].serieux = 0;
    db.shield.ips[ip].bloqueCount = 0;
    db.shield.ips[ip].blockBy = '';
    db.shield.ips[ip].blockedUntil = '';
    db.shield.ips[ip].blockReason = '';
    db.shield.ips[ip].legacyReouvert = false;
    db.shield.ips[ip].last = nowISO();
    shieldLog(ip, 'pdg-pardon', '/hq', 'PDG a rétabli l’adresse', 0);
    saveDb();
    auditLog('shield_pardon', { ip, par: 'PDG' });
    return sendJson(res, 200, { ok: true, ip, etat: 'normale' });
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
    /* 🛡️ même règle que pour les requêtes : état RÉEL (un blocage temporaire expiré est déjà rouvert) */
    if (shieldBloque(ip0)) { sock.end(); return; }
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
    try { pubMediaRestaurer(); } catch (e) { }   /* 🖼️ remet en place les médias perdus par un redéploiement (après chargement de la base) */
    try {
      tarifEnsure();
      const _zsrc = db.tarif.zonesSrc || {};
      console.log('  💰 Moteur de tarification : ' + Object.keys(db.tarif.svc).length + ' services tarifés · version ' + db.tarif.version
        + ' · déplacement : ' + (db.tarif.deplacement || {}).mode
        + ' · ' + Object.keys(db.tarif.zones || {}).length + ' zones (' + (_zsrc.actif ? 'distances validées' : 'distances À VALIDER : source + date') + ')');
      conditionsEnsure();
      console.log('  📜 Conditions Klean-Services : version ' + db.conditions.version + ' du ' + (db.conditions.maj || '?')
        + ' · ' + db.conditions.client.length + ' articles client · ' + db.conditions.pro.length + ' articles pro'
        + ' · ' + (db.conditions.exigee !== false ? 'acceptation OBLIGATOIRE à l’inscription' : 'acceptation facultative')
        + ' · ' + (db.conditions.acceptations || []).length + ' preuve(s) d’acceptation');
    } catch (e) { console.error('Tarification :', e.message); }
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
