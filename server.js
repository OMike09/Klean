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
  return c.split(';').some(x => x.trim() === 'klean_hq=' + adminToken());
}

/* ───────── Stockage : fichier local  OU  Postgres (Neon gratuit) si DATABASE_URL ─────────
   Sur Render (hébergement gratuit), le disque est effacé à chaque redémarrage :
   → mettez DATABASE_URL (Neon, gratuit sans CB) dans Render ≥ Environment,
     et les comptes/missions survivront à tous les redémarrages. */
let db = { agents: [], missions: [], clients: [] };
let pgClient = null;
async function pgQuery(sql, params) { const r = await pgClient.query(sql, params); return r; }
async function initStorage() {
  if (process.env.DATABASE_URL) {
    try {
      const { Client } = require('pg');
      pgClient = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await pgClient.connect();
      await pgClient.query('CREATE TABLE IF NOT EXISTS klean_state (id smallint PRIMARY KEY, data jsonb NOT NULL, updated timestamptz NOT NULL DEFAULT now())');
      const r = await pgClient.query('SELECT data FROM klean_state WHERE id=1');
      if (r.rows.length) db = r.rows[0].data;
      else await pgClient.query('INSERT INTO klean_state (id, data) VALUES (1, $1)', [JSON.stringify(db)]);
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
  if (!db.audit) db.audit = [];
  /* Pré-initialisation optionnelle du mot de passe via ADMIN_PIN (1er démarrage seulement) */
  if (!db.admin && process.env.ADMIN_PIN) {
    const salt = crypto.randomBytes(12).toString('hex');
    db.admin = { salt, passHash: hashPassword(salt, process.env.ADMIN_PIN) };
    saveDb();
  }
}
function saveDbNow() {
  const snap = JSON.stringify(db, null, 1);
  try { fs.writeFileSync(DB_FILE + '.tmp', snap); fs.renameSync(DB_FILE + '.tmp', DB_FILE); } catch (e) {}
  if (pgClient) {
    pgClient.query('UPDATE klean_state SET data=$1, updated=now() WHERE id=1', [JSON.parse(snap)])
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
function onlineAgents() { return [...sockets].filter(s => s.meta && s.meta.role === 'agent' && s.meta.online); }
function subsOf(missionId) { return [...sockets].filter(s => s.meta && s.meta.missions && s.meta.missions.has(missionId)); }
function adminSockets() { return [...sockets].filter(s => s.meta && s.meta.role === 'admin'); }
/* Envoie un événement au(x) tableau(x) de bord HQ en temps réel */
function emitAdmin(kind, text) { broadcast(adminSockets(), { type: 'admin_event', kind, text, at: nowISO() }); }

function routeWsMessage(sock, msg) {
  sock.meta = sock.meta || { missions: new Set() };
  switch (msg.type) {
    case 'hello':
      sock.meta.role = msg.role === 'agent' ? 'agent' : (msg.role === 'admin' && sock.meta.hqAuthed ? 'admin' : 'client');
      sock.meta.deviceId = msg.deviceId || null;
      break;
    case 'ping': break;
    case 'agent_online': {
      const ag = db.agents.find(a => a.id === (sock.meta.agentId || msg.agentId));
      if (!ag) { wsSend(sock, { type: 'agent_denied', reason: 'apply' }); break; }
      if (ag.status === 'pending') { wsSend(sock, { type: 'agent_pending' }); break; }
      if (ag.status === 'rejected') { wsSend(sock, { type: 'agent_denied', reason: 'rejected' }); break; }
      ag.nom = msg.nom || ag.nom; ag.quartier = msg.quartier || ag.quartier; ag.tel = msg.tel || ag.tel;
      ag.online = true; ag.lastSeen = nowISO();
      sock.meta.role = 'agent'; sock.meta.online = true; sock.meta.agentId = ag.id;
      saveDb();
      wsSend(sock, { type: 'agent_registered', agentId: ag.id });
      console.log(`🟢 Agent en ligne : ${ag.nom} (${ag.quartier}) — ${onlineAgents().length} en ligne`);
      emitAdmin('agent', `🟢 ${ag.nom} en ligne (${ag.quartier}) — ${onlineAgents().length} agent(s) en ligne`);
      break;
    }
    case 'agent_offline': {
      const ag = db.agents.find(a => a.id === (sock.meta.agentId || msg.agentId));
      if (ag) { ag.online = false; saveDb(); emitAdmin('agent', `⚪ ${ag.nom} est hors ligne`); }
      sock.meta.online = false;
      console.log('⚪ Agent hors ligne');
      break;
    }
    case 'subscribe_mission':
      sock.meta.missions.add(msg.missionId);
      break;
    case 'agent_pos': {   // 📡 position GPS envoyée périodiquement par l'agent
      const ag = db.agents.find(a => a.id === (sock.meta.agentId || msg.agentId));
      if (ag && typeof msg.lat === 'number' && typeof msg.lng === 'number') {
        ag.pos = { lat: msg.lat, lng: msg.lng, at: nowISO() };
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
    dist: m.dist, prixTotal: m.prixTotal,
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
function broadcastNewMission(m) {
  const targets = onlineAgents();
  broadcast(targets, { type: 'mission_request', mission: publicMissionForAgent(m) });
  console.log(`📢 Mission ${m.id} (${m.service} · ${m.prixTotal} F) diffusée à ${targets.length} agent(s)`);
  emitAdmin('mission', `📥 Nouvelle demande ${m.id} — ${m.service} · ${m.quartier} · ${m.prixTotal.toLocaleString('fr-FR')} F (${m.client.nom})`);
}

/* ───────── API REST ───────── */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/plain; charset=utf-8', '.ico': 'image/x-icon' };
function sendJson(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(b);
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

  /* --- API --- */
  if (p === '/api/health') return sendJson(res, 200, { ok: true, storage: pgClient ? 'postgres' : 'fichier', agentsEnLigne: onlineAgents().length, agentsTotal: db.agents.length, clientsTotal: db.clients.length, missions: db.missions.length });

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
      lat: typeof b.lat === 'number' ? b.lat : null,
      lng: typeof b.lng === 'number' ? b.lng : null,
      client: { nom: b.nom, tel: b.tel || '', deviceId: b.deviceId || '' },
      dist: Math.round((0.5 + Math.random() * 3.5) * 10) / 10,
      status: 'pending', agentId: null, createdAt: nowISO(), finishedAt: null, note: 0
    };
    const cli = findClientByToken(req);   // 👤 mission rattachée au compte client
    if (!cli) return sendJson(res, 401, { error: 'Inscription requise : créez votre compte client gratuit pour réserver' });
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
    console.log(`➡️  ${m.id} : ${status}`);
    const LBL = { enroute: '🛵 en route', arrive: '📍 arrivé sur place', encours: '🧽 nettoyage en cours', terminee: `✅ terminée — +${Math.round(m.prixTotal * feePct()).toLocaleString('fr-FR')} F de commission` };
    emitAdmin('status', `${LBL[status] || status} · ${m.id}`);
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

  if (p === '/api/admin/setup' && req.method === 'POST') {
    const { password } = await readBody(req);
    if (db.admin) return sendJson(res, 409, { error: 'Le mot de passe est déjà créé' });
    const perr = validPassword(password);
    if (perr) return sendJson(res, 400, { error: perr });
    const salt = crypto.randomBytes(12).toString('hex');
    db.admin = { salt, passHash: hashPassword(salt, password) };
    saveDb();
    console.log('🔑 Mot de passe HQ créé');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'klean_hq=' + adminToken() + '; Path=/; HttpOnly; SameSite=Lax; Secure' });
    return res.end('{"ok":true}');
  }

  if (p === '/api/admin/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || '?';
    const rec = loginTries.get(ip) || { n: 0, t: 0 };
    if (rec.n >= 6 && Date.now() - rec.t < 600000) { auditLog('hq_login_bloque', { ip }); return sendJson(res, 429, { error: 'Trop de tentatives — réessayez dans 10 min' }); }
    const b = await readBody(req);
    const pw = b.password || b.pin || '';
    if (db.admin && hashPassword(db.admin.salt, pw) === db.admin.passHash) {
      loginTries.delete(ip); auditLog('hq_connexion', { ip });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'klean_hq=' + adminToken() + '; Path=/; HttpOnly; SameSite=Lax; Secure' });
      return res.end('{"ok":true}');
    }
    loginTries.set(ip, { n: rec.n + 1, t: rec.t || Date.now() });
    auditLog('hq_login_echec', { ip });
    return sendJson(res, 401, { error: 'Mot de passe incorrect' });
  }

  if (p === '/api/admin/password' && req.method === 'POST') {
    if (!isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });
    const { current, next } = await readBody(req);
    if (!db.admin || hashPassword(db.admin.salt, current || '') !== db.admin.passHash)
      return sendJson(res, 401, { error: 'Mot de passe actuel incorrect' });
    const perr2 = validPassword(next);
    if (perr2) return sendJson(res, 400, { error: perr2 });
    const salt = crypto.randomBytes(12).toString('hex');
    db.admin = { salt, passHash: hashPassword(salt, next) };   // nouveau hash → nouvelles sessions, anciennes invalidées
    saveDb();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'klean_hq=' + adminToken() + '; Path=/; HttpOnly; SameSite=Lax; Secure' });
    return res.end('{"ok":true}');
  }
  if (p === '/api/admin/logout') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'klean_hq=; Path=/; Max-Age=0' });
    return res.end('{"ok":true}');
  }
  if (p.startsWith('/api/admin') && !isAdminReq(req)) return sendJson(res, 401, { error: 'non autorisé' });

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
    const cl = { id: uid('CL'), nom: b.nom.trim(), tel, quartier: b.quartier || '', salt, passHash: hashPassword(salt, b.password), createdAt: nowISO() };
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
    return sendJson(res, 200, { ok: true, clientId: cl.id, token: clientToken(cl.passHash), nom: cl.nom, quartier: cl.quartier, photo: cl.photo || '' });
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
    if (Array.isArray(b.services) && b.services.includes('cours') && !(b.niveau && String(b.niveau).trim())) return sendJson(res, 400, { error: 'Niveau d\'étude requis pour les Cours particuliers' });
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
      pieceType: b.pieceType, pieceNum: b.pieceNum,
      piecePhoto: typeof b.piecePhoto === 'string' && b.piecePhoto.length < 900000 ? b.piecePhoto : '',
      urgenceNom: b.urgenceNom.trim(), urgenceTel: String(b.urgenceTel).replace(/\D/g, ''),
      experience: Math.min(30, Math.max(0, parseInt(b.experience) || 0)),
      niveau: String(b.niveau || '').trim().slice(0, 60),
      ref1Nom: b.ref1Nom.trim(), ref1Tel: String(b.ref1Tel).replace(/\D/g, ''),
      ref2Nom: String(b.ref2Nom || '').trim(), ref2Tel: String(b.ref2Tel || '').replace(/\D/g, ''),
      photo: typeof b.photo === 'string' ? b.photo.slice(0, 600000) : '',
      services: Array.isArray(b.services) ? b.services.slice(0, 10) : [],
      online: false
    };
    ag.history = [{ at: nowISO(), by: 'agent', action: 'dossier envoye' }];
    if (reApply) {
      ag.history = (reApply.history || []).concat([{ at: nowISO(), by: 'agent', action: 'dossier renvoye apres infos demandees' }]);
      db.agents = db.agents.filter(a => a.id !== reApply.id);
      auditLog('agent_recandidature', { agent: ag.nom, tel: tel1 });
    }
    db.agents.push(ag); saveDb();
    emitAdmin('cand', `📋 Nouvelle candidature agent : ${ag.nom} (${ag.quartier}) — dossier à vérifier`);
    console.log(`📋 Candidature agent : ${ag.nom} — ${ag.pieceType} ${ag.pieceNum}`);
    return sendJson(res, 201, { ok: true, agentId: ag.id, status: 'pending' });
  }

  const aStatus = p.match(/^\/api\/agents\/(.+)\/status$/);
  if (aStatus && req.method === 'GET') {
    const ag = db.agents.find(a => a.id === aStatus[1]);
    if (!ag) return sendJson(res, 404, {});
    return sendJson(res, 200, { id: ag.id, nom: ag.nom, status: ag.status || 'approved', rejectReason: ag.rejectReason || '' });
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
    return sendJson(res, 200, {
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
    });
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

  if (p === '/api/admin/agents') {
    return sendJson(res, 200, db.agents.map(a => ({ id: a.id, nom: a.nom, quartier: a.quartier, online: !!a.online, status: a.status || 'approved', ...agentStats(a) })));
  }

  if (p === '/api/admin/inscrits') {
    const clients = db.clients.map(c => {
      const ms = db.missions.filter(m => m.clientId === c.id);
      const depense = ms.filter(m => m.status === 'terminee').reduce((s, m) => s + (m.prixTotal || 0), 0);
      return { id: c.id, nom: c.nom, tel: c.tel, quartier: c.quartier || '', createdAt: c.createdAt, photo: !!c.photo, missions: ms.length, depense };
    });
    const agents = db.agents.map(a => ({ id: a.id, nom: a.nom, tel: a.tel || a.tel1 || '', quartier: a.quartier || '', status: a.status || 'approved', online: !!a.online, niveau: a.niveau || '', services: a.services || [], createdAt: a.createdAt, photo: !!a.photo, ...agentStats(a) }));
    return sendJson(res, 200, { clients: clients.slice().reverse(), agents: agents.slice().reverse() });
  }

  /* --- Admin : dossiers de candidature --- */
  if (p === '/api/config') return sendJson(res, 200, { commission: (db.config && db.config.commission) || 25 });

  if (p === '/api/admin/config' && req.method === 'POST') {
    const b2 = await readBody(req);
    const cc = parseFloat(b2.commission);
    if (isNaN(cc) || cc < 0 || cc > 50) return sendJson(res, 400, { error: 'Taux de commission entre 0 et 50 %' });
    db.config = db.config || {}; db.config.commission = Math.round(cc * 10) / 10; db.config.updatedAt = nowISO();
    auditLog('commission_modifiee', { nouveau: db.config.commission, par: 'PDG' });
    saveDb();
    emitAdmin('admin', `⚙️ Commission plateforme réglée à ${db.config.commission} %`);
    return sendJson(res, 200, { ok: true, commission: db.config.commission });
  }

  if (p === '/api/admin/audit') return sendJson(res, 200, (db.audit || []).slice(-200).reverse());

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
    (ag.history = ag.history || []).push({ at: nowISO(), by: 'PDG', action: 'valide', from: 'pending', to: 'approved' });
    auditLog('agent_valide', { agent: ag.nom, id: ag.id, par: 'PDG' });
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
    (ag.history = ag.history || []).push({ at: nowISO(), by: 'PDG', action: 'rejete', motif: ag.rejectReason });
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
    (ag.history = ag.history || []).push({ at: nowISO(), by: 'PDG', action: 'infos_demandees', motif: ag.moreInfoReason });
    auditLog('agent_infos_demandees', { agent: ag.nom, id: ag.id, motif: ag.moreInfoReason });
    emitAdmin('cand', `📝 ${ag.nom} : informations supplémentaires demandées (${ag.moreInfoReason})`);
    const s = [...sockets].find(x => x.meta && x.meta.agentId === ag.id);
    if (s) wsSend(s, { type: 'agent_moreinfo', reason: ag.moreInfoReason });
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/stats') return sendJson(res, 200, {
    agentsEnLigne: onlineAgents().length,
    agentsTotal: db.agents.length,
    missionsTotal: db.missions.length,
    missionsTerminees: db.missions.filter(m => m.status === 'terminee').length
  });

  /* --- Fichiers statiques --- */
  if (p === '/admin' || p === '/admin.html') {
    // pas de redirection (certains proxies la cassent) : on sert directement le bon HTML
    const target = path.join(__dirname, isAdminReq(req) ? 'admin.html' : 'admin-login.html');
    fs.readFile(target, (err, data) => {
      if (err) { res.writeHead(404); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
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
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.meta = { missions: new Set(), hqAuthed: (req.headers.cookie || '').includes('klean_hq=' + adminToken()) };
  sockets.add(sock);
  sock.on('data', handleWsData(sock));
  const bye = () => {
    sockets.delete(sock);
    if (sock.meta && sock.meta.agentId) {
      const ag = db.agents.find(a => a.id === sock.meta.agentId);
      if (ag && ![...sockets].some(s => s.meta && s.meta.agentId === ag.id)) { ag.online = false; saveDb(); }
    }
  };
  sock.on('close', bye); sock.on('error', bye);
});

process.on('SIGTERM', () => { try { saveDbNow(); } catch (e) {} setTimeout(() => process.exit(0), 300); });

initStorage().then(() => {
  /* Sauvegarde avant l'arrêt du conteneur (redeploy Render envoie SIGTERM) */
process.on('SIGTERM', () => { try { saveDbNow(); } catch (e) { } setTimeout(() => process.exit(0), 400); });

server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log("  ✨ SERVEUR CENTRAL KLEAN — Côte d'Ivoire 🇨🇮");
    console.log('  ────────────────────────────────────');
    console.log('  🌐 Application : http://localhost:' + PORT);
    console.log('  🎛️  Tableau HQ : http://localhost:' + PORT + '/admin');
    console.log('  🔑 Mot de passe: ' + (db.admin ? 'déjà configuré ✓' : 'à créer à la 1re ouverture de /admin'));
    console.log('  📡 WebSocket   : ws://localhost:' + PORT + '/ws');
    console.log('  💰 Commission  : ' + (feePct() * 100) + '% par mission');
    console.log('  ────────────────────────────────────');
    console.log('');
  });
}).catch(e => { console.error('Démarrage impossible :', e); process.exit(1); });
