// ============================================================
// KLEAN-SERVICES CI — Serveur (Express + SQLite + SSE)
// ============================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const webpush = require('web-push');
const { db, hashPassword, getSetting, setSetting, DB_PATH } = require('./db');
const persist = require('./persist'); // sauvegarde PostgreSQL (activée si DATABASE_URL est définie)

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '2mb' }));
// Les prix, disponibilités et états sont toujours lus frais : aucun cache HTTP ne doit
// maintenir un ancien réglage du tableau de bord côté client.
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private'); next(); });

// Secret de session persistant
let SECRET = getSetting('auth_secret');
if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); setSetting('auth_secret', SECRET); }

// Web Push réel : s'active uniquement lorsque les 3 variables VAPID sont fournies sur Render.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contact@kleanservices.ci';
const WEB_PUSH_READY = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (WEB_PUSH_READY) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
else console.log('ℹ️ Web Push inactif : configurez VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY sur Render.');

// Réinitialisation du mot de passe administrateur via variable d'environnement (secours)
// Sur Render : Environment → ADMIN_PASSWORD = NouveauMotDePasse → redéployer → se connecter → retirer la variable.
if (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length >= 6) {
  const adminUser = db.prepare("SELECT * FROM users WHERE role IN ('pdg','admin') ORDER BY CASE role WHEN 'pdg' THEN 0 ELSE 1 END, id LIMIT 1").get();
  if (adminUser) {
    const s = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hashPassword(process.env.ADMIN_PASSWORD, s), s, adminUser.id);
    console.log('🔑 Mot de passe administrateur réinitialisé depuis la variable ADMIN_PASSWORD.');
  }
}

// ---------- UPLOADS ----------
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase().slice(0, 10).replace(/[^a-z0-9.]/g, '') || '.bin';
    cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });
// Les médias privés ne sont jamais servis par un simple dossier statique : connaître
// /uploads/nom.ext ne donne aucun droit. Une annonce publique active est la seule exception.
function uploadRequestUser(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  const payload = verifyToken(token);
  return payload ? db.prepare('SELECT * FROM users WHERE id=?').get(payload.id) : null;
}
function fileHasName(raw, name) {
  if (!raw) return false;
  try { return JSON.parse(raw).some(v => path.basename(String(v)) === name); } catch { return false; }
}
function uploadIsPublicAd(name) {
  return !!db.prepare("SELECT 1 FROM ads WHERE active=1 AND file LIKE ?").get('%/uploads/' + name);
}
function canReadUpload(user, name) {
  if (!user) return false;
  if (isStaff(user) && (hasPerm(user, 'securite') || hasPerm(user, 'missions') || hasPerm(user, 'communication'))) return true;
  const record = db.prepare('SELECT state, uploaded_by FROM file_records WHERE name=?').get(name);
  if (record && ['hidden', 'archived', 'recovery', 'purged'].includes(record.state) && record.uploaded_by !== user.id) return false;
  if (record && record.uploaded_by === user.id) return true;
  if (db.prepare('SELECT 1 FROM users WHERE id=? AND photo LIKE ?').get(user.id, '%/uploads/' + name)) return true;
  if (db.prepare('SELECT 1 FROM pro_profiles WHERE user_id=? AND documents LIKE ?').get(user.id, '%/uploads/' + name)) return true;
  const missions = db.prepare('SELECT * FROM missions WHERE photos LIKE ? OR audio LIKE ?').all('%/uploads/' + name, '%/uploads/' + name);
  for (const mission of missions) if ((fileHasName(mission.photos, name) || path.basename(mission.audio || '') === name) && missionAccess(mission, user)) return true;
  const msgMission = db.prepare('SELECT m.* FROM messages msg JOIN missions m ON m.id=msg.mission_id WHERE msg.file LIKE ?').all('%/uploads/' + name);
  for (const mission of msgMission) if (chatAccess(mission, user)) return true;
  const support = db.prepare('SELECT sc.* FROM support_messages sm JOIN support_conversations sc ON sc.id=sm.conversation_id WHERE sm.file LIKE ?').get('%/uploads/' + name);
  if (support && support.user_id === user.id) return true;
  // Les contenus explicitement publiés restent lisibles aux comptes connectés qui peuvent les voir dans l'application.
  if (db.prepare("SELECT 1 FROM avis_recherche WHERE photo LIKE ? AND status='approved'").get('%/uploads/' + name)) return true;
  if (db.prepare("SELECT 1 FROM jobs WHERE cv LIKE ? AND status='approved'").get('%/uploads/' + name)) return true;
  return false;
}
app.get('/uploads/:name', async (req, res) => {
  const name = path.basename(String(req.params.name || ''));
  if (!name || name !== req.params.name) return res.status(404).end();
  const user = uploadRequestUser(req);
  if (!uploadIsPublicAd(name) && !canReadUpload(user, name)) return res.status(user ? 403 : 401).end();
  const disk = path.join(UPLOAD_DIR, name);
  try {
    if (!fs.existsSync(disk) && persist.enabled()) {
      const data = await persist.loadFile(name);
      if (data) fs.writeFileSync(disk, data); // restauration locale après redéploiement
    }
    if (!fs.existsSync(disk)) return res.status(404).end();
    res.set('Cache-Control', 'private, no-store');
    res.sendFile(disk);
  } catch { res.status(404).end(); }
});

// ---------- SAUVEGARDE AUTOMATIQUE POSTGRESQL ----------
function dbBytes() {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { }
  return fs.readFileSync(DB_PATH);
}
let lastChanges = -1;
async function backupNow(force) {
  if (!persist.enabled()) return;
  try {
    const changes = db.prepare('SELECT total_changes() c').get().c;
    if (!force && changes === lastChanges) return;
    await persist.backupDb(dbBytes());
    lastChanges = changes;
  } catch (e) { console.error('Sauvegarde PostgreSQL échouée :', e.message); }
}
setInterval(() => backupNow(false), 30 * 1000);          // toutes les 30 s si quelque chose a changé
setInterval(() => backupNow(true), 10 * 60 * 1000);      // sécurité : toutes les 10 min quoi qu'il arrive
async function gracefulExit(sig) {
  try { await backupNow(true); console.log('Sauvegarde finale effectuée (' + sig + ').'); } catch { }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
process.on('SIGINT', () => gracefulExit('SIGINT'));

// ---------- AUTH ----------
function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return data + '.' + sig;
}
function verifyToken(token) {
  if (!token) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
function recordRealActivity(userId, state = 'active') {
  // Une interaction explicite est horodatée. Les rafraîchissements ou flux en arrière-plan ne l'appellent jamais.
  const user = db.prepare('SELECT last_activity_at FROM users WHERE id=?').get(userId);
  if (!user) return;
  if (state === 'background') {
    db.prepare("UPDATE users SET activity_state='background', last_background_at=datetime('now') WHERE id=?").run(userId);
    return;
  }
  db.prepare("UPDATE users SET activity_state='active', last_activity_at=datetime('now') WHERE id=?").run(userId);
  // Granularité volontairement limitée : au plus une trace active par quart d'heure, pour éviter le pistage fin.
  const recent = db.prepare("SELECT id FROM user_activity_events WHERE user_id=? AND event_type='active' AND created_at>=datetime('now','-15 minutes') ORDER BY id DESC LIMIT 1").get(userId);
  if (!recent) db.prepare("INSERT INTO user_activity_events(user_id,event_type) VALUES(?,'active')").run(userId);
}
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Session expirée. Veuillez vous reconnecter.' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(payload.id);
  if (!user) return res.status(401).json({ error: 'Compte introuvable.' });
  if (user.role !== 'pdg') { // le compte PDG reste TOUJOURS accessible
    if (user.blocked) return res.status(403).json({ error: 'Votre compte est bloqué. Contactez Klean Services.' });
    if (user.suspended) return res.status(403).json({ error: 'Votre compte est suspendu. Contactez Klean Services.' });
    if (user.disabled_until && user.disabled_until > new Date().toISOString().slice(0, 19).replace('T', ' '))
      return res.status(403).json({ error: 'Votre compte est temporairement désactivé jusqu\u2019au ' + user.disabled_until.slice(0, 16).replace('T', ' ') + '.' });
  }
  req.user = user;
  next();
}


// Lecture publique : un jeton valide enrichit la réponse avec les éléments appartenant au visiteur,
// sans jamais rendre obligatoire une session pour consulter le contenu ouvert.
function optionalAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  const payload = verifyToken(token);
  if (!payload) return next();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(payload.id);
  if (!user || (user.role !== 'pdg' && (user.blocked || user.suspended || (user.disabled_until && user.disabled_until > new Date().toISOString().slice(0, 19).replace('T', ' '))))) return next();
  req.user = user;
  next();
}

// ---------- HIÉRARCHIE & PERMISSIONS ----------
// PDG → Administrateurs → Gestionnaires → Agents → Utilisateurs
const STAFF_ROLES = ['pdg', 'admin', 'gestionnaire', 'agent'];
const ROLE_LABELS = { pdg: 'PDG', admin: 'Administrateur', gestionnaire: 'Gestionnaire', agent: 'Agent', user: 'Utilisateur' };
// Clés de permission (sections du tableau de bord). Le PDG a toujours tout.
const PERM_KEYS = {
  comptes: 'Gestion des comptes utilisateurs',
  comptes_suppr: 'Suppression définitive de comptes',
  pros: 'Validation des professionnels',
  catalogue: 'Métiers, services, tâches & villes',
  questions: 'Questions dynamiques',
  missions: 'Demandes & missions',
  paiements: 'Paiements & commissions',
  communication: 'Publicités & messages système',
  securite: 'Signalements, urgences & fichiers',
  contenu: 'Avis de recherche, jobs, école, jeux',
  parametres: 'Paramètres généraux',
  frequentation: 'Statistiques de fréquentation',
  journal: 'Journal des actions',
};
// Valeurs par défaut par rôle (modifiables par le PDG, compte par compte)
const DEFAULT_PERMS = {
  pdg: Object.keys(PERM_KEYS),
  admin: Object.keys(PERM_KEYS).filter(k => k !== 'comptes_suppr'),
  gestionnaire: ['comptes', 'pros', 'missions', 'contenu', 'frequentation'],
  agent: ['missions'],
};
function effectivePerms(u) {
  if (u.role === 'pdg') return Object.keys(PERM_KEYS);
  if (!STAFF_ROLES.includes(u.role)) return [];
  const base = DEFAULT_PERMS[u.role] || [];
  if (!u.perms) return base;
  try {
    const o = JSON.parse(u.perms); // { clé: 0|1 } — remplace la valeur par défaut
    return Object.keys(PERM_KEYS).filter(k => (k in o ? !!o[k] : base.includes(k)));
  } catch { return base; }
}
function hasPerm(u, key) { return u.role === 'pdg' || effectivePerms(u).includes(key); }
function isStaff(u) { return STAFF_ROLES.includes(u.role); }
function admin(req, res, next) {
  if (!isStaff(req.user)) return res.status(403).json({ error: 'Accès réservé à l\u2019administration.' });
  next();
}
function pdgOnly(req, res, next) {
  if (req.user.role !== 'pdg') return res.status(403).json({ error: 'Action réservée au PDG.' });
  next();
}

// ---------- JOURNAL DES ACTIONS SENSIBLES ----------
function logAction(adminUser, action, opts = {}) {
  db.prepare(`INSERT INTO admin_log(admin_id, admin_name, admin_role, action, target_type, target_id, target_name, details, reason)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(adminUser.id, adminUser.name, adminUser.role, action,
      opts.target_type || null, opts.target_id || null, opts.target_name || null,
      opts.details ? String(opts.details).slice(0, 500) : null, opts.reason || null);
}
function publicUser(u, withContact = false) {
  if (!u) return null;
  const r = db.prepare('SELECT AVG(rating) avg, COUNT(*) n FROM reviews WHERE target_id=?').get(u.id);
  const base = { id: u.id, name: u.name, photo: u.photo, is_pro: u.is_pro, verified: u.verified, rating: r.avg ? Math.round(r.avg * 10) / 10 : null, reviews_count: r.n };
  if (withContact) { base.phone = u.phone; base.address = u.address; }
  return base;
}

// ---------- SSE (temps réel) ----------
const sseClients = new Map(); // userId -> Set(res)
app.get('/api/stream', auth, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  if (!sseClients.has(req.user.id)) sseClients.set(req.user.id, new Set());
  sseClients.get(req.user.id).add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); const s = sseClients.get(req.user.id); if (s) { s.delete(res); if (!s.size) sseClients.delete(req.user.id); } });
});
function push(userId, type, data) {
  const set = sseClients.get(userId);
  if (!set) return;
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) { try { res.write(msg); } catch {} }
}
function sendWebPush(userId, payload) {
  if (!WEB_PUSH_READY) return;
  const subscriptions = db.prepare('SELECT id, subscription FROM push_subscriptions WHERE user_id=?').all(userId);
  subscriptions.forEach(s => {
    let sub; try { sub = JSON.parse(s.subscription); } catch { db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(s.id); return; }
    webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 60 }).catch(err => {
      // Une souscription expirée/invalide ne doit pas être réessayée indéfiniment.
      if (err && (err.statusCode === 404 || err.statusCode === 410)) db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(s.id);
      else console.warn('Web Push non envoyé :', err && err.statusCode || err && err.message || 'erreur');
    });
  });
}
function notify(userId, category, title, body, link, options = {}) {
  const info = db.prepare('INSERT INTO notifications(user_id, category, title, body, link) VALUES(?,?,?,?,?)').run(userId, category, title, body || '', link || '');
  const unread = db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0').get(userId).n;
  const payload = { id: info.lastInsertRowid, category, title, body, link, unread,
    // Le navigateur/OS décide du rendu final ; ce flag respecte le réglage PDG pour les missions.
    sound: category === 'mission' ? getSetting('dispatch_alert_sound', '1') === '1' : true };
  push(userId, 'notification', { ...payload, reminder: !!options.reminder });
  // Les rappels rapprochés sont sonores uniquement au premier plan (SSE). Ils ne déclenchent pas une rafale de Push/sonneries système.
  if (!options.skipWebPush) sendWebPush(userId, payload);
  return info.lastInsertRowid;
}
function notifyAdmins(category, title, body, link) {
  db.prepare("SELECT id FROM users WHERE role IN ('pdg','admin','gestionnaire')").all().forEach(a => notify(a.id, category, title, body, link));
}

// ============================================================
// AUTHENTIFICATION & COMPTE (compte unique client + pro)
// ============================================================
// ============================================================
// MODE MAINTENANCE / SUSPENSION DES ACTIVITÉS (réservé au PDG)
// ============================================================
const MAINT_SCOPES = {
  A: 'Suspendre toute nouvelle activité (demandes, inscriptions, activités pro, publications, jeux)',
  B: 'Suspendre uniquement les nouvelles demandes de service',
  C: 'Suspendre uniquement les inscriptions',
  D: 'Suspendre uniquement les activités des professionnels',
  E: 'Suspendre des fonctions précises (à cocher)',
  F: 'Mettre toute la plateforme en maintenance',
};
const MAINT_FONCTIONS = {
  missions: 'Nouvelles demandes de service',
  inscriptions: 'Nouvelles inscriptions',
  pro: 'Activités professionnelles (accepter, démarrer, terminer une mission…)',
  paiements: 'Confirmation des paiements',
  messages: 'Messagerie des missions',
  contenu: 'Publications (avis de recherche, jobs, école & famille)',
  jeux: 'Jeux (Quiz, Flip Fizz, Kdo)',
};
const SCOPE_FUNCS = { A: ['missions', 'inscriptions', 'pro', 'contenu', 'jeux'], B: ['missions'], C: ['inscriptions'], D: ['pro'] };
const MAINT_ROUTES = [
  [/^\/api\/auth\/register$/, 'inscriptions'],
  [/^\/api\/missions$/, 'missions'], // POST = nouvelle demande
  [/^\/api\/missions\/\d+\/(accept|refuse|confirm|montant|start|complete|relancer|choisir)/, 'pro'],
  [/^\/api\/pro\//, 'pro'],
  [/^\/api\/missions\/\d+\/payment\//, 'paiements'],
  [/^\/api\/missions\/\d+\/messages$/, 'messages'],
  [/^\/api\/(avis-recherche|jobs|ecole-famille)$/, 'contenu'],
  [/^\/api\/games\//, 'jeux'],
];
function getMaintenance() {
  try {
    const m = JSON.parse(getSetting('maintenance', '') || '{}');
    if (m.active && m.until && m.until.replace('T', ' ').slice(0, 19) < new Date().toISOString().slice(0, 19).replace('T', ' '))
      return { ...m, expired: true }; // durée écoulée → la maintenance se termine automatiquement
    return m;
  } catch { return {}; }
}
function maintenanceMessage(m) {
  return m.message || 'Klean Services est temporairement en maintenance. Nous revenons très vite. Merci de votre patience.';
}
// État public (l'application affiche le message aux utilisateurs)
app.get('/api/maintenance', (req, res) => {
  const m = getMaintenance();
  const on = m.active && !m.expired;
  res.json({ active: !!on, scope: on ? m.scope : null, message: on ? maintenanceMessage(m) : null, until: on && m.until ? m.until : null });
});
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const m = getMaintenance();
  if (!m.active || m.expired) return next();
  // Le compte PDG n'est JAMAIS bloqué
  const tok = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  const payload = verifyToken(tok);
  if (payload) {
    const u = db.prepare('SELECT role FROM users WHERE id=?').get(payload.id);
    if (u && u.role === 'pdg') return next();
  }
  // Toujours accessibles : connexion, état de maintenance, tableau de bord (les permissions du PDG s'y appliquent)
  if (req.path === '/api/auth/login' || req.path === '/api/maintenance' || req.path.startsWith('/api/auth/reset-') || req.path.startsWith('/api/admin/')) return next();
  if (m.scope === 'F') {
    if (req.method === 'GET' && (req.path === '/api/me' || req.path === '/api/rules')) return next(); // l'app peut se charger et afficher le message
    return res.status(503).json({ error: maintenanceMessage(m), maintenance: true });
  }
  if (req.method === 'GET') return next(); // hors plateforme entière, la consultation reste possible
  const fns = m.scope === 'E' ? (m.functions || []) : (SCOPE_FUNCS[m.scope] || []);
  if (MAINT_ROUTES.find(([re, k]) => re.test(req.path) && fns.includes(k)))
    return res.status(503).json({ error: maintenanceMessage(m), maintenance: true });
  next();
});

app.post('/api/auth/register', (req, res) => {
  const { name, phone, password, address, ville, quartier, lat, lng, accept_rules, referral_token } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Veuillez indiquer votre nom.' });
  if (!phone || !/^[+0-9 ]{8,20}$/.test(phone.trim())) return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
  if (!accept_rules) return res.status(400).json({ error: 'Vous devez accepter les règles d\u2019utilisation.' });
  const p = phone.trim().replace(/\s+/g, '');
  // UN NUMÉRO = UN COMPTE (règle stricte)
  if (db.prepare('SELECT id FROM users WHERE phone=?').get(p)) return res.status(409).json({ error: 'Ce numéro est déjà associé à un compte.', duplicate: true });
  const adr = (address || '').trim() || [ville, quartier].filter(Boolean).join(', ') || null;
  const salt = crypto.randomBytes(16).toString('hex');
  const info = db.prepare(`INSERT INTO users(name, phone, password_hash, salt, address, ville, quartier, lat, lng, rules_accepted_at) VALUES(?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(name.trim(), p, hashPassword(password, salt), salt, adr, (ville || '').trim() || null, (quartier || '').trim() || null, lat || null, lng || null);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  // Attribution vérifiable uniquement après l'inscription : jamais à partir d'un simple clic Partager.
  const ref = String(referral_token || '').trim();
  if (ref) {
    const share = db.prepare('SELECT * FROM share_events WHERE token=? AND joined_user_id IS NULL').get(ref);
    if (share && share.user_id !== user.id) {
      db.prepare("UPDATE share_events SET joined_user_id=?, joined_at=datetime('now') WHERE id=? AND joined_user_id IS NULL").run(user.id, share.id);
      db.prepare('UPDATE users SET referred_by_share_id=? WHERE id=?').run(share.id, user.id);
    }
  }
  recordRealActivity(user.id, 'active');
  notify(user.id, 'compte', 'Bienvenue sur Klean Services 👋', 'Votre compte est créé. Recherchez un service ou devenez professionnel depuis Mon compte.', '#/home');
  res.json({ token: sign({ id: user.id, exp: Date.now() + 90 * 86400000 }), user: me(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { phone, password } = req.body || {};
  const p = (phone || '').trim().replace(/\s+/g, '');
  const user = db.prepare('SELECT * FROM users WHERE phone=?').get(p);
  let ok = !!user && user.password_hash === hashPassword(password || '', user.salt);
  // Compte importé de l'ancienne application : on accepte aussi l'ANCIEN mot de passe
  if (!ok && user) {
    const legacy = db.prepare('SELECT sha256 FROM legacy_passwords WHERE user_id=?').get(user.id);
    if (legacy && crypto.createHash('sha256').update(password || '').digest('hex') === legacy.sha256) {
      ok = true; // on migre vers le nouveau chiffrement, puis on supprime l'ancien
      const salt = crypto.randomBytes(16).toString('hex');
      db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hashPassword(password, salt), salt, user.id);
      db.prepare('DELETE FROM legacy_passwords WHERE user_id=?').run(user.id);
    }
  }
  if (!ok)
    return res.status(401).json({ error: 'Téléphone ou mot de passe incorrect.' });
  if (user.role !== 'pdg') { // le compte PDG reste toujours accessible
    if (user.blocked) return res.status(403).json({ error: 'Votre compte est bloqué. Contactez Klean Services.' });
    if (user.suspended) return res.status(403).json({ error: 'Votre compte est suspendu. Contactez Klean Services.' });
    if (user.disabled_until && user.disabled_until > new Date().toISOString().slice(0, 19).replace('T', ' '))
      return res.status(403).json({ error: 'Votre compte est temporairement désactivé jusqu\u2019au ' + user.disabled_until.slice(0, 16) + '.' });
  }
  recordRealActivity(user.id, 'active');
  res.json({ token: sign({ id: user.id, exp: Date.now() + 90 * 86400000 }), user: me(user) });
});

function me(u) {
  const pro = db.prepare('SELECT * FROM pro_profiles WHERE user_id=?').get(u.id);
  const r = db.prepare('SELECT AVG(rating) avg, COUNT(*) n FROM reviews WHERE target_id=?').get(u.id);
  return {
    id: u.id, name: u.name, phone: u.phone, email: u.email, photo: u.photo, address: u.address, lat: u.lat, lng: u.lng,
    ville: u.ville, quartier: u.quartier, kp_code: u.kp_code || null,
    role: u.role, is_pro: u.is_pro, pro_status: u.pro_status, verified: u.verified,
    must_change_password: !!u.must_change_password, profile_incomplete: !!u.profile_incomplete, font_size: u.font_size || null,
    rating: r.avg ? Math.round(r.avg * 10) / 10 : null, reviews_count: r.n,
    pro: pro ? { ...pro, services: JSON.parse(pro.services), documents: JSON.parse(pro.documents),
      domain_categories: (() => { try { const v = JSON.parse(pro.domain_categories || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })(),
      authorized_domain_categories: pro.authorized_domain_categories === null || pro.authorized_domain_categories === undefined ? null : (() => { try { const v = JSON.parse(pro.authorized_domain_categories || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })(),
      service_cities: (() => { try { const v = JSON.parse(pro.service_cities || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })() } : null,
    perms: isStaff(u) ? effectivePerms(u) : undefined
  };
}
// ---------- À propos & partage traçable ----------
function safeAbout(raw) {
  let items; try { items = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { items = []; }
  if (!Array.isArray(items)) items = [];
  return items.slice(0, 20).map(v => ({ heading: String(v && v.heading || '').trim().slice(0, 120), text: String(v && v.text || '').trim().slice(0, 4000) })).filter(v => v.heading || v.text);
}
function publicBaseUrl(req) {
  const configured = String(getSetting('share_official_url', '') || '').trim();
  if (/^https?:\/\//i.test(configured)) return configured.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}
app.get('/api/about', (req, res) => {
  const row = db.prepare('SELECT title,published,published_at FROM app_about WHERE id=1').get();
  res.json({ title: row ? (row.published_title || row.title) : 'À propos de Klean Services', paragraphs: safeAbout(row && row.published), published_at: row && row.published_at });
});
app.get('/api/share/config', auth, (req, res) => res.json({ official_url: publicBaseUrl(req), text: String(getSetting('share_text', 'Découvrez Klean Services : exprimez votre besoin, un professionnel arrive.') || '').slice(0, 500) }));
app.post('/api/share/prepare', auth, (req, res) => {
  const token = crypto.randomBytes(18).toString('base64url');
  const id = db.prepare('INSERT INTO share_events(user_id,token) VALUES(?,?)').run(req.user.id, token).lastInsertRowid;
  const base = publicBaseUrl(req);
  const sep = base.includes('?') ? '&' : '?';
  res.json({ id, url: base + sep + 'ref=' + encodeURIComponent(token), text: String(getSetting('share_text', 'Découvrez Klean Services : exprimez votre besoin, un professionnel arrive.') || '').slice(0, 500), note: 'L’ouverture du partage ne prouve pas qu’un envoi externe a été effectué. Seuls un lien ouvert et une inscription par ce lien sont mesurables.' });
});
// Cette route est appelée à l'ouverture d'un lien : elle mesure l'arrivée, pas un partage externe.
app.post('/api/share/open/:token', (req, res) => {
  const r = db.prepare("UPDATE share_events SET detected_at=COALESCE(detected_at,datetime('now')) WHERE token=?").run(String(req.params.token || '').slice(0, 100));
  res.json({ ok: !!r.changes });
});
app.post('/api/activity', auth, (req, res) => {
  const state = req.body && req.body.state === 'background' ? 'background' : 'active';
  recordRealActivity(req.user.id, state);
  res.json({ ok: true, state });
});

app.get('/api/me', auth, (req, res) => res.json(me(req.user)));

app.put('/api/me', auth, (req, res) => {
  const { name, photo, address, ville, quartier, email, lat, lng, font_size } = req.body || {};
  if (font_size !== undefined && font_size !== null) {
    const f = parseInt(font_size, 10);
    if (isNaN(f) || f < 14 || f > 26) return res.status(400).json({ error: 'Taille de texte invalide (14 à 26).' });
  }
  db.prepare(`UPDATE users SET name=COALESCE(?,name), photo=COALESCE(?,photo), address=COALESCE(?,address),
    ville=COALESCE(?,ville), quartier=COALESCE(?,quartier), email=COALESCE(?,email),
    lat=COALESCE(?,lat), lng=COALESCE(?,lng), font_size=COALESCE(?,font_size) WHERE id=?`)
    .run(name || null, photo || null, address || null, (ville ?? null) || null, (quartier ?? null) || null, (email ?? null) || null,
      lat ?? null, lng ?? null, font_size ? parseInt(font_size, 10) : null, req.user.id);
  if (req.user.profile_incomplete && (ville || address)) db.prepare('UPDATE users SET profile_incomplete=0 WHERE id=?').run(req.user.id); // profil complété
  res.json(me(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)));
});

// ============================================================
// RÉCUPÉRATION SÉCURISÉE DE L'ACCÈS (mot de passe oublié)
// Un code de vérification à 6 chiffres est généré (haché en base,
// valable 15 minutes, 5 essais maximum). L'équipe le communique
// après vérification de l'identité. Aucun mot de passe n'est jamais
// affiché ni stocké en clair.
// ============================================================
app.post('/api/auth/reset-request', (req, res) => {
  const p = (req.body && req.body.phone || '').trim().replace(/\s+/g, '');
  const user = db.prepare('SELECT * FROM users WHERE phone=?').get(p);
  const reponse = { ok: true, message: 'Si un compte existe avec ce numéro, un code de vérification à 6 chiffres a été généré. Notre équipe vous le communique au ' + (p || 'numéro indiqué') + ' après vérification de votre identité. Il est valable 15 minutes.' };
  if (!user) return res.json(reponse); // réponse identique pour ne pas révéler l'existence d'un compte
  // Limite : 3 demandes par heure
  const recentes = db.prepare("SELECT COUNT(*) n FROM reset_codes WHERE user_id=? AND created_at > datetime('now','-1 hour')").get(user.id).n;
  if (recentes >= 3) return res.status(429).json({ error: 'Trop de demandes. Réessayez dans une heure ou contactez Klean Services.' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare('UPDATE reset_codes SET used=1 WHERE user_id=? AND used=0').run(user.id); // un seul code actif à la fois
  db.prepare("INSERT INTO reset_codes(user_id, code_hash, expires_at) VALUES(?,?,datetime('now','+15 minutes'))")
    .run(user.id, crypto.createHash('sha256').update(code).digest('hex'));
  notifyAdmins('securite', '🔑 Demande de récupération d\u2019accès',
    `${user.name} (${user.phone}) a demandé un code de récupération. VÉRIFIEZ SON IDENTITÉ (appelez le numéro du compte) puis communiquez-lui le code : ${code} — valable 15 minutes.`,
    'admin:users');
  res.json(reponse);
});
app.post('/api/auth/reset-confirm', (req, res) => {
  const { phone, code, password } = req.body || {};
  const p = (phone || '').trim().replace(/\s+/g, '');
  if (!password || password.length < 6) return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 6 caractères.' });
  const user = db.prepare('SELECT * FROM users WHERE phone=?').get(p);
  const rc = user ? db.prepare("SELECT * FROM reset_codes WHERE user_id=? AND used=0 AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1").get(user.id) : null;
  if (!rc) return res.status(400).json({ error: 'Code invalide ou expiré. Refaites une demande de récupération.' });
  if (rc.attempts >= 5) { db.prepare('UPDATE reset_codes SET used=1 WHERE id=?').run(rc.id); return res.status(400).json({ error: 'Trop d\u2019essais. Refaites une demande de récupération.' }); }
  if (crypto.createHash('sha256').update(String(code || '')).digest('hex') !== rc.code_hash) {
    db.prepare('UPDATE reset_codes SET attempts=attempts+1 WHERE id=?').run(rc.id);
    return res.status(400).json({ error: 'Code incorrect (' + (4 - rc.attempts) + ' essai(s) restant(s)).' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET password_hash=?, salt=?, must_change_password=0 WHERE id=?').run(hashPassword(password, salt), salt, user.id);
  db.prepare('UPDATE reset_codes SET used=1 WHERE id=?').run(rc.id);
  notify(user.id, 'compte', '🔑 Mot de passe modifié', 'Votre mot de passe a été modifié grâce au code de vérification. Si ce n\u2019était pas vous, contactez immédiatement Klean Services.', '#/account');
  res.json({ token: sign({ id: user.id, exp: Date.now() + 90 * 86400000 }), user: me(db.prepare('SELECT * FROM users WHERE id=?').get(user.id)) });
});

app.put('/api/me/password', auth, (req, res) => {
  const { current, password } = req.body || {};
  if (req.user.password_hash !== hashPassword(current || '', req.user.salt)) return res.status(400).json({ error: 'Mot de passe actuel incorrect.' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 6 caractères.' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET password_hash=?, salt=?, must_change_password=0 WHERE id=?').run(hashPassword(password, salt), salt, req.user.id);
  res.json({ ok: true });
});

// Souscriptions Web Push : permission navigateur nécessaire, VAPID requis côté Render.
app.get('/api/push/config', auth, (req, res) => res.json({ enabled: WEB_PUSH_READY, public_key: WEB_PUSH_READY ? VAPID_PUBLIC_KEY : null }));
app.post('/api/push/subscribe', auth, (req, res) => {
  if (!WEB_PUSH_READY) return res.status(503).json({ error: 'Les notifications Web Push ne sont pas encore configurées par Klean Services.' });
  const sub = (req.body || {}).subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return res.status(400).json({ error: 'Souscription navigateur invalide.' });
  db.prepare(`INSERT INTO push_subscriptions(user_id,endpoint,subscription,updated_at) VALUES(?,?,?,datetime('now'))
    ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, subscription=excluded.subscription, updated_at=datetime('now')`).run(req.user.id, sub.endpoint, JSON.stringify(sub));
  res.json({ ok: true });
});
app.delete('/api/push/subscribe', auth, (req, res) => {
  const endpoint = String((req.body || {}).endpoint || '');
  if (!endpoint) return res.status(400).json({ error: 'Souscription manquante.' });
  db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?').run(req.user.id, endpoint);
  res.json({ ok: true });
});

// Adresses
app.get('/api/addresses', auth, (req, res) => res.json(db.prepare('SELECT * FROM addresses WHERE user_id=? ORDER BY id DESC').all(req.user.id)));
app.post('/api/addresses', auth, (req, res) => {
  const { label, address, lat, lng } = req.body || {};
  if (!address) return res.status(400).json({ error: 'Adresse requise.' });
  const info = db.prepare('INSERT INTO addresses(user_id,label,address,lat,lng) VALUES(?,?,?,?,?)').run(req.user.id, label || null, address, lat || null, lng || null);
  res.json(db.prepare('SELECT * FROM addresses WHERE id=?').get(info.lastInsertRowid));
});
app.delete('/api/addresses/:id', auth, (req, res) => {
  db.prepare('DELETE FROM addresses WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// Upload générique (photos, audio, documents) — copié aussi dans PostgreSQL si configuré
app.post('/api/upload', auth, upload.array('files', 8), async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  // Le registre rend chaque fichier traçable (propriétaire, taille, état de conservation).
  const register = db.prepare(`INSERT INTO file_records(name, uploaded_by, mime, size) VALUES(?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET uploaded_by=excluded.uploaded_by, mime=excluded.mime, size=excluded.size, state='active', updated_at=datetime('now')`);
  for (const f of req.files) register.run(f.filename, req.user.id, f.mimetype || '', f.size || 0);
  if (persist.enabled()) {
    try {
      for (const f of req.files) await persist.saveFile(f.filename, fs.readFileSync(f.path));
    } catch (e) { console.error('Copie PostgreSQL du fichier échouée :', e.message); }
  }
  res.json({ files: req.files.map(f => '/uploads/' + f.filename) });
});

// Contrôles serveur des médias et quotas de discussion. Le client peut afficher un chrono,
// mais il ne décide jamais seul de ce qui est accepté.
function uploadRecordFor(file) {
  const name = typeof file === 'string' && file.startsWith('/uploads/') ? path.basename(file) : null;
  if (!name || file !== '/uploads/' + name) return null;
  return db.prepare('SELECT * FROM file_records WHERE name=?').get(name);
}
function settingInt(key, fallback, min, max) {
  const n = parseInt(getSetting(key, String(fallback)), 10);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : fallback));
}
let musicMetadataModule = null;
async function audioDurationSeconds(file) {
  const rec = uploadRecordFor(file);
  if (!rec) return null;
  const local = path.join(UPLOAD_DIR, rec.name);
  try {
    if (!fs.existsSync(local) && persist.enabled()) {
      const data = await persist.loadFile(rec.name); if (data) fs.writeFileSync(local, data);
    }
    if (!fs.existsSync(local)) return null;
    musicMetadataModule = musicMetadataModule || await import('music-metadata');
    const meta = await musicMetadataModule.parseFile(local, { duration: true });
    const d = meta && meta.format && Number(meta.format.duration);
    return Number.isFinite(d) && d >= 0 ? d : null;
  } catch { return null; }
}
function assertOwnUploadedFile(user, file, expected) {
  const rec = uploadRecordFor(file);
  if (!rec) throw new Error('Fichier invalide ou non enregistré.');
  if (rec.uploaded_by && rec.uploaded_by !== user.id) throw new Error('Ce fichier ne vous appartient pas.');
  if (rec.state !== 'active') throw new Error('Ce fichier est archivé, masqué ou indisponible.');
  if (expected === 'photo' && !/^image\//i.test(rec.mime || '')) throw new Error('Le fichier sélectionné n’est pas une image.');
  if (expected === 'audio' && !/^audio\//i.test(rec.mime || '')) throw new Error('Le fichier sélectionné n’est pas un audio.');
  return rec;
}

// Règles (textes gérés par l'administration)
app.get('/api/rules', (req, res) => res.json({ client: getSetting('rules_client'), pro: getSetting('rules_pro') }));

// ============================================================
// SERVICES & RECHERCHE INTELLIGENTE
// ============================================================
function normalize(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function jsonArray(raw) { try { const v = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw; return Array.isArray(v) ? v : []; } catch { return []; } }
function jsonObject(raw) { try { const v = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw; return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } }
function numberIds(raw) { return [...new Set(jsonArray(raw).map(Number).filter(Number.isInteger))]; }
// Tri francophone insensible aux accents, appliqué aux listes de consultation sans priorité métier.
const frenchCollator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
function frenchSort(rows, field = 'name') { return [...rows].sort((a, b) => frenchCollator.compare(String(a[field] || ''), String(b[field] || ''))); }
function cityMatches(target, city) {
  const a = normalize(target), b = normalize(city);
  if (!a || !b) return true;
  return a === b || (a === 'abidjan' && b.startsWith('abidjan '));
}
// Un service est-il proposé dans la ville demandée ? ([] = partout)
function villeOk(s, ville) {
  if (!ville) return true;
  const cities = jsonArray(s.cities);
  return !cities.length || cities.some(c => cityMatches(c, ville));
}
function activeCity(city) {
  const wanted = String(city || '').trim();
  if (!wanted) return null;
  const direct = db.prepare('SELECT name FROM villes WHERE active=1 AND lower(name)=lower(?)').get(wanted);
  if (direct) return direct;
  // Compatibilité non destructive des anciens profils « Abidjan / Cocody » :
  // ils sont lus comme Abidjan + commune, mais ne sont plus proposés à la sélection.
  const legacy = wanted.match(/^abidjan\s*\/\s*(.+)$/i);
  if (legacy) { const commune = activeCommune('Abidjan', legacy[1]); if (commune) return { name:'Abidjan', legacy_commune:commune.name }; }
  return null;
}
function activeCommune(city, commune) {
  const cityName = String(city || '').trim(), communeName = String(commune || '').trim();
  if (!cityName || !communeName) return null;
  return db.prepare('SELECT name FROM communes WHERE active=1 AND lower(city_name)=lower(?) AND lower(name)=lower(?)').get(cityName, communeName) || null;
}
function ruleCityMatches(ruleCity, city) {
  const targets = String(ruleCity || '').split(',').map(x => x.trim()).filter(Boolean);
  return !targets.length || targets.some(target => cityMatches(target, city));
}
function activeDomainIds(raw) {
  const ids = [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT id FROM grand_categories WHERE active=1 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return rows.map(r => r.id);
}
function domainsForServiceIds(raw) {
  const ids = [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return [];
  return [...new Set(db.prepare(`SELECT DISTINCT c.grand_category_id id FROM services s JOIN service_categories c ON c.id=s.category_id WHERE s.active=1 AND c.grand_category_id IS NOT NULL AND s.id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(r => r.id))];
}
function catalogueServiceRows(whereActive = true) {
  return db.prepare(`SELECT s.*, c.name cat, c.icon, c.grand_category_id, gc.name grand_category, gc.icon grand_icon, sc.name sous_cat
    FROM services s JOIN service_categories c ON c.id=s.category_id
    LEFT JOIN grand_categories gc ON gc.id=c.grand_category_id
    LEFT JOIN sous_categories sc ON sc.id=s.sub_id
    ${whereActive ? 'WHERE s.active=1 AND c.active=1 AND (gc.id IS NULL OR gc.active=1)' : ''}`).all();
}

function categoryReferencePrice(grandCategoryId, city) {
  const cats = db.prepare('SELECT id FROM service_categories WHERE active=1 AND grand_category_id=?').all(grandCategoryId).map(r => r.id);
  if (!cats.length) return null;
  const marks = cats.map(() => '?').join(',');
  const services = db.prepare(`SELECT id FROM services WHERE active=1 AND category_id IN (${marks})`).all(...cats).map(r => r.id);
  if (!services.length) return null;
  const svcMarks = services.map(() => '?').join(',');
  const tasks = db.prepare(`SELECT id FROM taches WHERE active=1 AND service_id IN (${svcMarks})`).all(...services).map(r => r.id);
  // Une carte de catégorie ne montre qu'une référence explicitement documentée.
  // Elle ne déduit ni prix de marché ni majoration de complexité/commune.
  const candidates = db.prepare('SELECT * FROM price_estimation_rules WHERE active=1 AND source_note IS NOT NULL AND source_note<>\'\' AND verified_at IS NOT NULL AND verified_at<>\'\'').all()
    .filter(r => {
      if (r.grand_category_id && Number(r.grand_category_id) !== Number(grandCategoryId)) return false;
      if (r.category_id && !cats.includes(Number(r.category_id))) return false;
      if (r.service_id && !services.includes(Number(r.service_id))) return false;
      if (r.task_id && !tasks.includes(Number(r.task_id))) return false;
      if (r.city && (!city || !ruleCityMatches(r.city, city))) return false;
      // Sans commune choisie, une règle strictement communale ne représente pas la catégorie entière.
      if (r.zone) return false;
      return Number(r.base_price || r.min_price || r.max_price || 0) > 0;
    }).map(r => Number(r.base_price || r.min_price || r.max_price)).filter(n => n > 0);
  return candidates.length ? Math.min(...candidates) : null;
}
function grandCategoryCatalogue(grandId, city) {
  const grand = db.prepare('SELECT id,name,description,icon,sort,popular,popular_sort FROM grand_categories WHERE id=? AND active=1').get(grandId);
  if (!grand) return null;
  const categories = frenchSort(db.prepare('SELECT id,name,icon,sort FROM service_categories WHERE active=1 AND grand_category_id=?').all(grand.id));
  const svcs = catalogueServiceRows().filter(s => Number(s.grand_category_id) === Number(grand.id) && villeOk(s, city));
  const taskRows = frenchSort(db.prepare('SELECT id,service_id,name,description,sort FROM taches WHERE active=1').all());
  return { ...grand, price_from: categoryReferencePrice(grand.id, city), categories: categories.map(c => ({ ...c,
    services: svcs.filter(s => Number(s.category_id) === Number(c.id)).map(s => ({ id:s.id,name:s.name,icon:s.icon,description:s.description || '',
      taches: taskRows.filter(t => Number(t.service_id) === Number(s.id)).map(t => ({ id:t.id,name:t.name,description:t.description || '' }))
    }))
  })).filter(c => c.services.length) };
}
app.get('/api/grand-categories', (req, res) => {
  const city = activeCity(req.query.ville);
  const ids = frenchSort(db.prepare('SELECT id,name FROM grand_categories WHERE active=1').all());
  res.json(ids.map(r => grandCategoryCatalogue(r.id, city && city.name)).filter(Boolean));
});
app.get('/api/grand-categories/populaires', (req, res) => {
  const city = activeCity(req.query.ville);
  const rows = db.prepare('SELECT id FROM grand_categories WHERE active=1 AND popular=1 ORDER BY CASE WHEN popular_sort IS NULL THEN 1 ELSE 0 END,popular_sort,sort,id').all();
  res.json(rows.map(r => grandCategoryCatalogue(r.id, city && city.name)).filter(Boolean));
});
app.get('/api/grand-categories/:id/catalogue', (req, res) => {
  const city = activeCity(req.query.ville);
  const catalogue = grandCategoryCatalogue(Number(req.params.id), city && city.name);
  if (!catalogue) return res.status(404).json({ error:'Catégorie introuvable ou inactive.' });
  res.json(catalogue);
});
app.get('/api/services', (req, res) => {
  const cats = frenchSort(db.prepare(`SELECT c.*,gc.name grand_category,gc.icon grand_icon FROM service_categories c
    LEFT JOIN grand_categories gc ON gc.id=c.grand_category_id WHERE c.active=1 AND (gc.id IS NULL OR gc.active=1)`).all());
  const svcs = frenchSort(catalogueServiceRows().filter(s => villeOk(s, req.query.ville)));
  const publicService = ({ price_from, price_prefix, price_show, price_updated_at, ...service }) => service;
  res.json(cats.map(c => ({ ...c, services: svcs.filter(s => s.category_id === c.id).map(publicService) })).filter(c => c.services.length));
});
// Catalogue complet : racine grand domaine → métiers existants → sous-catégories → prestations/tâches.
app.get('/api/catalogue', (req, res) => {
  const cats = frenchSort(db.prepare(`SELECT c.*,gc.name grand_category,gc.icon grand_icon FROM service_categories c
    LEFT JOIN grand_categories gc ON gc.id=c.grand_category_id WHERE c.active=1 AND (gc.id IS NULL OR gc.active=1)`).all());
  const svcs = frenchSort(catalogueServiceRows().filter(s => villeOk(s, req.query.ville)));
  const tas = frenchSort(db.prepare('SELECT * FROM taches WHERE active=1').all());
  res.json(cats.map(c => ({
    id: c.id, name: c.name, icon: c.icon, grand_category_id: c.grand_category_id, grand_category: c.grand_category, grand_icon: c.grand_icon,
    services: svcs.filter(s => s.category_id === c.id).map(s => ({
      id: s.id, name: s.name, popular: s.popular, seasonal: s.seasonal,
      taches: tas.filter(t => t.service_id === s.id).map(t => ({ id: t.id, name: t.name, description: t.description || '' }))
    }))
  })).filter(c => c.services.length));
});
// Services populaires (accueil) — sélection de la même liste de services,
// dans l'ordre choisi par l'administration (popular_sort)
app.get('/api/services/populaires', (req, res) => {
  const svcs = db.prepare(`SELECT s.id, s.name, s.cities, c.icon, c.name cat FROM services s
    JOIN service_categories c ON c.id=s.category_id
    LEFT JOIN grand_categories gc ON gc.id=c.grand_category_id
    WHERE s.active=1 AND c.active=1 AND (gc.id IS NULL OR gc.active=1) AND s.popular=1
    ORDER BY CASE WHEN s.popular_sort IS NULL THEN 1 ELSE 0 END, s.popular_sort, s.sort, s.id LIMIT 12`).all()
    .filter(s => villeOk(s, req.query.ville)).map(({ cities, ...s }) => s);
  res.json(svcs);
});
// Villes de Côte d'Ivoire (liste sélectionnable, avec recherche côté application)
app.get('/api/villes', (req, res) => {
  res.json(frenchSort(db.prepare("SELECT name FROM villes WHERE active=1 AND name NOT LIKE 'Abidjan / %'").all()).map(v => v.name));
});
// Communes administrées dans la source centrale. Une commune n'est demandée que
// lorsque la ville choisie est Abidjan ; le GPS ne peut jamais la déduire à la place du client.
app.get('/api/communes', (req, res) => {
  const city = activeCity(req.query.city);
  if (!city) return res.status(400).json({ error: 'Ville invalide.' });
  res.json(frenchSort(db.prepare('SELECT name FROM communes WHERE active=1 AND lower(city_name)=lower(?) ORDER BY sort,id').all(city.name)).map(r => r.name));
});
app.get('/api/services/:id/questions', (req, res) => {
  const svc = db.prepare(`SELECT s.*, c.name cat, c.grand_category_id, gc.name grand_category FROM services s
    JOIN service_categories c ON c.id=s.category_id LEFT JOIN grand_categories gc ON gc.id=c.grand_category_id
    WHERE s.id=? AND s.active=1 AND c.active=1`).get(req.params.id);
  if (!svc) return res.status(404).json({ error: 'Service introuvable.' });
  const questions = db.prepare('SELECT * FROM service_questions WHERE service_id=? AND active=1 ORDER BY sort,id').all(svc.id)
    .map(q => ({ ...q, options: JSON.parse(q.options) }));
  const taches = frenchSort(db.prepare('SELECT id, name, description FROM taches WHERE service_id=? AND active=1').all(svc.id));
  res.json({ service: { id: svc.id, name: svc.name, category: svc.cat, grand_category_id: svc.grand_category_id, grand_category: svc.grand_category }, questions, taches,
    limits: { photos: settingInt('request_image_limit', 3, 0, 3), audio_seconds: settingInt('request_audio_max_seconds', 25, 1, 25) } });
});

const STOPWORDS = new Set(['je', 'cherche', 'un', 'une', 'des', 'le', 'la', 'les', 'de', 'du', 'mon', 'ma', 'mes', 'pour', 'a', 'au', 'en', 'et', 'faire', 'veux', 'voudrais', 'besoin', 'il', 'me', 'faut', 'quelqu', 'qui', 'peut', 'sait', 'chez', 'dans', 'est', 'plus']);
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a || !b) return Math.max(a.length, b.length);
  if (Math.abs(a.length - b.length) > 3) return 4;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}
function relevanceForTerm(query, words, candidate) {
  const c = normalize(candidate); if (!c) return 0;
  if (c === query) return 120;
  if (c.includes(query) || (query.length > 3 && query.includes(c))) return 64;
  const candidateWords = c.split(' ').filter(Boolean);
  let score = 0;
  words.forEach(w => {
    if (candidateWords.includes(w)) score += 14;
    else if (candidateWords.some(v => v.startsWith(w) || (w.length > 3 && w.startsWith(v)))) score += 7;
    else if (w.length >= 4 && candidateWords.some(v => v.length >= 4 && levenshtein(w, v) <= (w.length >= 7 ? 2 : 1))) score += 5;
  });
  return score;
}
function intelligentSearch(query, city) {
  const q = normalize(query);
  const words = q.split(/\s+/).filter(w => w.length > 1 && !STOPWORDS.has(w));
  if (q.length < 2 || !words.length) return [];
  const svcs = catalogueServiceRows().filter(s => villeOk(s, city));
  const tasks = db.prepare('SELECT id,service_id,name FROM taches WHERE active=1').all();
  const terms = db.prepare(`SELECT st.service_id,st.task_id,st.term,t.name task_name FROM service_search_terms st
    LEFT JOIN taches t ON t.id=st.task_id WHERE st.active=1`).all();
  const tasksByService = new Map(), termsByService = new Map();
  tasks.forEach(t => { const a = tasksByService.get(t.service_id) || []; a.push(t); tasksByService.set(t.service_id, a); });
  terms.forEach(t => { const a = termsByService.get(t.service_id) || []; a.push(t); termsByService.set(t.service_id, a); });
  return svcs.map(s => {
    let bestScore = relevanceForTerm(q, words, `${s.name} ${s.cat} ${s.sous_cat || ''} ${s.keywords || ''}`), bestTask = null, bestMatch = '';
    (termsByService.get(s.id) || []).forEach(term => {
      const score = relevanceForTerm(q, words, term.term);
      if (score > bestScore) { bestScore = score; bestTask = term.task_id ? { id: term.task_id, name: term.task_name } : null; bestMatch = term.term; }
    });
    (tasksByService.get(s.id) || []).forEach(task => {
      const score = relevanceForTerm(q, words, task.name);
      if (score > bestScore) { bestScore = score; bestTask = task; bestMatch = task.name; }
    });
    // Sans tâche exacte, une tâche contenant le meilleur mot reste une suggestion, jamais une certitude.
    if (!bestTask && bestScore >= 14) {
      const fallback = (tasksByService.get(s.id) || []).find(t => words.some(w => normalize(t.name).includes(w)));
      if (fallback) bestTask = fallback;
    }
    return {
      id: s.id, name: s.name, category: s.cat, grand_category: s.grand_category || null, grand_category_id: s.grand_category_id || null,
      icon: s.icon,
      task_id: bestTask && bestTask.id || null, tache_suggeree: bestTask && bestTask.name || null,
      confidence: bestScore >= 60 ? 'élevée' : bestScore >= 18 ? 'moyenne' : 'faible', match: bestMatch || null, score: bestScore
    };
  }).filter(s => s.score >= 10).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'fr')).slice(0, 10);
}
app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').slice(0, 300);
  const results = intelligentSearch(q, req.query.ville);
  const normalized = normalize(q);
  const words = normalized.split(/\s+/).filter(Boolean);
  const groups = new Map();
  results.forEach(r => { if (r.grand_category_id) groups.set(Number(r.grand_category_id), Math.max(groups.get(Number(r.grand_category_id)) || 0, Number(r.score || 0))); });
  db.prepare('SELECT id,name,description,icon FROM grand_categories WHERE active=1').all().forEach(g => {
    const score = relevanceForTerm(normalized, words, `${g.name} ${g.description || ''}`);
    if (score >= 10) groups.set(g.id, Math.max(groups.get(g.id) || 0, score));
  });
  const categories = [...groups.entries()].map(([id,score]) => {
    const g = db.prepare('SELECT id,name,description,icon FROM grand_categories WHERE id=? AND active=1').get(id);
    return g && { ...g, score };
  }).filter(Boolean).sort((a,b) => b.score-a.score || a.name.localeCompare(b.name,'fr')).slice(0,6);
  res.json({ results, categories, query: q });
});

function parsedRuleFactors(raw) {
  const f = jsonObject(raw);
  const fixed = Math.max(-1000000, Math.min(1000000, Number(f.fixed_adjustment || f.frais_deplacement || 0) || 0));
  const percent = Math.max(-90, Math.min(500, Number(f.percent_adjustment || 0) || 0));
  return { ...f, fixed_adjustment: fixed, percent_adjustment: percent };
}
function estimatePrice({ serviceId, taskId, city, zone, details } = {}) {
  const svc = db.prepare(`SELECT s.*,c.id category_id,c.grand_category_id,c.name category_name,sc.name sub_name
    FROM services s JOIN service_categories c ON c.id=s.category_id LEFT JOIN sous_categories sc ON sc.id=s.sub_id
    WHERE s.id=? AND s.active=1 AND c.active=1`).get(Number(serviceId));
  if (!svc) return { status: 'confirm', reason: 'Service indisponible.' };
  const task = taskId ? db.prepare('SELECT * FROM taches WHERE id=? AND service_id=? AND active=1').get(Number(taskId), svc.id) : null;
  const description = String(details || '').trim();
  if (!description) return { status: 'confirm', needs_description: true, service_id: svc.id, task_id: task && task.id || null };
  const chosenCity = activeCity(city);
  if (!chosenCity) return { status: 'confirm', needs_city: true, service_id: svc.id, task_id: task && task.id || null };
  const chosenCommune = normalize(chosenCity.name) === 'abidjan' ? activeCommune(chosenCity.name, zone || chosenCity.legacy_commune) : null;
  if (normalize(chosenCity.name) === 'abidjan' && !chosenCommune) {
    return { status: 'confirm', needs_commune: true, city: chosenCity.name, service_id: svc.id, task_id: task && task.id || null };
  }
  const geoEnabled = getSetting('price_estimation_geo_enabled', '1') === '1';
  const rules = db.prepare('SELECT * FROM price_estimation_rules WHERE active=1').all().filter(r => {
    if (r.grand_category_id && Number(r.grand_category_id) !== Number(svc.grand_category_id)) return false;
    if (r.category_id && Number(r.category_id) !== Number(svc.category_id)) return false;
    if (r.sub_id && Number(r.sub_id) !== Number(svc.sub_id)) return false;
    if (r.service_id && Number(r.service_id) !== Number(svc.id)) return false;
    if (r.task_id && (!task || Number(r.task_id) !== Number(task.id))) return false;
    // Aucune surcote de commune implicite : une zone agit uniquement lorsqu'une
    // règle PDG/référence vérifiée l'a explicitement désignée.
    if (geoEnabled && r.city && !ruleCityMatches(r.city, chosenCity.name)) return false;
    if (geoEnabled && r.zone && (!chosenCommune || normalize(r.zone) !== normalize(chosenCommune.name))) return false;
    return true;
  });
  const rank = r => {
    const source = r.source_type === 'pdg' ? 3 : r.source_type === 'local_verifie' ? 2 : 1;
    const geographic = (r.city && ruleCityMatches(r.city, chosenCity.name) ? 32 : 0) + (r.zone && chosenCommune && normalize(r.zone) === normalize(chosenCommune.name) ? 16 : 0);
    const specificity = (r.task_id ? 16 : 0) + (r.service_id ? 8 : 0) + (r.sub_id ? 4 : 0) + (r.category_id ? 2 : 0) + (r.grand_category_id ? 1 : 0);
    return [source, Number(r.priority || 0), geographic + specificity, Number(r.id)];
  };
  rules.sort((a, b) => { const ra=rank(a), rb=rank(b); for(let i=0;i<ra.length;i++) if(ra[i]!==rb[i]) return rb[i]-ra[i]; return 0; });
  const selected = rules[0];
  if (selected && (Number(selected.base_price) > 0 || Number(selected.min_price) > 0 || Number(selected.max_price) > 0)) {
    const factors = parsedRuleFactors(selected.factors);
    let amount = Number(selected.base_price || selected.min_price || selected.max_price || 0);
    amount = Math.round(amount * (1 + factors.percent_adjustment / 100) + factors.fixed_adjustment);
    if (Number(selected.min_price) > 0) amount = Math.max(amount, Number(selected.min_price));
    if (Number(selected.max_price) > 0) amount = Math.min(amount, Number(selected.max_price));
    // La règle est une valeur explicitement approuvée par le PDG, ou une référence
    // locale vérifiée. Les facteurs ne peuvent jamais fabriquer une valeur sans base.
    return { status: 'estimated', amount, city: chosenCity.name, commune: chosenCommune && chosenCommune.name || null,
      service_id: svc.id, task_id: task && task.id || null, rule_id: selected.id };
  }
  const minSamples = settingInt('price_estimation_history_min_samples', 3, 3, 100);
  const historic = db.prepare(`SELECT m.amount FROM missions m JOIN payments p ON p.mission_id=m.id
    WHERE m.service_id=? AND m.intervention_city=? AND (? IS NULL OR m.intervention_commune=?)
      AND p.status='valide' AND m.amount IS NOT NULL ORDER BY m.amount`).all(svc.id, chosenCity.name, chosenCommune ? chosenCommune.name : null, chosenCommune ? chosenCommune.name : null).map(r => Number(r.amount)).filter(n => n > 0);
  if (historic.length >= minSamples) {
    // Médiane : plus robuste qu'une moyenne contre une mission atypique, et utilisée
    // seulement au sein d'une même prestation, ville et commune si nécessaire.
    const middle = Math.floor(historic.length / 2);
    const amount = historic.length % 2 ? historic[middle] : Math.round((historic[middle - 1] + historic[middle]) / 2);
    return { status: 'estimated', amount, city: chosenCity.name, commune: chosenCommune && chosenCommune.name || null,
      service_id: svc.id, task_id: task && task.id || null, samples: historic.length };
  }
  // Le prix statique d'un service n'est jamais exploité comme pseudo-prix de marché.
  return { status: 'confirm', city: chosenCity.name, commune: chosenCommune && chosenCommune.name || null,
    service_id: svc.id, task_id: task && task.id || null, reason: 'Prix à confirmer' };
}
app.get('/api/estimates', (req, res) => {
  const result = estimatePrice({ serviceId: req.query.service_id, taskId: req.query.task_id, city: req.query.city, zone: req.query.zone, details: req.query.details });
  res.json(result);
});

// ============================================================
// ESPACE PROFESSIONNEL
// ============================================================
function declaredDomainsFromPayload(body) {
  const raw = Array.isArray(body && body.domain_categories) ? body.domain_categories : [];
  const direct = activeDomainIds(raw);
  // Compatibilité API avec les comptes/profils créés avant la sélection simplifiée.
  return direct.length ? direct : domainsForServiceIds(Array.isArray(body && body.services) ? body.services : []);
}
function effectiveDomains(profile) {
  if (!profile) return null;
  if (profile.authorized_domain_categories !== null && profile.authorized_domain_categories !== undefined && profile.authorized_domain_categories !== '') return numberIds(profile.authorized_domain_categories);
  const declared = numberIds(profile.domain_categories);
  return declared.length ? declared : null; // null laisse les anciens profils sur la logique services.
}

app.post('/api/pro/apply', auth, (req, res) => {
  const { profession, description, experience, zone, services, documents, accept_rules } = req.body || {};
  const proType = req.body.pro_type === 'entreprise' ? 'entreprise' : 'particulier';
  const domainCategories = declaredDomainsFromPayload(req.body || {});
  if (req.user.pro_status === 'approved') return res.status(400).json({ error: 'Vous êtes déjà professionnel.' });
  if (req.user.pro_status === 'pending') return res.status(400).json({ error: 'Votre demande est déjà en cours de validation.' });
  if (!profession || !profession.trim()) return res.status(400).json({ error: proType === 'entreprise' ? 'Indiquez le domaine d\u2019activité de l\u2019entreprise.' : 'Indiquez votre profession.' });
  if (!domainCategories.length) return res.status(400).json({ error: 'Sélectionnez au moins un domaine d’activité actif.' });
  if (!zone || !zone.trim()) return res.status(400).json({ error: 'Indiquez votre zone d\u2019intervention.' });
  if (!accept_rules) return res.status(400).json({ error: 'Vous devez accepter les règles professionnelles.' });
  const companyName = (req.body.company_name || '').trim();
  if (proType === 'entreprise' && !companyName) return res.status(400).json({ error: 'Indiquez le nom de votre entreprise.' });
  // Condition de validation activable depuis le tableau de bord : justificatif requis selon le type de compte
  if (getSetting('pro_doc_' + proType) === '1' && !(Array.isArray(documents) && documents.length))
    return res.status(400).json({ error: proType === 'entreprise'
      ? 'Un document justificatif est requis pour un compte Entreprise (registre de commerce, pièce du responsable…).'
      : 'Un document justificatif est requis (CNI, attestation…).' });
  // Les domaines sont la source d’autorisation fonctionnelle. Le champ services
  // historique est conservé pour les anciens profils, sans obliger le nouveau pro à cocher chaque prestation.
  db.prepare(`INSERT INTO pro_profiles(user_id, profession, description, experience, zone, services, authorized_services, domain_categories, authorized_domain_categories, documents, pro_type, company_name, company_rccm, company_size)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(user_id) DO UPDATE SET profession=excluded.profession, description=excluded.description,
                experience=excluded.experience, zone=excluded.zone, domain_categories=excluded.domain_categories,
                authorized_domain_categories=NULL, documents=excluded.documents, pro_type=excluded.pro_type,
                company_name=excluded.company_name, company_rccm=excluded.company_rccm, company_size=excluded.company_size, rejected_reason=NULL`)
    .run(req.user.id, profession.trim(), description || '', experience || '', zone.trim(), JSON.stringify(Array.isArray(services) ? services.map(Number).filter(Number.isInteger) : []), '[]', JSON.stringify(domainCategories), null, JSON.stringify(documents || []),
      proType, companyName || null, (req.body.company_rccm || '').trim() || null, (req.body.company_size || '').trim() || null);
  db.prepare(`UPDATE users SET pro_status='pending', pro_rules_accepted_at=datetime('now') WHERE id=?`).run(req.user.id);
  notifyAdmins('compte', 'Nouvelle demande professionnelle', `${req.user.name} souhaite devenir professionnel (${proType === 'entreprise' ? '🏢 Entreprise « ' + companyName + ' » — ' : '👤 Particulier — '}${profession}).`, 'admin:pros');
  notify(req.user.id, 'compte', 'Demande envoyée ✅', 'Votre demande professionnelle est en cours de validation par l\u2019administration.', '#/pro');
  res.json({ ok: true, pro_status: 'pending' });
});

function parseOption(row) { return { ...row, categories: (() => { try { return JSON.parse(row.categories || '[]'); } catch { return []; } })() }; }
function eligibleProOptions(user) {
  const prof = db.prepare('SELECT pro_type, services FROM pro_profiles WHERE user_id=?').get(user.id);
  if (!prof) return [];
  let serviceIds = []; try { serviceIds = JSON.parse(prof.services || '[]').map(Number); } catch {}
  const cats = serviceIds.length ? db.prepare(`SELECT DISTINCT category_id FROM services WHERE id IN (${serviceIds.map(() => '?').join(',')})`).all(...serviceIds).map(r => r.category_id) : [];
  return db.prepare("SELECT * FROM pro_account_options WHERE active=1 AND suspended=0 AND (pro_type='tous' OR pro_type=?) ORDER BY sort,id").all(prof.pro_type || 'particulier')
    .map(parseOption).filter(o => !o.categories.length || o.categories.some(c => cats.includes(Number(c))));
}
app.get('/api/pro-options', auth, (req, res) => {
  if (req.user.pro_status !== 'approved') return res.status(403).json({ error: 'Espace réservé aux professionnels validés.' });
  const used = db.prepare('SELECT option_id, payload, created_at FROM pro_option_usage WHERE user_id=? ORDER BY id DESC').all(req.user.id);
  const latest = new Map(); used.forEach(u => { if (!latest.has(u.option_id)) latest.set(u.option_id, u); });
  res.json(eligibleProOptions(req.user).map(o => ({ ...o, usage: latest.get(o.id) ? { payload: latest.get(o.id).payload, created_at: latest.get(o.id).created_at } : null })));
});
app.post('/api/pro-options/:id/use', auth, (req, res) => {
  if (req.user.pro_status !== 'approved') return res.status(403).json({ error: 'Espace réservé aux professionnels validés.' });
  const option = db.prepare('SELECT * FROM pro_account_options WHERE id=?').get(req.params.id);
  if (!option || !option.active || option.suspended) return res.status(403).json({ error: 'Cette option professionnelle est inactive ou suspendue par Klean Services.' });
  if (!eligibleProOptions(req.user).some(o => o.id === option.id)) return res.status(403).json({ error: 'Cette option ne s’applique pas à votre type de compte ou à vos catégories.' });
  const payload = String((req.body || {}).payload || '').trim().slice(0, 2000);
  if (option.required && !payload) return res.status(400).json({ error: 'Cette option obligatoire doit être renseignée.' });
  db.prepare('INSERT INTO pro_option_usage(option_id,user_id,payload) VALUES(?,?,?)').run(option.id, req.user.id, payload || null);
  res.json({ ok: true });
});

app.put('/api/pro/availability', auth, (req, res) => {
  if (req.user.pro_status !== 'approved') return res.status(403).json({ error: 'Espace réservé aux professionnels validés.' });
  const active = db.prepare("SELECT 1 FROM missions WHERE pro_id=? AND status IN ('acceptee','confirmee','demarrage_demande','en_cours','fin_demande') LIMIT 1").get(req.user.id);
  if (active && req.body.available) return res.status(409).json({ error: 'Vous êtes déjà en mission. Votre disponibilité sera rétablie à la clôture de celle-ci.' });
  const available = req.body.available ? 1 : 0;
  db.prepare('UPDATE pro_profiles SET available=?, availability_status=?, availability_before_mission=NULL WHERE user_id=?')
    .run(available, available ? 'disponible' : 'indisponible', req.user.id);
  res.json({ available, availability_status: available ? 'disponible' : 'indisponible' });
});

app.put('/api/pro/profile', auth, (req, res) => {
  if (!db.prepare('SELECT 1 FROM pro_profiles WHERE user_id=?').get(req.user.id)) return res.status(404).json({ error: 'Profil professionnel introuvable.' });
  const { profession, description, experience, zone, services, documents, company_name, company_rccm, company_size } = req.body || {};
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'domain_categories')) return res.status(400).json({ error: 'Les domaines d’activité validés sont modifiés par une demande soumise à l’administration.' });
  db.prepare(`UPDATE pro_profiles SET profession=COALESCE(?,profession), description=COALESCE(?,description),
              experience=COALESCE(?,experience), zone=COALESCE(?,zone),
              services=COALESCE(?,services), documents=COALESCE(?,documents),
              company_name=COALESCE(?,company_name), company_rccm=COALESCE(?,company_rccm), company_size=COALESCE(?,company_size) WHERE user_id=?`)
    .run(profession || null, description ?? null, experience ?? null, zone || null,
         services ? JSON.stringify(services) : null, documents ? JSON.stringify(documents) : null,
         company_name ?? null, company_rccm ?? null, company_size ?? null, req.user.id);
  res.json(me(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)));
});

// Un professionnel déjà validé ne modifie pas lui-même ses domaines effectifs :
// la demande est historisée et attend la décision de l’administration.
app.post('/api/pro/domain-change-request', auth, (req, res) => {
  if (req.user.pro_status !== 'approved') return res.status(403).json({ error: 'Espace réservé aux professionnels validés.' });
  const profile = db.prepare('SELECT * FROM pro_profiles WHERE user_id=?').get(req.user.id);
  if (!profile) return res.status(404).json({ error: 'Profil professionnel introuvable.' });
  const requested = activeDomainIds((req.body || {}).domain_categories);
  if (!requested.length) return res.status(400).json({ error: 'Sélectionnez au moins un domaine d’activité actif.' });
  const current = effectiveDomains(profile) || numberIds(profile.domain_categories);
  if (requested.length === current.length && requested.every(id => current.includes(id))) return res.status(409).json({ error: 'Ces domaines sont déjà ceux autorisés sur votre profil.' });
  if (db.prepare("SELECT 1 FROM pro_domain_change_requests WHERE user_id=? AND status='en_attente'").get(req.user.id)) return res.status(409).json({ error: 'Une demande de modification de domaines est déjà en attente.' });
  const note = String((req.body || {}).note || '').trim().slice(0, 1000);
  const id = db.prepare('INSERT INTO pro_domain_change_requests(user_id,requested_domains,previous_domains,note) VALUES(?,?,?,?)')
    .run(req.user.id, JSON.stringify(requested), JSON.stringify(current), note || null).lastInsertRowid;
  notifyAdmins('compte', 'Modification de domaines professionnels', `${req.user.name} demande une modification de ses domaines d’activité.`, 'admin:users');
  notify(req.user.id, 'compte', 'Demande de modification envoyée', 'Vos domaines d’activité restent inchangés jusqu’à la décision de l’administration.', '#/pro');
  res.status(201).json({ id, status: 'en_attente', requested_domains: requested });
});

// Lieu où le professionnel travaille actuellement : indépendant de son inscription.
app.put('/api/pro/service-location', auth, (req, res) => {
  if (req.user.pro_status !== 'approved') return res.status(403).json({ error: 'Espace réservé aux professionnels validés.' });
  const city = String((req.body || {}).service_city || '').trim();
  if (!city) return res.status(400).json({ error: 'Choisissez votre lieu de service actuel.' });
  const valid = db.prepare('SELECT 1 FROM villes WHERE active=1 AND lower(name)=lower(?)').get(city);
  if (!valid) return res.status(400).json({ error: 'Choisissez un lieu dans la liste proposée.' });
  const profile = db.prepare('SELECT service_cities FROM pro_profiles WHERE user_id=?').get(req.user.id);
  let allowed = []; try { allowed = JSON.parse(profile && profile.service_cities || '[]'); } catch {}
  if (allowed.length && !allowed.includes('*') && !allowed.some(v => cityMatches(v, city))) return res.status(403).json({ error: 'Cette ville n’est pas autorisée pour votre profil professionnel. Contactez l’administration.' });
  db.prepare(`UPDATE pro_profiles SET service_city=?, service_cities=CASE WHEN service_cities IS NULL OR service_cities='[]' OR service_cities='' THEN ? ELSE service_cities END WHERE user_id=?`).run(city, JSON.stringify([city]), req.user.id);
  notify(req.user.id, 'compte', '📍 Lieu de service mis à jour', `Vous recevez désormais les demandes correspondant à ${city}.`, '#/pro');
  res.json(me(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)));
});

app.get('/api/pro/dashboard', auth, (req, res) => {
  if (req.user.pro_status !== 'approved') return res.status(403).json({ error: 'Espace réservé aux professionnels validés.' });
  const uid = req.user.id;
  const pro = db.prepare('SELECT * FROM pro_profiles WHERE user_id=?').get(uid);
  const missions = db.prepare(`SELECT m.*, s.name service_name FROM missions m JOIN services s ON s.id=m.service_id WHERE m.pro_id=? ORDER BY m.updated_at DESC`).all(uid);
  const offers = db.prepare(`SELECT m.*, s.name service_name, mc.offered_at FROM mission_candidates mc
    JOIN missions m ON m.id=mc.mission_id JOIN services s ON s.id=m.service_id
    WHERE mc.pro_id=? AND mc.status='offered' AND m.status='recherche' ORDER BY mc.offered_at DESC`).all(uid).filter(m => candidateStillEligible(m, uid));
  const pays = db.prepare(`SELECT p.* FROM payments p JOIN missions m ON m.id=p.mission_id WHERE m.pro_id=? AND p.status='valide'`).all(uid);
  const revenus = pays.reduce((s, p) => s + p.pro_amount, 0);
  const r = db.prepare('SELECT AVG(rating) avg, COUNT(*) n FROM reviews WHERE target_id=?').get(uid);
  res.json({
    available: pro.available, availability_status: pro.availability_status || (pro.available ? 'disponible' : 'indisponible'), profile: { ...pro, services: JSON.parse(pro.services), documents: JSON.parse(pro.documents),
      domain_categories: numberIds(pro.domain_categories), authorized_domain_categories: pro.authorized_domain_categories === null ? null : numberIds(pro.authorized_domain_categories),
      service_cities: (() => { try { const v = JSON.parse(pro.service_cities || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })() },
    offers, missions,
    stats: {
      en_cours: missions.filter(m => ['acceptee', 'confirmee', 'en_cours'].includes(m.status)).length,
      terminees: missions.filter(m => ['terminee', 'payee'].includes(m.status)).length,
      revenus, commission_rate: parseFloat(getSetting('commission_rate', '25')),
      rating: r.avg ? Math.round(r.avg * 10) / 10 : null, reviews: r.n
    }
  });
});

// Profil public d'un professionnel
app.get('/api/pros/:id', auth, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=? AND pro_status='approved' AND suspended=0").get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Professionnel introuvable.' });
  const p = db.prepare('SELECT * FROM pro_profiles WHERE user_id=?').get(u.id);
  const svcIds = JSON.parse(p.services);
  const svcNames = svcIds.length ? db.prepare(`SELECT name FROM services WHERE id IN (${svcIds.map(() => '?').join(',')})`).all(...svcIds).map(s => s.name) : [];
  const missionsDone = db.prepare("SELECT COUNT(*) n FROM missions WHERE pro_id=? AND status IN ('terminee','payee')").get(u.id).n;
  const reviews = db.prepare(`SELECT r.rating, r.comment, r.created_at, u.name author FROM reviews r JOIN users u ON u.id=r.author_id WHERE r.target_id=? ORDER BY r.id DESC LIMIT 20`).all(u.id);
  res.json({
    ...publicUser(u), profession: p.profession, description: p.description, experience: p.experience,
    zone: p.zone, service_city: p.service_city || null, pro_type: p.pro_type === 'entreprise' ? 'entreprise' : 'particulier', capacity_level: p.capacity_level || 1, available: p.available, services: svcNames, missions_done: missionsDone,
    documents_valides: JSON.parse(p.documents).length > 0, mis_en_avant: visibiliteNiveau(u.id) > 0, reviews
  });
});

// ============================================================
// MISSIONS — cycle complet + moteur de mise en relation
// ============================================================
const dispatchTimers = new Map(); // missionId -> délai de la vague
const dispatchReminderTimers = new Map(); // missionId -> rappels sonores / Push persistants

function clearDispatchTimers(missionId) {
  clearTimeout(dispatchTimers.get(missionId)); dispatchTimers.delete(missionId);
  clearInterval(dispatchReminderTimers.get(missionId)); dispatchReminderTimers.delete(missionId);
}
function startDispatchReminders(missionId) {
  clearInterval(dispatchReminderTimers.get(missionId));
  const seconds = settingInt('dispatch_reminder_seconds', 20, 2, 600);
  const maximum = settingInt('dispatch_max_reminders', 6, 0, 100);
  const timer = setInterval(() => {
    const mission = db.prepare("SELECT * FROM missions WHERE id=? AND status='recherche'").get(missionId);
    const offered = db.prepare("SELECT * FROM mission_candidates WHERE mission_id=? AND status='offered'").all(missionId);
    if (!mission || !offered.length) return clearDispatchTimers(missionId);
    const svc = db.prepare('SELECT name FROM services WHERE id=?').get(mission.service_id);
    // Les rappels sont bornés par le réglage PDG : ils ne sonnent jamais indéfiniment.
    offered.filter(o => o.reminder_count < maximum).forEach(o => {
      db.prepare("UPDATE mission_candidates SET reminder_count=reminder_count+1 WHERE id=? AND status='offered'").run(o.id);
      // notify() alimente SSE (son/badge au premier plan) et Web Push si VAPID est configuré.
      notify(o.pro_id, 'mission', '🔔 Rappel : mission disponible', `La demande « ${svc.name} » attend toujours votre réponse. Touchez pour accepter ou refuser.`, '#/mission/' + missionId, { reminder: true, skipWebPush: true });
    });
  }, seconds * 1000);
  dispatchReminderTimers.set(missionId, timer);
}

function haversine(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(v => v == null)) return 99999;
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function proHasActiveMission(proId) {
  return !!db.prepare("SELECT 1 FROM missions WHERE pro_id=? AND status IN ('acceptee','confirmee','demarrage_demande','en_cours','fin_demande') LIMIT 1").get(proId);
}
function proCanReceiveMission(proId) {
  const p = db.prepare(`SELECT u.pro_status, u.suspended, u.blocked, p.available, p.availability_status
    FROM users u JOIN pro_profiles p ON p.user_id=u.id WHERE u.id=?`).get(proId);
  return !!(p && p.pro_status === 'approved' && !p.suspended && !p.blocked && p.available &&
    !['indisponible', 'en_mission', 'suspendu'].includes(p.availability_status || '') && !proHasActiveMission(proId));
}
function setAlertStatus(proId) { db.prepare("UPDATE pro_profiles SET availability_status='alerte' WHERE user_id=? AND available=1 AND availability_status='disponible'").run(proId); }
function clearAlertStatus(proId) { if (!proHasActiveMission(proId)) db.prepare("UPDATE pro_profiles SET availability_status='disponible' WHERE user_id=? AND available=1 AND availability_status='alerte'").run(proId); }
function releaseProfessional(proId, reason) {
  if (!proId || proHasActiveMission(proId)) return;
  const u = db.prepare('SELECT suspended, blocked, pro_status FROM users WHERE id=?').get(proId);
  if (!u) return;
  const can = u.pro_status === 'approved' && !u.suspended && !u.blocked;
  db.prepare('UPDATE pro_profiles SET available=?, availability_status=?, availability_before_mission=NULL WHERE user_id=?')
    .run(can ? 1 : 0, can ? 'disponible' : 'suspendu', proId);
  if (reason) notify(proId, 'mission', '🟢 Vous êtes de nouveau disponible', reason, '#/pro');
}
function jsonNumberIds(value) { try { const a = JSON.parse(value || '[]'); return Array.isArray(a) ? a.map(Number).filter(Number.isFinite) : []; } catch { return []; } }
function providerTypeEnabled(type) { return getSetting('dispatch_allow_' + type, '1') === '1'; }
function proMatchesMission(p, mission, client) {
  const wantedType = mission.provider_type === 'entreprise' ? 'entreprise' : 'particulier';
  const profileType = p.pro_type === 'entreprise' ? 'entreprise' : 'particulier';
  if (wantedType !== profileType || !providerTypeEnabled(wantedType)) return false;
  // Les nouveaux profils sont associés à des grandes catégories : chaque tâche active
  // rattachée au domaine reste éligible, y compris si elle est ajoutée après l'inscription.
  const domains = effectiveDomains(p);
  if (domains !== null) {
    const serviceDomain = db.prepare('SELECT c.grand_category_id id FROM services s JOIN service_categories c ON c.id=s.category_id WHERE s.id=? AND s.active=1 AND c.active=1').get(mission.service_id);
    if (!serviceDomain || !domains.includes(Number(serviceDomain.id))) return false;
  } else {
    // Compatibilité stricte des anciens profils choisis prestation par prestation.
    const declared = numberIds(p.svc || p.services);
    const authorized = numberIds(p.authorized_services);
    const usable = authorized.length ? authorized : declared;
    if (!declared.includes(Number(mission.service_id)) || !usable.includes(Number(mission.service_id))) return false;
  }
  if (Number(p.capacity_level || 1) < Number(mission.capacity_required || 1)) return false;
  if (!p.available || ['indisponible', 'en_mission', 'suspendu'].includes(p.availability_status || '') || proHasActiveMission(p.id)) return false;
  const dist = haversine(mission.lat, mission.lng, p.lat, p.lng);
  let cities = []; try { cities = JSON.parse(p.service_cities || '[]'); } catch {}
  if (!cities.length && p.service_city) cities = [p.service_city];
  const interventionCity = mission.intervention_city || (client && client.ville) || '';
  const cityAllowed = cities.includes('*') || !interventionCity || cities.some(c => cityMatches(c, interventionCity));
  if (getSetting('dispatch_geo_enabled', '1') === '1' && cities.length && !cityAllowed && dist > 50) return false;
  return true;
}
function findMatchingPros(mission) {
  const pros = db.prepare(`SELECT u.*, p.services svc, p.authorized_services, p.domain_categories, p.authorized_domain_categories, p.pro_type, p.capacity_level, p.available, p.zone, p.service_city, p.service_cities, p.availability_status FROM users u JOIN pro_profiles p ON p.user_id=u.id
    WHERE u.pro_status='approved' AND u.suspended=0 AND COALESCE(u.blocked,0)=0 AND u.id != ?`).all(mission.client_id);
  const client = db.prepare('SELECT ville FROM users WHERE id=?').get(mission.client_id);
  return pros.filter(p => proMatchesMission(p, mission, client))
    .map(p => ({ ...p, dist: haversine(mission.lat, mission.lng, p.lat, p.lng) }))
    .sort((a, b) => (a.dist - b.dist) || (visibiliteNiveau(b.id) - visibiliteNiveau(a.id)) || a.id - b.id);
}
function candidateStillEligible(mission, proId) {
  const p = db.prepare(`SELECT u.*, p.services svc, p.authorized_services, p.domain_categories, p.authorized_domain_categories, p.pro_type, p.capacity_level, p.available, p.zone, p.service_city, p.service_cities, p.availability_status FROM users u JOIN pro_profiles p ON p.user_id=u.id WHERE u.id=?`).get(proId);
  const client = db.prepare('SELECT ville FROM users WHERE id=?').get(mission.client_id);
  return !!(p && proMatchesMission(p, mission, client));
}
function revokeIneligibleOffers(mission) {
  const offered = db.prepare("SELECT pro_id FROM mission_candidates WHERE mission_id=? AND status='offered'").all(mission.id);
  offered.forEach(row => {
    if (candidateStillEligible(mission, row.pro_id)) return;
    db.prepare("UPDATE mission_candidates SET status='expired', responded_at=datetime('now') WHERE mission_id=? AND pro_id=? AND status='offered'").run(mission.id, row.pro_id);
    clearAlertStatus(row.pro_id);
    notify(row.pro_id, 'mission', 'Mission retirée', 'Cette demande ne correspond plus à votre disponibilité ou à vos autorisations.', '#/pro');
    push(row.pro_id, 'mission', { id: mission.id, status: 'retiree' });
  });
}

function revokeProfessionalOffers(proId) {
  db.prepare("SELECT m.* FROM missions m JOIN mission_candidates mc ON mc.mission_id=m.id WHERE mc.pro_id=? AND mc.status='offered' AND m.status='recherche'").all(proId).forEach(revokeIneligibleOffers);
}

function addEvent(missionId, status, actorId, note) {
  db.prepare('INSERT INTO mission_events(mission_id,status,actor_id,note) VALUES(?,?,?,?)').run(missionId, status, actorId || null, note || null);
  db.prepare("UPDATE missions SET updated_at=datetime('now') WHERE id=?").run(missionId);
}
function alertWaveSize(missionId) {
  const already = db.prepare("SELECT COUNT(*) n FROM mission_candidates WHERE mission_id=? AND status IN ('offered','expired','refused')").get(missionId).n;
  const key = already ? 'dispatch_expand_alert_count' : 'dispatch_initial_alert_count';
  return Math.max(1, Math.min(50, parseInt(getSetting(key, '3'), 10) || 3));
}
function expireOfferedWave(missionId) {
  const offered = db.prepare("SELECT pro_id FROM mission_candidates WHERE mission_id=? AND status='offered'").all(missionId);
  if (!offered.length) return;
  db.prepare("UPDATE mission_candidates SET status='expired', responded_at=datetime('now') WHERE mission_id=? AND status='offered'").run(missionId);
  offered.forEach(o => { clearAlertStatus(o.pro_id); notify(o.pro_id, 'mission', 'Mission retirée', 'Le délai de réponse est dépassé : la demande a été proposée à d’autres professionnels.', '#/pro'); push(o.pro_id, 'mission', { id: missionId, status: 'retiree' }); });
}
function offerNext(missionId) {
  const mission = db.prepare('SELECT * FROM missions WHERE id=?').get(missionId);
  if (!mission || mission.status !== 'recherche') return;
  if (getSetting('dispatch_auto_enabled', '1') !== '1') return;
  revokeIneligibleOffers(mission);
  if (mission.search_expires_at && db.prepare("SELECT 1 FROM missions WHERE id=? AND search_expires_at <= datetime('now')").get(missionId)) {
    db.prepare("UPDATE missions SET status='sans_pro' WHERE id=? AND status='recherche'").run(missionId);
    addEvent(missionId, 'sans_pro', null, 'Délai maximal de recherche atteint');
    notify(mission.client_id, 'mission', 'Recherche arrivée à son délai maximal', 'Aucun prestataire n’a accepté dans le délai prévu. Vous pouvez modifier votre choix Particulier / Entreprise et relancer.', '#/mission/' + missionId);
    push(mission.client_id, 'mission', { id: missionId, status: 'sans_pro' }); return;
  }
  if (db.prepare("SELECT 1 FROM mission_candidates WHERE mission_id=? AND status='offered'").get(missionId)) return;
  const client = db.prepare('SELECT ville FROM users WHERE id=?').get(mission.client_id);
  const allPending = db.prepare(`SELECT mc.id AS candidate_id, mc.*, u.*, p.services svc, p.authorized_services, p.domain_categories, p.authorized_domain_categories, p.pro_type, p.capacity_level, p.available, p.zone, p.service_city, p.availability_status FROM mission_candidates mc
    JOIN pro_profiles p ON p.user_id=mc.pro_id JOIN users u ON u.id=mc.pro_id WHERE mc.mission_id=? AND mc.status='pending' ORDER BY mc.rank ASC`).all(missionId);
  const pending = allPending.filter(c => proMatchesMission(c, mission, client)).slice(0, alertWaveSize(missionId));
  if (!pending.length) {
    db.prepare("UPDATE missions SET status='sans_pro' WHERE id=? AND status='recherche'").run(missionId);
    addEvent(missionId, 'sans_pro', null, 'Aucun professionnel disponible après les vagues d’alerte');
    notify(mission.client_id, 'mission', 'Aucun professionnel disponible pour le moment', `Aucun ${mission.provider_type === 'entreprise' ? 'entreprise' : 'particulier'} n’est disponible. Vous pouvez modifier votre choix puis relancer la recherche ; Klean Services garde votre demande dans l’historique.`, '#/mission/' + missionId);
    push(mission.client_id, 'mission', { id: missionId, status: 'sans_pro' }); return;
  }
  const svc = db.prepare('SELECT name FROM services WHERE id=?').get(mission.service_id);
  const tx = db.transaction(() => pending.forEach(c => db.prepare("UPDATE mission_candidates SET status='offered', offered_at=datetime('now') WHERE id=? AND status='pending'").run(c.candidate_id))); tx();
  pending.forEach(c => { setAlertStatus(c.pro_id); notify(c.pro_id, 'mission', '🔔 Nouvelle mission : ' + svc.name, (mission.urgence ? 'URGENT — ' : '') + (mission.address || 'Localisation fournie') + '. Touchez pour voir et accepter la mission.', '#/mission/' + missionId); push(c.pro_id, 'mission', { id: missionId, status: 'offre', persistent: true }); });
  const wait = Math.max(15, parseInt(getSetting('dispatch_wait_seconds', '60'), 10)) * 1000;
  clearDispatchTimers(missionId);
  startDispatchReminders(missionId);
  dispatchTimers.set(missionId, setTimeout(() => { expireOfferedWave(missionId); clearDispatchTimers(missionId); offerNext(missionId); }, wait));
}
function startDispatch(missionId) {
  const mission = db.prepare('SELECT * FROM missions WHERE id=?').get(missionId);
  if (!mission || mission.status !== 'recherche') return;
  const maxSeconds = settingInt('dispatch_search_max_seconds', 3600, 60, 86400);
  db.prepare("UPDATE missions SET search_started_at=COALESCE(search_started_at,datetime('now')), search_expires_at=COALESCE(search_expires_at,datetime('now','+' || ? || ' seconds')) WHERE id=?").run(maxSeconds, missionId);
  mission.search_started_at = mission.search_started_at || new Date().toISOString();
  mission.search_expires_at = mission.search_expires_at || new Date(Date.now() + maxSeconds * 1000).toISOString();
  if (getSetting('dispatch_auto_enabled', '1') !== '1') {
    addEvent(missionId, 'recherche', null, 'Attribution automatique temporairement désactivée par la direction');
    notify(mission.client_id, 'mission', 'Demande enregistrée', 'Votre demande est enregistrée. La mise en relation automatique est temporairement désactivée ; elle sera reprise par Klean Services.', '#/mission/' + missionId);
    return;
  }
  const pros = findMatchingPros(mission), ins = db.prepare('INSERT OR IGNORE INTO mission_candidates(mission_id, pro_id, rank) VALUES(?,?,?)');
  pros.forEach((p, i) => ins.run(missionId, p.id, i));
  if (!pros.length) {
    db.prepare("UPDATE missions SET status='sans_pro' WHERE id=?").run(missionId); addEvent(missionId, 'sans_pro', null, 'Aucun professionnel compatible et disponible trouvé');
    notify(mission.client_id, 'mission', 'Recherche sans résultat', `Aucun ${mission.provider_type === 'entreprise' ? 'entreprise' : 'particulier'} admissible ne propose ce service dans votre zone. Vous pouvez modifier votre choix puis relancer la recherche.`, '#/mission/' + missionId); notifyAdmins('mission', 'Demande sans professionnel', `Demande #${mission.code} : aucun professionnel compatible disponible.`, 'admin:missions'); return;
  }
  offerNext(missionId);
}

/* ================== MODÈLE ÉCONOMIQUE (tout est calculé CÔTÉ SERVEUR) ================== */
function commissionInfo(mission) {
  if (getSetting('commission_enabled', '1') !== '1') return { enabled: false, rate: 0 };
  let rate = parseFloat(getSetting('commission_rate', '25'));
  try {
    const pro = mission.pro_id ? db.prepare('SELECT pro_type FROM pro_profiles WHERE user_id=?').get(mission.pro_id) : null;
    const svc = db.prepare('SELECT category_id FROM services WHERE id=?').get(mission.service_id);
    const cli = db.prepare('SELECT ville FROM users WHERE id=?').get(mission.client_id);
    const rule = db.prepare(`SELECT rate FROM commission_rules WHERE active=1
      AND (pro_type IS NULL OR pro_type='' OR pro_type=?)
      AND (category_id IS NULL OR category_id=?)
      AND (ville IS NULL OR ville='' OR ville=?)
      AND (date_debut IS NULL OR date_debut='' OR date(date_debut) <= date('now'))
      AND (date_fin IS NULL OR date_fin='' OR date(date_fin) >= date('now'))
      ORDER BY priority DESC, id DESC LIMIT 1`)
      .get((pro && pro.pro_type) || '', (svc && svc.category_id) || 0, (cli && cli.ville) || '');
    if (rule) rate = rule.rate;
  } catch { /* règle illisible : on garde le taux général */ }
  return { enabled: true, rate };
}
function missionFinance(mission) {
  // Transparence : prix total, commission Klean Services et part du professionnel.
  const { enabled, rate } = commissionInfo(mission);
  const amount = mission.amount || 0;
  const commission = enabled ? Math.round(amount * rate / 100) : 0;
  return { amount, commission_enabled: enabled, commission_rate: rate, commission, pro_amount: amount - commission };
}
function addTransaction(o) {
  return db.prepare(`INSERT INTO transactions(user_id, kind, ref_id, label, amount, method, ville, categorie, status)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(o.user_id || null, o.kind, o.ref_id || null, o.label || '', o.amount || 0, o.method || null,
         o.ville || null, o.categorie || null, o.status || 'en_attente').lastInsertRowid;
}
function pubNiveaux() {
  try { const n = JSON.parse(getSetting('pub_niveaux', '[]')); return Array.isArray(n) ? n : []; } catch { return []; }
}
function pubNiveauPourBudget(budget) {
  const n = pubNiveaux().filter(x => x.actif).sort((a, b) => (b.min_budget || 0) - (a.min_budget || 0));
  const hit = n.find(x => budget >= (x.min_budget || 0));
  return hit ? hit.code : 'standard';
}
function pubPoids(code) {
  const n = pubNiveaux().find(x => x.code === code && x.actif);
  return Math.max(1, Math.min(3, (n && parseInt(n.poids, 10)) || 1)); // rotation équilibrée : jamais de monopole
}
function pubSlotsMax() { return Math.max(1, parseInt(getSetting('pub_max_actives', '10'), 10) || 10); }
function pubTick() {
  // Expiration automatique + promotion de la file d'attente (aucune demande supprimée)
  db.prepare(`UPDATE ad_campaigns SET status='expiree' WHERE status='active' AND end_at IS NOT NULL AND end_at < datetime('now')`).run();
  let actives = db.prepare(`SELECT COUNT(*) n FROM ad_campaigns WHERE status='active'`).get().n;
  while (actives < pubSlotsMax()) {
    const next = db.prepare(`SELECT * FROM ad_campaigns WHERE status='validee' ORDER BY
      CASE priorite WHEN 'premium' THEN 0 WHEN 'prioritaire' THEN 1 ELSE 2 END, created_at LIMIT 1`).get();
    if (!next) break;
    db.prepare(`UPDATE ad_campaigns SET status='active', start_at=datetime('now'), end_at=datetime('now', '+' || duration_days || ' days') WHERE id=?`).run(next.id);
    notify(next.user_id, 'information', '📣 Votre campagne est en ligne', `« ${next.title} » est maintenant diffusée pour ${next.duration_days} jour(s).`, '#/pub');
    actives++;
  }
}
function visibiliteTick() {
  db.prepare(`UPDATE visibility_subs SET status='expiree' WHERE status='active' AND end_at < datetime('now')`).run();
}
function visibiliteNiveau(userId) {
  if (getSetting('visibilite_enabled', '1') !== '1') return 0; // option facultative : jamais bloquante
  const r = db.prepare(`SELECT MAX(level) l FROM visibility_subs WHERE user_id=? AND status='active' AND end_at >= datetime('now')`).get(userId);
  return (r && r.l) || 0;
}

// Configuration commerciale visible par l'application (uniquement ce qui concerne l'utilisateur)
app.get('/api/commerce/config', auth, (req, res) => {
  res.json({
    devise: getSetting('devise', 'FCFA'),
    commission: { enabled: getSetting('commission_enabled', '1') === '1', rate: parseFloat(getSetting('commission_rate', '25')) },
    visibilite: { enabled: getSetting('visibilite_enabled', '1') === '1' },
    pub: {
      enabled: getSetting('pub_campagnes_enabled', '1') === '1',
      budgets: (getSetting('pub_budgets', '') || '').split(',').map(x => parseInt(x, 10)).filter(x => x > 0),
      niveaux: pubNiveaux().filter(n => n.actif).map(n => ({ code: n.code, label: n.label, min_budget: n.min_budget || 0 }))
    },
    avis: {
      prix_normal: parseInt(getSetting('avis_prix_normal', '0'), 10) || 0,
      avant: { enabled: getSetting('avis_avant_enabled', '1') === '1', prix: parseInt(getSetting('avis_prix_avant', '1000'), 10) || 0 },
      urgent: { enabled: getSetting('avis_urgent_enabled', '1') === '1', prix: parseInt(getSetting('avis_prix_urgent', '2000'), 10) || 0 },
      duree_jours: parseInt(getSetting('avis_duree_jours', '30'), 10) || 30
    },
    emploi: {
      enabled: getSetting('emploi_boost_enabled', '1') === '1',
      prix_avant: parseInt(getSetting('emploi_prix_avant', '1000'), 10) || 0,
      prix_prioritaire: parseInt(getSetting('emploi_prix_prioritaire', '2000'), 10) || 0,
      duree_jours: parseInt(getSetting('emploi_boost_duree_jours', '30'), 10) || 30
    }
  });
});

// ----- Visibilité professionnelle : FACULTATIVE (le profil normal reste gratuit et complet) -----
app.get('/api/visibilite', auth, (req, res) => {
  visibiliteTick();
  const enabled = getSetting('visibilite_enabled', '1') === '1';
  const pp = db.prepare('SELECT pro_type FROM pro_profiles WHERE user_id=?').get(req.user.id);
  const plans = enabled ? db.prepare('SELECT * FROM visibility_plans WHERE active=1 ORDER BY price').all()
    .filter(pl => pl.cible === 'tous' || !pp || !pp.pro_type || pl.cible === pp.pro_type) : [];
  const subs = db.prepare('SELECT * FROM visibility_subs WHERE user_id=? ORDER BY id DESC LIMIT 10').all(req.user.id);
  res.json({ enabled, plans, subs, niveau_actuel: visibiliteNiveau(req.user.id), devise: getSetting('devise', 'FCFA') });
});
app.post('/api/visibilite/souscrire', auth, (req, res) => {
  if (getSetting('visibilite_enabled', '1') !== '1') return res.status(403).json({ error: 'La visibilité payante est désactivée pour le moment. Votre profil reste pleinement fonctionnel gratuitement.' });
  if (req.user.pro_status !== 'approved') return res.status(403).json({ error: 'Réservé aux professionnels validés.' });
  const plan = db.prepare('SELECT * FROM visibility_plans WHERE id=? AND active=1').get(req.body.plan_id);
  if (!plan) return res.status(400).json({ error: 'Formule introuvable ou désactivée.' });
  if (db.prepare(`SELECT 1 FROM visibility_subs WHERE user_id=? AND status='attente_paiement'`).get(req.user.id))
    return res.status(409).json({ error: 'Vous avez déjà une souscription en attente de paiement.' });
  const sid = db.prepare(`INSERT INTO visibility_subs(user_id, plan_id, plan_name, price, level, duration_days)
    VALUES(?,?,?,?,?,?)`).run(req.user.id, plan.id, plan.name, plan.price, plan.level, plan.duration_days).lastInsertRowid;
  addTransaction({ user_id: req.user.id, kind: 'visibilite', ref_id: sid, label: `${plan.name} — ${req.user.name}`, amount: plan.price, ville: req.user.ville });
  notifyAdmins('information', '⭐ Souscription visibilité à encaisser', `${req.user.name} : ${plan.name} (${plan.price.toLocaleString('fr-FR')} FCFA).`, 'admin:payments');
  notify(req.user.id, 'information', '⭐ Souscription enregistrée', `Réglez ${plan.price.toLocaleString('fr-FR')} FCFA à Klean Services : votre visibilité sera activée dès confirmation du paiement.`, '#/visibilite');
  res.json({ ok: true, id: sid, status: 'attente_paiement' });
});

// ----- Campagnes publicitaires des annonceurs -----
app.get('/api/pub', auth, (req, res) => {
  pubTick();
  res.json({
    enabled: getSetting('pub_campagnes_enabled', '1') === '1',
    budgets: (getSetting('pub_budgets', '') || '').split(',').map(x => parseInt(x, 10)).filter(x => x > 0),
    niveaux: pubNiveaux().filter(n => n.actif).map(n => ({ code: n.code, label: n.label, min_budget: n.min_budget || 0 })),
    devise: getSetting('devise', 'FCFA'),
    campagnes: db.prepare('SELECT * FROM ad_campaigns WHERE user_id=? ORDER BY id DESC').all(req.user.id)
  });
});
app.post('/api/pub/campagnes', auth, (req, res) => {
  if (getSetting('pub_campagnes_enabled', '1') !== '1') return res.status(403).json({ error: 'Les campagnes publicitaires sont désactivées pour le moment.' });
  const b = req.body || {};
  const type = ['texte', 'image', 'video'].includes(b.type) ? b.type : 'texte';
  if (!(b.title || '').trim()) return res.status(400).json({ error: 'Donnez un titre à votre campagne.' });
  if (type === 'texte' && !(b.content || '').trim()) return res.status(400).json({ error: 'Écrivez le texte de votre publicité.' });
  if (type !== 'texte' && !b.file) return res.status(400).json({ error: 'Ajoutez le fichier image ou vidéo de votre publicité.' });
  const budget = parseInt(b.budget, 10);
  if (!budget || budget < 500) return res.status(400).json({ error: 'Budget invalide (minimum 500 FCFA).' });
  const duration = Math.max(1, Math.min(90, parseInt(b.duration_days, 10) || 7));
  let zones; try { zones = assertValidZones(b.zones !== undefined ? b.zones : b.zone); } catch (e) { return res.status(400).json({ error: e.message }); }
  const prio = pubNiveauPourBudget(budget); // priorité déterminée côté serveur selon le budget
  const cid = db.prepare(`INSERT INTO ad_campaigns(user_id, type, title, content, file, link, placement, zone, zones, budget, duration_days, priorite)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, type, b.title.trim(), (b.content || '').trim() || null, b.file || null, (b.link || '').trim() || null,
         b.placement === 'services' ? 'services' : 'accueil', zones[0] || null, JSON.stringify(zones), budget, duration, prio).lastInsertRowid;
  addTransaction({ user_id: req.user.id, kind: 'publicite', ref_id: cid, label: `Campagne « ${b.title.trim()} »`, amount: budget, ville: req.user.ville, categorie: prio });
  notifyAdmins('information', '📣 Nouvelle campagne publicitaire', `${req.user.name} : « ${b.title.trim()} » — budget ${budget.toLocaleString('fr-FR')} FCFA, ${duration} j.`, 'admin:payments');
  notify(req.user.id, 'information', '📣 Campagne enregistrée', `Réglez ${budget.toLocaleString('fr-FR')} FCFA à Klean Services. Après confirmation du paiement, votre campagne sera examinée puis diffusée.`, '#/pub');
  res.json({ ok: true, id: cid, status: 'attente_paiement', priorite: prio });
});

// Créer une demande
app.post('/api/missions', auth, async (req, res) => {
  const { service_id, answers, description, address, lat, lng, urgence, date_souhaitee, photos, audio, tache, taches, intervention_city, intervention_commune, task_id } = req.body || {};
  const schedule_type = ['asap', 'today', 'date'].includes((req.body || {}).schedule_type) ? (req.body || {}).schedule_type : 'asap';
  const provider_type = req.body && req.body.provider_type === 'entreprise' ? 'entreprise' : 'particulier';
  if (!providerTypeEnabled(provider_type)) return res.status(409).json({ error: `Les demandes destinées aux ${provider_type === 'entreprise' ? 'entreprises' : 'particuliers'} sont temporairement désactivées par Klean Services.` });
  const svc = db.prepare('SELECT * FROM services WHERE id=? AND active=1').get(service_id);
  if (!svc) return res.status(400).json({ error: 'Service invalide.' });
  // Le nouveau parcours client exige une description avant l’estimation. Pour conserver
  // les anciennes applications/API, une demande historique sans description reste envoyable,
  // mais le moteur ne peut alors produire qu’un « Prix à confirmer ».
  if (!address || !address.trim()) return res.status(400).json({ error: 'Indiquez votre localisation (GPS ou saisie manuelle).' });
  // Compatibilité des anciennes applications : elles n’envoyaient pas encore ce champ.
  // Le nouveau formulaire l’exige explicitement ; l’API historique reprend seulement la ville du compte si elle existe.
  const placeCity = activeCity(intervention_city || req.user.ville);
  if (!placeCity) return res.status(400).json({ error: 'Choisissez la ville réelle d’intervention dans la liste proposée.' });
  const placeCommune = normalize(placeCity.name) === 'abidjan' ? activeCommune(placeCity.name, intervention_commune || placeCity.legacy_commune) : null;
  if (normalize(placeCity.name) === 'abidjan' && !placeCommune) return res.status(400).json({ error: 'Choisissez la commune d’intervention à Abidjan.' });
  if (schedule_type === 'date' && !date_souhaitee) return res.status(400).json({ error: 'Choisissez la date souhaitée ou sélectionnez une autre disponibilité.' });
  if (schedule_type === 'date' && Number.isNaN(Date.parse(date_souhaitee))) return res.status(400).json({ error: 'Date souhaitée invalide.' });
  const requestPhotos = Array.isArray(photos) ? [...new Set(photos)].slice(0, 3) : [];
  const maxPhotos = settingInt('request_image_limit', 3, 0, 3);
  if (requestPhotos.length > maxPhotos) return res.status(400).json({ error: `Vous pouvez joindre au maximum ${maxPhotos} photo(s) à cette demande.` });
  // Les pièces jointes d'une demande doivent appartenir à son créateur.
  for (const photo of requestPhotos) { try { assertOwnUploadedFile(req.user, photo, 'photo'); } catch (e) { return res.status(400).json({ error: e.message }); } }
  if (audio) {
    try { assertOwnUploadedFile(req.user, audio, 'audio'); } catch (e) { return res.status(400).json({ error: e.message }); }
    const seconds = await audioDurationSeconds(audio), max = settingInt('request_audio_max_seconds', 25, 1, 25);
    if (seconds === null) return res.status(400).json({ error: 'La durée de cette note vocale ne peut pas être vérifiée. Réenregistrez-la depuis l’application.' });
    if (seconds > max + 0.25) return res.status(400).json({ error: `La note vocale dépasse la limite autorisée (${max} secondes).` });
  }
  // Le formulaire universel conserve les anciennes réponses si un ancien client les envoie,
  // mais n’impose plus de questions prédéfinies propres au service.
  // Anti-doublon souple : on avertit, mais le client peut confirmer un besoin réellement distinct.
  const dup = db.prepare(`SELECT id, code FROM missions WHERE client_id=? AND service_id=? AND provider_type=? AND status IN ('recherche','sans_pro','acceptee','confirmee','demarrage_demande','en_cours','fin_demande')
    AND created_at > datetime('now','-2 hours') ORDER BY id DESC LIMIT 1`).get(req.user.id, service_id, provider_type);
  if (dup && !(req.body || {}).duplicate_confirmed) return res.status(409).json({ error: 'Une demande semblable est déjà en cours. Voulez-vous vraiment créer une nouvelle demande indépendante ?', duplicate: true, mission_id: dup.id, mission_code: dup.code });

  // Une demande peut regrouper plusieurs tâches du MÊME service. Les noms viennent de la base,
  // et chaque précision est bornée : un client ne peut pas injecter une tâche d'un autre service.
  const rawTasks = Array.isArray(taches) ? taches.slice(0, 30) : [];
  if (task_id !== undefined && task_id !== null && task_id !== '') rawTasks.unshift({ id: task_id });
  const selected = [];
  const allowedTasks = db.prepare('SELECT id, name FROM taches WHERE service_id=? AND active=1').all(service_id);
  const allowedById = new Map(allowedTasks.map(t => [String(t.id), t]));
  const seenTasks = new Set();
  for (const raw of rawTasks) {
    const id = String(raw && (raw.id ?? raw));
    const task = allowedById.get(id);
    if (task && !seenTasks.has(id)) {
      seenTasks.add(id);
      selected.push({ id: task.id, name: task.name, detail: String((raw && raw.detail) || '').trim().slice(0, 500) || null });
    }
  }
  // Compatibilité totale avec les anciennes versions de l'application (une seule tâche texte).
  if (!selected.length && tache && allowedTasks.some(t => t.name === String(tache))) {
    const task = allowedTasks.find(t => t.name === String(tache)); selected.push({ id: task.id, name: task.name, detail: null });
  }
  const legacyTask = selected.length ? selected.map(t => t.name).join(' • ') : null;
  // Les détails déjà saisis sont utilisés sans imposer un écran supplémentaire au client.
  const scopeText = [description, legacyTask, ...Object.values(answers || {})].join(' ').toLowerCase();
  const capacityRequired = /chantier|industriel|immeuble|plusieurs|grande?\s+(maison|surface|quantit)|gros travaux|équipe|volume important/.test(scopeText) ? 2 : 1;
  const estimate = estimatePrice({ serviceId: service_id, taskId: selected[0] && selected[0].id, city: placeCity.name, zone: placeCommune && placeCommune.name, details: description });
  const code = 'KS' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 90 + 10);
  const info = db.prepare(`INSERT INTO missions(code, client_id, service_id, provider_type, capacity_required, answers, description, address, intervention_city, intervention_commune, lat, lng, urgence, date_souhaitee, schedule_type, photos, audio, tache, taches, estimated_price, estimate_meta, search_started_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(code, req.user.id, service_id, provider_type, capacityRequired, JSON.stringify(answers || {}), String(description || '').trim().slice(0, 5000), address.trim(), placeCity.name, placeCommune && placeCommune.name || null, lat || null, lng || null,
         urgence ? 1 : 0, schedule_type === 'date' ? date_souhaitee : null, schedule_type, JSON.stringify(requestPhotos), audio || null, legacyTask, JSON.stringify(selected), estimate.status === 'estimated' ? estimate.amount : null, JSON.stringify(estimate));
  addEvent(info.lastInsertRowid, 'recherche', req.user.id, `Demande créée — ${placeCity.name} — prestataire souhaité : ${provider_type}`);
  startDispatch(info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid, code, status: db.prepare('SELECT status FROM missions WHERE id=?').get(info.lastInsertRowid).status, provider_type, estimate });
});

function missionAccess(mission, user) {
  if (!mission) return null;
  if (isStaff(user) && hasPerm(user, 'missions')) return 'admin';
  if (mission.client_id === user.id) return 'client';
  if (mission.pro_id === user.id) return 'pro';
  const cand = db.prepare("SELECT * FROM mission_candidates WHERE mission_id=? AND pro_id=? AND status IN ('offered','accepted')").get(mission.id, user.id);
  if (cand && candidateStillEligible(mission, user.id)) return 'candidat';
  return null;
}
function missionFull(mission, role, user) {
  const svc = db.prepare('SELECT s.name, c.icon FROM services s JOIN service_categories c ON c.id=s.category_id WHERE s.id=?').get(mission.service_id);
  const questions = db.prepare('SELECT id, label, type FROM service_questions WHERE service_id=?').all(mission.service_id);
  const answers = JSON.parse(mission.answers);
  let missionTasks = [];
  try { missionTasks = JSON.parse(mission.taches || '[]'); if (!Array.isArray(missionTasks)) missionTasks = []; } catch { missionTasks = []; }
  const detail = questions.filter(q => answers[q.id] !== undefined && String(answers[q.id]).trim() !== '')
    .map(q => ({ label: q.label, value: q.type === 'bool' ? (answers[q.id] ? 'Oui' : 'Non') : answers[q.id] }));
  const events = db.prepare('SELECT status, note, created_at FROM mission_events WHERE mission_id=? ORDER BY id').all(mission.id);
  const payment = db.prepare('SELECT * FROM payments WHERE mission_id=?').get(mission.id);
  const client = db.prepare('SELECT * FROM users WHERE id=?').get(mission.client_id);
  const pro = mission.pro_id ? db.prepare('SELECT * FROM users WHERE id=?').get(mission.pro_id) : null;
  const myReview = db.prepare('SELECT * FROM reviews WHERE mission_id=? AND author_id=?').get(mission.id, user.id);
  const unreadMsgs = db.prepare('SELECT COUNT(*) n FROM messages WHERE mission_id=? AND sender_id!=? AND read=0').get(mission.id, user.id).n;
  // Confidentialité stricte : le téléphone professionnel n'est jamais envoyé au client.
  // Le téléphone client est transmis uniquement au professionnel effectivement attribué,
  // à partir de l'acceptation de la mission. Les administrateurs habilités gardent la vue de gestion.
  const assignedStage = ['acceptee', 'confirmee', 'en_cours', 'terminee', 'payee', 'litige'].includes(mission.status);
  const adminView = isStaff(user) && hasPerm(user, 'missions');
  const shareClientContact = adminView || (role === 'pro' && mission.pro_id === user.id && assignedStage);
  let candidates = null, offerPending = null;
  // Le client n'obtient plus de liste de professionnels/candidats : l'attribution est automatique.
  if (role === 'candidat') {
    offerPending = db.prepare("SELECT 1 FROM mission_candidates WHERE mission_id=? AND pro_id=? AND status='offered'").get(mission.id, user.id) ? true : false;
  }
  const canChat = ['client', 'pro'].includes(role) && !!mission.pro_id;
  const chatMeta = {
    locked: conversationIsLocked(mission),
    text_limit: settingInt('chat_text_limit', 30, 1, 500),
    image_limit: settingInt('chat_image_limit', 3, 0, 30),
    audio_max_seconds: settingInt('chat_audio_max_seconds', 20, 1, 120),
    image_enabled: getSetting('chat_image_enabled', '1') === '1',
    audio_enabled: getSetting('chat_audio_enabled', '1') === '1',
    used_text: canChat ? db.prepare("SELECT COUNT(*) n FROM messages WHERE mission_id=? AND sender_id=? AND type='text'").get(mission.id, user.id).n : 0,
    used_images: canChat ? db.prepare("SELECT COUNT(*) n FROM messages WHERE mission_id=? AND sender_id=? AND type='photo'").get(mission.id, user.id).n : 0
  };
  return {
    id: mission.id, code: mission.code, status: mission.status, role,
    provider_type: mission.provider_type === 'entreprise' ? 'entreprise' : 'particulier', capacity_required: mission.capacity_required || 1,
    service: svc.name, icon: svc.icon, tache: mission.tache || null, taches: missionTasks, detail, description: mission.description,
    address: mission.address, intervention_city: mission.intervention_city || client.ville || null, lat: mission.lat, lng: mission.lng,
    urgence: mission.urgence, date_souhaitee: mission.date_souhaitee,
    estimate: jsonObject(mission.estimate_meta), estimated_price: mission.estimated_price || null,
    photos: JSON.parse(mission.photos), audio: mission.audio,
    amount: mission.amount, created_at: mission.created_at, events, payment,
    client: publicUser(client, shareClientContact),
    pro: pro ? publicUser(pro, adminView) : null,
    chat: chatMeta,
    my_review: myReview || null, unread_messages: unreadMsgs,
    candidates, offer_pending: offerPending,
    finance: mission.amount ? missionFinance(mission) : null, // prix total, commission, part pro — calculés côté serveur
    price_changes: db.prepare('SELECT * FROM mission_price_changes WHERE mission_id=? ORDER BY id DESC').all(mission.id),
    commission_rate: role !== 'client' ? commissionInfo(mission).rate : undefined
  };
}

// Mes demandes / missions
app.get('/api/missions', auth, (req, res) => {
  const asClient = db.prepare(`SELECT m.*, s.name service_name, c.icon FROM missions m JOIN services s ON s.id=m.service_id
    JOIN service_categories c ON c.id=s.category_id WHERE m.client_id=? ORDER BY m.updated_at DESC`).all(req.user.id);
  let asPro = [], offers = [];
  if (req.user.pro_status === 'approved') {
    asPro = db.prepare(`SELECT m.*, s.name service_name, c.icon FROM missions m JOIN services s ON s.id=m.service_id
      JOIN service_categories c ON c.id=s.category_id WHERE m.pro_id=? ORDER BY m.updated_at DESC`).all(req.user.id);
    offers = db.prepare(`SELECT m.*, s.name service_name, c.icon FROM mission_candidates mc JOIN missions m ON m.id=mc.mission_id
      JOIN services s ON s.id=m.service_id JOIN service_categories c ON c.id=s.category_id
      WHERE mc.pro_id=? AND mc.status='offered' AND m.status='recherche' ORDER BY mc.offered_at DESC`).all(req.user.id).filter(m => candidateStillEligible(m, req.user.id));
  }
  const strip = m => ({ id: m.id, code: m.code, status: m.status, provider_type: m.provider_type === 'entreprise' ? 'entreprise' : 'particulier', service: m.service_name, icon: m.icon, tache: m.tache || null, address: m.address, intervention_city: m.intervention_city || null, urgence: m.urgence, amount: m.amount, estimated_price: m.estimated_price || null, created_at: m.created_at, updated_at: m.updated_at });
  res.json({ client: asClient.map(strip), pro: asPro.map(strip), offers: offers.map(strip) });
});

app.get('/api/missions/:id', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=?').get(req.params.id);
  const role = missionAccess(mission, req.user);
  if (!role) return res.status(404).json({ error: 'Demande introuvable ou accès non autorisé.' });
  res.json(missionFull(mission, role === 'admin' ? 'client' : role, req.user));
});

// Le professionnel accepte : une transaction atomique garantit un unique gagnant.
app.post('/api/missions/:id/accept', auth, (req, res) => {
  let result;
  try {
    result = db.transaction(() => {
      const mission = db.prepare('SELECT * FROM missions WHERE id=?').get(req.params.id);
      if (!mission) throw new Error('NOT_FOUND');
      if (mission.status !== 'recherche') throw new Error('TAKEN');
      if (!proCanReceiveMission(req.user.id)) throw new Error('BUSY');
      const profile = db.prepare(`SELECT u.*, p.services svc, p.authorized_services, p.domain_categories, p.authorized_domain_categories, p.pro_type, p.capacity_level, p.available, p.zone, p.service_city, p.service_cities, p.availability_status FROM users u JOIN pro_profiles p ON p.user_id=u.id WHERE u.id=?`).get(req.user.id);
      const clientForMatch = db.prepare('SELECT ville FROM users WHERE id=?').get(mission.client_id);
      if (!profile || !proMatchesMission(profile, mission, clientForMatch)) throw new Error('INELIGIBLE');
      const cand = db.prepare("SELECT * FROM mission_candidates WHERE mission_id=? AND pro_id=? AND status='offered'").get(mission.id, req.user.id);
      if (!cand) throw new Error('NOT_OFFERED');
      const won = db.prepare("UPDATE missions SET status='acceptee', pro_id=?, updated_at=datetime('now') WHERE id=? AND status='recherche'").run(req.user.id, mission.id);
      if (!won.changes) throw new Error('TAKEN');
      db.prepare("UPDATE mission_candidates SET status='accepted', responded_at=datetime('now') WHERE id=?").run(cand.id);
      const others = db.prepare("SELECT pro_id FROM mission_candidates WHERE mission_id=? AND id!=? AND status IN ('pending','offered')").all(mission.id, cand.id);
      db.prepare("UPDATE mission_candidates SET status='expired', responded_at=datetime('now') WHERE mission_id=? AND id!=? AND status IN ('pending','offered')").run(mission.id, cand.id);
      db.prepare("UPDATE pro_profiles SET availability_before_mission=available, available=0, availability_status='en_mission' WHERE user_id=?").run(req.user.id);
      addEvent(mission.id, 'acceptee', req.user.id, 'Professionnel : ' + req.user.name);
      return { mission, others };
    })();
  } catch (err) {
    const errMap = { NOT_FOUND: ['Demande introuvable.', 404], BUSY: ['Vous êtes indisponible ou déjà en mission : vous ne pouvez pas accepter une nouvelle demande.', 409], INELIGIBLE: ['Vous ne correspondez plus aux critères de cette demande ; elle vous a été retirée.', 403], NOT_OFFERED: ['Cette mission ne vous est plus proposée.', 403], TAKEN: ['Cette demande a déjà été attribuée à un autre professionnel.', 409] };
    const out = errMap[err.message] || ['Attribution impossible.', 409]; return res.status(out[1]).json({ error: out[0] });
  }
  clearDispatchTimers(result.mission.id);
  // Le professionnel devenu « en mission » perd immédiatement toute autre offre encore affichée.
  revokeProfessionalOffers(req.user.id);
  result.others.forEach(o => { clearAlertStatus(o.pro_id); notify(o.pro_id, 'mission', 'Mission déjà attribuée', 'Un autre professionnel a accepté cette demande avant vous.', '#/pro'); push(o.pro_id, 'mission', { id: result.mission.id, status: 'attribuee' }); });
  const svc = db.prepare('SELECT name FROM services WHERE id=?').get(result.mission.service_id);
  notify(result.mission.client_id, 'mission', '✅ Un professionnel a accepté votre demande', `${req.user.name} a accepté « ${svc.name} ». Votre commande est attribuée ; vous pouvez consulter son profil et poursuivre la mission.`, '#/mission/' + result.mission.id);
  push(result.mission.client_id, 'mission', { id: result.mission.id, status: 'acceptee' });
  res.json({ ok: true, status: 'acceptee' });
});

// Le professionnel refuse
app.post('/api/missions/:id/refuse', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=?').get(req.params.id);
  if (!mission) return res.status(404).json({ error: 'Demande introuvable.' });
  const cand = db.prepare("SELECT * FROM mission_candidates WHERE mission_id=? AND pro_id=? AND status='offered'").get(mission.id, req.user.id);
  if (!cand) return res.status(409).json({ error: 'Aucune offre en attente pour cette mission.' });
  db.prepare("UPDATE mission_candidates SET status='refused', responded_at=datetime('now') WHERE id=?").run(cand.id);
  clearAlertStatus(req.user.id);
  clearDispatchTimers(mission.id);
  offerNext(mission.id);
  res.json({ ok: true });
});

// L’attribution est automatique : le client ne sélectionne plus de professionnel.
app.post('/api/missions/:id/choisir/:proId', auth, (req, res) => res.status(410).json({ error: 'L’attribution est désormais automatique : attendez qu’un professionnel disponible accepte la demande.' }));

// Modifier le type de prestataire après une recherche sans résultat : aucun détail de la demande n’est perdu.
app.put('/api/missions/:id/provider-type', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=? AND client_id=?').get(req.params.id, req.user.id);
  if (!mission) return res.status(404).json({ error: 'Demande introuvable.' });
  if (!['recherche', 'sans_pro'].includes(mission.status)) return res.status(409).json({ error: 'Le type de prestataire ne peut plus être modifié après l’attribution.' });
  const providerType = (req.body || {}).provider_type === 'entreprise' ? 'entreprise' : 'particulier';
  if (!providerTypeEnabled(providerType)) return res.status(409).json({ error: 'Ce type de prestataire est temporairement indisponible.' });
  clearDispatchTimers(mission.id);
  db.prepare('DELETE FROM mission_candidates WHERE mission_id=?').run(mission.id);
  db.prepare("UPDATE missions SET provider_type=?, status='recherche', search_started_at=datetime('now'), search_expires_at=NULL, updated_at=datetime('now') WHERE id=?").run(providerType, mission.id);
  addEvent(mission.id, 'recherche', req.user.id, 'Choix prestataire modifié : ' + providerType);
  startDispatch(mission.id);
  res.json({ ok: true, provider_type: providerType, status: db.prepare('SELECT status FROM missions WHERE id=?').get(mission.id).status });
});

// Relancer la recherche
app.post('/api/missions/:id/relancer', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=? AND client_id=?').get(req.params.id, req.user.id);
  if (!mission) return res.status(404).json({ error: 'Demande introuvable.' });
  if (mission.status !== 'sans_pro') return res.status(409).json({ error: 'La recherche est déjà en cours.' });
  db.prepare("UPDATE missions SET status='recherche', search_started_at=datetime('now'), search_expires_at=NULL WHERE id=?").run(mission.id);
  clearDispatchTimers(mission.id);
  db.prepare('DELETE FROM mission_candidates WHERE mission_id=?').run(mission.id);
  addEvent(mission.id, 'recherche', req.user.id, 'Recherche relancée');
  startDispatch(mission.id);
  res.json({ ok: true, status: 'recherche' });
});

// Le client confirme le professionnel
app.post('/api/missions/:id/confirm', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=? AND client_id=?').get(req.params.id, req.user.id);
  if (!mission) return res.status(404).json({ error: 'Demande introuvable.' });
  if (mission.status !== 'acceptee') return res.status(409).json({ error: 'Cette demande ne peut pas être confirmée à ce stade.' });
  db.prepare("UPDATE missions SET status='confirmee' WHERE id=?").run(mission.id);
  addEvent(mission.id, 'confirmee', req.user.id, 'Client a confirmé — mission programmée');
  notify(mission.pro_id, 'mission', '🎉 Mission confirmée par le client', 'La mission est programmée. Consultez les détails et contactez le client si besoin.', '#/mission/' + mission.id);
  push(mission.pro_id, 'mission', { id: mission.id, status: 'confirmee' });
  res.json({ ok: true, status: 'confirmee' });
});

// Le professionnel propose/ajuste le montant
app.post('/api/missions/:id/montant', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=? AND pro_id=?').get(req.params.id, req.user.id);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable.' });
  if (!['acceptee', 'confirmee', 'en_cours'].includes(mission.status)) return res.status(409).json({ error: 'Le montant ne peut plus être modifié.' });
  const amount = parseInt(req.body.amount, 10);
  if (!amount || amount < 100) return res.status(400).json({ error: 'Montant invalide (minimum 100 FCFA).' });
  if (mission.amount && mission.amount !== amount)
    return res.status(409).json({ error: `Le montant est déjà fixé à ${mission.amount.toLocaleString('fr-FR')} FCFA. Pour le modifier, utilisez « Demander une modification du prix » : le client devra l\u2019accepter.` });
  db.prepare('UPDATE missions SET amount=? WHERE id=?').run(amount, mission.id);
  const fin = missionFinance({ ...mission, amount });
  addEvent(mission.id, mission.status, req.user.id, `Montant fixé : ${amount} FCFA`);
  notify(mission.client_id, 'paiement', 'Montant de la mission', `Le professionnel a fixé le montant à ${amount.toLocaleString('fr-FR')} FCFA.`, '#/mission/' + mission.id);
  push(mission.client_id, 'mission', { id: mission.id, status: mission.status });
  res.json({ ok: true, amount, finance: fin });
});

// ----- Modification du prix sur le terrain : jamais cachée, toujours soumise à l'accord du client -----
app.post('/api/missions/:id/prix-modif', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=? AND pro_id=?').get(req.params.id, req.user.id);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable.' });
  if (!['acceptee', 'confirmee', 'en_cours'].includes(mission.status)) return res.status(409).json({ error: 'Le prix ne peut plus être modifié à ce stade.' });
  if (!mission.amount) return res.status(400).json({ error: 'Fixez d\u2019abord le montant initial.' });
  const newAmount = parseInt(req.body.new_amount, 10);
  const reason = (req.body.reason || '').trim();
  if (!newAmount || newAmount < 100) return res.status(400).json({ error: 'Nouveau montant invalide (minimum 100 FCFA).' });
  if (newAmount === mission.amount) return res.status(400).json({ error: 'Le nouveau montant est identique au montant actuel.' });
  if (!reason) return res.status(400).json({ error: 'Indiquez la raison du changement de prix (obligatoire).' });
  if (db.prepare(`SELECT 1 FROM mission_price_changes WHERE mission_id=? AND status='en_attente'`).get(mission.id))
    return res.status(409).json({ error: 'Une demande de modification attend déjà la réponse du client.' });
  const pcid = db.prepare(`INSERT INTO mission_price_changes(mission_id, pro_id, client_id, old_amount, new_amount, reason)
    VALUES(?,?,?,?,?,?)`).run(mission.id, req.user.id, mission.client_id, mission.amount, newAmount, reason).lastInsertRowid;
  const fin = missionFinance({ ...mission, amount: newAmount });
  const diff = newAmount - mission.amount;
  addEvent(mission.id, mission.status, req.user.id, `Demande de modification du prix : ${mission.amount} → ${newAmount} FCFA (${reason})`);
  notify(mission.client_id, 'paiement', '💬 Changement de prix proposé',
    `Ancien prix : ${mission.amount.toLocaleString('fr-FR')} FCFA → Nouveau prix : ${newAmount.toLocaleString('fr-FR')} FCFA (${diff > 0 ? '+' : ''}${diff.toLocaleString('fr-FR')} FCFA). Motif : ${reason}. Acceptez ou refusez dans la mission.`,
    '#/mission/' + mission.id);
  push(mission.client_id, 'mission', { id: mission.id, status: mission.status });
  res.json({ ok: true, id: pcid, status: 'en_attente', finance_si_accepte: fin });
});
app.post('/api/missions/:id/prix-modif/:pcid/reponse', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=? AND client_id=?').get(req.params.id, req.user.id);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable.' });
  const pc = db.prepare(`SELECT * FROM mission_price_changes WHERE id=? AND mission_id=? AND status='en_attente'`).get(req.params.pcid, mission.id);
  if (!pc) return res.status(404).json({ error: 'Demande de modification introuvable ou déjà traitée.' });
  const accepte = !!req.body.accepte;
  db.prepare(`UPDATE mission_price_changes SET status=?, decided_at=datetime('now') WHERE id=?`).run(accepte ? 'accepte' : 'refuse', pc.id);
  if (accepte) {
    db.prepare('UPDATE missions SET amount=? WHERE id=?').run(pc.new_amount, mission.id); // la commission sera recalculée automatiquement sur ce montant
    const fin = missionFinance({ ...mission, amount: pc.new_amount });
    addEvent(mission.id, mission.status, req.user.id, `Nouveau prix accepté par le client : ${pc.new_amount} FCFA`);
    notify(mission.pro_id, 'paiement', '✅ Nouveau prix accepté',
      `Le client a accepté ${pc.new_amount.toLocaleString('fr-FR')} FCFA. Commission ${fin.commission_rate}% : ${fin.commission.toLocaleString('fr-FR')} FCFA — votre part : ${fin.pro_amount.toLocaleString('fr-FR')} FCFA.`, '#/mission/' + mission.id);
  } else {
    addEvent(mission.id, mission.status, req.user.id, `Nouveau prix refusé par le client (l\u2019ancien prix ${pc.old_amount} FCFA reste valable)`);
    notify(mission.pro_id, 'paiement', 'Nouveau prix refusé', `Le client a refusé la modification. Le prix reste ${pc.old_amount.toLocaleString('fr-FR')} FCFA.`, '#/mission/' + mission.id);
  }
  push(mission.pro_id, 'mission', { id: mission.id, status: mission.status });
  res.json({ ok: true, status: accepte ? 'accepte' : 'refuse' });
});

// Chronologie contrôlée : le professionnel formule une demande, le client confirme ou conteste.
app.post('/api/missions/:id/start', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=? AND pro_id=?').get(req.params.id, req.user.id);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable.' });
  if (mission.status !== 'confirmee') return res.status(409).json({ error: 'La mission doit être confirmée avant la demande de démarrage.' });
  db.prepare("UPDATE missions SET status='demarrage_demande', start_requested_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND status='confirmee'").run(mission.id);
  addEvent(mission.id, 'demarrage_demande', req.user.id, 'Le professionnel demande le démarrage de la mission');
  notify(mission.client_id, 'mission', '🛠️ Démarrage à confirmer', 'Le professionnel demande à démarrer la mission. Confirmez ou contestez dans la mission.', '#/mission/' + mission.id);
  push(mission.client_id, 'mission', { id: mission.id, status: 'demarrage_demande' });
  res.json({ ok: true, status: 'demarrage_demande' });
});
app.post('/api/missions/:id/start/confirm', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=? AND client_id=?').get(req.params.id, req.user.id);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable.' });
  if (mission.status !== 'demarrage_demande') return res.status(409).json({ error: 'Aucune demande de démarrage à confirmer.' });
  db.prepare("UPDATE missions SET status='en_cours', start_client_confirmed_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND status='demarrage_demande'").run(mission.id);
  addEvent(mission.id, 'en_cours', req.user.id, 'Client a confirmé le démarrage');
  notify(mission.pro_id, 'mission', '✅ Démarrage confirmé', 'Le client a confirmé le démarrage. La mission est maintenant en cours.', '#/mission/' + mission.id);
  push(mission.pro_id, 'mission', { id: mission.id, status: 'en_cours' });
  res.json({ ok: true, status: 'en_cours' });
});
app.post('/api/missions/:id/start/contest', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=? AND client_id=?').get(req.params.id, req.user.id);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable.' });
  if (mission.status !== 'demarrage_demande') return res.status(409).json({ error: 'Aucune demande de démarrage à contester.' });
  const reason = String(req.body && req.body.reason || '').trim().slice(0, 500);
  db.prepare("UPDATE missions SET status='confirmee', updated_at=datetime('now') WHERE id=? AND status='demarrage_demande'").run(mission.id);
  addEvent(mission.id, 'demarrage_conteste', req.user.id, 'Client a contesté le démarrage' + (reason ? ' : ' + reason : ''));
  notify(mission.pro_id, 'mission', 'Démarrage contesté', 'Le client n’a pas confirmé le démarrage' + (reason ? ' : ' + reason : '.') + ' Contactez-le avant de refaire une demande.', '#/mission/' + mission.id);
  push(mission.pro_id, 'mission', { id: mission.id, status: 'confirmee' });
  res.json({ ok: true, status: 'confirmee' });
});

// Terminer : le paiement ne peut être créé qu'après confirmation client de fin.
app.post('/api/missions/:id/complete', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=? AND pro_id=?').get(req.params.id, req.user.id);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable.' });
  if (mission.status !== 'en_cours') return res.status(409).json({ error: 'La mission doit être en cours avant la demande de fin.' });
  if (!mission.amount) return res.status(400).json({ error: 'Fixez d’abord le montant de la mission avant de demander la fin.' });
  if (db.prepare("SELECT 1 FROM mission_price_changes WHERE mission_id=? AND status='en_attente'").get(mission.id)) return res.status(409).json({ error: 'Une modification de prix attend la réponse du client.' });
  db.prepare("UPDATE missions SET status='fin_demande', completion_requested_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND status='en_cours'").run(mission.id);
  addEvent(mission.id, 'fin_demande', req.user.id, 'Le professionnel demande la confirmation de fin');
  notify(mission.client_id, 'mission', '✅ Fin de mission à confirmer', 'Le professionnel déclare la mission terminée. Confirmez ou contestez dans la mission.', '#/mission/' + mission.id);
  push(mission.client_id, 'mission', { id: mission.id, status: 'fin_demande' });
  res.json({ ok: true, status: 'fin_demande' });
});
function completeMissionAfterClientConfirmation(mission, actorId) {
  const fin = missionFinance(mission);
  const tx = db.transaction(() => {
    const won = db.prepare("UPDATE missions SET status='terminee', completion_client_confirmed_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND status='fin_demande'").run(mission.id);
    if (!won.changes) throw new Error('STATE');
    db.prepare(`INSERT INTO payments(mission_id, amount, method, commission_rate, commission_amount, pro_amount) VALUES(?,?,?,?,?,?) ON CONFLICT(mission_id) DO NOTHING`).run(mission.id, mission.amount, 'especes', fin.commission_rate, fin.commission, fin.pro_amount);
  });
  tx();
  addEvent(mission.id, 'terminee', actorId, 'Client a confirmé la fin — paiement déclaré en attente');
  releaseProfessional(mission.pro_id, 'La prestation est confirmée terminée : vous pouvez recevoir de nouvelles demandes.');
  return fin;
}
app.post('/api/missions/:id/complete/confirm', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=? AND client_id=?').get(req.params.id, req.user.id);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable.' });
  if (mission.status !== 'fin_demande') return res.status(409).json({ error: 'Aucune fin de mission à confirmer.' });
  try { completeMissionAfterClientConfirmation(mission, req.user.id); } catch { return res.status(409).json({ error: 'Cette confirmation a déjà été traitée.' }); }
  notify(mission.pro_id, 'paiement', '✅ Fin de mission confirmée', 'Le client a confirmé la fin. Déclarez ensuite la réception du paiement.', '#/mission/' + mission.id);
  notify(mission.client_id, 'paiement', '💵 Paiement à confirmer', `Montant : ${mission.amount.toLocaleString('fr-FR')} FCFA. Confirmez le paiement après l’avoir effectué.`, '#/mission/' + mission.id);
  push(mission.pro_id, 'mission', { id:mission.id,status:'terminee' }); push(mission.client_id, 'mission', { id:mission.id,status:'terminee' });
  res.json({ ok:true, status:'terminee' });
});
app.post('/api/missions/:id/complete/contest', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=? AND client_id=?').get(req.params.id, req.user.id);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable.' });
  if (mission.status !== 'fin_demande') return res.status(409).json({ error: 'Aucune fin de mission à contester.' });
  const reason = String(req.body && req.body.reason || '').trim().slice(0, 500);
  db.prepare("UPDATE missions SET status='litige', updated_at=datetime('now') WHERE id=? AND status='fin_demande'").run(mission.id);
  addEvent(mission.id, 'fin_contestee', req.user.id, 'Client a contesté la fin' + (reason ? ' : ' + reason : ''));
  notify(mission.pro_id, 'mission', '⚠️ Fin de mission contestée', 'Le client a contesté la fin' + (reason ? ' : ' + reason : '.') + ' L’administration est informée.', '#/mission/' + mission.id);
  notifyAdmins('securite', '⚠️ Fin de mission contestée', `Mission ${mission.code} : ${reason || 'motif non renseigné'}`, 'admin:missions');
  push(mission.pro_id, 'mission', { id:mission.id,status:'litige' });
  res.json({ ok:true, status:'litige' });
});

// Confirmation du paiement en espèces par les deux parties
app.post('/api/missions/:id/payment/confirm', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=?').get(req.params.id);
  const role = missionAccess(mission, req.user);
  if (!mission || !['client', 'pro'].includes(role)) return res.status(404).json({ error: 'Mission introuvable.' });
  const pay = db.prepare('SELECT * FROM payments WHERE mission_id=?').get(mission.id);
  if (!pay) return res.status(409).json({ error: 'Aucun paiement en attente pour cette mission.' });
  if (pay.status === 'valide') return res.status(409).json({ error: 'Le paiement est déjà validé.' });
  if (role === 'client') {
    if (pay.client_confirmed_at) return res.status(409).json({ error: 'Vous avez déjà confirmé ce paiement.' });
    db.prepare("UPDATE payments SET client_confirmed_at=datetime('now') WHERE id=?").run(pay.id);
  } else {
    if (pay.pro_confirmed_at) return res.status(409).json({ error: 'Vous avez déjà confirmé ce paiement.' });
    db.prepare("UPDATE payments SET pro_confirmed_at=datetime('now') WHERE id=?").run(pay.id);
  }
  const p2 = db.prepare('SELECT * FROM payments WHERE id=?').get(pay.id);
  let status = p2.client_confirmed_at && p2.pro_confirmed_at ? 'valide' : (p2.client_confirmed_at ? 'confirme_client' : 'confirme_pro');
  db.prepare('UPDATE payments SET status=? WHERE id=?').run(status, pay.id);
  if (status === 'valide') {
    db.prepare("UPDATE missions SET status='payee', conversation_locked_at=datetime('now'), conversation_lock_reason='Paiement validé' WHERE id=?").run(mission.id);
    addEvent(mission.id, 'payee', req.user.id, 'Paiement validé par les deux parties — conversation clôturée');
    notify(mission.client_id, 'paiement', '💰 Paiement validé', 'Merci ! Vous pouvez maintenant évaluer le professionnel.', '#/mission/' + mission.id);
    notify(mission.pro_id, 'paiement', '💰 Paiement validé', `Montant reçu : ${p2.amount.toLocaleString('fr-FR')} FCFA — votre part : ${p2.pro_amount.toLocaleString('fr-FR')} FCFA (commission ${p2.commission_rate}%).`, '#/mission/' + mission.id);
    const cliV = db.prepare('SELECT ville FROM users WHERE id=?').get(mission.client_id);
    const catV = db.prepare('SELECT c.name FROM services s JOIN service_categories c ON c.id=s.category_id WHERE s.id=?').get(mission.service_id);
    addTransaction({ user_id: mission.pro_id, kind: 'commission', ref_id: p2.id, label: `Commission mission ${mission.code}`,
      amount: p2.commission_amount, method: p2.method, ville: cliV && cliV.ville, categorie: catV && catV.name, status: 'confirme' });
    push(mission.client_id, 'mission', { id: mission.id, status: 'payee' });
    push(mission.pro_id, 'mission', { id: mission.id, status: 'payee' });
  } else {
    const other = role === 'client' ? mission.pro_id : mission.client_id;
    notify(other, 'paiement', 'Confirmation de paiement', `${req.user.name} a confirmé le paiement en espèces. Confirmez à votre tour.`, '#/mission/' + mission.id);
    push(other, 'mission', { id: mission.id, status: mission.status });
  }
  res.json({ ok: true, payment_status: status });
});

// Annulation
app.post('/api/missions/:id/cancel', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=?').get(req.params.id);
  const role = missionAccess(mission, req.user);
  if (!mission || !['client', 'pro'].includes(role)) return res.status(404).json({ error: 'Mission introuvable.' });
  if (['terminee', 'payee', 'annulee'].includes(mission.status)) return res.status(409).json({ error: 'Cette mission ne peut plus être annulée.' });
  clearTimeout(dispatchTimers.get(mission.id));
  db.prepare("UPDATE missions SET status='annulee' WHERE id=?").run(mission.id);
  addEvent(mission.id, 'annulee', req.user.id, `Annulée par ${role === 'client' ? 'le client' : 'le professionnel'}${req.body.reason ? ' : ' + req.body.reason : ''}`);
  const other = role === 'client' ? mission.pro_id : mission.client_id;
  if (other) { notify(other, 'mission', 'Mission annulée', 'La mission a été annulée par l\u2019autre partie.', '#/mission/' + mission.id); push(other, 'mission', { id: mission.id, status: 'annulee' }); }
  clearDispatchTimers(mission.id);
  if (mission.pro_id) releaseProfessional(mission.pro_id, 'La mission annulée ne vous bloque plus.');
  res.json({ ok: true, status: 'annulee' });
});

// Avis (client ↔ professionnel, un seul par partie et par mission)
app.post('/api/missions/:id/review', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=?').get(req.params.id);
  const role = missionAccess(mission, req.user);
  if (!mission || !['client', 'pro'].includes(role)) return res.status(404).json({ error: 'Mission introuvable.' });
  if (!['terminee', 'payee'].includes(mission.status)) return res.status(409).json({ error: 'Vous pourrez évaluer après la fin de la mission.' });
  const rating = parseInt(req.body.rating, 10);
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Note invalide (1 à 5 étoiles).' });
  const target = role === 'client' ? mission.pro_id : mission.client_id;
  try {
    db.prepare('INSERT INTO reviews(mission_id, author_id, target_id, rating, comment) VALUES(?,?,?,?,?)')
      .run(mission.id, req.user.id, target, rating, (req.body.comment || '').slice(0, 1000));
  } catch {
    return res.status(409).json({ error: 'Vous avez déjà évalué cette mission.' });
  }
  notify(target, 'information', '⭐ Nouvelle évaluation reçue', `${req.user.name} vous a attribué ${rating}/5.`, '#/mission/' + mission.id);
  res.json({ ok: true });
});

app.get('/api/reviews/mine', auth, (req, res) => {
  const received = db.prepare(`SELECT r.*, u.name author, m.code FROM reviews r JOIN users u ON u.id=r.author_id JOIN missions m ON m.id=r.mission_id WHERE r.target_id=? ORDER BY r.id DESC`).all(req.user.id);
  const given = db.prepare(`SELECT r.*, u.name target, m.code FROM reviews r JOIN users u ON u.id=r.target_id JOIN missions m ON m.id=r.mission_id WHERE r.author_id=? ORDER BY r.id DESC`).all(req.user.id);
  res.json({ received, given });
});

// Signalement
app.post('/api/signalements', auth, (req, res) => {
  const { target_id, mission_id, reason } = req.body || {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Décrivez le problème.' });
  db.prepare('INSERT INTO signalements(reporter_id, target_id, mission_id, reason) VALUES(?,?,?,?)').run(req.user.id, target_id || null, mission_id || null, reason.trim());
  notifyAdmins('urgence', '⚠️ Nouveau signalement', `${req.user.name} a signalé un problème.`, 'admin:securite');
  res.json({ ok: true });
});

// ============================================================
// CHAT rattaché à la mission (texte, photo, audio)
// ============================================================
function chatAccess(mission, user) {
  const role = missionAccess(mission, user);
  if (role === 'admin') return isStaff(user) && hasPerm(user, 'missions') ? 'admin' : null;
  // Avant l'attribution, aucun candidat ne peut ouvrir de conversation avec le client.
  if (!mission || !mission.pro_id || !['client', 'pro'].includes(role)) return null;
  return role;
}
function conversationIsLocked(mission) {
  return !!(mission && (mission.status === 'payee' || mission.conversation_locked_at || ['annulee', 'litige'].includes(mission.status)));
}
app.get('/api/missions/:id/messages', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=?').get(req.params.id);
  if (!mission || !chatAccess(mission, req.user)) return res.status(404).json({ error: 'Conversation introuvable.' });
  db.prepare('UPDATE messages SET read=1 WHERE mission_id=? AND sender_id!=?').run(mission.id, req.user.id);
  const msgs = db.prepare(`SELECT m.*, u.name sender_name, u.photo sender_photo FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.mission_id=? ORDER BY m.id`).all(mission.id);
  res.json(msgs);
});
app.post('/api/missions/:id/messages', auth, async (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=?').get(req.params.id);
  const role = chatAccess(mission, req.user);
  if (!mission || !role) return res.status(404).json({ error: 'Conversation introuvable.' });
  if (role === 'admin') return res.status(403).json({ error: 'L’administration consulte cette conversation mais ne peut pas écrire à la place des parties.' });
  if (conversationIsLocked(mission)) return res.status(409).json({ error: mission.status === 'payee' ? 'La prestation est payée : cette conversation est définitivement en lecture seule.' : 'Cette conversation est clôturée. Utilisez Contacter Klean Services pour toute demande de support.' });
  const { type, content, file } = req.body || {};
  if (!['text', 'photo', 'audio'].includes(type)) return res.status(400).json({ error: 'Type de message invalide.' });
  if (type === 'text' && (!content || !content.trim())) return res.status(400).json({ error: 'Message vide.' });
  if (type !== 'text' && !file) return res.status(400).json({ error: 'Fichier manquant.' });

  const textLimit = settingInt('chat_text_limit', 30, 1, 500);
  const imageLimit = settingInt('chat_image_limit', 3, 0, 30);
  if (type === 'text') {
    const used = db.prepare("SELECT COUNT(*) n FROM messages WHERE mission_id=? AND sender_id=? AND type='text'").get(mission.id, req.user.id).n;
    if (used >= textLimit) return res.status(429).json({ error: `Votre quota de ${textLimit} message(s) texte pour cette conversation est atteint.` });
  }
  if (type === 'photo') {
    if (getSetting('chat_image_enabled', '1') !== '1') return res.status(403).json({ error: 'L’envoi d’images est temporairement suspendu par Klean Services.' });
    const used = db.prepare("SELECT COUNT(*) n FROM messages WHERE mission_id=? AND sender_id=? AND type='photo'").get(mission.id, req.user.id).n;
    if (used >= imageLimit) return res.status(429).json({ error: `Votre quota de ${imageLimit} image(s) pour cette conversation est atteint.` });
    try { assertOwnUploadedFile(req.user, file, 'photo'); } catch (err) { return res.status(400).json({ error: err.message }); }
  }
  if (type === 'audio') {
    if (getSetting('chat_audio_enabled', '1') !== '1') return res.status(403).json({ error: 'Les messages vocaux sont temporairement suspendus par Klean Services.' });
    try { assertOwnUploadedFile(req.user, file, 'audio'); } catch (err) { return res.status(400).json({ error: err.message }); }
    const max = settingInt('chat_audio_max_seconds', 20, 1, 120), seconds = await audioDurationSeconds(file);
    if (seconds === null) return res.status(400).json({ error: 'La durée de cette note vocale ne peut pas être vérifiée. Réenregistrez-la depuis l’application.' });
    if (seconds > max + 0.25) return res.status(400).json({ error: `La note vocale dépasse la limite autorisée (${max} secondes).` });
  }
  const info = db.prepare('INSERT INTO messages(mission_id, sender_id, type, content, file) VALUES(?,?,?,?,?)')
    .run(mission.id, req.user.id, type, (content || '').trim().slice(0, 2000), file || null);
  const msg = db.prepare('SELECT m.*, u.name sender_name, u.photo sender_photo FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?').get(info.lastInsertRowid);
  const recipients = req.user.id === mission.client_id ? [mission.pro_id] : [mission.client_id];
  const svc = db.prepare('SELECT name FROM services WHERE id=?').get(mission.service_id);
  for (const rid of recipients.filter(Boolean)) {
    push(rid, 'message', msg);
    notify(rid, 'message', '💬 ' + req.user.name, type === 'text' ? content.slice(0, 80) : (type === 'photo' ? '📷 Photo' : '🎤 Message vocal') + ' — ' + svc.name, '#/chat/' + mission.id);
  }
  push(req.user.id, 'message', msg);
  res.json(msg);
});
// Liste des conversations
app.get('/api/conversations', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT m.id, m.code, m.status, s.name service_name, m.client_id, m.pro_id,
      (SELECT content FROM messages WHERE mission_id=m.id ORDER BY id DESC LIMIT 1) last_content,
      (SELECT type FROM messages WHERE mission_id=m.id ORDER BY id DESC LIMIT 1) last_type,
      (SELECT created_at FROM messages WHERE mission_id=m.id ORDER BY id DESC LIMIT 1) last_at,
      (SELECT COUNT(*) FROM messages WHERE mission_id=m.id AND sender_id!=? AND read=0) unread
    FROM missions m JOIN services s ON s.id=m.service_id
    WHERE (m.client_id=? OR m.pro_id=?) AND EXISTS (SELECT 1 FROM messages WHERE mission_id=m.id)
    ORDER BY last_at DESC`).all(req.user.id, req.user.id, req.user.id);
  res.json(rows.map(r => {
    const otherId = r.client_id === req.user.id ? r.pro_id : r.client_id;
    const other = otherId ? db.prepare('SELECT * FROM users WHERE id=?').get(otherId) : null;
    return { ...r, other: other ? { name: other.name, photo: other.photo } : { name: 'Professionnel', photo: null } };
  }));
});

// ============================================================
// CONTACT DIRECT : client ↔ Klean Services (suggestions et préoccupations)
// ============================================================
const SUPPORT_SUBJECTS = { suggestion: '💡 Suggestion', preoccupation: '⚠️ Préoccupation' };
function supportMessageRow(id) {
  return db.prepare(`SELECT sm.*, COALESCE(u.name, 'Klean Services') sender_name, u.photo sender_photo
    FROM support_messages sm LEFT JOIN users u ON u.id=sm.sender_id WHERE sm.id=?`).get(id);
}
function supportConversationForUser(id, user) {
  const c = db.prepare('SELECT * FROM support_conversations WHERE id=?').get(id);
  if (!c || c.user_id !== user.id) return null;
  return c;
}
function supportMessages(id) {
  return db.prepare(`SELECT sm.*, COALESCE(u.name, 'Klean Services') sender_name, u.photo sender_photo
    FROM support_messages sm LEFT JOIN users u ON u.id=sm.sender_id WHERE sm.conversation_id=? ORDER BY sm.id`).all(id);
}
app.get('/api/support/conversations', auth, (req, res) => {
  const rows = db.prepare(`SELECT c.*,
    (SELECT content FROM support_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) last_content,
    (SELECT type FROM support_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) last_type,
    (SELECT created_at FROM support_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) last_at,
    (SELECT COUNT(*) FROM support_messages WHERE conversation_id=c.id AND sender_id IS NULL AND read=0) unread
    FROM support_conversations c WHERE c.user_id=? ORDER BY c.updated_at DESC, c.id DESC`).all(req.user.id);
  res.json(rows);
});
app.post('/api/support/conversations', auth, (req, res) => {
  const body = req.body || {};
  const subject = body.subject === 'suggestion' ? 'suggestion' : body.subject === 'preoccupation' ? 'preoccupation' : null;
  const content = String(body.content || '').trim();
  if (!subject) return res.status(400).json({ error: 'Choisissez Suggestion ou Préoccupation.' });
  if (!content) return res.status(400).json({ error: 'Écrivez votre message avant de l’envoyer.' });
  if (content.length > 3000) return res.status(400).json({ error: 'Message trop long (3 000 caractères maximum).' });
  const tx = db.transaction(() => {
    const c = db.prepare('INSERT INTO support_conversations(user_id, subject) VALUES(?,?)').run(req.user.id, subject);
    const m = db.prepare("INSERT INTO support_messages(conversation_id, sender_id, type, content) VALUES(?,?, 'text', ?)").run(c.lastInsertRowid, req.user.id, content);
    const automatic = subject === 'suggestion'
      ? 'Merci pour votre suggestion. Nous l’avons bien reçue et nous en tiendrons compte.'
      : 'Nous avons bien reçu votre préoccupation. Un agent Klean Services vous contactera dans peu de temps.';
    db.prepare("INSERT INTO support_messages(conversation_id, sender_id, type, content, is_auto, read) VALUES(?,NULL, 'text', ?,1,1)").run(c.lastInsertRowid, automatic);
    db.prepare("UPDATE support_conversations SET updated_at=datetime('now') WHERE id=?").run(c.lastInsertRowid);
    return { id: c.lastInsertRowid, message_id: m.lastInsertRowid };
  });
  const out = tx();
  notifyAdmins('message', SUPPORT_SUBJECTS[subject] + ' reçue', `${req.user.name} : ${content.slice(0, 120)}`, 'admin:support');
  res.status(201).json({ id: out.id, conversation: db.prepare('SELECT * FROM support_conversations WHERE id=?').get(out.id), messages: supportMessages(out.id) });
});
app.get('/api/support/conversations/:id', auth, (req, res) => {
  const c = supportConversationForUser(req.params.id, req.user);
  if (!c) return res.status(404).json({ error: 'Conversation introuvable.' });
  db.prepare('UPDATE support_messages SET read=1 WHERE conversation_id=? AND sender_id IS NULL').run(c.id);
  res.json({ conversation: c, messages: supportMessages(c.id) });
});
app.post('/api/support/conversations/:id/messages', auth, (req, res) => {
  const c = supportConversationForUser(req.params.id, req.user);
  if (!c) return res.status(404).json({ error: 'Conversation introuvable.' });
  if (c.status !== 'ouverte') return res.status(409).json({ error: 'Cette conversation est fermée.' });
  const body = req.body || {}, type = body.type === 'audio' ? 'audio' : 'text';
  const content = String(body.content || '').trim(), file = String(body.file || '').trim();
  if (type === 'text' && !content) return res.status(400).json({ error: 'Message vide.' });
  if (type === 'audio' && !file.startsWith('/uploads/')) return res.status(400).json({ error: 'Fichier audio manquant.' });
  if (content.length > 3000) return res.status(400).json({ error: 'Message trop long (3 000 caractères maximum).' });
  const info = db.prepare('INSERT INTO support_messages(conversation_id, sender_id, type, content, file) VALUES(?,?,?,?,?)').run(c.id, req.user.id, type, content || null, file || null);
  db.prepare("UPDATE support_conversations SET updated_at=datetime('now'), status='ouverte' WHERE id=?").run(c.id);
  const m = supportMessageRow(info.lastInsertRowid);
  notifyAdmins('message', SUPPORT_SUBJECTS[c.subject] + ' — nouveau message', `${req.user.name} : ${type === 'audio' ? '🎤 Message vocal' : content.slice(0, 120)}`, 'admin:support');
  res.status(201).json(m);
});

// ============================================================
// NOTIFICATIONS
// ============================================================
app.get('/api/notifications', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100').all(req.user.id);
  const unread = db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0').get(req.user.id).n;
  res.json({ notifications: rows, unread });
});
app.post('/api/notifications/read', auth, (req, res) => {
  if (req.body.id) db.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=?').run(req.body.id, req.user.id);
  else db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(req.user.id);
  const unread = db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0').get(req.user.id).n;
  res.json({ unread });
});
app.get('/api/badges', auth, (req, res) => {
  const unreadNotifs = db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0').get(req.user.id).n;
  const unreadMsgs = db.prepare(`SELECT COUNT(*) n FROM messages msg JOIN missions m ON m.id=msg.mission_id
    WHERE (m.client_id=? OR m.pro_id=?) AND msg.sender_id!=? AND msg.read=0`).get(req.user.id, req.user.id, req.user.id).n;
  res.json({ notifications: unreadNotifs, messages: unreadMsgs });
});

// ============================================================
// CONTENUS : avis de recherche, jobs, école & famille, urgence
// ============================================================
app.get('/api/avis-recherche/categories', optionalAuth, (req,res) => {
  res.json(frenchSort(db.prepare('SELECT * FROM search_notice_categories WHERE active=1 ORDER BY sort,id').all()));
});
app.get('/api/avis-recherche', optionalAuth, (req, res) => {
  const viewerId = req.user ? req.user.id : -1;
  const q = normalize(req.query.q || ''), categoryId = Number(req.query.category_id) || null, city = String(req.query.city || '').trim();
  let list = db.prepare(`SELECT a.*, u.name publisher, c.name category_name, c.description category_description FROM avis_recherche a
    JOIN users u ON u.id=a.user_id LEFT JOIN search_notice_categories c ON c.id=a.category_id
    WHERE (a.status='approved' AND (a.expire_at IS NULL OR a.expire_at >= datetime('now'))) OR a.user_id=?
    ORDER BY CASE WHEN a.paid=1 AND a.formule='urgent' THEN 0 WHEN a.paid=1 AND a.formule='avant' THEN 1 ELSE 2 END, a.id DESC`).all(viewerId);
  if (categoryId) list = list.filter(a => Number(a.category_id) === categoryId);
  if (city) list = list.filter(a => cityMatches(a.city || a.dernier_lieu || '', city));
  if (q) list = list.filter(a => normalize([a.nom,a.description,a.infos,a.dernier_lieu,a.city,a.category_name].join(' ')).includes(q));
  // Les coordonnées de publication ne sont jamais exposées aux visiteurs anonymes.
  res.json(req.user ? list : list.map(a => ({ ...a, contact: null })));
});
app.post('/api/avis-recherche', auth, (req, res) => {
  const b = req.body || {}, title = String(b.nom || b.title || '').trim().slice(0, 180), contact = String(b.contact || '').trim().slice(0, 80);
  const description = String(b.description || '').trim().slice(0, 5000);
  if (!title || !description || !contact) return res.status(400).json({ error: 'L’intitulé, la description et un contact sont obligatoires.' });
  const categoryId = Number(b.category_id);
  const category = db.prepare('SELECT * FROM search_notice_categories WHERE id=? AND active=1').get(categoryId);
  if (!category) return res.status(400).json({ error: 'Choisissez une catégorie d’avis active.' });
  const city = String(b.city || '').trim();
  if (!city) return res.status(400).json({ error: 'Choisissez la ville concernée dans la liste proposée.' });
  if (!activeCity(city)) return res.status(400).json({ error: 'Choisissez une ville active dans la liste proposée.' });
  if (b.photo) { try { assertOwnUploadedFile(req.user, b.photo, 'photo'); } catch (e) { return res.status(400).json({ error:e.message }); } }
  // Formule : normal (gratuit ou payant selon le paramètre du PDG) | mis en avant | urgent
  let formule = ['avant', 'urgent'].includes(b.formule) ? b.formule : 'normal';
  if (formule === 'avant' && getSetting('avis_avant_enabled', '1') !== '1') formule = 'normal';
  if (formule === 'urgent' && getSetting('avis_urgent_enabled', '1') !== '1') formule = 'normal';
  const prixAvis = parseInt(getSetting('avis_prix_' + formule, '0'), 10) || 0;
  const info = db.prepare(`INSERT INTO avis_recherche(user_id, nom, photo, description, date_disparition, heure_disparition, dernier_lieu, derniere_vue, description_physique, vetements, contact, infos, category_id, city, formule, paid)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, title, b.photo || null, description, b.date_disparition || null, b.heure_disparition || null,
         String(b.dernier_lieu || '').trim().slice(0,300) || null, String(b.derniere_vue || '').trim().slice(0,500) || null, String(b.description_physique || '').trim().slice(0,3000) || null, String(b.vetements || '').trim().slice(0,1000) || null, contact, String(b.infos || '').trim().slice(0,3000) || null,
         category.id, city || null, formule, prixAvis === 0 ? 1 : 0);
  if (prixAvis > 0) addTransaction({ user_id: req.user.id, kind: 'avis_recherche', ref_id: info.lastInsertRowid, label: `Avis de recherche « ${title} » — formule ${formule}`, amount: prixAvis, ville: city || req.user.ville, categorie: formule });
  notifyAdmins('information', 'Avis de recherche à modérer', `Publié par ${req.user.name} : ${title}${prixAvis > 0 ? ` (formule ${formule} — ${prixAvis.toLocaleString('fr-FR')} FCFA à encaisser)` : ''}`, 'admin:contenu');
  notify(req.user.id, 'information', 'Avis de recherche envoyé', prixAvis > 0
    ? `Réglez ${prixAvis.toLocaleString('fr-FR')} FCFA à Klean Services : la mise en avant sera appliquée après confirmation du paiement. L’avis sera publié après validation.`
    : 'Votre avis sera publié après validation par l’administration.', '#/avis-recherche');
  res.json({ ok: true, id: info.lastInsertRowid, status: 'pending', formule, prix: prixAvis });
});

// Les offres d’emploi sont distinctes des profils de candidats historiques : aucune création de compte pro n’est requise.
app.get('/api/job-offers', optionalAuth, (req,res) => {
  const viewerId=req.user ? req.user.id : -1;
  const q=normalize(req.query.q||''), city=String(req.query.city||'').trim();
  let rows=db.prepare(`SELECT o.*,u.name publisher FROM job_offers o JOIN users u ON u.id=o.user_id
    WHERE o.status='approved' OR o.user_id=? ORDER BY CASE o.status WHEN 'approved' THEN 0 ELSE 1 END,o.id DESC`).all(viewerId);
  if(city) rows=rows.filter(o=>cityMatches(o.city||o.location||'',city));
  if(q) rows=rows.filter(o=>normalize([o.title,o.description,o.skills,o.city,o.location,o.contract_type,o.duration].join(' ')).includes(q));
  res.json(req.user ? rows : rows.map(o => ({ ...o, contact: null, application_method: null })));
});
app.post('/api/job-offers', auth, (req,res) => {
  const b=req.body||{}, title=String(b.title||'').trim().slice(0,180), description=String(b.description||'').trim().slice(0,5000), contact=String(b.contact||req.user.phone||'').trim().slice(0,80);
  if(!title || !description || !contact) return res.status(400).json({error:'L’intitulé, la description et un moyen de candidature sont obligatoires.'});
  const city=String(b.city||'').trim(); if(!city) return res.status(400).json({error:'Choisissez la ville concernée dans la liste proposée.'}); if(!activeCity(city)) return res.status(400).json({error:'Choisissez une ville active dans la liste proposée.'});
  const info=db.prepare(`INSERT INTO job_offers(user_id,title,description,skills,city,location,contract_type,duration,compensation,contact,application_method)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(req.user.id,title,description,String(b.skills||'').trim().slice(0,2000)||null,city||null,String(b.location||'').trim().slice(0,300)||null,String(b.contract_type||'').trim().slice(0,120)||null,String(b.duration||'').trim().slice(0,180)||null,String(b.compensation||'').trim().slice(0,180)||null,contact,String(b.application_method||'').trim().slice(0,500)||null);
  notifyAdmins('information','Offre de job à modérer',`${req.user.name} propose : ${title}`,'admin:contenu');
  notify(req.user.id,'information','Offre de job envoyée','Votre offre sera visible après validation par l’administration.','#/jobs');
  res.status(201).json({ok:true,id:info.lastInsertRowid,status:'pending'});
});

// Profils de candidats historiques : l’API et les données sont conservées, mais l’interface les présente avec le nouveau vocabulaire.
app.get('/api/jobs', optionalAuth, (req, res) => {
  const viewerId = req.user ? req.user.id : -1;
  const q = normalize(req.query.q || '');
  let list = db.prepare(`SELECT j.*, u.name publisher FROM jobs j JOIN users u ON u.id=j.user_id WHERE j.status='approved' OR j.user_id=?
    ORDER BY CASE WHEN j.boost != 'normal' AND (j.boost_until IS NULL OR j.boost_until >= datetime('now'))
      THEN (CASE j.boost WHEN 'prioritaire' THEN 0 ELSE 1 END) ELSE 2 END, j.id DESC`).all(viewerId);
  if (q) list = list.filter(j => normalize([j.metier, j.competences, j.localisation, j.description].join(' ')).includes(q));
  res.json(req.user ? list : list.map(j => ({ ...j, contact: null, cv: null })));
});
app.post('/api/jobs', auth, (req, res) => {
  const b = req.body || {};
  if (!b.metier || !b.contact) return res.status(400).json({ error: 'Le métier recherché et un contact sont obligatoires.' });
  const info = db.prepare(`INSERT INTO jobs(user_id, metier, competences, experience, localisation, disponibilite, contact, cv, photo, description)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, b.metier, b.competences || null, b.experience || null, b.localisation || null, b.disponibilite || null, b.contact, b.cv || null, b.photo || null, b.description || null);
  notifyAdmins('information', 'Profil candidat à modérer', `${req.user.name} : ${b.metier}`, 'admin:contenu');
  notify(req.user.id, 'information', 'Profil candidat envoyé', 'Votre profil sera visible après validation par l’administration.', '#/jobs');
  res.json({ ok: true, id: info.lastInsertRowid, status: 'pending' });
});
// Mise en avant FACULTATIVE d'un profil emploi (la recherche d'emploi reste gratuite)
app.post('/api/jobs/:id/boost', auth, (req, res) => {
  if (getSetting('emploi_boost_enabled', '1') !== '1') return res.status(403).json({ error: 'La mise en avant des profils emploi est désactivée pour le moment. La recherche d\u2019emploi reste gratuite.' });
  const j = db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!j) return res.status(404).json({ error: 'Profil introuvable.' });
  const f = req.body.formule === 'prioritaire' ? 'prioritaire' : 'avant';
  const prix = parseInt(getSetting('emploi_prix_' + f, '1000'), 10) || 0;
  if (db.prepare(`SELECT 1 FROM transactions WHERE kind='emploi' AND ref_id=? AND status='en_attente'`).get(j.id))
    return res.status(409).json({ error: 'Une demande de mise en avant est déjà en attente de paiement pour ce profil.' });
  const dj = Math.max(1, parseInt(getSetting('emploi_boost_duree_jours', '30'), 10) || 30);
  if (prix === 0) {
    db.prepare(`UPDATE jobs SET boost=?, boost_until=datetime('now', '+' || ? || ' days') WHERE id=?`).run(f, dj, j.id);
    addTransaction({ user_id: req.user.id, kind: 'emploi', ref_id: j.id, label: `Mise en avant ${f} — profil « ${j.metier} » (gratuite)`, amount: 0, ville: req.user.ville, categorie: f, status: 'confirme' });
    notify(req.user.id, 'information', '⭐ Profil mis en avant', `Votre profil « ${j.metier} » est mis en avant pour ${dj} jours.`, '#/jobs');
    return res.json({ ok: true, status: 'active' });
  }
  addTransaction({ user_id: req.user.id, kind: 'emploi', ref_id: j.id, label: `Mise en avant ${f} — profil « ${j.metier} »`, amount: prix, ville: req.user.ville, categorie: f });
  notifyAdmins('information', '⭐ Mise en avant emploi à encaisser', `${req.user.name} : profil « ${j.metier} » — ${prix.toLocaleString('fr-FR')} FCFA (${f}).`, 'admin:payments');
  notify(req.user.id, 'information', '⭐ Demande enregistrée', `Réglez ${prix.toLocaleString('fr-FR')} FCFA à Klean Services : la mise en avant sera activée dès confirmation du paiement.`, '#/jobs');
  res.json({ ok: true, status: 'attente_paiement', prix });
});

app.get('/api/ecole-famille', auth, (req, res) => res.json(db.prepare('SELECT * FROM ecole_famille WHERE user_id=? ORDER BY id DESC').all(req.user.id)));
app.post('/api/ecole-famille', auth, (req, res) => {
  const { type, details, contact } = req.body || {};
  if (!type) return res.status(400).json({ error: 'Choisissez le type de demande.' });
  if (!details || !details.trim()) return res.status(400).json({ error: 'Décrivez votre besoin.' });
  const info = db.prepare('INSERT INTO ecole_famille(user_id, type, details, contact) VALUES(?,?,?,?)').run(req.user.id, type, details.trim(), contact || req.user.phone);
  notifyAdmins('information', 'Nouvelle demande École & famille', `${req.user.name} : ${type}`, 'admin:contenu');
  notify(req.user.id, 'information', 'Demande École & famille envoyée ✅', 'L\u2019équipe Klean Services va vous recontacter.', '#/ecole-famille');
  res.json({ ok: true, id: info.lastInsertRowid });
});

function emergencyConfig() {
  let rawCategories = [];
  try { rawCategories = JSON.parse(getSetting('urgence_categories', '[]')); } catch { rawCategories = []; }
  const contacts = db.prepare(`SELECT service_name,phone,label,source_name,source_url,source_date,verified_at,updated_at,group_key
    FROM emergency_contacts WHERE active=1 ORDER BY CASE group_key WHEN 'vital' THEN 0 ELSE 1 END,sort,id`).all()
    .map(c => ({ nom:c.service_name, tel:c.phone, label:c.label || '', source_name:c.source_name, source_url:c.source_url,
      source_date:c.source_date || null, verified_at:c.verified_at, last_modified:c.updated_at, group:c.group_key }));
  const categories = rawCategories.filter(c => c && c.name && c.active !== false).map(c => ({ name:String(c.name).slice(0,120), description:String(c.description||'').slice(0,300) }));
  return { info:getSetting('urgence_info',''), contacts, categories, assistance_available:getSetting('urgence_assistance_enabled','0') === '1' };
}
app.get('/api/urgence/config', optionalAuth, (req, res) => res.json(emergencyConfig()));
app.post('/api/urgence', auth, (req, res) => {
  const { message, lat, lng, category } = req.body || {}, cfg=emergencyConfig();
  if (!cfg.assistance_available) return res.status(503).json({ error:'L’assistance d’urgence Klean Services n’est pas disponible actuellement.' });
  const cat=String(category||'').trim();
  if (cfg.categories.length && !cfg.categories.some(c=>c.name===cat)) return res.status(400).json({error:'Choisissez une catégorie d’assistance disponible.'});
  const safeMessage=String(message||'').trim().slice(0,2000);
  const label=cat ? '['+cat+'] ' : '';
  const info = db.prepare('INSERT INTO urgences(user_id, message, lat, lng) VALUES(?,?,?,?)').run(req.user.id, label+safeMessage, lat || null, lng || null);
  notifyAdmins('urgence', '🚨 Demande d’assistance urgente', `${req.user.name} (${req.user.phone}) a demandé une assistance${cat ? ' — '+cat : ''}${safeMessage ? ' : ' + safeMessage : ''}.`, 'admin:securite');
  notify(req.user.id, 'urgence', 'Demande d’assistance envoyée', 'Votre demande a été transmise à l’équipe Klean Services.', '#/urgence');
  res.json({ ok: true, id: info.lastInsertRowid });
});

// ============================================================
// JEUX (isolés du parcours principal, configurables)
// ============================================================
app.get('/api/games/config', (req, res) => {
  const gv = k => db.prepare('SELECT COUNT(*) n FROM view_seen WHERE key=?').get('game:' + k).n;
  res.json({ quiz: getSetting('quiz_enabled') === '1', flipfizz: getSetting('flipfizz_enabled') === '1', kdo: getSetting('kdo_enabled') === '1',
    views: { quiz: gv('quiz'), flipfizz: gv('flipfizz'), kdo: gv('kdo') } });
});
// Le QCM autonome est fusionné dans les sessions concours synchronisées.
app.get('/api/games/quiz', auth, (req, res) => res.status(410).json({ error: 'Le QCM est intégré aux sessions Quiz en direct. Attendez le prochain lancement.' }));
app.post('/api/games/quiz', auth, (req, res) => res.status(410).json({ error: 'Le QCM est intégré aux sessions Quiz en direct.' }));

// ----- QUIZ CONCOURS : sessions animées depuis le tableau de bord -----
function hasCompletedService(userId) {
  return db.prepare("SELECT 1 FROM missions WHERE client_id=? AND status IN ('terminee','payee') LIMIT 1").get(userId) ? true : false;
}
function hasMeasuredShare(userId, level) {
  if (level === 'lien_ouvert') return !!db.prepare('SELECT 1 FROM share_events WHERE user_id=? AND detected_at IS NOT NULL LIMIT 1').get(userId);
  if (level === 'inscription_acquise') return !!db.prepare('SELECT 1 FROM share_events WHERE user_id=? AND joined_user_id IS NOT NULL LIMIT 1').get(userId);
  if (level === 'sans_partage') return !db.prepare('SELECT 1 FROM share_events WHERE user_id=? AND (detected_at IS NOT NULL OR joined_user_id IS NOT NULL) LIMIT 1').get(userId);
  return true;
}
function gameEligibility(user, game) {
  // Les trois critères sont indépendants et tous vérifiés côté serveur.
  const legacy = game === 'quiz' ? (getSetting('quiz_audience') || 'tous') : 'tous';
  const account = getSetting('game_' + game + '_account', legacy) || legacy;
  const share = getSetting('game_' + game + '_share', 'tous') || 'tous';
  const service = getSetting('game_' + game + '_service', 'tous') || 'tous';
  const isPro = user.pro_status === 'approved';
  const done = hasCompletedService(user.id);
  const accountOK = account === 'tous' || account === 'clients_pros' || (account === 'clients' && !isPro) || (account === 'pros' && isPro);
  const shareOK = share === 'tous' || hasMeasuredShare(user.id, share);
  const serviceOK = service === 'tous' || (service === 'realisee' && done) || (service === 'non_realisee' && !done);
  return { ok: accountOK && shareOK && serviceOK, account, share, service, done };
}
function gameEligibilityMessage(g) {
  if (g.account === 'clients') return 'Ce jeu est réservé aux clients.';
  if (g.account === 'pros') return 'Ce jeu est réservé aux professionnels validés.';
  if (g.share === 'lien_ouvert') return 'Ce jeu nécessite au moins une ouverture mesurable de votre lien de partage.';
  if (g.share === 'inscription_acquise') return 'Ce jeu nécessite une inscription attribuée à votre lien de partage.';
  if (g.share === 'sans_partage') return 'Ce jeu est réservé aux comptes sans partage mesurable.';
  if (g.service === 'realisee') return 'Ce jeu est réservé aux clients ayant réalisé une mission.';
  if (g.service === 'non_realisee') return 'Ce jeu est réservé aux comptes sans mission réalisée.';
  return 'Vous ne remplissez pas les conditions de participation à ce jeu.';
}
function quizAudienceOk(user) { return gameEligibility(user, 'quiz').ok; }
function quizParticipant(sid, uid) {
  return db.prepare('SELECT * FROM quiz_participants WHERE session_id=? AND user_id=?').get(sid, uid);
}
// Enregistre une réponse (ou un temps écoulé) et fait avancer le participant — enregistrement immédiat
function quizRecord(s, p, answer, elapsedMs) {
  const qids = JSON.parse(s.qids || '[]');
  const qid = qids[p.current_q];
  if (qid === undefined) return p;
  const q = db.prepare('SELECT answer FROM quiz_questions WHERE id=?').get(qid);
  const correct = q && answer === q.answer ? 1 : 0;
  const ms = Math.max(0, Math.min(elapsedMs, s.time_per_q * 1000));
  db.prepare('INSERT INTO quiz_answers(session_id, user_id, question_id, answer, correct, ms) VALUES(?,?,?,?,?,?)')
    .run(s.id, p.user_id, qid, answer, correct, ms);
  const nextQ = p.current_q + 1;
  let status = p.status, finished = null;
  if (s.elimination && !correct) { status = 'elimine'; finished = 1; }
  else if (nextQ >= qids.length) { status = 'finaliste'; finished = 1; }
  db.prepare(`UPDATE quiz_participants SET score=score+?, total_ms=total_ms+?, current_q=?, q_started_at=NULL,
              status=?, finished_at=CASE WHEN ? THEN datetime('now') ELSE finished_at END WHERE id=?`)
    .run(correct, ms, nextQ, status, finished ? 1 : 0, p.id);
  return db.prepare('SELECT * FROM quiz_participants WHERE id=?').get(p.id);
}

// ----- Série synchronisée : la phase se calcule à partir de l'heure de lancement -----
function quizTimeline(s) {
  const n = JSON.parse(s.qids || '[]').length;
  const startMs = s.started_ms || Date.parse(String(s.started_at || '').replace(' ', 'T') + 'Z') || Date.now();
  const q = s.time_per_q * 1000, pause = (s.interval_s == null ? 30 : s.interval_s) * 1000, C = q + pause;
  // Une pause fige une référence de temps serveur : aucun navigateur ne peut créer de dérive.
  const el = s.paused_at ? Math.max(0, Number(s.paused_elapsed_ms || 0)) : Math.max(0, Date.now() - startMs);
  const endMs = (n - 1) * C + q;
  if (!n || el >= endMs) return { over: true, n, paused: !!s.paused_at };
  const i = Math.floor(el / C), t = el % C;
  if (t < q) return { over: false, n, paused: !!s.paused_at, phase: 'question', index: i, remaining_ms: q - t, qStartMs: startMs + i * C };
  return { over: false, n, paused: !!s.paused_at, phase: 'pause', index: i, next_in_ms: C - t };
}
// Finalisation automatique (une seule fois) quand la série est finie
function quizFinalize(s) {
  const r = db.prepare("UPDATE quiz_sessions SET status='terminee', ended_at=datetime('now') WHERE id=? AND status='en_cours'").run(s.id);
  if (!r.changes) return;
  const n = JSON.parse(s.qids || '[]').length;
  const okCount = db.prepare('SELECT COUNT(*) n FROM quiz_answers WHERE session_id=? AND user_id=? AND correct=1');
  db.prepare('SELECT * FROM quiz_participants WHERE session_id=?').all(s.id).forEach(p => {
    const good = okCount.get(s.id, p.user_id).n;
    const finaliste = s.elimination ? good === n : true; // progression : finaliste = sans faute
    db.prepare("UPDATE quiz_participants SET status=?, score=?, finished_at=COALESCE(finished_at, datetime('now')) WHERE id=?")
      .run(finaliste ? 'finaliste' : 'elimine', good, p.id);
  });
  if (s.winner_mode === 'auto') {
    db.prepare(`SELECT user_id FROM quiz_participants WHERE session_id=? AND status='finaliste'
      ORDER BY score DESC, total_ms ASC, id ASC LIMIT ?`).all(s.id, s.nb_winners).forEach(w => {
      db.prepare("UPDATE quiz_participants SET status='gagnant' WHERE session_id=? AND user_id=?").run(s.id, w.user_id);
      notify(w.user_id, 'contenu', '🏆 Félicitations, vous avez gagné !', `Vous êtes gagnant(e) du quiz « ${s.title} » ! Ouvrez le quiz pour contacter l\u2019administration.`, '#/quiz');
    });
  }
}
// État en direct pour un utilisateur : question active, verrou, spectateur, révélation en pause
function quizLiveFor(s, userId) {
  const tl = quizTimeline(s);
  if (tl.over) return null;
  const qids = JSON.parse(s.qids || '[]');
  const p = quizParticipant(s.id, userId);
  const getAns = qi => db.prepare('SELECT answer, correct FROM quiz_answers WHERE session_id=? AND user_id=? AND question_id=?').get(s.id, userId, qids[qi]);
  const mine = getAns(tl.index);
  const prev = tl.index > 0 ? getAns(tl.index - 1) : null;
  const eliminated = !!(p && p.status === 'elimine');
  const okPrev = !eliminated && (tl.index === 0 || !s.elimination || !!(prev && prev.correct === 1));
  const base = { phase: tl.phase, index: tl.index, total: tl.n, time_per_q: s.time_per_q, interval_s: s.interval_s, paused: !!tl.paused };
  if (tl.phase === 'question') {
    const q = db.prepare('SELECT id, question, options FROM quiz_questions WHERE id=?').get(qids[tl.index]);
    return { ...base, remaining_ms: tl.remaining_ms,
      question: q ? { id: q.id, question: q.question, options: JSON.parse(q.options).slice(0, 4) } : null,
      answered: !!mine, my_answer: mine ? mine.answer : null,
      can_answer: !mine && okPrev, spectator: eliminated || (!mine && !okPrev), eliminated };
  }
  const q = db.prepare('SELECT question, options, answer FROM quiz_questions WHERE id=?').get(qids[tl.index]);
  return { ...base, next_in_ms: tl.next_in_ms, next_index: tl.index + 1, last_question: tl.index + 1 >= tl.n,
    reveal: q ? { question: q.question, options: JSON.parse(q.options).slice(0, 4), correct: q.answer,
      my_answer: mine ? mine.answer : null, my_correct: !!(mine && mine.correct === 1) } : null,
    spectator_next: eliminated || (s.elimination ? !(mine && mine.correct === 1) : false), eliminated };
}

function quizRecordView(sid, uid) {
  db.prepare("INSERT INTO quiz_views(session_id,user_id,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(session_id,user_id) DO UPDATE SET updated_at=datetime('now')").run(sid, uid);
}
function quizLiveCounts(sid) {
  const registered = db.prepare('SELECT COUNT(*) n FROM quiz_participants WHERE session_id=?').get(sid).n;
  const in_competition = db.prepare("SELECT COUNT(*) n FROM quiz_participants WHERE session_id=? AND status='en_lice'").get(sid).n;
  const watchers = db.prepare("SELECT COUNT(*) n FROM quiz_views v WHERE v.session_id=? AND v.updated_at >= datetime('now','-20 seconds')").get(sid).n;
  // Un spectateur est soit un visiteur non inscrit, soit une personne éliminée :
  // elle reste visible mais n'est jamais comptée parmi les concurrents en lice.
  const spectators = db.prepare("SELECT COUNT(*) n FROM quiz_views v LEFT JOIN quiz_participants p ON p.session_id=v.session_id AND p.user_id=v.user_id WHERE v.session_id=? AND v.updated_at >= datetime('now','-20 seconds') AND (p.id IS NULL OR p.status='elimine')").get(sid).n;
  return { registered, participants: registered, in_competition, spectators, watchers };
}
function archiveQuizSession(s, userId, reason) {
  const participants = db.prepare('SELECT user_id,status,score,total_ms,current_q,finished_at FROM quiz_participants WHERE session_id=? ORDER BY id').all(s.id);
  const answers = db.prepare('SELECT user_id,question_id,answer,correct,ms FROM quiz_answers WHERE session_id=? ORDER BY id').all(s.id);
  const messages = db.prepare('SELECT user_id,from_admin,body,created_at FROM quiz_messages WHERE session_id=? ORDER BY id').all(s.id);
  const snapshot = JSON.stringify({ reason, session: s, participants, answers, messages, archived_server_ms: Date.now() });
  db.prepare('INSERT INTO quiz_archives(source_session_id,title,snapshot,archived_by) VALUES(?,?,?,?)').run(s.id, s.title, snapshot, userId || null);
}
// État du concours pour l'utilisateur connecté
app.get('/api/games/concours', auth, (req, res) => {
  if (getSetting('quiz_enabled') !== '1') return res.json({ enabled: false });
  const criteria = gameEligibility(req.user, 'quiz');
  const audience = criteria.account; // compatibilité d’affichage
  const allowed = criteria.ok;
  let s = db.prepare("SELECT * FROM quiz_sessions WHERE status='en_cours' ORDER BY id DESC LIMIT 1").get();
  if (s && quizTimeline(s).over) { quizFinalize(s); s = null; } // série finie -> finalisation auto
  let p = null;
  if (s) { if (s.status === 'en_cours') quizRecordView(s.id, req.user.id); p = quizParticipant(s.id, req.user.id); }
  else {
    // dernière session terminée à laquelle l'utilisateur a participé (résultats, gagnant…)
    s = db.prepare(`SELECT s.* FROM quiz_sessions s JOIN quiz_participants pp ON pp.session_id=s.id
                    WHERE s.status='terminee' AND pp.user_id=? ORDER BY s.id DESC LIMIT 1`).get(req.user.id);
    if (s) p = quizParticipant(s.id, req.user.id);
  }
  if (!s) return res.json({ enabled: true, allowed, audience, criteria, reason: allowed ? null : gameEligibilityMessage(criteria), session: null });
  const winnersDone = db.prepare("SELECT COUNT(*) n FROM quiz_participants WHERE session_id=? AND status='gagnant'").get(s.id).n > 0;
  const out = {
    enabled: true, allowed, audience, criteria, reason: allowed ? null : gameEligibilityMessage(criteria),
    session: {
      id: s.id, title: s.title, status: s.status, nb_questions: JSON.parse(s.qids || '[]').length || s.nb_questions,
      time_per_q: s.time_per_q, interval_s: s.interval_s, elimination: !!s.elimination, nb_winners: s.nb_winners, winners_designated: winnersDone,
      paused: !!s.paused_at, counts: s.status === 'en_cours' ? quizLiveCounts(s.id) : { registered: db.prepare('SELECT COUNT(*) n FROM quiz_participants WHERE session_id=?').get(s.id).n, participants: db.prepare('SELECT COUNT(*) n FROM quiz_participants WHERE session_id=?').get(s.id).n, in_competition: 0, spectators: 0, watchers: 0 }
    },
    participant: p ? { status: p.status, score: p.score, current_q: p.current_q, photo_asked: !!p.photo_asked, photo_consent: p.photo_consent } : null,
    est_gagnant: !!(p && p.status === 'gagnant')
  };
  if (s.status === 'en_cours' && allowed) out.live = quizLiveFor(s, req.user.id); // question active, verrou, spectateur…
  if (out.est_gagnant) // bulle de contact gagnant ↔ administration
    out.messages = db.prepare('SELECT from_admin, body, created_at FROM quiz_messages WHERE session_id=? AND user_id=? ORDER BY id').all(s.id, req.user.id);
  res.json(out);
});

app.post('/api/games/concours/:id/rejoindre', auth, (req, res) => {
  if (getSetting('quiz_enabled') !== '1') return res.status(403).json({ error: 'Le quiz est désactivé.' });
  if (!quizAudienceOk(req.user)) return res.status(403).json({ error: gameEligibilityMessage(gameEligibility(req.user, 'quiz')) });
  const s = db.prepare("SELECT * FROM quiz_sessions WHERE id=? AND status='en_cours'").get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Ce quiz n\u2019est pas (ou plus) en cours.' });
  if (quizParticipant(s.id, req.user.id)) return res.status(400).json({ error: 'Vous participez déjà à ce quiz.' });
  db.prepare('INSERT INTO quiz_participants(session_id, user_id) VALUES(?,?)').run(s.id, req.user.id);
  res.json({ ok: true });
});

// Compatibilité : la question renvoyée est la même pour tout le monde, basée sur la chronologie serveur.
app.get('/api/games/concours/:id/question', auth, (req, res) => {
  const s = db.prepare("SELECT * FROM quiz_sessions WHERE id=? AND status='en_cours'").get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Ce quiz n’est pas (ou plus) en cours.' });
  quizRecordView(s.id, req.user.id);
  const live = quizLiveFor(s, req.user.id);
  if (!live || live.paused) return res.json({ done: false, paused: !!(live && live.paused), live });
  if (live.phase !== 'question') return res.json({ done: false, waiting: true, ...live });
  res.json({ done: false, ...live });
});

// Réponse : UNE seule par compte et par quiz, acceptée uniquement pendant la fenêtre de la question
app.post('/api/games/concours/:id/repondre', auth, (req, res) => {
  if (getSetting('quiz_enabled') !== '1') return res.status(403).json({ error: 'Le quiz est désactivé.' });
  if (!quizAudienceOk(req.user)) return res.status(403).json({ error: gameEligibilityMessage(gameEligibility(req.user, 'quiz')) });
  const s = db.prepare("SELECT * FROM quiz_sessions WHERE id=? AND status='en_cours'").get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Ce quiz n\u2019est pas (ou plus) en cours.' });
  const tl = quizTimeline(s);
  if (tl.paused) return res.status(409).json({ error: 'Le quiz est momentanément en pause par l’administration.' });
  if (tl.over) { quizFinalize(s); return res.status(400).json({ error: 'Cette série de quiz est terminée.' }); }
  if (tl.phase !== 'question') return res.status(400).json({ error: 'Patientez : le prochain quiz arrive (décompte à l\u2019écran).' });
  const index = parseInt(req.body.index, 10);
  if (index !== tl.index) return res.status(400).json({ error: 'Cette question est fermée.' });
  const answer = parseInt(req.body.answer, 10);
  if (!Number.isInteger(answer) || answer < 0 || answer > 3) return res.status(400).json({ error: 'Choisissez une réponse (A, B, C ou D).' });
  const qids = JSON.parse(s.qids || '[]'), qid = qids[index];
  if (db.prepare('SELECT id FROM quiz_answers WHERE session_id=? AND user_id=? AND question_id=?').get(s.id, req.user.id, qid))
    return res.status(400).json({ error: 'Votre réponse est déjà enregistrée et verrouillée.' });
  if (s.elimination && index > 0) { // progression conditionnelle -> sinon spectateur
    const prev = db.prepare('SELECT correct FROM quiz_answers WHERE session_id=? AND user_id=? AND question_id=?').get(s.id, req.user.id, qids[index - 1]);
    if (!prev || prev.correct !== 1)
      return res.status(403).json({ error: 'Mode spectateur : seuls ceux qui ont trouvé la bonne réponse précédente peuvent continuer à répondre.' });
  }
  const q = db.prepare('SELECT answer FROM quiz_questions WHERE id=?').get(qid);
  const correct = q && q.answer === answer ? 1 : 0;
  const ms = Math.max(0, Math.min(Date.now() - tl.qStartMs, s.time_per_q * 1000));
  db.prepare('INSERT OR IGNORE INTO quiz_participants(session_id, user_id) VALUES(?,?)').run(s.id, req.user.id);
  try {
    db.prepare('INSERT INTO quiz_answers(session_id, user_id, question_id, answer, correct, ms) VALUES(?,?,?,?,?,?)')
      .run(s.id, req.user.id, qid, answer, correct, ms);
  } catch { return res.status(400).json({ error: 'Votre réponse est déjà enregistrée et verrouillée.' }); }
  // L'élimination est immédiate et persistée. La personne pourra encore lire le direct,
  // mais aucun endpoint ne lui laissera répondre aux questions suivantes.
  const eliminatedNow = !!(s.elimination && !correct);
  db.prepare("UPDATE quiz_participants SET score=score+?, total_ms=total_ms+?, current_q=?, status=CASE WHEN ? THEN 'elimine' ELSE status END, finished_at=CASE WHEN ? THEN datetime('now') ELSE finished_at END WHERE session_id=? AND user_id=?")
    .run(correct, ms, index + 1, eliminatedNow ? 1 : 0, eliminatedNow ? 1 : 0, s.id, req.user.id);
  res.json({ ok: true, locked: true, correct: !!correct, eliminated: eliminatedNow, counts: quizLiveCounts(s.id) });
});

// Consentement photo du gagnant : ✅ j'accepte / ❌ je refuse (jamais redemandé après un refus)
app.post('/api/games/concours/:id/photo', auth, (req, res) => {
  const p = quizParticipant(req.params.id, req.user.id);
  if (!p || p.status !== 'gagnant') return res.status(403).json({ error: 'Réservé aux gagnants.' });
  if (!p.photo_asked) return res.status(400).json({ error: 'Aucune demande de photo en attente.' });
  if (p.photo_consent) return res.status(400).json({ error: 'Votre choix a déjà été enregistré.' });
  const decision = req.body.decision === 'accepte' ? 'accepte' : 'refuse';
  db.prepare("UPDATE quiz_participants SET photo_consent=?, photo_consent_at=datetime('now') WHERE id=?").run(decision, p.id);
  notifyAdmins('contenu', 'Consentement photo (quiz)', `${req.user.name} a ${decision === 'accepte' ? 'ACCEPTÉ ✅' : 'REFUSÉ ❌'} l\u2019utilisation de sa photo.`, 'admin:games');
  res.json({ ok: true, decision });
});

// Bulle de contact : le gagnant écrit à l'administration
app.post('/api/games/concours/:id/message', auth, (req, res) => {
  const p = quizParticipant(req.params.id, req.user.id);
  if (!p || p.status !== 'gagnant') return res.status(403).json({ error: 'Réservé aux gagnants.' });
  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Écrivez un message.' });
  if (body.length > 1000) return res.status(400).json({ error: 'Message trop long (1000 caractères max).' });
  db.prepare('INSERT INTO quiz_messages(session_id, user_id, from_admin, body) VALUES(?,?,0,?)').run(p.session_id, req.user.id, body);
  notifyAdmins('contenu', 'Message d\u2019un gagnant du quiz', `${req.user.name} : ${body.slice(0, 120)}`, 'admin:games');
  res.json({ ok: true });
});
app.post('/api/games/flipfizz', auth, (req, res) => {
  if (getSetting('flipfizz_enabled') !== '1') return res.status(403).json({ error: 'Flip Fizz est désactivé.' });
  const eligible = gameEligibility(req.user, 'flipfizz');
  if (!eligible.ok) return res.status(403).json({ error: gameEligibilityMessage(eligible) });
  const today = db.prepare("SELECT COUNT(*) n FROM game_plays WHERE user_id=? AND game='flipfizz' AND date(created_at)=date('now')").get(req.user.id).n;
  if (today >= 3) return res.status(429).json({ error: 'Vous avez atteint vos 3 essais du jour. Revenez demain !' });
  const win = Math.random() < 0.15;
  const result = win ? 'gagné' : 'perdu';
  db.prepare("INSERT INTO game_plays(user_id, game, result) VALUES(?,'flipfizz',?)").run(req.user.id, result);
  if (win) notifyAdmins('information', '🎁 Gagnant Flip Fizz', `${req.user.name} (${req.user.phone}) a gagné à Flip Fizz.`, 'admin:contenu');
  res.json({ win, essais_restants: 2 - today });
});
app.post('/api/games/kdo', auth, (req, res) => {
  if (getSetting('kdo_enabled') !== '1') return res.status(403).json({ error: 'Kdo est désactivé.' });
  const eligible = gameEligibility(req.user, 'kdo');
  if (!eligible.ok) return res.status(403).json({ error: gameEligibilityMessage(eligible) });
  const code = (req.body.code || '').trim().toUpperCase();
  const row = db.prepare('SELECT * FROM kdo_codes WHERE code=? AND active=1').get(code);
  if (!row) return res.status(404).json({ error: 'Code invalide.' });
  if (row.used_by) return res.status(409).json({ error: 'Ce code a déjà été utilisé.' });
  db.prepare("UPDATE kdo_codes SET used_by=?, used_at=datetime('now') WHERE id=?").run(req.user.id, row.id);
  notifyAdmins('information', '🎁 Code Kdo utilisé', `${req.user.name} a utilisé le code ${code} (${row.reward}).`, 'admin:contenu');
  res.json({ ok: true, reward: row.reward });
});

// Ciblage des publicités : [] signifie toute la Côte d'Ivoire. Les zones sont
// validées côté serveur à la création, puis comparées à la ville du compte.
function cleanZones(raw) {
  let a = raw;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = a ? [a] : []; } }
  if (!Array.isArray(a)) a = [];
  return [...new Set(a.map(v => String(v || '').trim()).filter(Boolean))].slice(0, 100);
}
function assertValidZones(raw) {
  const zones = cleanZones(raw);
  for (const zone of zones) if (!db.prepare('SELECT 1 FROM villes WHERE active=1 AND lower(name)=lower(?)').get(zone))
    throw new Error('Une zone sélectionnée n’est plus disponible : ' + zone);
  return zones;
}
function adZoneAllowed(zones, city) {
  const list = cleanZones(zones);
  return !list.length || (!!city && list.some(z => cityMatches(z, city)));
}
function viewerForAds(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const payload = verifyToken(token);
  return payload ? db.prepare('SELECT ville FROM users WHERE id=?').get(payload.id) : null;
}
// Publicités actives, avec leur nombre de vues (une vue par compte maximum), filtrées géographiquement.
app.get('/api/ads', (req, res) => {
  pubTick();
  const viewer = viewerForAds(req);
  const rows = db.prepare(`SELECT a.id, a.type, a.title, a.content, a.file, a.placement, a.duration, a.zones,
    (SELECT COUNT(*) FROM view_seen v WHERE v.key = 'ad:' || a.id) AS views
    FROM ads a WHERE a.active=1 ORDER BY a.sort, a.id`).all()
    .filter(a => adZoneAllowed(a.zones, viewer && viewer.ville));
  if (getSetting('pub_campagnes_enabled', '1') === '1') {
    const dur = Math.max(3, parseInt(getSetting('pub_duree_affichage', '6'), 10) || 6);
    for (const c of db.prepare(`SELECT * FROM ad_campaigns WHERE status='active' ORDER BY id`).all()) {
      // Anciennes campagnes avec « zone » unique sont conservées et ciblées correctement.
      const zones = cleanZones(c.zones).length ? c.zones : (c.zone ? [c.zone] : []);
      if (!adZoneAllowed(zones, viewer && viewer.ville)) continue;
      const entry = { id: 'c' + c.id, type: c.type, title: c.title, content: c.content, file: c.file, placement: c.placement, duration: dur, zones, views: 0, sponsor: true };
      for (let i = 0; i < pubPoids(c.priorite); i++) rows.push(entry);
    }
  }
  res.json(rows);
});

// Bandeau d'annonces défilantes (bas de l'accueil) — visible aussi sans compte
app.get('/api/annonces', (req, res) => {
  res.json({
    enabled: getSetting('bandeau_enabled') === '1',
    speed: Math.max(10, Math.min(400, parseInt(getSetting('bandeau_speed') || '60', 10) || 60)),
    items: db.prepare('SELECT id, type, theme, title, content, icon, color, link FROM annonces WHERE active=1 ORDER BY sort, id').all()
  });
});

// Comptage des vues (pub, infos, urgences, jeux) — chaque compte ne compte qu'UNE fois par élément
const seeView = db.prepare('INSERT OR IGNORE INTO view_seen(key, user_id) VALUES(?, ?)');
app.post('/api/vues', auth, (req, res) => {
  const keys = Array.isArray(req.body.keys) ? req.body.keys.slice(0, 20) : [];
  keys.forEach(k => { if (typeof k === 'string' && /^(ad:\d+|game:(quiz|flipfizz|kdo))$/.test(k)) seeView.run(k, req.user.id); });
  res.json({ ok: true });
});

// ============================================================
// ADMINISTRATION
// ============================================================
const A = express.Router();
A.use(auth, admin);

// Chaque section du tableau de bord correspond à une permission (le PDG a toujours tout)
const PERM_ROUTES = [
  [/^\/staff/, 'PDG'], // gestion de l'équipe : réservé au PDG
  [/^\/pro-options/, 'PDG'], // options professionnelles : choix de direction
  [/^\/maintenance/, 'PDG'], // mode maintenance : réservé au PDG
  [/^\/journal/, 'journal'],
  [/^\/users\/\d+$/, 'comptes'], [/^\/users/, 'comptes'],
  [/^\/pros/, 'pros'],
  [/^\/(estimation-rules|estimation-config|estimation-test|search-terms|grand-categories|emergency-contacts)/, 'PDG'],
  [/^\/(catalog|categories|sous-categories|services|taches|villes|communes)/, 'catalogue'], 
  [/^\/questions/, 'questions'],
  [/^\/missions/, 'missions'],
  [/^\/payments/, 'paiements'],
  [/^\/(finances|transactions|prix-modifs|visibilite|pub)/, 'paiements'],
  [/^\/commissions/, 'parametres'],
  [/^\/dispatch/, 'parametres'],
  [/^\/(ads|broadcast|general-messages|annonces|support)/, 'communication'],
  [/^\/frequentation/, 'frequentation'],
  [/^\/about/, 'PDG'],
  [/^\/(signalements|urgences|files|rules)/, 'securite'],
  [/^\/(avis-recherche|avis-categories|jobs|job-offers|ecole-famille|quiz|kdo|game-plays|quiz-sessions|shares)/, 'contenu'],
  [/^\/settings/, 'parametres'],
];
// Libellés lisibles pour le journal automatique
const ACTION_LABELS = [
  [/^POST \/users\/\d+\/suspend/, 'Suspension / réactivation de compte'],
  [/^POST \/users\/\d+\/block/, 'Blocage / déblocage de compte'],
  [/^POST \/users\/\d+\/disable-temp/, 'Désactivation temporaire de compte'],
  [/^POST \/users\/\d+\/reset-access/, 'Réinitialisation d\u2019accès'],
  [/^POST \/users\/\d+\/force-password/, 'Changement de mot de passe forcé'],
  [/^POST \/users\/\d+\/verify/, 'Vérification de compte'],
  [/^PUT \/users\/\d+/, 'Modification de compte'],
  [/^DELETE \/users\/\d+/, 'Suppression de compte'],
  [/^POST \/users/, 'Création rapide de compte'],
  [/^POST \/pros\/\d+\/approve/, 'Validation professionnelle'],
  [/^POST \/pros\/\d+\/reject/, 'Refus professionnel'],
  [/^(POST|PUT|DELETE) \/grand-categories/, 'Catalogue : grande catégorie'],
  [/^(POST|PUT|DELETE) \/search-terms/, 'Dictionnaire de recherche'],
  [/^(POST|PUT|DELETE) \/estimation-rules/, 'Règle tarifaire intelligente'],
  [/^PUT \/estimation-config/, 'Paramètres d’estimation'],
  [/^(POST|PUT|DELETE) \/categories/, 'Catalogue : métier'],
  [/^(POST|PUT|DELETE) \/sous-categories/, 'Catalogue : sous-catégorie'],
  [/^(POST|PUT|DELETE) \/services/, 'Catalogue : service'],
  [/^(POST|PUT|DELETE) \/taches/, 'Catalogue : tâche'],
  [/^(POST|PUT|DELETE) \/villes/, 'Catalogue : ville'],
  [/^(POST|PUT|DELETE) \/questions/, 'Question dynamique'],
  [/^PUT \/settings/, 'Modification des paramètres'],
  [/^POST \/broadcast/, 'Message système envoyé'],
  [/^(POST|PUT|DELETE) \/general-messages/, 'Message général ciblé'],
  [/^(POST|PUT) \/about/, 'Contenu À propos modifié'],
  [/^POST \/support\/conversations\/\d+\/messages/, 'Réponse à un client'],
  [/^(POST|PUT|DELETE) \/ads/, 'Publicité / information'],
  [/^PUT \/rules/, 'Modification des règles'],
  [/^POST \/staff\/\d+\/reset-access/, 'Équipe : réinitialisation d\u2019accès'],
  [/^PUT \/staff\/\d+/, 'Équipe : rôle / permissions modifiés'],
  [/^DELETE \/staff\/\d+/, 'Équipe : compte supprimé'],
  [/^POST \/staff/, 'Équipe : compte créé'],
  [/^POST \/maintenance/, '🛠 MODE MAINTENANCE modifié'],
  [/^POST \/missions\/\d+/, 'Intervention sur une mission'],
  [/^POST \/payments/, 'Intervention sur un paiement'],
  [/^POST \/transactions/, '💰 Finance : statut d\u2019une transaction modifié'],
  [/^(POST|PUT|DELETE) \/pub\/campagnes/, '📣 Publicité : action sur une campagne'],
  [/^(POST|PUT|DELETE) \/commissions/, '💰 Commission : règle modifiée'],
  [/^(POST|PUT|DELETE) \/visibilite/, '⭐ Visibilité : modification'],
];
A.use((req, res, next) => {
  // L'écran « Questions dynamiques » lit le catalogue : la permission « questions » suffit pour la LECTURE du catalogue
  const lectureCatalogue = req.method === 'GET' && /^\/catalog/.test(req.path) && (hasPerm(req.user, 'catalogue') || hasPerm(req.user, 'questions'));
  const rule = lectureCatalogue ? null : PERM_ROUTES.find(([re]) => re.test(req.path));
  if (rule) {
    if (rule[1] === 'PDG') { if (req.user.role !== 'pdg') return res.status(403).json({ error: 'Action réservée au PDG.' }); }
    else if (!hasPerm(req.user, rule[1])) return res.status(403).json({ error: 'Vous n\u2019avez pas la permission « ' + (PERM_KEYS[rule[1]] || rule[1]) + ' ». Contactez le PDG.' });
  }
  // Journal automatique de toute action d'écriture réussie
  if (req.method !== 'GET') {
    const method = req.method, p = req.path;
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      const lbl = (ACTION_LABELS.find(([re]) => re.test(method + ' ' + p)) || [null, method + ' ' + p])[1];
      const body = { ...(req.body || {}) };
      ['password', 'temp_password', 'current'].forEach(k => delete body[k]);
      const idm = p.match(/\/(\d+)/);
      logAction(req.user, lbl, {
        target_type: p.split('/')[1] || null,
        target_id: idm ? parseInt(idm[1], 10) : null,
        details: method + ' ' + p + (Object.keys(body).length ? ' ' + JSON.stringify(body).slice(0, 300) : ''),
        reason: (req.body && req.body.reason) || null,
      });
    });
  }
  next();
});

A.get('/stats', (req, res) => {
  const g = q => db.prepare(q).get().n;
  res.json({
    users: g("SELECT COUNT(*) n FROM users WHERE role='user'"),
    pros: g("SELECT COUNT(*) n FROM users WHERE pro_status='approved'"),
    pros_pending: g("SELECT COUNT(*) n FROM users WHERE pro_status='pending'"),
    suspended: g('SELECT COUNT(*) n FROM users WHERE suspended=1'),
    missions: g('SELECT COUNT(*) n FROM missions'),
    missions_actives: g("SELECT COUNT(*) n FROM missions WHERE status IN ('recherche','acceptee','confirmee','en_cours')"),
    missions_terminees: g("SELECT COUNT(*) n FROM missions WHERE status IN ('terminee','payee')"),
    litiges: g("SELECT COUNT(*) n FROM missions WHERE status='litige'"),
    ca: db.prepare("SELECT COALESCE(SUM(amount),0) n FROM payments WHERE status='valide'").get().n,
    commissions: db.prepare("SELECT COALESCE(SUM(commission_amount),0) n FROM payments WHERE status='valide'").get().n,
    signalements: g("SELECT COUNT(*) n FROM signalements WHERE status='nouveau'"),
    urgences: g('SELECT COUNT(*) n FROM urgences WHERE handled=0'),
    moderation: g("SELECT COUNT(*) n FROM avis_recherche WHERE status='pending'") + g("SELECT COUNT(*) n FROM jobs WHERE status='pending'"),
    metiers: g('SELECT COUNT(*) n FROM service_categories WHERE active=1'),
    services_count: g('SELECT COUNT(*) n FROM services WHERE active=1'),
    taches: g('SELECT COUNT(*) n FROM taches WHERE active=1'),
    villes: g('SELECT COUNT(*) n FROM villes WHERE active=1'),
    admin_font_size: parseInt(getSetting('admin_font_size', '16'), 10),
  });
});

// STATISTIQUES DE FRÉQUENTATION — données d'interaction, séparées des simples connexions techniques.
function frequencyRange(q) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  let to = iso.test(String(q.to || '')) ? String(q.to) : new Date().toISOString().slice(0, 10);
  let from;
  if (iso.test(String(q.from || ''))) from = String(q.from);
  else { const days = Math.max(1, Math.min(366, parseInt(q.days || '30', 10) || 30)); const d = new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - days + 1); from = d.toISOString().slice(0, 10); }
  if (from > to) [from, to] = [to, from];
  const start = new Date(from + 'T00:00:00Z'), end = new Date(to + 'T00:00:00Z');
  if ((end - start) / 86400000 > 365) { const d = new Date(end); d.setUTCDate(d.getUTCDate() - 365); from = d.toISOString().slice(0,10); }
  return { from, to, until: to + ' 23:59:59' };
}
function activityStatus(u, thresholdMin) {
  const now = Date.now(), last = u.last_activity_at ? Date.parse(String(u.last_activity_at).replace(' ', 'T') + 'Z') : 0;
  const back = u.last_background_at ? Date.parse(String(u.last_background_at).replace(' ', 'T') + 'Z') : 0;
  if (u.activity_state === 'background' && back && now - back <= thresholdMin * 60000) return 'arriere_plan';
  if (u.activity_state === 'active' && last && now - last <= thresholdMin * 60000) return 'actif';
  return 'inactif';
}
A.get('/frequentation', (req, res) => {
  const r = frequencyRange(req.query || {}), threshold = Math.max(1, Math.min(120, parseInt(getSetting('activity_active_minutes','5'), 10) || 5));
  const activeWhere = "e.event_type='active' AND e.created_at>=? AND e.created_at<=?";
  const rangeArgs = [r.from + ' 00:00:00', r.until];
  const active = db.prepare(`SELECT COUNT(DISTINCT e.user_id) n FROM user_activity_events e JOIN users u ON u.id=e.user_id WHERE ${activeWhere} AND u.role='user'`).get(...rangeArgs).n;
  const clients = db.prepare(`SELECT COUNT(DISTINCT e.user_id) n FROM user_activity_events e JOIN users u ON u.id=e.user_id WHERE ${activeWhere} AND u.role='user' AND u.pro_status!='approved'`).get(...rangeArgs).n;
  const pros = db.prepare(`SELECT COUNT(DISTINCT e.user_id) n FROM user_activity_events e JOIN users u ON u.id=e.user_id WHERE ${activeWhere} AND u.role='user' AND u.pro_status='approved'`).get(...rangeArgs).n;
  const registrations = db.prepare("SELECT COUNT(*) n FROM users WHERE role='user' AND created_at>=? AND created_at<=?").get(...rangeArgs).n;
  const returning = db.prepare(`SELECT COUNT(DISTINCT e.user_id) n FROM user_activity_events e WHERE ${activeWhere} AND EXISTS (SELECT 1 FROM user_activity_events prior WHERE prior.user_id=e.user_id AND prior.event_type='active' AND prior.created_at<?)`).get(...rangeArgs, r.from+' 00:00:00').n;
  const cities = db.prepare(`SELECT COALESCE(NULLIF(TRIM(u.ville),''),'Non renseignée') city, COUNT(DISTINCT e.user_id) n FROM user_activity_events e JOIN users u ON u.id=e.user_id WHERE ${activeWhere} AND u.role='user' GROUP BY city ORDER BY n DESC, city COLLATE NOCASE LIMIT 100`).all(...rangeArgs);
  const series = [];
  for (let d = new Date(r.from+'T00:00:00Z'), e = new Date(r.to+'T00:00:00Z'); d <= e; d.setUTCDate(d.getUTCDate()+1)) { const day = d.toISOString().slice(0,10); series.push({ date:day, active:db.prepare("SELECT COUNT(DISTINCT user_id) n FROM user_activity_events WHERE event_type='active' AND date(created_at)=?").get(day).n, registrations:db.prepare("SELECT COUNT(*) n FROM users WHERE role='user' AND date(created_at)=?").get(day).n }); }
  const recentRaw = db.prepare("SELECT id,name,phone,photo,ville,pro_status,last_activity_at,last_background_at,activity_state FROM users WHERE role='user' AND (last_activity_at IS NOT NULL OR last_background_at IS NOT NULL) ORDER BY COALESCE(last_activity_at,last_background_at) DESC LIMIT 100").all();
  const recent = recentRaw.map(u => ({id:u.id,name:u.name,phone:u.phone,photo:u.photo,ville:u.ville,pro_status:u.pro_status,last_activity_at:u.last_activity_at,last_background_at:u.last_background_at,status:activityStatus(u,threshold)}));
  const since = m => db.prepare("SELECT COUNT(DISTINCT user_id) n FROM user_activity_events WHERE event_type='active' AND created_at>=datetime('now',?)").get('-'+m+' days').n;
  res.json({range:r,threshold_minutes:threshold,active,clients,pros,registrations,returning,dau:since(1),wau:since(7),mau:since(30),cities,series,recent});
});

// UTILISATEURS
A.get('/users', (req, res) => {
  const f = req.query.filter || 'all';
  let where = "u.role='user'";
  if (f === 'pros') where += " AND u.pro_status='approved'";
  if (f === 'clients') where += " AND (u.pro_status IS NULL OR u.pro_status!='approved')";
  if (f === 'pending') where += " AND u.pro_status='pending'";
  if (f === 'suspended') where = "u.role='user' AND (u.suspended=1 OR u.blocked=1 OR (u.disabled_until IS NOT NULL AND u.disabled_until > datetime('now')))";
  if (f === 'verified') where += ' AND u.verified=1';
  if (f === 'incomplete') where += ' AND u.profile_incomplete=1';
  const sort = req.query.sort === 'nom' ? 'u.name COLLATE NOCASE ASC' : 'u.id DESC'; // alphabétique ou date d'inscription (récents d'abord)
  const rows = db.prepare(`SELECT u.id, u.name, u.phone, u.email, u.address, u.ville, u.quartier, u.is_pro, u.pro_status, u.kp_code, u.suspended, u.blocked, u.disabled_until, u.must_change_password, u.profile_incomplete, u.verified, u.created_at,
    p.profession AS pro_profession, p.services AS pro_services, p.service_city AS service_city
    FROM users u LEFT JOIN pro_profiles p ON p.user_id=u.id WHERE ${where} ORDER BY ${sort} LIMIT 500`).all();
  // Les identifiants enregistrés dans le profil sont résolus à chaque lecture : aucune copie
  // et donc aucune désynchronisation lorsque le professionnel modifie ses services.
  const ids = [...new Set(rows.flatMap(r => { try { return JSON.parse(r.pro_services || '[]'); } catch { return []; } }).map(Number).filter(Number.isInteger))];
  const names = new Map();
  if (ids.length) db.prepare(`SELECT id, name FROM services WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).forEach(s => names.set(s.id, s.name));
  res.json(rows.map(r => {
    let serviceIds = []; try { serviceIds = JSON.parse(r.pro_services || '[]'); } catch { serviceIds = []; }
    const services = serviceIds.map(Number).map(id => names.get(id)).filter(Boolean);
    return { ...r, services, pro_profession: r.pro_profession || null, service_city: r.service_city || null, pro_services: undefined };
  }));
});
A.get('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  const pro = db.prepare('SELECT * FROM pro_profiles WHERE user_id=?').get(u.id);
  const missions = db.prepare('SELECT COUNT(*) n FROM missions WHERE client_id=? OR pro_id=?').get(u.id, u.id).n;
  const history = db.prepare("SELECT admin_name, admin_role, action, details, reason, created_at FROM admin_log WHERE target_type='users' AND target_id=? ORDER BY id DESC LIMIT 50").all(u.id);
  delete u.password_hash; delete u.salt; delete u.perms;
  res.json({ ...u, pro: pro ? { ...pro, services: JSON.parse(pro.services), authorized_services: jsonNumberIds(pro.authorized_services || pro.services),
    domain_categories: (() => { try { const v=JSON.parse(pro.domain_categories || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })(),
    authorized_domain_categories: pro.authorized_domain_categories === null || pro.authorized_domain_categories === undefined ? null : (() => { try { const v=JSON.parse(pro.authorized_domain_categories || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })(),
    service_cities: (() => { try { return JSON.parse(pro.service_cities || '[]'); } catch { return []; } })(), documents: JSON.parse(pro.documents) } : null, missions, history });
});

// Garde-fou : un membre de l'équipe ne peut pas agir sur un compte de l'équipe (sauf le PDG, et jamais sur le PDG)
function cibleUtilisateur(req, res) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) { res.status(404).json({ error: 'Utilisateur introuvable.' }); return null; }
  if (u.role === 'pdg') { res.status(403).json({ error: 'Le compte PDG ne peut pas être modifié ici.' }); return null; }
  if (STAFF_ROLES.includes(u.role) && req.user.role !== 'pdg') {
    res.status(403).json({ error: 'Seul le PDG peut agir sur un compte de l\u2019équipe.' }); return null;
  }
  return u;
}
function motDePasseTemporaire() {
  return 'KS' + String(Math.floor(100000 + Math.random() * 900000));
}

// ＋ Créer rapidement un compte (infos minimales — l'utilisateur complètera son profil)
A.post('/users', (req, res) => {
  const { name, phone, email, type } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Veuillez indiquer le nom.' });
  if (!phone || !/^[+0-9 ]{8,20}$/.test(phone.trim())) return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
  const p = phone.trim().replace(/\s+/g, '');
  if (db.prepare('SELECT id FROM users WHERE phone=?').get(p)) return res.status(409).json({ error: 'Ce numéro est déjà associé à un compte.' });
  const temp = motDePasseTemporaire();
  const salt = crypto.randomBytes(16).toString('hex');
  const info = db.prepare(`INSERT INTO users(name, phone, email, password_hash, salt, must_change_password, profile_incomplete, created_by)
    VALUES(?,?,?,?,?,1,1,?)`).run(name.trim(), p, (email || '').trim() || null, hashPassword(temp, salt), salt, req.user.id);
  notify(info.lastInsertRowid, 'compte', 'Bienvenue sur Klean Services 👋',
    'Votre compte a été créé par notre équipe. Connectez-vous, choisissez votre mot de passe et complétez votre profil.' +
    (type === 'pro' ? ' Pour devenir professionnel, faites votre demande depuis Mon compte (validation normale).' : ''), '#/account');
  res.json({ id: info.lastInsertRowid, temp_password: temp });
});

// Conversion contrôlée d’un client : identité minimale conservée, aucune donnée inventée.
A.post('/users/:id/convert-pro', (req, res) => {
  const u = cibleUtilisateur(req, res); if (!u) return;
  if (!hasPerm(req.user, 'pros')) return res.status(403).json({ error: 'La permission de validation des professionnels est requise.' });
  if (!u.name || !u.phone) return res.status(400).json({ error: 'Nom et téléphone sont indispensables avant toute conversion professionnelle.' });
  const b = req.body || {}, exceptional = !!b.exceptional, reason = String(b.reason || '').trim().slice(0, 500), type = b.pro_type === 'entreprise' ? 'entreprise' : 'particulier';
  if (exceptional && !reason) return res.status(400).json({ error: 'Le motif de validation exceptionnelle est obligatoire.' });
  const existing = db.prepare('SELECT * FROM pro_profiles WHERE user_id=?').get(u.id);
  if (!existing) db.prepare(`INSERT INTO pro_profiles(user_id,profession,description,experience,zone,services,authorized_services,documents,pro_type,available,availability_status)
    VALUES(?,?,?,?,?,'[]','[]','[]',?,0,'indisponible')`).run(u.id, 'À compléter', '', '', u.ville || '', type);
  const next = exceptional ? 'approved' : 'pending';
  db.prepare("UPDATE users SET is_pro=1, pro_status=?, profile_incomplete=1, verified=CASE WHEN ? THEN verified ELSE 0 END WHERE id=?").run(next, exceptional ? 1 : 0, u.id);
  if (exceptional) {
    db.prepare("UPDATE pro_profiles SET pro_type=?, validated_at=datetime('now'), available=0, availability_status='indisponible' WHERE user_id=?").run(type, u.id);
    let kp = u.kp_code; if (!kp) { do { kp = 'KP' + String(Math.floor(100000 + Math.random() * 900000)); } while (db.prepare('SELECT 1 FROM users WHERE kp_code=?').get(kp)); db.prepare('UPDATE users SET kp_code=? WHERE id=?').run(kp, u.id); }
    notify(u.id, 'compte', 'Profil professionnel exceptionnellement validé', 'Votre profil professionnel est activé mais incomplet. Complétez vos informations et attendez l’activation de vos services par l’administration.', '#/pro');
  } else notify(u.id, 'compte', 'Conversion en professionnel en attente', 'Votre compte est maintenant en parcours professionnel. Complétez votre profil ; l’administration le validera.', '#/pro');
  logAction(req.user, exceptional ? 'Validation exceptionnelle d’un professionnel incomplet' : 'Conversion client vers parcours professionnel', { target_type:'users', target_id:u.id, target_name:u.name, reason, details:`type=${type}; état=${next}; données minimales conservées` });
  res.json({ ok:true, pro_status:next, profile_incomplete:true });
});

// Modification rapide du compte depuis la fiche
A.put('/users/:id', (req, res) => {
  const u = cibleUtilisateur(req, res); if (!u) return;
  const { name, phone, email, address, ville, quartier } = req.body || {};
  if (phone) {
    const p = phone.trim().replace(/\s+/g, '');
    if (!/^[+0-9]{8,20}$/.test(p)) return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
    const dup = db.prepare('SELECT id FROM users WHERE phone=? AND id!=?').get(p, u.id);
    if (dup) return res.status(409).json({ error: 'Ce numéro est déjà associé à un autre compte.' });
    db.prepare('UPDATE users SET phone=? WHERE id=?').run(p, u.id);
  }
  db.prepare(`UPDATE users SET name=COALESCE(?,name), email=COALESCE(?,email), address=COALESCE(?,address),
    ville=COALESCE(?,ville), quartier=COALESCE(?,quartier) WHERE id=?`)
    .run(name ?? null, email ?? null, address ?? null, ville ?? null, quartier ?? null, u.id);
  res.json({ ok: true });
});

A.post('/users/:id/suspend', (req, res) => {
  const u = cibleUtilisateur(req, res); if (!u) return;
  db.prepare('UPDATE users SET suspended=? WHERE id=?').run(req.body.suspended ? 1 : 0, u.id);
  if (req.body.suspended) revokeProfessionalOffers(u.id);
  if (!req.body.suspended) notify(u.id, 'compte', 'Compte réactivé', 'Votre compte a été réactivé par l\u2019administration.', '#/home');
  res.json({ ok: true });
});
A.post('/users/:id/block', (req, res) => {
  const u = cibleUtilisateur(req, res); if (!u) return;
  db.prepare('UPDATE users SET blocked=? WHERE id=?').run(req.body.blocked ? 1 : 0, u.id);
  if (req.body.blocked) revokeProfessionalOffers(u.id);
  if (!req.body.blocked) notify(u.id, 'compte', 'Compte débloqué', 'Votre compte a été débloqué par l\u2019administration.', '#/home');
  res.json({ ok: true });
});
A.post('/users/:id/disable-temp', (req, res) => {
  const u = cibleUtilisateur(req, res); if (!u) return;
  const { until } = req.body || {}; // date/heure ISO, ou null pour réactiver
  if (until && isNaN(Date.parse(until))) return res.status(400).json({ error: 'Date invalide.' });
  db.prepare('UPDATE users SET disabled_until=? WHERE id=?').run(until ? until.replace('T', ' ').slice(0, 19) : null, u.id);
  if (until) revokeProfessionalOffers(u.id);
  res.json({ ok: true });
});
// Réinitialiser l'accès : nouveau mot de passe temporaire (l'admin ne voit JAMAIS l'ancien mot de passe)
A.post('/users/:id/reset-access', (req, res) => {
  const u = cibleUtilisateur(req, res); if (!u) return;
  const temp = motDePasseTemporaire();
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET password_hash=?, salt=?, must_change_password=1 WHERE id=?').run(hashPassword(temp, salt), salt, u.id);
  notify(u.id, 'compte', '🔑 Accès réinitialisé', 'Votre accès a été réinitialisé par l\u2019administration. Connectez-vous avec le mot de passe temporaire qui vous a été communiqué, puis choisissez-en un nouveau.', '#/account');
  res.json({ ok: true, temp_password: temp });
});
A.post('/users/:id/force-password', (req, res) => {
  const u = cibleUtilisateur(req, res); if (!u) return;
  db.prepare('UPDATE users SET must_change_password=1 WHERE id=?').run(u.id);
  notify(u.id, 'compte', '🔒 Changement de mot de passe requis', 'Pour votre sécurité, vous devez choisir un nouveau mot de passe à votre prochaine connexion.', '#/account');
  res.json({ ok: true });
});
// Suppression définitive (permission spéciale accordée par le PDG)
A.delete('/users/:id', (req, res) => {
  if (!hasPerm(req.user, 'comptes_suppr')) return res.status(403).json({ error: 'La suppression définitive est réservée au PDG (ou à un compte autorisé par lui).' });
  const u = cibleUtilisateur(req, res); if (!u) return;
  const nb = db.prepare('SELECT COUNT(*) n FROM missions WHERE client_id=? OR pro_id=?').get(u.id, u.id).n;
  if (nb) return res.status(409).json({ error: `Ce compte est lié à ${nb} mission(s). Suspendez-le ou bloquez-le plutôt (l\u2019historique doit être conservé).` });
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  res.json({ ok: true });
});
A.post('/users/:id/verify', (req, res) => {
  db.prepare('UPDATE users SET verified=? WHERE id=?').run(req.body.verified ? 1 : 0, req.params.id);
  if (req.body.verified) notify(parseInt(req.params.id), 'compte', '✅ Compte vérifié', 'Votre compte a été vérifié par l\u2019administration.', '#/account');
  res.json({ ok: true });
});

// ============== ÉQUIPE & PERMISSIONS (réservé au PDG) ==============
A.get('/staff', (req, res) => {
  const rows = db.prepare("SELECT id, name, phone, email, role, perms, suspended, blocked, created_at FROM users WHERE role IN ('pdg','admin','gestionnaire','agent') ORDER BY CASE role WHEN 'pdg' THEN 0 WHEN 'admin' THEN 1 WHEN 'gestionnaire' THEN 2 ELSE 3 END, id").all();
  res.json({
    staff: rows.map(u => ({ ...u, perms_effectives: effectivePerms(u), perms: undefined })),
    perm_keys: PERM_KEYS, role_labels: ROLE_LABELS, defaults: DEFAULT_PERMS,
  });
});
A.post('/staff', (req, res) => {
  const { name, phone, email, role } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Veuillez indiquer le nom.' });
  if (!['admin', 'gestionnaire', 'agent'].includes(role)) return res.status(400).json({ error: 'Rôle invalide (administrateur, gestionnaire ou agent).' });
  if (!phone || !/^[+0-9 ]{3,20}$/.test(phone.trim())) return res.status(400).json({ error: 'Identifiant / téléphone invalide.' });
  const p = phone.trim().replace(/\s+/g, '');
  if (db.prepare('SELECT id FROM users WHERE phone=?').get(p)) return res.status(409).json({ error: 'Ce numéro est déjà associé à un compte.' });
  const temp = motDePasseTemporaire();
  const salt = crypto.randomBytes(16).toString('hex');
  const info = db.prepare(`INSERT INTO users(name, phone, email, password_hash, salt, role, must_change_password, created_by)
    VALUES(?,?,?,?,?,?,1,?)`).run(name.trim(), p, (email || '').trim() || null, hashPassword(temp, salt), salt, role, req.user.id);
  res.json({ id: info.lastInsertRowid, temp_password: temp });
});
A.put('/staff/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u || !STAFF_ROLES.includes(u.role)) return res.status(404).json({ error: 'Membre introuvable.' });
  if (u.role === 'pdg') return res.status(403).json({ error: 'Le compte PDG ne peut pas être modifié ici.' });
  const { role, perms, suspended, blocked, name } = req.body || {};
  if (role !== undefined) {
    if (!['admin', 'gestionnaire', 'agent', 'user'].includes(role)) return res.status(400).json({ error: 'Rôle invalide.' });
    db.prepare('UPDATE users SET role=?, perms=NULL WHERE id=?').run(role, u.id); // retour aux permissions par défaut du nouveau rôle
  }
  if (perms !== undefined) db.prepare('UPDATE users SET perms=? WHERE id=?').run(perms ? JSON.stringify(perms) : null, u.id);
  if (suspended !== undefined) db.prepare('UPDATE users SET suspended=? WHERE id=?').run(suspended ? 1 : 0, u.id);
  if (blocked !== undefined) db.prepare('UPDATE users SET blocked=? WHERE id=?').run(blocked ? 1 : 0, u.id);
  if (name !== undefined && name.trim()) db.prepare('UPDATE users SET name=? WHERE id=?').run(name.trim(), u.id);
  res.json({ ok: true });
});
A.post('/staff/:id/reset-access', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u || !STAFF_ROLES.includes(u.role)) return res.status(404).json({ error: 'Membre introuvable.' });
  if (u.role === 'pdg' && u.id !== req.user.id) return res.status(403).json({ error: 'Impossible.' });
  const temp = motDePasseTemporaire();
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET password_hash=?, salt=?, must_change_password=1 WHERE id=?').run(hashPassword(temp, salt), salt, u.id);
  res.json({ ok: true, temp_password: temp });
});
A.delete('/staff/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u || !STAFF_ROLES.includes(u.role)) return res.status(404).json({ error: 'Membre introuvable.' });
  if (u.role === 'pdg') return res.status(403).json({ error: 'Le compte PDG ne peut pas être supprimé.' });
  const nb = db.prepare('SELECT COUNT(*) n FROM missions WHERE client_id=? OR pro_id=?').get(u.id, u.id).n;
  if (nb) { db.prepare("UPDATE users SET role='user', perms=NULL WHERE id=?").run(u.id); return res.json({ ok: true, downgraded: true }); }
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  res.json({ ok: true });
});

// ============== MODE MAINTENANCE (réservé au PDG) ==============
A.get('/maintenance', (req, res) => {
  const m = getMaintenance();
  res.json({ config: m, scopes: MAINT_SCOPES, fonctions: MAINT_FONCTIONS, actif: !!(m.active && !m.expired) });
});
A.post('/maintenance', (req, res) => {
  const { active, scope, functions, until, message, reason } = req.body || {};
  if (!active) {
    setSetting('maintenance', JSON.stringify({ active: 0 }));
    return res.json({ ok: true });
  }
  if (!MAINT_SCOPES[scope]) return res.status(400).json({ error: 'Choisissez la portée de la maintenance (A à F).' });
  if (scope === 'E' && (!Array.isArray(functions) || !functions.length)) return res.status(400).json({ error: 'Cochez au moins une fonction à suspendre.' });
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Indiquez la justification (enregistrée dans le journal).' });
  if (until && isNaN(Date.parse(until))) return res.status(400).json({ error: 'Date de fin invalide.' });
  setSetting('maintenance', JSON.stringify({
    active: 1, scope, functions: scope === 'E' ? functions.filter(f => MAINT_FONCTIONS[f]) : undefined,
    until: until || null, message: (message || '').trim() || null, reason: reason.trim(),
    activated_at: new Date().toISOString().slice(0, 19).replace('T', ' '), activated_by: req.user.name,
  }));
  res.json({ ok: true });
});

// ============== GRANDE RECHERCHE ADMINISTRATEUR ==============
// Comptes, téléphone, e-mail, code KP, équipe, métiers, services, tâches, missions, paiements, journal…
A.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ q, groups: [] });
  const lq = q.toLowerCase();
  const like = '%' + q + '%';
  const num = /^\d+$/.test(q) ? parseInt(q, 10) : null;
  const groups = [];
  const add = (type, titre, items) => { if (items.length) groups.push({ type, titre, items }); };

  if (hasPerm(req.user, 'comptes')) {
    const users = db.prepare(`SELECT id, name, phone, email, kp_code, ville, quartier, pro_status, suspended, blocked FROM users
      WHERE role='user' AND (name LIKE ? OR phone LIKE ? OR email LIKE ? OR kp_code LIKE ? OR id=?)
      ORDER BY id DESC LIMIT 10`).all(like, like, like, like, num ?? -1);
    add('user', '👥 Comptes utilisateurs', users.map(u => ({
      id: u.id,
      label: u.name + (u.kp_code ? ' — ' + u.kp_code : ''),
      sub: u.phone + (u.email ? ' • ' + u.email : '') + (u.ville ? ' • ' + u.ville : '') +
        (u.pro_status === 'approved' ? ' • Professionnel' : '') + (u.blocked ? ' • 🚫 bloqué' : u.suspended ? ' • suspendu' : ''),
    })));
  }
  if (req.user.role === 'pdg') {
    const st = db.prepare(`SELECT id, name, phone, role FROM users WHERE role IN ('pdg','admin','gestionnaire','agent') AND (name LIKE ? OR phone LIKE ?) LIMIT 5`).all(like, like);
    add('staff', '👑 Équipe', st.map(u => ({ id: u.id, label: u.name, sub: u.phone + ' • ' + (ROLE_LABELS[u.role] || u.role) })));
  }
  if (hasPerm(req.user, 'catalogue')) {
    const mets = db.prepare('SELECT id, name, icon FROM service_categories WHERE name LIKE ? LIMIT 6').all(like);
    add('metier', '🗂️ Catégories de services', mets.map(c => ({ id: c.id, label: (c.icon || '') + ' ' + c.name, sub: 'Catégorie' })));
    const svcs = db.prepare(`SELECT s.id, s.name, s.active, c.name cat, c.icon FROM services s JOIN service_categories c ON c.id=s.category_id
      WHERE s.name LIKE ? OR s.keywords LIKE ? LIMIT 8`).all(like, like);
    add('service', '🛠 Services', svcs.map(s => ({ id: s.id, label: (s.icon || '') + ' ' + s.name, sub: s.cat + (s.active ? '' : ' • désactivé') })));
    const tas = db.prepare(`SELECT t.id, t.name, t.service_id, s.name svc FROM taches t JOIN services s ON s.id=t.service_id WHERE t.name LIKE ? LIMIT 8`).all(like);
    add('tache', '📝 Tâches', tas.map(t => ({ id: t.service_id, label: t.name, sub: 'Service : ' + t.svc })));
  }
  if (hasPerm(req.user, 'missions')) {
    const mis = db.prepare(`SELECT m.id, m.code, m.status, m.tache, s.name svc, uc.name client, up.name pro FROM missions m
      JOIN services s ON s.id=m.service_id JOIN users uc ON uc.id=m.client_id LEFT JOIN users up ON up.id=m.pro_id
      WHERE m.code LIKE ? OR m.id=? OR m.tache LIKE ? OR s.name LIKE ? OR uc.name LIKE ? OR up.name LIKE ?
      ORDER BY m.id DESC LIMIT 10`).all(like, num ?? -1, like, like, like, like);
    add('mission', '🧰 Demandes & missions', mis.map(m => ({
      id: m.id, label: m.code + ' — ' + m.svc + (m.tache ? ' (' + m.tache + ')' : ''),
      sub: 'Client : ' + m.client + (m.pro ? ' • Pro : ' + m.pro : '') + ' • ' + m.status,
    })));
  }
  if (hasPerm(req.user, 'paiements')) {
    const pays = db.prepare(`SELECT p.id, p.amount, p.commission_amount, p.status, p.mission_id, m.code FROM payments p JOIN missions m ON m.id=p.mission_id
      WHERE m.code LIKE ? OR p.mission_id=? OR p.amount=? ORDER BY p.id DESC LIMIT 8`).all(like, num ?? -1, num ?? -1);
    add('paiement', '💰 Paiements', pays.map(p => ({
      id: p.mission_id, label: p.amount.toLocaleString('fr-FR') + ' F — mission ' + p.code,
      sub: 'Commission : ' + (p.commission_amount || 0).toLocaleString('fr-FR') + ' F • ' + p.status,
    })));
  }
  if (hasPerm(req.user, 'journal')) {
    const logs = db.prepare(`SELECT id, admin_name, action, created_at FROM admin_log
      WHERE admin_name LIKE ? OR action LIKE ? OR details LIKE ? OR reason LIKE ? ORDER BY id DESC LIMIT 6`).all(like, like, like, like);
    add('journal', '🧾 Journal des actions', logs.map(l => ({ id: l.id, label: l.action, sub: l.admin_name + ' • ' + l.created_at })));
  }
  res.json({ q, groups });
});

// ============== JOURNAL DES ACTIONS ==============
A.get('/journal', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  let rows = db.prepare('SELECT * FROM admin_log ORDER BY id DESC LIMIT 1000').all();
  if (q) rows = rows.filter(l =>
    (l.admin_name || '').toLowerCase().includes(q) || (l.action || '').toLowerCase().includes(q) ||
    (l.target_name || '').toLowerCase().includes(q) || (l.details || '').toLowerCase().includes(q) ||
    (l.reason || '').toLowerCase().includes(q) || String(l.target_id) === q);
  res.json(rows.slice(0, 300));
});

// VALIDATION DES PROFESSIONNELS
A.get('/pros/pending', (req, res) => {
  const rows = db.prepare(`SELECT u.id, u.name, u.phone, u.address, u.created_at, p.* FROM users u JOIN pro_profiles p ON p.user_id=u.id WHERE u.pro_status='pending' ORDER BY u.id DESC`).all();
  res.json(rows.map(r => ({ ...r, services: JSON.parse(r.services), domain_categories: numberIds(r.domain_categories), documents: JSON.parse(r.documents) })));
});
A.put('/pros/:id/eligibility', (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=? AND pro_status='approved'").get(req.params.id);
  const profile = db.prepare('SELECT * FROM pro_profiles WHERE user_id=?').get(req.params.id);
  if (!u || !profile) return res.status(404).json({ error: 'Professionnel validé introuvable.' });
  const body = req.body || {};
  const hasDomains = Array.isArray(body.authorized_domain_categories);
  let authorizedDomains = hasDomains ? activeDomainIds(body.authorized_domain_categories) : effectiveDomains(profile);
  if (hasDomains && body.authorized_domain_categories.length && !authorizedDomains.length) return res.status(400).json({ error: 'Un ou plusieurs domaines sélectionnés sont invalides ou inactifs.' });
  let requested = Array.isArray(body.authorized_services) ? [...new Set(body.authorized_services.map(Number).filter(Number.isInteger))].slice(0, 200) : numberIds(profile.authorized_services || profile.services);
  // Les anciens comptes conservent le contrôle historique service par service. Pour un compte
  // par domaine, cette liste n'est plus un filtre de matching et n'empêche pas les nouvelles tâches.
  if (authorizedDomains === null) {
    const declared = numberIds(profile.services);
    if (requested.some(id => !declared.includes(id))) return res.status(400).json({ error: 'Un service autorisé doit d’abord être déclaré dans le profil du professionnel.' });
    const found = requested.length ? db.prepare(`SELECT COUNT(*) n FROM services WHERE active=1 AND id IN (${requested.map(() => '?').join(',')})`).get(...requested).n : 0;
    if (found !== requested.length) return res.status(400).json({ error: 'Un ou plusieurs services sélectionnés sont invalides ou inactifs.' });
  }
  const type = body.pro_type === 'entreprise' ? 'entreprise' : 'particulier';
  const capacity = Math.max(1, Math.min(3, parseInt(body.capacity_level, 10) || 1));
  let serviceCities = Array.isArray(body.service_cities) ? [...new Set(body.service_cities.map(v => String(v || '').trim()).filter(Boolean))].slice(0, 100) : [];
  if (serviceCities.includes('*')) serviceCities = ['*'];
  else {
    const activeCities = new Set(db.prepare('SELECT name FROM villes WHERE active=1').all().map(r => r.name));
    if (serviceCities.some(c => !activeCities.has(c))) return res.status(400).json({ error: 'Une ville d’intervention est inactive ou inconnue.' });
  }
  const oldCities = jsonArray(profile.service_cities);
  if ((serviceCities.length > 1 || serviceCities.includes('*')) && !['pdg','admin'].includes(req.user.role)) return res.status(403).json({ error: 'Seul un administrateur ou le PDG peut autoriser plusieurs villes ou toutes les villes.' });
  if (!serviceCities.length) serviceCities = oldCities.length ? oldCities : (profile.service_city ? [profile.service_city] : []);
  const defaultCity = serviceCities.includes('*') ? profile.service_city : (serviceCities.includes(profile.service_city) ? profile.service_city : serviceCities[0] || null);
  db.prepare('UPDATE pro_profiles SET authorized_services=?, authorized_domain_categories=?, pro_type=?, capacity_level=?, service_cities=?, service_city=? WHERE user_id=?')
    .run(JSON.stringify(requested), authorizedDomains === null ? profile.authorized_domain_categories : JSON.stringify(authorizedDomains), type, capacity, JSON.stringify(serviceCities), defaultCity, u.id);
  db.prepare("SELECT * FROM missions WHERE status='recherche' AND id IN (SELECT mission_id FROM mission_candidates WHERE pro_id=? AND status='offered')").all(u.id).forEach(revokeIneligibleOffers);
  notify(u.id, 'compte', 'Autorisation professionnelle mise à jour', 'La direction a actualisé vos domaines, autorisations et capacité de mission.', '#/pro');
  push(u.id, 'account', { pro_status: 'approved' });
  res.json({ ok: true, authorized_services: requested, authorized_domain_categories: authorizedDomains, pro_type: type, capacity_level: capacity, service_cities: serviceCities, service_city: defaultCity });
});
A.get('/pros/:id/domain-requests', (req,res) => {
  const rows=db.prepare(`SELECT r.*,u.name reviewer_name FROM pro_domain_change_requests r LEFT JOIN users u ON u.id=r.reviewed_by WHERE r.user_id=? ORDER BY r.id DESC LIMIT 100`).all(req.params.id)
    .map(r=>({...r,requested_domains:numberIds(r.requested_domains),previous_domains:numberIds(r.previous_domains)}));
  res.json(rows);
});
A.post('/pros/:id/domain-requests/:rid/review', (req,res) => {
  const u=db.prepare("SELECT * FROM users WHERE id=? AND pro_status='approved'").get(req.params.id);
  const profile=db.prepare('SELECT * FROM pro_profiles WHERE user_id=?').get(req.params.id);
  const request=db.prepare("SELECT * FROM pro_domain_change_requests WHERE id=? AND user_id=? AND status='en_attente'").get(req.params.rid,req.params.id);
  if(!u||!profile||!request)return res.status(404).json({error:'Demande de domaines introuvable.'});
  const decision=(req.body||{}).decision==='approuver'?'approuvee':(req.body||{}).decision==='refuser'?'refusee':null;
  if(!decision)return res.status(400).json({error:'Décision invalide.'});
  const note=String((req.body||{}).note||'').trim().slice(0,1000);
  const domains=numberIds(request.requested_domains);
  if(decision==='approuvee') {
    const valid=activeDomainIds(domains); if(valid.length!==domains.length)return res.status(400).json({error:'Un domaine demandé est devenu inactif ou introuvable.'});
    db.prepare('UPDATE pro_profiles SET domain_categories=?,authorized_domain_categories=? WHERE user_id=?').run(JSON.stringify(valid),JSON.stringify(valid),u.id);
    db.prepare("SELECT * FROM missions WHERE status='recherche' AND id IN (SELECT mission_id FROM mission_candidates WHERE pro_id=? AND status='offered')").all(u.id).forEach(revokeIneligibleOffers);
  }
  db.prepare("UPDATE pro_domain_change_requests SET status=?,note=?,reviewed_by=?,reviewed_at=datetime('now') WHERE id=?").run(decision,note||request.note||null,req.user.id,request.id);
  notify(u.id,'compte',decision==='approuvee'?'Domaines d’activité mis à jour':'Modification de domaines refusée',decision==='approuvee'?'La direction a approuvé vos nouveaux domaines d’activité.':(note||'La direction a refusé votre demande de modification.'),'#/pro');
  res.json({ok:true,status:decision});
});
A.post('/pros/:id/approve', (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=? AND pro_status='pending'").get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Demande introuvable.' });
  db.prepare("UPDATE users SET pro_status='approved', is_pro=1, verified=1 WHERE id=?").run(u.id);
  db.prepare("UPDATE pro_profiles SET validated_at=datetime('now'), authorized_domain_categories=CASE WHEN domain_categories IS NOT NULL AND domain_categories!='' AND domain_categories!='[]' THEN domain_categories ELSE authorized_domain_categories END WHERE user_id=?").run(u.id);
  // Attribution du code professionnel unique (KP######)
  let kp = db.prepare('SELECT kp_code FROM users WHERE id=?').get(u.id).kp_code;
  if (!kp) {
    do { kp = 'KP' + String(Math.floor(100000 + Math.random() * 900000)); }
    while (db.prepare('SELECT 1 FROM users WHERE kp_code=?').get(kp));
    db.prepare('UPDATE users SET kp_code=? WHERE id=?').run(kp, u.id);
  }
  notify(u.id, 'compte', '🎉 Vous êtes maintenant professionnel !', `Votre espace professionnel est actif. Votre code professionnel est ${kp}. Vous pouvez recevoir des missions. Votre compte reste aussi un compte client.`, '#/pro');
  push(u.id, 'account', { pro_status: 'approved' });
  res.json({ ok: true });
});
A.post('/pros/:id/reject', (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=? AND pro_status='pending'").get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Demande introuvable.' });
  db.prepare("UPDATE users SET pro_status='rejected' WHERE id=?").run(u.id);
  db.prepare('UPDATE pro_profiles SET rejected_reason=? WHERE user_id=?').run(req.body.reason || 'Dossier incomplet', u.id);
  notify(u.id, 'compte', 'Demande professionnelle refusée', (req.body.reason || 'Dossier incomplet') + '. Vous pouvez compléter votre dossier et renvoyer votre demande.', '#/pro');
  push(u.id, 'account', { pro_status: 'rejected' });
  res.json({ ok: true });
});

// SERVICES / CATÉGORIES / QUESTIONS
// Options de compte professionnel — gestion exclusivement PDG, sans jeu de démonstration imposé.
A.get('/pro-options', (req, res) => res.json(db.prepare('SELECT * FROM pro_account_options ORDER BY sort,id').all().map(parseOption)));
A.post('/pro-options', (req, res) => {
  const b = req.body || {}, key = String(b.opt_key || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 60);
  const name = String(b.name || '').trim().slice(0, 120);
  if (!key || !name) return res.status(400).json({ error: 'Clé technique et nom de l’option requis.' });
  if (!['tous','particulier','entreprise'].includes(b.pro_type || 'tous')) return res.status(400).json({ error: 'Cible professionnelle invalide.' });
  const cats = Array.isArray(b.categories) ? b.categories.map(Number).filter(Number.isInteger) : [];
  const info = db.prepare('INSERT INTO pro_account_options(opt_key,name,description,categories,pro_type,required,active,suspended,sort) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(key, name, String(b.description || '').trim().slice(0, 1000), JSON.stringify(cats), b.pro_type || 'tous', b.required ? 1 : 0, b.active === false ? 0 : 1, b.suspended ? 1 : 0, Number.isFinite(Number(b.sort)) ? Number(b.sort) : 0);
  res.status(201).json(parseOption(db.prepare('SELECT * FROM pro_account_options WHERE id=?').get(info.lastInsertRowid)));
});
A.put('/pro-options/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM pro_account_options WHERE id=?').get(req.params.id); if (!old) return res.status(404).json({ error: 'Option introuvable.' });
  const b = req.body || {}, key = b.opt_key === undefined ? old.opt_key : String(b.opt_key).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 60);
  const name = b.name === undefined ? old.name : String(b.name).trim().slice(0, 120);
  if (!key || !name || !['tous','particulier','entreprise'].includes(b.pro_type === undefined ? old.pro_type : b.pro_type)) return res.status(400).json({ error: 'Option invalide.' });
  const cats = b.categories === undefined ? old.categories : JSON.stringify(Array.isArray(b.categories) ? b.categories.map(Number).filter(Number.isInteger) : []);
  try { db.prepare('UPDATE pro_account_options SET opt_key=?,name=?,description=?,categories=?,pro_type=?,required=?,active=?,suspended=?,sort=?,updated_at=datetime(\'now\') WHERE id=?')
    .run(key, name, b.description === undefined ? old.description : String(b.description).trim().slice(0,1000), cats, b.pro_type === undefined ? old.pro_type : b.pro_type, b.required === undefined ? old.required : (b.required ? 1 : 0), b.active === undefined ? old.active : (b.active ? 1 : 0), b.suspended === undefined ? old.suspended : (b.suspended ? 1 : 0), b.sort === undefined ? old.sort : (Number(b.sort) || 0), old.id); }
  catch (e) { if (/UNIQUE/.test(e.message)) return res.status(409).json({ error: 'Cette clé technique existe déjà.' }); throw e; }
  res.json(parseOption(db.prepare('SELECT * FROM pro_account_options WHERE id=?').get(old.id)));
});
A.delete('/pro-options/:id', (req, res) => { const r = db.prepare('DELETE FROM pro_account_options WHERE id=?').run(req.params.id); if (!r.changes) return res.status(404).json({ error: 'Option introuvable.' }); res.json({ ok: true }); });

// Catalogue complet (catégories + sous-catégories + services + tâches)
A.get('/catalog', (req, res) => {
  const grand_categories = frenchSort(db.prepare('SELECT * FROM grand_categories ORDER BY sort,id').all());
  const cats = frenchSort(db.prepare('SELECT * FROM service_categories').all());
  const subs = frenchSort(db.prepare('SELECT * FROM sous_categories').all());
  const svcs = frenchSort(db.prepare('SELECT * FROM services').all()).map(({ price_from, price_prefix, price_show, price_updated_at, ...s }) => ({ ...s, cities: JSON.parse(s.cities || '[]') }));
  const tas = frenchSort(db.prepare('SELECT * FROM taches').all());
  const qs = db.prepare('SELECT * FROM service_questions ORDER BY sort,id').all().map(q => ({ ...q, options: JSON.parse(q.options) }));
  res.json({ grand_categories, categories: cats, sous_categories: subs, services: svcs, taches: tas, questions: qs });
});
// GRANDES CATÉGORIES : racine stable administrée exclusivement par le PDG.
A.get('/grand-categories', (req, res) => res.json(frenchSort(db.prepare('SELECT * FROM grand_categories ORDER BY sort,id').all())));
A.put('/grand-categories/populaires/ordre', pdgOnly, (req,res) => {
  const ids = Array.isArray((req.body||{}).ids) ? [...new Set(req.body.ids.map(Number).filter(Number.isInteger))] : null;
  if (!ids) return res.status(400).json({error:'Liste de catégories requise.'});
  const existing = ids.length ? db.prepare(`SELECT id FROM grand_categories WHERE id IN (${ids.map(()=>'?').join(',')})`).all(...ids).map(r=>r.id) : [];
  if (existing.length !== ids.length) return res.status(400).json({error:'Une catégorie est introuvable.'});
  db.transaction(() => { db.prepare('UPDATE grand_categories SET popular=0,popular_sort=NULL WHERE popular=1').run(); ids.forEach((id,index) => db.prepare("UPDATE grand_categories SET popular=1,popular_sort=?,updated_at=datetime('now') WHERE id=?").run(index+1,id)); })();
  res.json({ok:true});
});
A.post('/grand-categories', pdgOnly, (req, res) => {
  const b=req.body||{}, name=String(b.name||'').trim().slice(0,120);
  if (!name) return res.status(400).json({ error:'Nom de grande catégorie requis.' });
  try { const id=db.prepare('INSERT INTO grand_categories(name,description,icon,sort,popular) VALUES(?,?,?,?,?)').run(name,String(b.description||'').trim().slice(0,1000),String(b.icon||'🧩').trim().slice(0,16),Number(b.sort)||99,b.popular?1:0).lastInsertRowid;
    if (b.popular) { const max=db.prepare('SELECT COALESCE(MAX(popular_sort),0) n FROM grand_categories').get().n; db.prepare('UPDATE grand_categories SET popular_sort=? WHERE id=?').run(max+1,id); } res.status(201).json({id}); }
  catch { res.status(409).json({ error:'Cette grande catégorie existe déjà.' }); }
});
A.put('/grand-categories/:id', pdgOnly, (req,res) => {
  const old=db.prepare('SELECT * FROM grand_categories WHERE id=?').get(req.params.id); if(!old)return res.status(404).json({error:'Grande catégorie introuvable.'}); const b=req.body||{};
  const popular=b.popular===undefined?old.popular:(b.popular?1:0);
  db.prepare(`UPDATE grand_categories SET name=COALESCE(?,name),description=COALESCE(?,description),icon=COALESCE(?,icon),active=COALESCE(?,active),sort=COALESCE(?,sort),popular=?,popular_sort=CASE WHEN ?=0 THEN NULL WHEN popular_sort IS NULL THEN (SELECT COALESCE(MAX(popular_sort),0)+1 FROM grand_categories) ELSE popular_sort END,updated_at=datetime('now') WHERE id=?`)
    .run(b.name === undefined ? null : String(b.name).trim().slice(0,120),b.description === undefined ? null : String(b.description).trim().slice(0,1000),b.icon === undefined ? null : String(b.icon).trim().slice(0,16),b.active === undefined ? null : (b.active ? 1 : 0),b.sort ?? null,popular,popular,old.id);
  res.json({ok:true});
});
A.delete('/grand-categories/:id', pdgOnly, (req,res) => {
  const used=db.prepare('SELECT COUNT(*) n FROM service_categories WHERE grand_category_id=?').get(req.params.id).n;
  if (used) return res.status(400).json({error:`Cette catégorie contient ${used} sous-catégorie(s)/métier(s). Réaffectez-les ou désactivez-la plutôt.`});
  const r=db.prepare('DELETE FROM grand_categories WHERE id=?').run(req.params.id); if(!r.changes) return res.status(404).json({error:'Grande catégorie introuvable.'}); res.json({ok:true});
});
// Dictionnaire réel de la recherche intelligente, rattaché aux services/tâches centraux.
A.get('/search-terms', (req,res) => res.json(db.prepare(`SELECT st.*,s.name service_name,t.name task_name FROM service_search_terms st JOIN services s ON s.id=st.service_id LEFT JOIN taches t ON t.id=st.task_id ORDER BY st.updated_at DESC,st.id DESC LIMIT 1000`).all()));
A.post('/search-terms', pdgOnly, (req,res) => {
  const b=req.body||{}, serviceId=Number(b.service_id), taskId=b.task_id ? Number(b.task_id) : null, term=String(b.term||'').trim().slice(0,300), normalized=normalize(term);
  const service=db.prepare('SELECT id FROM services WHERE id=?').get(serviceId); if(!service || !normalized) return res.status(400).json({error:'Service et expression sont requis.'});
  if(taskId && !db.prepare('SELECT 1 FROM taches WHERE id=? AND service_id=?').get(taskId,serviceId)) return res.status(400).json({error:'La tâche doit appartenir au service choisi.'});
  try { const id=db.prepare("INSERT INTO service_search_terms(service_id,task_id,term,normalized,source) VALUES(?,?,?,?, 'direction')").run(serviceId,taskId,term,normalized).lastInsertRowid; res.status(201).json({id}); }
  catch { res.status(409).json({error:'Cette expression existe déjà pour cette cible.'}); }
});
A.put('/search-terms/:id', pdgOnly, (req,res) => { const b=req.body||{}; const old=db.prepare('SELECT * FROM service_search_terms WHERE id=?').get(req.params.id); if(!old) return res.status(404).json({error:'Expression introuvable.'}); const term=b.term===undefined?old.term:String(b.term).trim().slice(0,300); if(!term) return res.status(400).json({error:'Expression requise.'}); db.prepare("UPDATE service_search_terms SET term=?,normalized=?,active=COALESCE(?,active),updated_at=datetime('now') WHERE id=?").run(term,normalize(term),b.active ?? null,old.id);res.json({ok:true}); });
A.delete('/search-terms/:id', pdgOnly, (req,res) => { const r=db.prepare('DELETE FROM service_search_terms WHERE id=?').run(req.params.id); if(!r.changes)return res.status(404).json({error:'Expression introuvable.'});res.json({ok:true}); });

A.delete('/categories/:id', pdgOnly, (req, res) => {
  const n = db.prepare(`SELECT COUNT(*) n FROM missions m JOIN services s ON s.id=m.service_id WHERE s.category_id=?`).get(req.params.id).n;
  if (n) return res.status(400).json({ error: `Impossible de supprimer : ${n} mission(s) utilisent ce métier. Désactivez-le plutôt.` });
  db.prepare('DELETE FROM service_categories WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
// SOUS-CATÉGORIES
A.post('/sous-categories', (req, res) => {
  if (!req.body.name || !req.body.metier_id) return res.status(400).json({ error: 'Nom et métier requis.' });
  const info = db.prepare('INSERT INTO sous_categories(metier_id, name, sort) VALUES(?,?,?)').run(req.body.metier_id, req.body.name, req.body.sort ?? 99);
  res.json({ id: info.lastInsertRowid });
});
A.put('/sous-categories/:id', (req, res) => {
  db.prepare('UPDATE sous_categories SET name=COALESCE(?,name), metier_id=COALESCE(?,metier_id), active=COALESCE(?,active), sort=COALESCE(?,sort) WHERE id=?')
    .run(req.body.name || null, req.body.metier_id || null, req.body.active ?? null, req.body.sort ?? null, req.params.id);
  res.json({ ok: true });
});
A.delete('/sous-categories/:id', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) n FROM services WHERE sub_id=?').get(req.params.id).n;
  if (n) return res.status(400).json({ error: `Impossible : ${n} service(s) sont rattachés à cette sous-catégorie.` });
  db.prepare('DELETE FROM sous_categories WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
// TÂCHES : la tâche reste toujours rattachée à une prestation puis à sa catégorie racine.
A.post('/taches', pdgOnly, (req, res) => {
  const b=req.body||{}, service=db.prepare('SELECT id FROM services WHERE id=?').get(b.service_id);
  if (!b.name || !service) return res.status(400).json({ error: 'Nom et prestation requis.' });
  const info = db.prepare("INSERT INTO taches(service_id,name,description,sort,updated_at) VALUES(?,?,?,?,datetime('now'))").run(service.id,String(b.name).trim().slice(0,180),String(b.description||'').trim().slice(0,1000),b.sort ?? 99);
  res.status(201).json({ id: info.lastInsertRowid });
});
A.put('/taches/:id', pdgOnly, (req, res) => {
  const old=db.prepare('SELECT * FROM taches WHERE id=?').get(req.params.id); if(!old)return res.status(404).json({error:'Tâche introuvable.'}); const b=req.body||{};
  const serviceId=b.service_id===undefined?old.service_id:Number(b.service_id); if(!db.prepare('SELECT 1 FROM services WHERE id=?').get(serviceId))return res.status(400).json({error:'Prestation de destination invalide.'});
  db.prepare("UPDATE taches SET service_id=?,name=COALESCE(?,name),description=COALESCE(?,description),active=COALESCE(?,active),sort=COALESCE(?,sort),updated_at=datetime('now') WHERE id=?")
    .run(serviceId,b.name===undefined?null:String(b.name).trim().slice(0,180),b.description===undefined?null:String(b.description).trim().slice(0,1000),b.active === undefined ? null : (b.active ? 1 : 0),b.sort??null,old.id);
  res.json({ ok: true });
});
A.delete('/taches/:id', pdgOnly, (req, res) => { const old=db.prepare('SELECT * FROM taches WHERE id=?').get(req.params.id);if(!old)return res.status(404).json({error:'Tâche introuvable.'}); const n=db.prepare("SELECT COUNT(*) n FROM missions WHERE taches LIKE ? OR tache=?").get('%\"id\":'+old.id+'%',old.name).n; if(n)return res.status(409).json({error:`Cette tâche est liée à ${n} demande(s) historique(s). Désactivez-la plutôt.`}); db.prepare('DELETE FROM taches WHERE id=?').run(old.id);res.json({ ok: true }); });
A.get('/villes', (req, res) => res.json(frenchSort(db.prepare('SELECT * FROM villes').all())));
A.post('/villes', (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Nom requis.' });
  try { const info = db.prepare('INSERT INTO villes(name) VALUES(?)').run(req.body.name.trim()); res.json({ id: info.lastInsertRowid }); }
  catch { res.status(400).json({ error: 'Cette ville existe déjà.' }); }
});
A.put('/villes/:id', (req, res) => {
  db.prepare('UPDATE villes SET name=COALESCE(?,name), active=COALESCE(?,active) WHERE id=?')
    .run(req.body.name || null, req.body.active ?? null, req.params.id);
  res.json({ ok: true });
});
A.delete('/villes/:id', (req, res) => { db.prepare('DELETE FROM villes WHERE id=?').run(req.params.id); res.json({ ok: true }); });
// Communes : la même source centrale que les villes, sans liste parallèle client.
A.get('/communes', (req,res) => res.json(frenchSort(db.prepare('SELECT * FROM communes ORDER BY city_name,sort,id').all())));
A.post('/communes', (req,res) => { const city=activeCity((req.body||{}).city_name), name=String((req.body||{}).name||'').trim().slice(0,120); if(!city||!name)return res.status(400).json({error:'Ville centrale et nom de commune requis.'}); try { const id=db.prepare('INSERT INTO communes(city_name,name,sort) VALUES(?,?,?)').run(city.name,name,Number(req.body.sort)||99).lastInsertRowid;res.status(201).json({id}); }catch{return res.status(409).json({error:'Cette commune existe déjà pour cette ville.'});} });
A.put('/communes/:id', (req,res) => { const old=db.prepare('SELECT * FROM communes WHERE id=?').get(req.params.id);if(!old)return res.status(404).json({error:'Commune introuvable.'});const b=req.body||{}, city=b.city_name===undefined?old.city_name:activeCity(b.city_name)?.name,name=b.name===undefined?old.name:String(b.name).trim().slice(0,120);if(!city||!name)return res.status(400).json({error:'Ville ou commune invalide.'});try{db.prepare("UPDATE communes SET city_name=?,name=?,active=COALESCE(?,active),sort=COALESCE(?,sort),updated_at=datetime('now') WHERE id=?").run(city,name,b.active??null,b.sort??null,old.id);res.json({ok:true});}catch{return res.status(409).json({error:'Cette commune existe déjà pour cette ville.'});} });
A.post('/categories', pdgOnly, (req, res) => {
  const domainId = req.body.grand_category_id ? Number(req.body.grand_category_id) : null;
  if (domainId && !db.prepare('SELECT 1 FROM grand_categories WHERE id=?').get(domainId)) return res.status(400).json({ error: 'Grande catégorie invalide.' });
  const info = db.prepare('INSERT INTO service_categories(name, icon, sort, grand_category_id) VALUES(?,?,?,?)').run(req.body.name, req.body.icon || '🔹', req.body.sort || 99, domainId);
  res.json({ id: info.lastInsertRowid });
});
A.put('/categories/:id', pdgOnly, (req, res) => {
  const domainId = req.body.grand_category_id === undefined ? null : (req.body.grand_category_id ? Number(req.body.grand_category_id) : null);
  if (req.body.grand_category_id !== undefined && domainId && !db.prepare('SELECT 1 FROM grand_categories WHERE id=?').get(domainId)) return res.status(400).json({ error: 'Grande catégorie invalide.' });
  db.prepare('UPDATE service_categories SET name=COALESCE(?,name), icon=COALESCE(?,icon), active=COALESCE(?,active), sort=COALESCE(?,sort), grand_category_id=CASE WHEN ? THEN ? ELSE grand_category_id END WHERE id=?')
    .run(req.body.name || null, req.body.icon || null, req.body.active ?? null, req.body.sort ?? null, req.body.grand_category_id !== undefined ? 1 : 0, domainId, req.params.id);
  res.json({ ok: true });
});
A.post('/services', (req, res) => {
  if (!req.body.name || !req.body.category_id) return res.status(400).json({ error: 'Nom et catégorie requis.' });
  const info = db.prepare('INSERT INTO services(category_id, sub_id, name, keywords, sort) VALUES(?,?,?,?,?)')
    .run(req.body.category_id, req.body.sub_id || null, req.body.name, req.body.keywords || '', req.body.sort || 99);
  res.json({ id: info.lastInsertRowid });
});
A.put('/services/:id', (req, res) => {
  db.prepare(`UPDATE services SET name=COALESCE(?,name), keywords=COALESCE(?,keywords), active=COALESCE(?,active), sort=COALESCE(?,sort),
    category_id=COALESCE(?,category_id), sub_id=COALESCE(?,sub_id), popular=COALESCE(?,popular), seasonal=COALESCE(?,seasonal), cities=COALESCE(?,cities) WHERE id=?`)
    .run(req.body.name || null, req.body.keywords ?? null, req.body.active ?? null, req.body.sort ?? null,
      req.body.category_id || null, req.body.sub_id || null, req.body.popular ?? null, req.body.seasonal ?? null,
      req.body.cities !== undefined ? JSON.stringify(req.body.cities) : null, req.params.id);
  // Cohérence de l'ordre des populaires : ajout → en fin de liste ; retrait → ordre effacé
  if (req.body.popular === 1) {
    const s = db.prepare('SELECT popular_sort FROM services WHERE id=?').get(req.params.id);
    if (s && s.popular_sort == null) {
      const max = db.prepare('SELECT COALESCE(MAX(popular_sort),0) m FROM services WHERE popular=1').get().m;
      db.prepare('UPDATE services SET popular_sort=? WHERE id=?').run(max + 1, req.params.id);
    }
  } else if (req.body.popular === 0) {
    db.prepare('UPDATE services SET popular_sort=NULL WHERE id=?').run(req.params.id);
  }
  res.json({ ok: true });
});
// Ordre des services populaires (affichage de l'accueil) — liste complète d'ids dans l'ordre voulu
A.put('/services-populaires/ordre', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : null;
  if (!ids) return res.status(400).json({ error: 'Liste d\u2019ids requise.' });
  const tx = db.transaction(() => {
    db.prepare('UPDATE services SET popular=0, popular_sort=NULL WHERE popular=1').run();
    ids.forEach((id, i) => db.prepare('UPDATE services SET popular=1, popular_sort=? WHERE id=?').run(i + 1, id));
  });
  tx();
  res.json({ ok: true });
});
A.delete('/services/:id', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) n FROM missions WHERE service_id=?').get(req.params.id).n;
  if (n) return res.status(400).json({ error: `Impossible de supprimer : ${n} mission(s) utilisent ce service. Désactivez-le plutôt.` });
  db.prepare('DELETE FROM services WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
A.post('/questions', (req, res) => {
  const { service_id, label, type, options, required, sort } = req.body || {};
  if (!service_id || !label) return res.status(400).json({ error: 'Service et libellé requis.' });
  const info = db.prepare('INSERT INTO service_questions(service_id, label, type, options, required, sort) VALUES(?,?,?,?,?,?)')
    .run(service_id, label, type || 'text', JSON.stringify(options || []), required ? 1 : 0, sort ?? 99);
  res.json({ id: info.lastInsertRowid });
});
A.put('/questions/:id', (req, res) => {
  const { label, type, options, required, active, sort } = req.body || {};
  db.prepare('UPDATE service_questions SET label=COALESCE(?,label), type=COALESCE(?,type), options=COALESCE(?,options), required=COALESCE(?,required), active=COALESCE(?,active), sort=COALESCE(?,sort) WHERE id=?')
    .run(label || null, type || null, options ? JSON.stringify(options) : null, required ?? null, active ?? null, sort ?? null, req.params.id);
  res.json({ ok: true });
});
A.delete('/questions/:id', (req, res) => { db.prepare('DELETE FROM service_questions WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// TARIFS ET ESTIMATIONS INTELLIGENTES — réglages exclusivement PDG.
function optionalRef(value) { const n=Number(value); return Number.isInteger(n) && n>0 ? n : null; }
function cleanEstimationRule(body, previous) {
  const b=body||{};
  const get=(key, fallback=null) => b[key] === undefined ? fallback : b[key];
  const out={
    grand_category_id: optionalRef(get('grand_category_id', previous && previous.grand_category_id)),
    category_id: optionalRef(get('category_id', previous && previous.category_id)),
    sub_id: optionalRef(get('sub_id', previous && previous.sub_id)),
    service_id: optionalRef(get('service_id', previous && previous.service_id)),
    task_id: optionalRef(get('task_id', previous && previous.task_id)),
    city: String(get('city', previous && previous.city) || '').trim().slice(0,120) || null,
    zone: String(get('zone', previous && previous.zone) || '').trim().slice(0,180) || null,
    base_price: get('base_price', previous && previous.base_price), min_price: get('min_price', previous && previous.min_price), max_price: get('max_price', previous && previous.max_price),
    factors: get('factors', previous && previous.factors), source_type: get('source_type', previous && previous.source_type) || 'pdg',
    source_note: String(get('source_note', previous && previous.source_note) || '').trim().slice(0,1500) || null,
    source_url: String(get('source_url', previous && previous.source_url) || '').trim().slice(0,500) || null,
    source_date: String(get('source_date', previous && previous.source_date) || '').trim().slice(0,10) || null,
    verified_at: String(get('verified_at', previous && previous.verified_at) || '').trim().slice(0,10) || null,
    active: get('active', previous && previous.active) === undefined ? 1 : (get('active', previous && previous.active) ? 1 : 0),
    priority: Math.max(-1000,Math.min(1000,parseInt(get('priority', previous && previous.priority),10)||0))
  };
  ['base_price','min_price','max_price'].forEach(k=>{ const n=parseInt(out[k],10); out[k]=Number.isFinite(n) && n>0 ? Math.min(n,100000000) : null; });
  if(!out.base_price && !out.min_price && !out.max_price) throw new Error('PRICE');
  if(out.min_price && out.max_price && out.min_price>out.max_price) throw new Error('RANGE');
  if(!out.grand_category_id && !out.category_id && !out.sub_id && !out.service_id && !out.task_id) throw new Error('TARGET');
  if(!['pdg','local_verifie'].includes(out.source_type)) throw new Error('SOURCE');
  let f=out.factors;
  if(typeof f==='string') { try { f=JSON.parse(f||'{}'); } catch { throw new Error('FACTORS'); } }
  if(!f || typeof f!=='object' || Array.isArray(f)) throw new Error('FACTORS');
  out.factors=JSON.stringify(parsedRuleFactors(f));
  if(out.city) { const cities=out.city.split(',').map(x=>x.trim()).filter(Boolean); if(!cities.length || cities.some(city=>!activeCity(city))) throw new Error('CITY'); out.city=cities.join(', '); }
  if(out.zone && (!out.city || !out.city.split(',').some(city => normalize(city)==='abidjan') || !activeCommune('Abidjan',out.zone))) throw new Error('ZONE');
  if(!out.source_note || !out.verified_at) throw new Error('VERIFY');
  if(out.grand_category_id && !db.prepare('SELECT 1 FROM grand_categories WHERE id=?').get(out.grand_category_id)) throw new Error('DOMAIN');
  const category=out.category_id && db.prepare('SELECT * FROM service_categories WHERE id=?').get(out.category_id);
  if(out.category_id && !category) throw new Error('CATEGORY');
  if(category && out.grand_category_id && Number(category.grand_category_id)!==Number(out.grand_category_id)) throw new Error('HIERARCHY');
  const sub=out.sub_id && db.prepare('SELECT * FROM sous_categories WHERE id=?').get(out.sub_id);
  if(out.sub_id && !sub) throw new Error('SUB');
  if(sub && out.category_id && Number(sub.metier_id)!==Number(out.category_id)) throw new Error('HIERARCHY');
  const svc=out.service_id && db.prepare('SELECT * FROM services WHERE id=?').get(out.service_id);
  if(out.service_id && !svc) throw new Error('SERVICE');
  if(svc && out.category_id && Number(svc.category_id)!==Number(out.category_id)) throw new Error('HIERARCHY');
  if(svc && out.sub_id && Number(svc.sub_id)!==Number(out.sub_id)) throw new Error('HIERARCHY');
  const task=out.task_id && db.prepare('SELECT * FROM taches WHERE id=?').get(out.task_id);
  if(out.task_id && (!task || (out.service_id && task.service_id!==out.service_id))) throw new Error('TASK');
  if(out.source_type==='local_verifie' && !out.source_note) throw new Error('NOTE');
  return out;
}
function ruleError(e) { return ({ PRICE:'Indiquez un prix de départ ou une fourchette.', RANGE:'La fourchette minimale ne peut pas dépasser le maximum.', TARGET:'Choisissez au moins une cible tarifaire.', SOURCE:'Source tarifaire invalide.', FACTORS:'Les facteurs doivent être un objet JSON valide.', CITY:'La ville tarifaire doit être active dans le catalogue.', DOMAIN:'Grande catégorie invalide.', CATEGORY:'Métier invalide.', SUB:'Sous-catégorie invalide.', SERVICE:'Prestation invalide.', TASK:'Tâche invalide pour cette prestation.', HIERARCHY:'Les niveaux choisis ne correspondent pas à la même branche du catalogue.', NOTE:'Décrivez la source locale vérifiée.', ZONE:'La commune doit être une commune active d’Abidjan et la règle doit inclure Abidjan.', VERIFY:'Indiquez la provenance vérifiable et la date de vérification.' })[e.message] || 'Règle tarifaire invalide.'; }
A.get('/estimation-rules', pdgOnly, (req,res) => res.json(db.prepare(`SELECT r.*,gc.name grand_category_name,c.name category_name,sc.name sub_name,s.name service_name,t.name task_name
  FROM price_estimation_rules r LEFT JOIN grand_categories gc ON gc.id=r.grand_category_id LEFT JOIN service_categories c ON c.id=r.category_id
  LEFT JOIN sous_categories sc ON sc.id=r.sub_id LEFT JOIN services s ON s.id=r.service_id LEFT JOIN taches t ON t.id=r.task_id
  ORDER BY r.active DESC, CASE r.source_type WHEN 'pdg' THEN 1 ELSE 0 END DESC,r.priority DESC,r.updated_at DESC,r.id DESC`).all()));
function priceRuleHistory(id, action, snapshot, user) { db.prepare('INSERT INTO price_estimation_rule_history(rule_id,action,snapshot,changed_by) VALUES(?,?,?,?)').run(id,action,JSON.stringify(snapshot||{}),user.id); }
A.post('/estimation-rules', pdgOnly, (req,res) => {
  let r;try{r=cleanEstimationRule(req.body);}catch(e){return res.status(400).json({error:ruleError(e)});}
  const id=db.prepare(`INSERT INTO price_estimation_rules(grand_category_id,category_id,sub_id,service_id,task_id,city,zone,base_price,min_price,max_price,factors,source_type,source_note,source_url,source_date,verified_at,active,priority)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(r.grand_category_id,r.category_id,r.sub_id,r.service_id,r.task_id,r.city,r.zone,r.base_price,r.min_price,r.max_price,r.factors,r.source_type,r.source_note,r.source_url,r.source_date,r.verified_at,r.active,r.priority).lastInsertRowid;
  priceRuleHistory(id,'creation',r,req.user); res.status(201).json({id});
});
A.put('/estimation-rules/:id', pdgOnly, (req,res) => {
  const old=db.prepare('SELECT * FROM price_estimation_rules WHERE id=?').get(req.params.id);if(!old)return res.status(404).json({error:'Règle introuvable.'});let r;try{r=cleanEstimationRule(req.body,old);}catch(e){return res.status(400).json({error:ruleError(e)});}
  db.prepare(`UPDATE price_estimation_rules SET grand_category_id=?,category_id=?,sub_id=?,service_id=?,task_id=?,city=?,zone=?,base_price=?,min_price=?,max_price=?,factors=?,source_type=?,source_note=?,source_url=?,source_date=?,verified_at=?,active=?,priority=?,updated_at=datetime('now') WHERE id=?`)
    .run(r.grand_category_id,r.category_id,r.sub_id,r.service_id,r.task_id,r.city,r.zone,r.base_price,r.min_price,r.max_price,r.factors,r.source_type,r.source_note,r.source_url,r.source_date,r.verified_at,r.active,r.priority,old.id); priceRuleHistory(old.id,r.active?'modification':'désactivation',{before:old,after:r},req.user);res.json({ok:true});
});
A.get('/estimation-rules/:id/history', pdgOnly, (req,res)=>res.json(db.prepare('SELECT h.*,u.name changed_by_name FROM price_estimation_rule_history h LEFT JOIN users u ON u.id=h.changed_by WHERE h.rule_id=? ORDER BY h.id DESC').all(req.params.id)));
A.delete('/estimation-rules/:id', pdgOnly, (req,res)=>{const old=db.prepare('SELECT * FROM price_estimation_rules WHERE id=?').get(req.params.id);if(!old)return res.status(404).json({error:'Règle introuvable.'});db.prepare("UPDATE price_estimation_rules SET active=0,updated_at=datetime('now') WHERE id=?").run(old.id);priceRuleHistory(old.id,'désactivation',old,req.user);res.json({ok:true});});
A.get('/estimation-config', pdgOnly, (req,res)=>res.json({geo_enabled:getSetting('price_estimation_geo_enabled','1')==='1',fallback:'confirmer',history_min_samples:settingInt('price_estimation_history_min_samples',3,3,100)}));
A.put('/estimation-config', pdgOnly, (req,res)=>{const b=req.body||{};if(b.geo_enabled!==undefined)setSetting('price_estimation_geo_enabled',b.geo_enabled?'1':'0');setSetting('price_estimation_fallback','confirmer');if(b.history_min_samples!==undefined)setSetting('price_estimation_history_min_samples',String(Math.max(3,Math.min(100,parseInt(b.history_min_samples,10)||3))));res.json({ok:true});});
A.get('/estimation-test', pdgOnly, (req,res)=>res.json(estimatePrice({serviceId:req.query.service_id,taskId:req.query.task_id,city:req.query.city,zone:req.query.zone,details:req.query.details||'Prévisualisation de règle tarifaire'})));

function safeEmergencyContact(body, old = {}) {
  const b = body || {}, group = b.group_key ?? old.group_key, service = String(b.service_name ?? old.service_name ?? '').trim().slice(0,120), phone = String(b.phone ?? old.phone ?? '').trim().slice(0,60);
  const sourceName = String(b.source_name ?? old.source_name ?? '').trim().slice(0,240), sourceUrl = String(b.source_url ?? old.source_url ?? '').trim().slice(0,1000);
  if (!['vital','public_assistance'].includes(group)) throw new Error('GROUP');
  if (!service || !phone || !sourceName || !/^https:\/\//i.test(sourceUrl)) throw new Error('FIELDS');
  return { group_key:group, service_name:service, phone, label:String(b.label ?? old.label ?? '').trim().slice(0,240), source_name:sourceName, source_url:sourceUrl,
    source_date:String(b.source_date ?? old.source_date ?? '').trim().slice(0,32) || null, verified_at:String(b.verified_at ?? old.verified_at ?? '').trim().slice(0,32) || new Date().toISOString().slice(0,10),
    active:b.active === undefined ? (old.active ?? 1) : (b.active ? 1 : 0), sort:Math.max(0, Math.min(9999, Number(b.sort ?? old.sort ?? 99) || 99)) };
}
function emergencyContactHistory(id, action, snapshot, user) {
  db.prepare('INSERT INTO emergency_contact_history(contact_id,action,previous_data,changed_by) VALUES(?,?,?,?)').run(id, action, JSON.stringify(snapshot || {}), user && user.id || null);
}
A.get('/emergency-contacts', pdgOnly, (req,res) => res.json(db.prepare(`SELECT c.*,u.name changed_by_name FROM emergency_contacts c
  LEFT JOIN emergency_contact_history h ON h.id=(SELECT id FROM emergency_contact_history WHERE contact_id=c.id ORDER BY id DESC LIMIT 1)
  LEFT JOIN users u ON u.id=h.changed_by ORDER BY CASE c.group_key WHEN 'vital' THEN 0 ELSE 1 END,c.sort,c.id`).all()));
A.get('/emergency-contacts/:id/history', pdgOnly, (req,res) => res.json(db.prepare(`SELECT h.*,u.name changed_by_name FROM emergency_contact_history h LEFT JOIN users u ON u.id=h.changed_by WHERE h.contact_id=? ORDER BY h.id DESC`).all(req.params.id)));
A.post('/emergency-contacts', pdgOnly, (req,res) => { let c; try { c=safeEmergencyContact(req.body); } catch(e) { return res.status(400).json({error:'Renseignez un groupe, le service, le numéro, la source institutionnelle HTTPS et la date de vérification.'}); }
  const id=db.prepare(`INSERT INTO emergency_contacts(group_key,service_name,phone,label,source_name,source_url,source_date,verified_at,active,sort) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(c.group_key,c.service_name,c.phone,c.label,c.source_name,c.source_url,c.source_date,c.verified_at,c.active,c.sort).lastInsertRowid;
  emergencyContactHistory(id,'creation',c,req.user); res.status(201).json({id}); });
A.put('/emergency-contacts/:id', pdgOnly, (req,res) => { const old=db.prepare('SELECT * FROM emergency_contacts WHERE id=?').get(req.params.id); if(!old)return res.status(404).json({error:'Contact introuvable.'}); let c; try { c=safeEmergencyContact(req.body,old); } catch(e) { return res.status(400).json({error:'Renseignez un groupe, le service, le numéro, la source institutionnelle HTTPS et la date de vérification.'}); }
  db.prepare(`UPDATE emergency_contacts SET group_key=?,service_name=?,phone=?,label=?,source_name=?,source_url=?,source_date=?,verified_at=?,active=?,sort=?,updated_at=datetime('now') WHERE id=?`).run(c.group_key,c.service_name,c.phone,c.label,c.source_name,c.source_url,c.source_date,c.verified_at,c.active,c.sort,old.id);
  emergencyContactHistory(old.id,c.active ? 'modification' : 'désactivation',{before:old,after:c},req.user); res.json({ok:true}); });


// MISSIONS
A.get('/missions', (req, res) => {
  const f = req.query.filter || 'all';
  let where = '1=1';
  if (f === 'demandes') where = "m.status IN ('recherche','sans_pro')";
  if (f === 'attente') where = "m.status IN ('acceptee','confirmee')";
  if (f === 'en_cours') where = "m.status='en_cours'";
  if (f === 'terminees') where = "m.status IN ('terminee','payee')";
  if (f === 'litiges') where = "m.status='litige'";
  const rows = db.prepare(`SELECT m.*, s.name service_name, uc.name client_name, up.name pro_name
    FROM missions m JOIN services s ON s.id=m.service_id JOIN users uc ON uc.id=m.client_id
    LEFT JOIN users up ON up.id=m.pro_id WHERE ${where} ORDER BY m.updated_at DESC LIMIT 300`).all();
  res.json(rows);
});
A.post('/missions/:id/conversation-lock', (req, res) => {
  const m = db.prepare('SELECT * FROM missions WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Mission introuvable.' });
  const locked = !!(req.body || {}).locked;
  const reason = String((req.body || {}).reason || '').trim().slice(0, 300);
  if (locked) db.prepare("UPDATE missions SET conversation_locked_at=datetime('now'), conversation_lock_reason=? WHERE id=?").run(reason || 'Échanges suspendus par l’administration', m.id);
  else db.prepare('UPDATE missions SET conversation_locked_at=NULL, conversation_lock_reason=NULL WHERE id=?').run(m.id);
  [m.client_id, m.pro_id].filter(Boolean).forEach(uid => notify(uid, 'mission', locked ? '🔒 Échanges suspendus' : '🔓 Échanges rétablis', locked ? (reason || 'L’administration a temporairement suspendu les échanges liés à cette mission.') : 'L’administration a rétabli les échanges liés à cette mission.', '#/mission/' + m.id));
  res.json({ ok: true, locked });
});
A.post('/missions/:id/litige', (req, res) => {
  const m = db.prepare('SELECT * FROM missions WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Mission introuvable.' });
  const to = req.body.open ? 'litige' : (db.prepare('SELECT 1 FROM payments WHERE mission_id=? AND status=\'valide\'').get(m.id) ? 'payee' : 'terminee');
  db.prepare('UPDATE missions SET status=? WHERE id=?').run(to, m.id);
  addEvent(m.id, to, req.user.id, req.body.open ? 'Litige ouvert par l\u2019administration' : 'Litige résolu par l\u2019administration');
  [m.client_id, m.pro_id].filter(Boolean).forEach(uid =>
    notify(uid, 'mission', req.body.open ? '⚠️ Litige ouvert' : 'Litige résolu', 'L\u2019administration ' + (req.body.open ? 'a ouvert un litige sur votre mission.' : 'a résolu le litige.'), '#/mission/' + m.id));
  res.json({ ok: true });
});

// PAIEMENTS
A.get('/payments', (req, res) => {
  const rows = db.prepare(`SELECT p.*, m.code, uc.name client_name, up.name pro_name FROM payments p
    JOIN missions m ON m.id=p.mission_id JOIN users uc ON uc.id=m.client_id LEFT JOIN users up ON up.id=m.pro_id
    ORDER BY p.id DESC LIMIT 300`).all();
  res.json(rows);
});

/* =============== COMMERCE : règles de commission =============== */
A.get('/commissions', (req, res) => {
  const rules = db.prepare(`SELECT r.*, c.name category_name FROM commission_rules r
    LEFT JOIN service_categories c ON c.id=r.category_id ORDER BY r.priority DESC, r.id`).all();
  res.json({ enabled: getSetting('commission_enabled', '1') === '1', rate: parseFloat(getSetting('commission_rate', '25')), rules });
});
A.post('/commissions', (req, res) => {
  const b = req.body || {};
  const rate = parseFloat(b.rate);
  if (isNaN(rate) || rate < 0 || rate > 100) return res.status(400).json({ error: 'Taux invalide (0 à 100 %).' });
  const info = db.prepare(`INSERT INTO commission_rules(label, pro_type, category_id, ville, rate, priority, date_debut, date_fin)
    VALUES(?,?,?,?,?,?,?,?)`)
    .run((b.label || '').trim(), ['particulier', 'entreprise'].includes(b.pro_type) ? b.pro_type : null,
         parseInt(b.category_id, 10) || null, (b.ville || '').trim() || null, rate, parseInt(b.priority, 10) || 0,
         (b.date_debut || '').trim() || null, (b.date_fin || '').trim() || null);
  res.json({ ok: true, id: info.lastInsertRowid });
});
A.put('/commissions/:id', (req, res) => {
  const b = req.body || {};
  if (b.rate !== undefined) { const r = parseFloat(b.rate); if (isNaN(r) || r < 0 || r > 100) return res.status(400).json({ error: 'Taux invalide (0 à 100 %).' }); }
  db.prepare(`UPDATE commission_rules SET label=COALESCE(?,label), rate=COALESCE(?,rate), priority=COALESCE(?,priority), active=COALESCE(?,active) WHERE id=?`)
    .run(b.label ?? null, b.rate ?? null, b.priority ?? null, b.active ?? null, req.params.id);
  res.json({ ok: true });
});
A.delete('/commissions/:id', (req, res) => { db.prepare('DELETE FROM commission_rules WHERE id=?').run(req.params.id); res.json({ ok: true }); });

/* =============== COMMERCE : formules de visibilité =============== */
A.get('/visibilite/plans', (req, res) => res.json(db.prepare('SELECT * FROM visibility_plans ORDER BY price').all()));
A.post('/visibilite/plans', (req, res) => {
  const b = req.body || {};
  if (!(b.name || '').trim()) return res.status(400).json({ error: 'Donnez un nom à la formule.' });
  const price = parseInt(b.price, 10);
  if (isNaN(price) || price < 0) return res.status(400).json({ error: 'Prix invalide.' });
  const info = db.prepare(`INSERT INTO visibility_plans(name, price, duration_days, level, avantages, cible) VALUES(?,?,?,?,?,?)`)
    .run(b.name.trim(), price, Math.max(1, parseInt(b.duration_days, 10) || 30), Math.max(1, Math.min(3, parseInt(b.level, 10) || 1)),
         (b.avantages || '').trim(), ['particulier', 'entreprise'].includes(b.cible) ? b.cible : 'tous');
  res.json({ ok: true, id: info.lastInsertRowid });
});
A.put('/visibilite/plans/:id', (req, res) => {
  const b = req.body || {};
  db.prepare(`UPDATE visibility_plans SET name=COALESCE(?,name), price=COALESCE(?,price), duration_days=COALESCE(?,duration_days),
    level=COALESCE(?,level), avantages=COALESCE(?,avantages), cible=COALESCE(?,cible), active=COALESCE(?,active) WHERE id=?`)
    .run(b.name ?? null, b.price ?? null, b.duration_days ?? null, b.level ?? null, b.avantages ?? null, b.cible ?? null, b.active ?? null, req.params.id);
  res.json({ ok: true });
});
A.delete('/visibilite/plans/:id', (req, res) => { db.prepare('DELETE FROM visibility_plans WHERE id=?').run(req.params.id); res.json({ ok: true }); }); // les abonnements déjà vendus sont conservés (nom/prix copiés)
A.get('/visibilite/subs', (req, res) => {
  visibiliteTick();
  res.json(db.prepare(`SELECT vs.*, u.name user_name, u.phone FROM visibility_subs vs JOIN users u ON u.id=vs.user_id ORDER BY vs.id DESC LIMIT 300`).all());
});

/* =============== COMMERCE : campagnes publicitaires =============== */
A.get('/pub/campagnes', (req, res) => {
  pubTick();
  res.json(db.prepare(`SELECT c.*, u.name user_name, u.phone FROM ad_campaigns c JOIN users u ON u.id=c.user_id ORDER BY
    CASE c.status WHEN 'active' THEN 0 WHEN 'attente_validation' THEN 1 WHEN 'validee' THEN 2 WHEN 'attente_paiement' THEN 3 ELSE 4 END, c.id DESC LIMIT 500`).all());
});
A.put('/pub/campagnes/:id', (req, res) => {
  const b = req.body || {};
  if (b.priorite !== undefined && !['standard', 'prioritaire', 'premium'].includes(b.priorite)) return res.status(400).json({ error: 'Priorité invalide.' });
  db.prepare(`UPDATE ad_campaigns SET title=COALESCE(?,title), content=COALESCE(?,content), duration_days=COALESCE(?,duration_days),
    placement=COALESCE(?,placement), priorite=COALESCE(?,priorite), zone=COALESCE(?,zone) WHERE id=?`)
    .run(b.title ?? null, b.content ?? null, b.duration_days ?? null, b.placement ?? null, b.priorite ?? null, b.zone ?? null, req.params.id);
  res.json({ ok: true });
});
A.post('/pub/campagnes/:id/action', (req, res) => {
  const c = db.prepare('SELECT * FROM ad_campaigns WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campagne introuvable.' });
  const { action, note } = req.body || {};
  const set = (st, extra = '') => db.prepare(`UPDATE ad_campaigns SET status=?, note_admin=COALESCE(?, note_admin) ${extra} WHERE id=?`).run(st, note || null, c.id);
  const trx = db.prepare(`SELECT * FROM transactions WHERE kind='publicite' AND ref_id=? ORDER BY id DESC LIMIT 1`).get(c.id);
  if (action === 'paiement') {
    if (c.status !== 'attente_paiement') return res.status(409).json({ error: 'Cette campagne n\u2019attend pas de paiement.' });
    set('attente_validation');
    if (trx && trx.status === 'en_attente') db.prepare(`UPDATE transactions SET status='confirme', confirmed_at=datetime('now') WHERE id=?`).run(trx.id);
    notify(c.user_id, 'information', '📣 Paiement confirmé', `Le paiement de « ${c.title} » est confirmé. Votre campagne est en cours de validation.`, '#/pub');
  } else if (action === 'valider') {
    if (!['attente_validation', 'paiement_confirme'].includes(c.status)) return res.status(409).json({ error: 'La campagne doit d\u2019abord être payée.' });
    const actives = db.prepare(`SELECT COUNT(*) n FROM ad_campaigns WHERE status='active'`).get().n;
    if (actives < pubSlotsMax()) {
      db.prepare(`UPDATE ad_campaigns SET status='active', start_at=datetime('now'), end_at=datetime('now', '+' || duration_days || ' days'), note_admin=COALESCE(?, note_admin) WHERE id=?`).run(note || null, c.id);
      notify(c.user_id, 'information', '📣 Campagne validée et diffusée', `« ${c.title} » est en ligne pour ${c.duration_days} jour(s).`, '#/pub');
    } else {
      set('validee'); // file d'attente : passera automatiquement en ligne dès qu'un emplacement se libère
      notify(c.user_id, 'information', '📣 Campagne validée — en file d\u2019attente', `Tous les emplacements sont occupés. « ${c.title} » sera diffusée automatiquement dès qu\u2019une place se libère.`, '#/pub');
    }
  } else if (action === 'refuser') {
    set('refusee');
    if (trx && trx.status === 'confirme') db.prepare(`UPDATE transactions SET status='rembourse' WHERE id=?`).run(trx.id); // à rembourser
    if (trx && trx.status === 'en_attente') db.prepare(`UPDATE transactions SET status='echoue' WHERE id=?`).run(trx.id);
    notify(c.user_id, 'information', 'Campagne refusée', `« ${c.title} » n\u2019a pas été validée${note ? ' : ' + note : '.'}`, '#/pub');
  } else if (action === 'suspendre') {
    if (c.status !== 'active') return res.status(409).json({ error: 'Seule une campagne active peut être suspendue.' });
    set('suspendue');
    notify(c.user_id, 'information', 'Campagne suspendue', `« ${c.title} » est temporairement suspendue${note ? ' : ' + note : '.'}`, '#/pub');
  } else if (action === 'reactiver') {
    if (c.status !== 'suspendue') return res.status(409).json({ error: 'Seule une campagne suspendue peut être réactivée.' });
    const actives = db.prepare(`SELECT COUNT(*) n FROM ad_campaigns WHERE status='active'`).get().n;
    set(actives < pubSlotsMax() ? 'active' : 'validee');
    notify(c.user_id, 'information', 'Campagne réactivée', `« ${c.title} » reprend sa diffusion.`, '#/pub');
  } else return res.status(400).json({ error: 'Action inconnue.' });
  res.json({ ok: true });
});
A.delete('/pub/campagnes/:id', (req, res) => { db.prepare('DELETE FROM ad_campaigns WHERE id=?').run(req.params.id); res.json({ ok: true }); });

/* =============== COMMERCE : historique financier & transactions =============== */
A.get('/transactions', (req, res) => {
  const q = req.query || {};
  const cond = ['1=1']; const args = [];
  if (q.kind) { cond.push('t.kind=?'); args.push(q.kind); }
  if (q.status) { cond.push('t.status=?'); args.push(q.status); }
  if (q.du) { cond.push("date(t.created_at) >= date(?)"); args.push(q.du); }
  if (q.au) { cond.push("date(t.created_at) <= date(?)"); args.push(q.au); }
  if (q.q) { cond.push('(t.label LIKE ? OR t.ville LIKE ? OR t.categorie LIKE ? OR u.name LIKE ?)'); const like = '%' + q.q + '%'; args.push(like, like, like, like); }
  res.json(db.prepare(`SELECT t.*, u.name user_name FROM transactions t LEFT JOIN users u ON u.id=t.user_id
    WHERE ${cond.join(' AND ')} ORDER BY t.id DESC LIMIT 500`).all(...args));
});
A.post('/transactions/:id/statut', (req, res) => {
  const t = db.prepare('SELECT * FROM transactions WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Transaction introuvable.' });
  const st = req.body.status;
  if (!['confirme', 'echoue', 'rembourse'].includes(st)) return res.status(400).json({ error: 'Statut invalide.' });
  db.prepare(`UPDATE transactions SET status=?, confirmed_at=CASE WHEN ?='confirme' THEN datetime('now') ELSE confirmed_at END WHERE id=?`).run(st, st, t.id);
  // Effets automatiques à la confirmation du paiement (tout reste calculé et appliqué côté serveur)
  if (st === 'confirme' && t.status !== 'confirme') {
    if (t.kind === 'visibilite') {
      const sub = db.prepare('SELECT * FROM visibility_subs WHERE id=?').get(t.ref_id);
      if (sub && sub.status === 'attente_paiement') {
        db.prepare(`UPDATE visibility_subs SET status='active', start_at=datetime('now'), end_at=datetime('now', '+' || duration_days || ' days') WHERE id=?`).run(sub.id);
        notify(sub.user_id, 'information', '⭐ Visibilité activée', `Votre formule « ${sub.plan_name} » est active pour ${sub.duration_days} jours. Profil mis en avant !`, '#/visibilite');
      }
    } else if (t.kind === 'publicite') {
      const c = db.prepare('SELECT * FROM ad_campaigns WHERE id=?').get(t.ref_id);
      if (c && c.status === 'attente_paiement') {
        db.prepare(`UPDATE ad_campaigns SET status='attente_validation' WHERE id=?`).run(c.id);
        notify(c.user_id, 'information', '📣 Paiement confirmé', `Le paiement de « ${c.title} » est confirmé. Votre campagne est en cours de validation.`, '#/pub');
      }
    } else if (t.kind === 'avis_recherche') {
      db.prepare('UPDATE avis_recherche SET paid=1 WHERE id=?').run(t.ref_id);
      notify(t.user_id, 'information', '🔎 Mise en avant payée', 'Votre avis de recherche bénéficie maintenant de sa formule.', '#/avis-recherche');
    } else if (t.kind === 'emploi') {
      const dj = Math.max(1, parseInt(getSetting('emploi_boost_duree_jours', '30'), 10) || 30);
      db.prepare(`UPDATE jobs SET boost=?, boost_until=datetime('now', '+' || ? || ' days') WHERE id=?`).run(t.categorie === 'prioritaire' ? 'prioritaire' : 'avant', dj, t.ref_id);
      notify(t.user_id, 'information', '⭐ Profil emploi mis en avant', `Votre profil est mis en avant pour ${dj} jours.`, '#/jobs');
    }
  }
  if (st !== 'confirme' && t.kind === 'visibilite') {
    const sub = db.prepare('SELECT * FROM visibility_subs WHERE id=?').get(t.ref_id);
    if (sub && sub.status === 'attente_paiement') db.prepare(`UPDATE visibility_subs SET status='annulee' WHERE id=?`).run(sub.id);
  }
  res.json({ ok: true });
});
A.get('/prix-modifs', (req, res) => {
  res.json(db.prepare(`SELECT pc.*, m.code, up.name pro_name, uc.name client_name FROM mission_price_changes pc
    JOIN missions m ON m.id=pc.mission_id JOIN users up ON up.id=pc.pro_id JOIN users uc ON uc.id=pc.client_id
    ORDER BY pc.id DESC LIMIT 300`).all());
});
A.get('/finances', (req, res) => {
  pubTick(); visibiliteTick();
  const sum = (w, a = []) => db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM transactions WHERE ${w}`).get(...a).n;
  const cnt = (t, w) => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${w}`).get().n;
  const revKind = k => sum(`kind=? AND status='confirme'`, [k]);
  res.json({
    devise: getSetting('devise', 'FCFA'),
    commissions: {
      aujourdhui: sum(`kind='commission' AND status='confirme' AND date(created_at)=date('now')`),
      semaine: sum(`kind='commission' AND status='confirme' AND created_at >= datetime('now', '-7 days')`),
      mois: sum(`kind='commission' AND status='confirme' AND strftime('%Y-%m', created_at)=strftime('%Y-%m', 'now')`),
      total: revKind('commission')
    },
    pub: {
      actives: cnt('ad_campaigns', `status='active'`),
      en_attente: cnt('ad_campaigns', `status IN ('attente_paiement','attente_validation','validee')`),
      expirees: cnt('ad_campaigns', `status='expiree'`),
      refusees: cnt('ad_campaigns', `status='refusee'`),
      revenus: revKind('publicite')
    },
    visibilite: { actifs: cnt('visibility_subs', `status='active'`), revenus: revKind('visibilite') },
    avis: { actifs: cnt('avis_recherche', `status='approved' AND (expire_at IS NULL OR expire_at >= datetime('now'))`), revenus: revKind('avis_recherche') },
    emploi: {
      profils_actifs: cnt('jobs', `status='approved'`),
      mis_en_avant: cnt('jobs', `status='approved' AND boost != 'normal' AND (boost_until IS NULL OR boost_until >= datetime('now'))`),
      revenus: revKind('emploi')
    },
    paiements: {
      en_attente: sum(`status='en_attente'`), confirmes: sum(`status='confirme'`),
      echoues: sum(`status='echoue'`), rembourses: sum(`status='rembourse'`)
    },
    revenu_total: sum(`status='confirme'`)
  });
});

// VUE OPÉRATIONNELLE DES DEMANDES : chiffres DB, sans donnée de démonstration.
A.get('/dispatch/overview', (req, res) => {
  const count = q => db.prepare(q).get().n;
  const byState = db.prepare(`SELECT COALESCE(availability_status, CASE WHEN available=1 THEN 'disponible' ELSE 'indisponible' END) state, COUNT(*) n
    FROM pro_profiles p JOIN users u ON u.id=p.user_id WHERE u.pro_status='approved' GROUP BY state`).all();
  res.json({
    searching: count("SELECT COUNT(*) n FROM missions WHERE status='recherche'"),
    unanswered: count("SELECT COUNT(*) n FROM missions WHERE status='sans_pro'"),
    assigned: count("SELECT COUNT(*) n FROM missions WHERE status IN ('acceptee','confirmee','demarrage_demande','en_cours','fin_demande')"),
    professionals: Object.fromEntries(byState.map(r => [r.state, r.n]))
  });
});

// PARAMÈTRES
A.get('/about', (req, res) => {
  const r = db.prepare('SELECT * FROM app_about WHERE id=1').get();
  res.json({ title: r.draft_title || r.title, published_title: r.published_title || r.title, draft: safeAbout(r.draft), published: safeAbout(r.published), updated_at: r.updated_at, published_at: r.published_at });
});
A.put('/about', (req, res) => {
  const title = String(req.body && req.body.title || '').trim();
  const paragraphs = safeAbout(req.body && req.body.paragraphs);
  if (!title || !paragraphs.length) return res.status(400).json({ error: 'Un titre et au moins un paragraphe sont requis.' });
  db.prepare("UPDATE app_about SET draft_title=?,draft=?,updated_at=datetime('now') WHERE id=1").run(title.slice(0, 120), JSON.stringify(paragraphs));
  res.json({ ok: true, title: title.slice(0,120), draft: paragraphs });
});
A.post('/about/publish', (req, res) => {
  const r = db.prepare('SELECT * FROM app_about WHERE id=1').get();
  const draft = safeAbout(r.draft);
  if (!draft.length) return res.status(400).json({ error: 'Le brouillon est vide.' });
  db.prepare("UPDATE app_about SET published=draft,published_title=COALESCE(draft_title,title),title=COALESCE(draft_title,title),published_at=datetime('now') WHERE id=1").run();
  res.json({ ok: true });
});

A.get('/settings', (req, res) => {
  const keys = ['commission_rate', 'dispatch_wait_seconds', 'file_retention_days', 'payment_especes', 'payment_mobile_money',
    'quiz_enabled', 'flipfizz_enabled', 'kdo_enabled', 'quiz_audience', 'bandeau_enabled', 'bandeau_speed', 'urgence_info', 'urgence_contacts', 'urgence_categories', 'urgence_assistance_enabled', 'rules_client', 'rules_pro', 'admin_font_size',
    'pro_doc_particulier', 'pro_doc_entreprise',
    'commission_enabled', 'visibilite_enabled', 'pub_campagnes_enabled', 'pub_max_actives', 'pub_budgets', 'pub_niveaux', 'avis_prix_normal', 'avis_prix_avant', 'avis_prix_urgent', 'avis_avant_enabled', 'avis_urgent_enabled', 'avis_duree_jours', 'emploi_boost_enabled', 'emploi_prix_avant', 'emploi_prix_prioritaire', 'emploi_boost_duree_jours', 'pays', 'devise',
    'dispatch_initial_alert_count', 'dispatch_expand_alert_count', 'dispatch_expand_strategy', 'dispatch_reminder_seconds', 'dispatch_auto_enabled', 'dispatch_geo_enabled', 'dispatch_alert_sound', 'dispatch_max_reminders', 'dispatch_search_max_seconds', 'dispatch_allow_particulier', 'dispatch_allow_entreprise',
    'chat_text_limit', 'chat_audio_max_seconds', 'chat_image_limit', 'chat_audio_enabled', 'chat_image_enabled', 'file_recovery_days', 'request_image_limit', 'request_audio_max_seconds', 'activity_active_minutes', 'share_official_url', 'share_text', 'game_quiz_account', 'game_quiz_share', 'game_quiz_service', 'game_flipfizz_account', 'game_flipfizz_share', 'game_flipfizz_service', 'game_kdo_account', 'game_kdo_share', 'game_kdo_service'];
  const out = {};
  keys.forEach(k => out[k] = getSetting(k));
  res.json(out);
});
A.put('/settings', (req, res) => {
  const allowed = ['commission_rate', 'dispatch_wait_seconds', 'file_retention_days', 'payment_especes', 'payment_mobile_money',
    'quiz_enabled', 'flipfizz_enabled', 'kdo_enabled', 'quiz_audience', 'bandeau_enabled', 'bandeau_speed', 'urgence_info', 'urgence_contacts', 'urgence_categories', 'urgence_assistance_enabled', 'rules_client', 'rules_pro', 'admin_font_size',
    'pro_doc_particulier', 'pro_doc_entreprise',
    'commission_enabled', 'visibilite_enabled', 'pub_campagnes_enabled', 'pub_max_actives', 'pub_budgets', 'pub_niveaux', 'avis_prix_normal', 'avis_prix_avant', 'avis_prix_urgent', 'avis_avant_enabled', 'avis_urgent_enabled', 'avis_duree_jours', 'emploi_boost_enabled', 'emploi_prix_avant', 'emploi_prix_prioritaire', 'emploi_boost_duree_jours', 'pays', 'devise',
    'dispatch_initial_alert_count', 'dispatch_expand_alert_count', 'dispatch_expand_strategy', 'dispatch_reminder_seconds', 'dispatch_auto_enabled', 'dispatch_geo_enabled', 'dispatch_alert_sound', 'dispatch_max_reminders', 'dispatch_search_max_seconds', 'dispatch_allow_particulier', 'dispatch_allow_entreprise',
    'chat_text_limit', 'chat_audio_max_seconds', 'chat_image_limit', 'chat_audio_enabled', 'chat_image_enabled', 'file_recovery_days', 'request_image_limit', 'request_audio_max_seconds', 'activity_active_minutes', 'share_official_url', 'share_text', 'game_quiz_account', 'game_quiz_share', 'game_quiz_service', 'game_flipfizz_account', 'game_flipfizz_share', 'game_flipfizz_service', 'game_kdo_account', 'game_kdo_share', 'game_kdo_service'];
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!allowed.includes(k)) continue;
    if (['share_official_url','share_text'].includes(k) && req.user.role !== 'pdg') return res.status(403).json({ error: 'Le partage officiel est configuré par le PDG uniquement.' });
    if (k === 'admin_font_size') { // taille du tableau de bord : réservée au PDG
      if (req.user.role !== 'pdg') return res.status(403).json({ error: 'La taille du tableau de bord est définie par le PDG uniquement.' });
      const f = parseInt(v, 10); if (isNaN(f) || f < 14 || f > 26) return res.status(400).json({ error: 'Taille invalide (14 à 26).' });
    }
    if (k === 'commission_rate') { const r = parseFloat(v); if (isNaN(r) || r < 0 || r > 100) return res.status(400).json({ error: 'Taux de commission invalide (0 à 100).' }); }
    if (k === 'dispatch_wait_seconds') { const s = parseInt(v, 10); if (isNaN(s) || s < 15 || s > 3600) return res.status(400).json({ error: 'Délai d\u2019attente invalide (15 à 3600 secondes).' }); }
    if (['dispatch_initial_alert_count', 'dispatch_expand_alert_count'].includes(k)) { const n = parseInt(v, 10); if (isNaN(n) || n < 1 || n > 50) return res.status(400).json({ error: 'Taille de vague invalide (1 à 50 professionnels).' }); }
    if (k === 'dispatch_reminder_seconds') { const n = parseInt(v, 10); if (isNaN(n) || n < 2 || n > 600) return res.status(400).json({ error: 'Délai de rappel invalide (2 à 600 secondes).' }); }
    if (k === 'dispatch_max_reminders') { const n = parseInt(v, 10); if (isNaN(n) || n < 0 || n > 100) return res.status(400).json({ error: 'Nombre maximal de rappels invalide (0 à 100).' }); }
    if (k === 'dispatch_search_max_seconds') { const n = parseInt(v, 10); if (isNaN(n) || n < 60 || n > 86400) return res.status(400).json({ error: 'Délai maximal de recherche invalide (60 à 86400 secondes).' }); }
    if (['dispatch_auto_enabled', 'dispatch_geo_enabled', 'dispatch_alert_sound', 'dispatch_allow_particulier', 'dispatch_allow_entreprise'].includes(k) && !['0','1',0,1,true,false].includes(v)) return res.status(400).json({ error: 'Paramètre d’activation invalide.' });
    if (k === 'dispatch_expand_strategy' && !['vagues'].includes(String(v))) return res.status(400).json({ error: 'Stratégie d\u2019alerte invalide.' });
    if (['chat_text_limit', 'chat_image_limit'].includes(k)) { const n = parseInt(v, 10); if (isNaN(n) || n < 0 || n > 500) return res.status(400).json({ error: 'Limite de messagerie invalide.' }); }
    if (k === 'chat_audio_max_seconds') { const n = parseInt(v, 10); if (isNaN(n) || n < 1 || n > 120) return res.status(400).json({ error: 'Durée vocale invalide (1 à 120 secondes).' }); }
    if (k === 'file_recovery_days') { const n = parseInt(v, 10); if (isNaN(n) || n < 0 || n > 365) return res.status(400).json({ error: 'Délai de récupération invalide (0 à 365 jours).' }); }
    if (k === 'pub_max_actives') { const n = parseInt(v, 10); if (isNaN(n) || n < 1 || n > 200) return res.status(400).json({ error: 'Nombre d\u2019emplacements publicitaires invalide (1 à 200).' }); }
    if (k === 'request_image_limit') { const n=parseInt(v,10); if (isNaN(n)||n<0||n>3) return res.status(400).json({ error: 'Limite de photos invalide (0 à 3).' }); }
    if (k === 'request_audio_max_seconds') { const n=parseInt(v,10); if (isNaN(n)||n<1||n>25) return res.status(400).json({ error: 'La durée vocale doit être comprise entre 1 et 25 secondes.' }); }
    if (k === 'activity_active_minutes') { const n=parseInt(v,10); if (isNaN(n)||n<1||n>120) return res.status(400).json({ error: 'Seuil d’activité invalide (1 à 120 minutes).' }); }
    if (k === 'urgence_assistance_enabled' && !['0','1',0,1,true,false].includes(v)) return res.status(400).json({ error: 'Disponibilité d’urgence invalide.' });
    if (k === 'urgence_contacts') { try { const items=JSON.parse(v); if(!Array.isArray(items)||items.some(c=>!c||!String(c.nom||'').trim()||!String(c.tel||'').trim()||typeof c.verified!=='boolean')) throw new Error(); } catch { return res.status(400).json({error:'Contacts d’urgence invalides : nom, numéro et statut vérifié requis.'}); } }
    if (k === 'urgence_categories') { try { const items=JSON.parse(v); if(!Array.isArray(items)||items.some(c=>!c||!String(c.name||'').trim())) throw new Error(); } catch { return res.status(400).json({error:'Catégories d’urgence invalides.'}); } }
    if (k === 'share_official_url' && String(v||'').trim() && !/^https:\/\//i.test(String(v).trim())) return res.status(400).json({ error: 'Le lien officiel doit commencer par https://.' });
    if (/^game_(quiz|flipfizz|kdo)_(account|share|service)$/.test(k)) { const type=k.split('_').pop(); const ok=type==='account'?['tous','clients','pros','clients_pros'].includes(v):type==='share'?['tous','lien_ouvert','inscription_acquise','sans_partage'].includes(v):['tous','realisee','non_realisee'].includes(v); if (!ok) return res.status(400).json({ error: 'Condition de jeu invalide.' }); }
    const ancienneValeur = getSetting(k);
    setSetting(k, v);
    // Sécurité financière : chaque modification de paramètre est journalisée (qui, ancienne valeur, nouvelle valeur, quand)
    if (String(ancienneValeur) !== String(v)) logAction(req.user, 'Paramètre « ' + k + ' » modifié', { details: `Ancienne valeur : ${ancienneValeur === null ? '(vide)' : ancienneValeur} → Nouvelle valeur : ${v}` });
  }
  const changedDispatch = Object.keys(req.body || {}).some(k => ['dispatch_auto_enabled', 'dispatch_geo_enabled', 'dispatch_alert_sound', 'dispatch_allow_particulier', 'dispatch_allow_entreprise', 'dispatch_search_max_seconds', 'dispatch_wait_seconds', 'dispatch_reminder_seconds', 'dispatch_max_reminders', 'dispatch_initial_alert_count', 'dispatch_expand_alert_count'].includes(k));
  if (changedDispatch) {
    const activeSearches = db.prepare("SELECT * FROM missions WHERE status='recherche'").all();
    if (getSetting('dispatch_auto_enabled', '1') === '1') {
      activeSearches.forEach(m => {
        clearDispatchTimers(m.id);
        db.prepare("DELETE FROM mission_candidates WHERE mission_id=? AND status IN ('pending','offered','expired','refused')").run(m.id);
        db.prepare("UPDATE missions SET search_started_at=datetime('now'), search_expires_at=NULL WHERE id=?").run(m.id);
        addEvent(m.id, 'recherche', req.user.id, 'Recherche recalculée après modification des paramètres PDG');
        startDispatch(m.id);
      });
    } else activeSearches.forEach(m => {
      clearDispatchTimers(m.id);
      const offered = db.prepare("SELECT pro_id FROM mission_candidates WHERE mission_id=? AND status='offered'").all(m.id);
      db.prepare("UPDATE mission_candidates SET status='expired', responded_at=datetime('now') WHERE mission_id=? AND status='offered'").run(m.id);
      offered.forEach(o => clearAlertStatus(o.pro_id));
    });
  }
  res.json({ ok: true });
});

// COMMUNICATION : support client + publicités + message système
A.get('/support/conversations', (req, res) => {
  const subject = ['suggestion', 'preoccupation'].includes(req.query.subject) ? req.query.subject : null;
  const rows = db.prepare(`SELECT c.*, u.name user_name, u.phone user_phone, u.ville user_ville,
    (SELECT content FROM support_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) last_content,
    (SELECT type FROM support_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) last_type,
    (SELECT created_at FROM support_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) last_at,
    (SELECT COUNT(*) FROM support_messages WHERE conversation_id=c.id AND sender_id IS NOT NULL AND read=0) unread_client
    FROM support_conversations c JOIN users u ON u.id=c.user_id ${subject ? 'WHERE c.subject=?' : ''}
    ORDER BY CASE c.status WHEN 'ouverte' THEN 0 ELSE 1 END, c.updated_at DESC, c.id DESC`).all(...(subject ? [subject] : []));
  res.json(rows);
});
A.get('/support/conversations/:id', (req, res) => {
  const c = db.prepare(`SELECT c.*, u.name user_name, u.phone user_phone, u.ville user_ville FROM support_conversations c JOIN users u ON u.id=c.user_id WHERE c.id=?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Conversation introuvable.' });
  db.prepare('UPDATE support_messages SET read=1 WHERE conversation_id=? AND sender_id IS NOT NULL').run(c.id);
  res.json({ conversation: c, messages: supportMessages(c.id) });
});
A.post('/support/conversations/:id/messages', (req, res) => {
  const c = db.prepare('SELECT * FROM support_conversations WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Conversation introuvable.' });
  const body = req.body || {}, type = body.type === 'audio' ? 'audio' : 'text';
  const content = String(body.content || '').trim(), file = String(body.file || '').trim();
  if (type === 'text' && !content) return res.status(400).json({ error: 'Écrivez votre réponse.' });
  if (type === 'audio' && !file.startsWith('/uploads/')) return res.status(400).json({ error: 'Fichier audio manquant.' });
  const info = db.prepare('INSERT INTO support_messages(conversation_id, sender_id, type, content, file) VALUES(?,?,?,?,?)').run(c.id, req.user.id, type, content || null, file || null);
  db.prepare("UPDATE support_conversations SET updated_at=datetime('now'), status='ouverte' WHERE id=?").run(c.id);
  const m = supportMessageRow(info.lastInsertRowid);
  notify(c.user_id, 'message', '💬 Klean Services', type === 'audio' ? '🎤 Nouveau message vocal' : content.slice(0, 120), '#/contact/' + c.id);
  push(c.user_id, 'support', { conversation_id: c.id, message: m });
  res.status(201).json(m);
});
A.post('/support/conversations/:id/status', (req, res) => {
  const status = (req.body || {}).status === 'fermee' ? 'fermee' : 'ouverte';
  const out = db.prepare("UPDATE support_conversations SET status=?, updated_at=datetime('now') WHERE id=?").run(status, req.params.id);
  if (!out.changes) return res.status(404).json({ error: 'Conversation introuvable.' });
  res.json({ ok: true, status });
});
A.get('/ads', (req, res) => res.json(db.prepare(`SELECT a.*,
  (SELECT COUNT(*) FROM view_seen v WHERE v.key = 'ad:' || a.id) AS views
  FROM ads a ORDER BY a.sort, a.id DESC`).all()));
A.get('/game-plays/vues', (req, res) => {
  const gv = k => db.prepare('SELECT COUNT(*) n FROM view_seen WHERE key=?').get(k).n;
  res.json({ quiz: gv('game:quiz'), flipfizz: gv('game:flipfizz'), kdo: gv('game:kdo') });
});
A.post('/ads', (req, res) => {
  const { type, title, content, file, placement, duration, active } = req.body || {};
  let zones; try { zones = assertValidZones((req.body || {}).zones); } catch (e) { return res.status(400).json({ error: e.message }); }
  const info = db.prepare('INSERT INTO ads(type, title, content, file, placement, duration, active, zones) VALUES(?,?,?,?,?,?,?,?)')
    .run(type || 'texte', title || '', content || '', file || null, placement || 'accueil', duration || 6, active ?? 1, JSON.stringify(zones));
  res.json({ id: info.lastInsertRowid, zones });
});
A.put('/ads/:id', (req, res) => {
  const { title, content, placement, duration, active, sort } = req.body || {};
  let zones = null;
  if ((req.body || {}).zones !== undefined) { try { zones = JSON.stringify(assertValidZones(req.body.zones)); } catch (e) { return res.status(400).json({ error: e.message }); } }
  db.prepare('UPDATE ads SET title=COALESCE(?,title), content=COALESCE(?,content), placement=COALESCE(?,placement), duration=COALESCE(?,duration), active=COALESCE(?,active), sort=COALESCE(?,sort), zones=COALESCE(?,zones) WHERE id=?')
    .run(title ?? null, content ?? null, placement || null, duration ?? null, active ?? null, sort ?? null, zones, req.params.id);
  res.json({ ok: true });
});
A.delete('/ads/:id', (req, res) => { db.prepare('DELETE FROM ads WHERE id=?').run(req.params.id); res.json({ ok: true }); });
// ----- Bandeau d'annonces défilantes -----
A.get('/annonces', (req, res) => res.json(db.prepare('SELECT * FROM annonces ORDER BY sort, id').all()));
const TYPES_BANDEAU = { pub: '📢', info: 'ℹ️', urgence: '🚨' }; // icône posée automatiquement selon le type
A.post('/annonces', (req, res) => {
  const { type, theme, title, content, color, link } = req.body || {};
  if (!(content || '').trim() && !(title || '').trim()) return res.status(400).json({ error: 'Écrivez le message à faire défiler.' });
  const t = TYPES_BANDEAU[type] ? type : 'info';
  const info = db.prepare('INSERT INTO annonces(type, theme, title, content, icon, color, link) VALUES(?,?,?,?,?,?,?)')
    .run(t, (theme || '').trim(), (title || '').trim(), (content || '').trim(), TYPES_BANDEAU[t],
      (color || '#ffffff').trim() || '#ffffff', (link || '').trim() || null);
  db.prepare('UPDATE annonces SET sort=? WHERE id=?').run(info.lastInsertRowid, info.lastInsertRowid); // ordre stable
  res.json({ ok: true, id: info.lastInsertRowid });
});
A.put('/annonces/:id', (req, res) => {
  const { type, theme, title, content, color, link, active, sort } = req.body || {};
  const t = (type !== undefined && type !== null) ? (TYPES_BANDEAU[type] ? type : 'info') : null;
  db.prepare(`UPDATE annonces SET type=COALESCE(?,type), theme=COALESCE(?,theme), icon=COALESCE(?,icon),
    title=COALESCE(?,title), content=COALESCE(?,content),
    color=COALESCE(?,color), link=COALESCE(?,link), active=COALESCE(?,active), sort=COALESCE(?,sort) WHERE id=?`)
    .run(t, theme ?? null, t ? TYPES_BANDEAU[t] : null, title ?? null, content ?? null,
      color ?? null, link ?? null, active ?? null, sort ?? null, req.params.id);
  res.json({ ok: true });
});
A.delete('/annonces/:id', (req, res) => { db.prepare('DELETE FROM annonces WHERE id=?').run(req.params.id); res.json({ ok: true }); });
// L'ancien endpoint est conservé, mais passe par le système ciblé et historisé.
A.post('/broadcast', (req, res) => {
  const title = String(req.body && req.body.title || '').trim();
  const body = String(req.body && req.body.body || '').trim();
  if (!title) return res.status(400).json({ error: 'Titre requis.' });
  const info = db.prepare(`INSERT INTO general_messages(author_id,title,body,account_types,cities,mode,status)
    VALUES(?,?,?,'[]','[]','immediate','draft')`).run(req.user.id, title.slice(0, 160), body.slice(0, 2000));
  const result = deliverGeneralMessage(info.lastInsertRowid);
  res.json({ ok: true, sent: result.delivered, id: info.lastInsertRowid, migrated: true });
});
function listStrings(raw, allowed, max = 100) {
  const a = Array.isArray(raw) ? raw : [];
  return [...new Set(a.map(v => String(v || '').trim()).filter(v => allowed ? allowed.includes(v) : !!v))].slice(0, max);
}
function generalTargetUsers(msg) {
  let types = []; let cities = [];
  try { types = JSON.parse(msg.account_types || '[]'); } catch {}
  try { cities = JSON.parse(msg.cities || '[]'); } catch {}
  const args = [];
  let where = "role='user' AND suspended=0 AND blocked=0";
  if (types.includes('clients') && !types.includes('pros')) where += " AND pro_status!='approved'";
  if (types.includes('pros') && !types.includes('clients')) where += " AND pro_status='approved'";
  if (cities.length) { where += ` AND ville IN (${cities.map(() => '?').join(',')})`; args.push(...cities); }
  return db.prepare('SELECT id FROM users WHERE ' + where).all(...args);
}
function deliverGeneralMessage(id) {
  const msg = db.prepare('SELECT * FROM general_messages WHERE id=?').get(id);
  if (!msg || ['sent', 'cancelled'].includes(msg.status)) return { delivered: msg ? msg.delivered_count : 0, ignored: true };
  const lock = db.prepare("UPDATE general_messages SET status='sending', updated_at=datetime('now') WHERE id=? AND status IN ('draft','scheduled')").run(id);
  if (!lock.changes) return { delivered: msg.delivered_count || 0, ignored: true };
  let delivered = 0;
  const tx = db.transaction(() => {
    generalTargetUsers(msg).forEach(u => {
      // Une contrainte primaire garantit qu'une personne ne reçoit jamais deux fois le même message.
      const exists = db.prepare('SELECT 1 FROM general_message_deliveries WHERE message_id=? AND user_id=?').get(id, u.id);
      if (exists) return;
      const notificationId = notify(u.id, 'information', msg.title, msg.body, '#/notifications');
      db.prepare('INSERT INTO general_message_deliveries(message_id,user_id,notification_id) VALUES(?,?,?)').run(id, u.id, notificationId);
      delivered++;
    });
    db.prepare("UPDATE general_messages SET status='sent', sent_at=datetime('now'), target_count=?, delivered_count=?, updated_at=datetime('now') WHERE id=?")
      .run(generalTargetUsers(msg).length, delivered, id);
  });
  tx();
  return { delivered };
}
function generalMessageRow(m) {
  let account_types = [], cities = [];
  try { account_types = JSON.parse(m.account_types || '[]'); } catch {}
  try { cities = JSON.parse(m.cities || '[]'); } catch {}
  const read = db.prepare(`SELECT COUNT(*) n FROM general_message_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE d.message_id=? AND n.read=1`).get(m.id).n;
  return { ...m, account_types, cities, read_count: read, delivery_state: m.status === 'sent' ? 'Notification enregistrée dans l’application' : '—' };
}
function runDueGeneralMessages() {
  const due = db.prepare("SELECT id FROM general_messages WHERE status='scheduled' AND scheduled_at<=datetime('now') ORDER BY id LIMIT 30").all();
  due.forEach(m => { try { deliverGeneralMessage(m.id); } catch (e) { console.error('Message programmé non envoyé', m.id, e.message); } });
}
setInterval(runDueGeneralMessages, 30000).unref();
runDueGeneralMessages();
A.get('/general-messages', (req, res) => res.json(db.prepare('SELECT * FROM general_messages ORDER BY id DESC LIMIT 200').all().map(generalMessageRow)));
A.post('/general-messages', (req, res) => {
  const b = req.body || {}, title = String(b.title || '').trim(), body = String(b.body || '').trim();
  if (!title) return res.status(400).json({ error: 'Donnez un titre au message.' });
  const types = listStrings(b.account_types, ['clients', 'pros'], 2);
  const existingCities = new Set(db.prepare('SELECT name FROM villes WHERE active=1').all().map(v => v.name));
  const cities = listStrings(b.cities, null).filter(c => existingCities.has(c));
  if (Array.isArray(b.cities) && cities.length !== listStrings(b.cities).length) return res.status(400).json({ error: 'Une ville sélectionnée n’existe plus ou est inactive.' });
  const mode = ['draft', 'immediate', 'scheduled'].includes(b.mode) ? b.mode : 'draft';
  let scheduledAt = null;
  if (mode === 'scheduled') {
    scheduledAt = String(b.scheduled_at || '').trim().replace('T', ' ');
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(scheduledAt) || scheduledAt <= new Date().toISOString().slice(0, 16).replace('T', ' ')) return res.status(400).json({ error: 'Choisissez une date de programmation future.' });
    scheduledAt += scheduledAt.length === 16 ? ':00' : '';
  }
  const status = mode === 'draft' ? 'draft' : mode === 'scheduled' ? 'scheduled' : 'draft';
  const info = db.prepare(`INSERT INTO general_messages(author_id,title,body,account_types,cities,mode,status,scheduled_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(req.user.id, title.slice(0, 160), body.slice(0, 2000), JSON.stringify(types), JSON.stringify(cities), mode, status, scheduledAt);
  const sent = mode === 'immediate' ? deliverGeneralMessage(info.lastInsertRowid) : null;
  res.status(201).json({ ...generalMessageRow(db.prepare('SELECT * FROM general_messages WHERE id=?').get(info.lastInsertRowid)), sent: sent && sent.delivered });
});
A.put('/general-messages/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM general_messages WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Message introuvable.' });
  if (m.status !== 'draft') return res.status(409).json({ error: 'Seul un brouillon peut être modifié.' });
  const title = String(req.body && req.body.title || '').trim(), body = String(req.body && req.body.body || '').trim();
  if (!title) return res.status(400).json({ error: 'Donnez un titre au message.' });
  const types = listStrings(req.body.account_types, ['clients', 'pros'], 2);
  const cities = listStrings(req.body.cities, null).filter(c => db.prepare('SELECT 1 FROM villes WHERE name=? AND active=1').get(c));
  db.prepare("UPDATE general_messages SET title=?,body=?,account_types=?,cities=?,updated_at=datetime('now') WHERE id=?").run(title.slice(0,160), body.slice(0,2000), JSON.stringify(types), JSON.stringify(cities), m.id);
  res.json(generalMessageRow(db.prepare('SELECT * FROM general_messages WHERE id=?').get(m.id)));
});
A.post('/general-messages/:id/send', (req, res) => {
  const m = db.prepare('SELECT * FROM general_messages WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Message introuvable.' });
  if (!['draft', 'scheduled'].includes(m.status)) return res.status(409).json({ error: 'Ce message a déjà été traité.' });
  const out = deliverGeneralMessage(m.id);
  res.json({ ok: true, delivered: out.delivered });
});
A.delete('/general-messages/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM general_messages WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Message introuvable.' });
  if (m.status === 'sent') return res.status(409).json({ error: 'Un message envoyé reste dans l’historique.' });
  db.prepare("UPDATE general_messages SET status='cancelled',updated_at=datetime('now') WHERE id=?").run(m.id);
  res.json({ ok: true });
});

// SÉCURITÉ : signalements, urgences
A.get('/signalements', (req, res) => {
  res.json(db.prepare(`SELECT s.*, ur.name reporter, ut.name target FROM signalements s
    JOIN users ur ON ur.id=s.reporter_id LEFT JOIN users ut ON ut.id=s.target_id ORDER BY s.id DESC LIMIT 200`).all());
});
A.post('/signalements/:id/traiter', (req, res) => { db.prepare("UPDATE signalements SET status='traite' WHERE id=?").run(req.params.id); res.json({ ok: true }); });
A.get('/urgences', (req, res) => {
  res.json(db.prepare('SELECT u.*, us.name, us.phone FROM urgences u JOIN users us ON us.id=u.user_id ORDER BY u.id DESC LIMIT 200').all());
});
A.post('/urgences/:id/traiter', (req, res) => { db.prepare('UPDATE urgences SET handled=1 WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// CONTENU : avis de recherche, jobs, école & famille, quiz, kdo
A.get('/shares/stats', (req, res) => {
  const total = q => db.prepare(q).get().n;
  res.json({
    clicks: total('SELECT COUNT(*) n FROM share_events'),
    opened: total('SELECT COUNT(*) n FROM share_events WHERE detected_at IS NOT NULL'),
    joined: total('SELECT COUNT(*) n FROM share_events WHERE joined_user_id IS NOT NULL'),
    recent: db.prepare(`SELECT s.clicked_at,s.detected_at,s.joined_at,u.name,u.phone FROM share_events s JOIN users u ON u.id=s.user_id ORDER BY s.id DESC LIMIT 20`).all()
  });
});
A.get('/avis-recherche', (req, res) => res.json(db.prepare(`SELECT a.*, u.name publisher, u.phone, c.name category_name FROM avis_recherche a
  JOIN users u ON u.id=a.user_id LEFT JOIN search_notice_categories c ON c.id=a.category_id ORDER BY a.id DESC LIMIT 200`).all()));
A.get('/avis-categories', (req,res) => res.json(db.prepare('SELECT * FROM search_notice_categories ORDER BY sort,id').all()));
A.post('/avis-categories', (req,res) => { const name=String(req.body&&req.body.name||'').trim().slice(0,120); if(!name)return res.status(400).json({error:'Nom de catégorie requis.'}); try{const id=db.prepare('INSERT INTO search_notice_categories(name,description,sort) VALUES(?,?,?)').run(name,String(req.body.description||'').trim().slice(0,500),Number(req.body.sort)||99).lastInsertRowid;res.status(201).json({id});}catch{res.status(409).json({error:'Cette catégorie existe déjà.'});} });
A.put('/avis-categories/:id', (req,res) => { const b=req.body||{}; const name=b.name===undefined?null:String(b.name).trim().slice(0,120); if(name!==null&&!name)return res.status(400).json({error:'Nom de catégorie requis.'}); try { const changed=db.prepare('UPDATE search_notice_categories SET name=COALESCE(?,name),description=COALESCE(?,description),active=COALESCE(?,active),sort=COALESCE(?,sort) WHERE id=?').run(name,b.description===undefined?null:String(b.description).trim().slice(0,500),b.active??null,b.sort??null,req.params.id); if(!changed.changes)return res.status(404).json({error:'Catégorie introuvable.'});res.json({ok:true}); }catch{return res.status(409).json({error:'Cette catégorie existe déjà.'});} });
A.post('/avis-recherche/:id/status', (req, res) => {
  const a = db.prepare('SELECT * FROM avis_recherche WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Avis introuvable.' });
  db.prepare('UPDATE avis_recherche SET status=? WHERE id=?').run(req.body.status, a.id);
  if (req.body.status === 'approved') {
    const dj = Math.max(1, parseInt(getSetting('avis_duree_jours', '30'), 10) || 30);
    db.prepare(`UPDATE avis_recherche SET expire_at=datetime('now', '+' || ? || ' days') WHERE id=?`).run(dj, a.id); // expiration automatique
    notify(a.user_id, 'information', 'Avis de recherche publié ✅', `L\u2019avis concernant « ${a.nom} » est maintenant visible.`, '#/avis-recherche');
  }
  if (req.body.status === 'rejected') notify(a.user_id, 'information', 'Avis de recherche refusé', 'Votre avis n\u2019a pas été validé par l\u2019administration.', '#/avis-recherche');
  res.json({ ok: true });
});
A.get('/job-offers', (req,res) => res.json(db.prepare(`SELECT o.*,u.name publisher,u.phone FROM job_offers o JOIN users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT 300`).all()));
A.post('/job-offers/:id/status', (req,res) => {
  const o=db.prepare('SELECT * FROM job_offers WHERE id=?').get(req.params.id); if(!o)return res.status(404).json({error:'Offre introuvable.'});
  const status=['approved','rejected','closed'].includes(req.body.status)?req.body.status:'pending';
  db.prepare("UPDATE job_offers SET status=?,updated_at=datetime('now') WHERE id=?").run(status,o.id);
  if(status==='approved') notify(o.user_id,'information','Offre de job publiée ✅',`Votre offre « ${o.title} » est maintenant visible.`, '#/jobs');
  if(status==='rejected') notify(o.user_id,'information','Offre de job refusée',`Votre offre « ${o.title} » n’a pas été validée.`, '#/jobs');
  res.json({ok:true});
});
A.get('/jobs', (req, res) => res.json(db.prepare('SELECT j.*, u.name publisher, u.phone FROM jobs j JOIN users u ON u.id=j.user_id ORDER BY j.id DESC LIMIT 200').all()));
A.post('/jobs/:id/status', (req, res) => {
  const j = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Profil introuvable.' });
  db.prepare('UPDATE jobs SET status=? WHERE id=?').run(req.body.status, j.id);
  if (req.body.status === 'approved') notify(j.user_id, 'information', 'Profil emploi publié ✅', 'Votre profil candidat est maintenant visible.', '#/jobs');
  res.json({ ok: true });
});
A.get('/ecole-famille', (req, res) => res.json(db.prepare('SELECT e.*, u.name, u.phone FROM ecole_famille e JOIN users u ON u.id=e.user_id ORDER BY e.id DESC LIMIT 200').all()));
A.post('/ecole-famille/:id/status', (req, res) => {
  db.prepare('UPDATE ecole_famille SET status=? WHERE id=?').run(req.body.status, req.params.id);
  res.json({ ok: true });
});
A.get('/quiz', (req, res) => res.json(db.prepare('SELECT * FROM quiz_questions ORDER BY id DESC').all().map(q => ({ ...q, options: JSON.parse(q.options) }))));
A.post('/quiz', (req, res) => {
  const { question, options, answer } = req.body || {};
  if (!question || !question.trim()) return res.status(400).json({ error: 'Écrivez la question.' });
  if (!Array.isArray(options) || options.length !== 4 || options.some(o => !String(o).trim()))
    return res.status(400).json({ error: 'Un QCM doit avoir exactement 4 réponses (A, B, C, D).' });
  const ans = parseInt(answer, 10);
  if (!Number.isInteger(ans) || ans < 0 || ans > 3) return res.status(400).json({ error: 'Indiquez la bonne réponse (A, B, C ou D).' });
  const info = db.prepare('INSERT INTO quiz_questions(question, options, answer) VALUES(?,?,?)').run(question.trim(), JSON.stringify(options.map(o => String(o).trim())), ans);
  res.json({ id: info.lastInsertRowid });
});
A.delete('/quiz/:id', (req, res) => { db.prepare('DELETE FROM quiz_questions WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ----- Sessions de quiz (concours) : tout est piloté ici -----
A.get('/quiz-sessions', (req, res) => {
  const list = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM quiz_participants p WHERE p.session_id=s.id) AS participants,
    (SELECT COUNT(*) FROM quiz_participants p WHERE p.session_id=s.id AND p.status='gagnant') AS gagnants,
    (SELECT COUNT(*) FROM quiz_participants p WHERE p.session_id=s.id AND p.status='en_lice') AS in_competition,
    (SELECT COUNT(*) FROM quiz_views v LEFT JOIN quiz_participants p ON p.session_id=v.session_id AND p.user_id=v.user_id WHERE v.session_id=s.id AND v.updated_at >= datetime('now','-20 seconds') AND (p.id IS NULL OR p.status='elimine')) AS spectators
    FROM quiz_sessions s ORDER BY s.id DESC`).all();
  res.json(list);
});
function quizSessionBody(b) {
  const title = (b.title || '').trim();
  const nbQ = parseInt(b.nb_questions, 10), time = parseInt(b.time_per_q, 10), nbW = parseInt(b.nb_winners, 10);
  if (!title) return { error: 'Donnez un titre au quiz.' };
  if (!Number.isInteger(nbQ) || nbQ < 1 || nbQ > 50) return { error: 'Nombre de questions invalide (1 à 50).' };
  if (!Number.isInteger(time) || time < 5 || time > 600) return { error: 'Temps par question invalide (5 à 600 secondes).' };
  if (!Number.isInteger(nbW) || nbW < 1 || nbW > 100) return { error: 'Nombre de gagnants invalide (1 à 100).' };
  const inter = parseInt(b.interval_s == null ? 30 : b.interval_s, 10);
  if (!Number.isInteger(inter) || inter < 3 || inter > 600) return { error: 'Intervalle entre deux quiz invalide (3 à 600 secondes).' };
  return { title, nb_questions: nbQ, time_per_q: time, nb_winners: nbW, interval_s: inter,
    elimination: b.elimination ? 1 : 0, winner_mode: b.winner_mode === 'admin' ? 'admin' : 'auto' };
}
A.post('/quiz-sessions', (req, res) => {
  const v = quizSessionBody(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const info = db.prepare(`INSERT INTO quiz_sessions(title, nb_questions, time_per_q, elimination, nb_winners, winner_mode, interval_s)
    VALUES(?,?,?,?,?,?,?)`).run(v.title, v.nb_questions, v.time_per_q, v.elimination, v.nb_winners, v.winner_mode, v.interval_s);
  res.json({ ok: true, id: info.lastInsertRowid });
});
A.put('/quiz-sessions/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM quiz_sessions WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session introuvable.' });
  if (s.status !== 'brouillon') return res.status(400).json({ error: 'Seul un brouillon peut être modifié.' });
  const v = quizSessionBody(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  db.prepare('UPDATE quiz_sessions SET title=?, nb_questions=?, time_per_q=?, elimination=?, nb_winners=?, winner_mode=?, interval_s=? WHERE id=?')
    .run(v.title, v.nb_questions, v.time_per_q, v.elimination, v.nb_winners, v.winner_mode, v.interval_s, s.id);
  res.json({ ok: true });
});
A.delete('/quiz-sessions/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM quiz_sessions WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session introuvable.' });
  if (s.status !== 'brouillon') return res.status(400).json({ error: 'Les sessions déjà lancées sont conservées dans l’historique. Utilisez « Rejouer » pour archiver et réinitialiser.' });
  db.prepare('DELETE FROM quiz_answers WHERE session_id=?').run(s.id);
  db.prepare('DELETE FROM quiz_participants WHERE session_id=?').run(s.id);
  db.prepare('DELETE FROM quiz_messages WHERE session_id=?').run(s.id);
  db.prepare('DELETE FROM quiz_sessions WHERE id=?').run(s.id);
  res.json({ ok: true });
});
A.post('/quiz-sessions/:id/lancer', (req, res) => {
  const s = db.prepare('SELECT * FROM quiz_sessions WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session introuvable.' });
  if (s.status !== 'brouillon') return res.status(400).json({ error: 'Cette session a déjà été lancée.' });
  if (db.prepare("SELECT COUNT(*) n FROM quiz_sessions WHERE status='en_cours'").get().n)
    return res.status(400).json({ error: 'Un quiz est déjà en cours. Arrêtez-le avant d\u2019en lancer un autre.' });
  if (getSetting('quiz_enabled') !== '1') return res.status(400).json({ error: 'Activez d\u2019abord le quiz (bouton Activation ci-dessus).' });
  const qids = db.prepare('SELECT id FROM quiz_questions WHERE active=1 ORDER BY RANDOM() LIMIT ?').all(s.nb_questions).map(q => q.id);
  if (qids.length < s.nb_questions)
    return res.status(400).json({ error: `Pas assez de questions actives (${qids.length} disponibles, ${s.nb_questions} demandées). Ajoutez des questions.` });
  db.prepare("UPDATE quiz_sessions SET status='en_cours', qids=?, started_at=datetime('now'), started_ms=?, paused_elapsed_ms=NULL, paused_at=NULL WHERE id=?").run(JSON.stringify(qids), Date.now(), s.id);
  res.json({ ok: true });
});
// Rejouer / Reprendre : réinitialise les réponses et les statuts, et relance la même série
A.post('/quiz-sessions/:id/rejouer', (req, res) => {
  const s = db.prepare('SELECT * FROM quiz_sessions WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session introuvable.' });
  if (s.status === 'brouillon') return res.status(400).json({ error: 'Lancez d’abord cette session.' });
  if (!(req.body || {}).confirmed) return res.status(400).json({ error: 'Confirmez la réinitialisation : l’historique sera archivé avant le redémarrage.' });
  if (db.prepare("SELECT COUNT(*) n FROM quiz_sessions WHERE status='en_cours' AND id!=?").get(s.id).n) return res.status(400).json({ error: 'Un autre quiz est déjà en cours. Arrêtez-le d’abord.' });
  if (getSetting('quiz_enabled') !== '1') return res.status(400).json({ error: 'Activez d’abord le quiz (bouton Activation ci-dessus).' });
  archiveQuizSession(s, req.user.id, 'Réinitialisation confirmée');
  db.prepare('DELETE FROM quiz_answers WHERE session_id=?').run(s.id);
  db.prepare('DELETE FROM quiz_participants WHERE session_id=?').run(s.id);
  db.prepare('DELETE FROM quiz_messages WHERE session_id=?').run(s.id);
  db.prepare('DELETE FROM quiz_views WHERE session_id=?').run(s.id);
  db.prepare("UPDATE quiz_sessions SET status='en_cours', started_at=datetime('now'), started_ms=?, ended_at=NULL, paused_elapsed_ms=NULL, paused_at=NULL WHERE id=?").run(Date.now(), s.id);
  res.json({ ok: true, archived: true });
});
A.post('/quiz-sessions/:id/pause', (req, res) => {
  const s = db.prepare("SELECT * FROM quiz_sessions WHERE id=? AND status='en_cours'").get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Quiz en cours introuvable.' });
  if (s.paused_at) return res.status(409).json({ error: 'Le quiz est déjà en pause.' });
  const elapsed = Math.max(0, Date.now() - Number(s.started_ms || Date.now()));
  db.prepare("UPDATE quiz_sessions SET paused_elapsed_ms=?, paused_at=datetime('now') WHERE id=?").run(elapsed, s.id);
  res.json({ ok: true, paused: true });
});
A.post('/quiz-sessions/:id/reprendre', (req, res) => {
  const s = db.prepare("SELECT * FROM quiz_sessions WHERE id=? AND status='en_cours'").get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Quiz en cours introuvable.' });
  if (!s.paused_at) return res.status(409).json({ error: 'Le quiz n’est pas en pause.' });
  const elapsed = Math.max(0, Number(s.paused_elapsed_ms || 0));
  db.prepare('UPDATE quiz_sessions SET started_ms=?, paused_elapsed_ms=NULL, paused_at=NULL WHERE id=?').run(Date.now() - elapsed, s.id);
  res.json({ ok: true, paused: false });
});
A.post('/quiz-sessions/:id/arreter', (req, res) => {
  const s = db.prepare('SELECT * FROM quiz_sessions WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session introuvable.' });
  if (s.status !== 'en_cours') return res.status(400).json({ error: 'Cette session n\u2019est pas en cours.' });
  // les participants encore en lice (non éliminés) deviennent finalistes
  db.prepare("UPDATE quiz_participants SET status='finaliste' WHERE session_id=? AND status='en_lice'").run(s.id);
  db.prepare("UPDATE quiz_sessions SET status='terminee', ended_at=datetime('now') WHERE id=?").run(s.id);
  let winners = [];
  if (s.winner_mode === 'auto') {
    winners = db.prepare(`SELECT p.user_id FROM quiz_participants p WHERE p.session_id=? AND p.status='finaliste'
      ORDER BY p.score DESC, p.total_ms ASC, p.id ASC LIMIT ?`).all(s.id, s.nb_winners).map(w => w.user_id);
    const up = db.prepare("UPDATE quiz_participants SET status='gagnant' WHERE session_id=? AND user_id=?");
    winners.forEach(uid => {
      up.run(s.id, uid);
      notify(uid, 'contenu', '🏆 Félicitations, vous avez gagné !', `Vous êtes gagnant(e) du quiz « ${s.title} » ! Ouvrez le quiz pour contacter l\u2019administration.`, '#/quiz');
    });
  }
  res.json({ ok: true, winners });
});
A.get('/quiz-sessions/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM quiz_sessions WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session introuvable.' });
  const participants = db.prepare(`SELECT p.*, u.name, u.phone, u.ville FROM quiz_participants p
    JOIN users u ON u.id=p.user_id WHERE p.session_id=? ORDER BY p.score DESC, p.total_ms ASC`).all(s.id);
  const messages = db.prepare(`SELECT m.*, u.name FROM quiz_messages m JOIN users u ON u.id=m.user_id
    WHERE m.session_id=? ORDER BY m.id`).all(s.id);
  const questions = JSON.parse(s.qids || '[]').map(qid => {
    const q = db.prepare('SELECT id, question, options, answer FROM quiz_questions WHERE id=?').get(qid);
    if (!q) return null;
    const stats = db.prepare('SELECT COUNT(*) n, SUM(correct) ok FROM quiz_answers WHERE session_id=? AND question_id=?').get(s.id, qid);
    return { ...q, options: JSON.parse(q.options), reponses: stats.n || 0, bonnes: stats.ok || 0 };
  }).filter(Boolean);
  res.json({ ...s, elimination: !!s.elimination, counts: s.status === 'en_cours' ? quizLiveCounts(s.id) : { participants: participants.length, spectators: 0, watchers: 0 }, participants, messages, questions });
});
A.get('/quiz-archives', (req, res) => res.json(db.prepare('SELECT id,source_session_id,title,archived_at,archived_by FROM quiz_archives ORDER BY id DESC LIMIT 200').all()));
A.get('/quiz-archives/:id', (req, res) => { const a = db.prepare('SELECT * FROM quiz_archives WHERE id=?').get(req.params.id); if (!a) return res.status(404).json({ error: 'Archive introuvable.' }); res.json({ ...a, snapshot: JSON.parse(a.snapshot) }); });
A.post('/quiz-sessions/:id/gagnants',  (req, res) => {
  const s = db.prepare('SELECT * FROM quiz_sessions WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session introuvable.' });
  if (s.status !== 'terminee') return res.status(400).json({ error: 'Arrêtez d\u2019abord la session.' });
  const ids = Array.isArray(req.body.user_ids) ? req.body.user_ids.map(Number) : [];
  if (!ids.length) return res.status(400).json({ error: 'Sélectionnez au moins un finaliste.' });
  if (ids.length > s.nb_winners) return res.status(400).json({ error: `Maximum ${s.nb_winners} gagnant(s) pour ce quiz.` });
  const finalists = db.prepare("SELECT user_id FROM quiz_participants WHERE session_id=? AND status IN ('finaliste','gagnant')").all(s.id).map(f => f.user_id);
  if (ids.some(id => !finalists.includes(id))) return res.status(400).json({ error: 'Les gagnants doivent être choisis parmi les finalistes.' });
  db.prepare("UPDATE quiz_participants SET status='finaliste' WHERE session_id=? AND status='gagnant'").run(s.id);
  const up = db.prepare("UPDATE quiz_participants SET status='gagnant' WHERE session_id=? AND user_id=?");
  ids.forEach(uid => {
    up.run(s.id, uid);
    notify(uid, 'contenu', '🏆 Félicitations, vous avez gagné !', `Vous êtes gagnant(e) du quiz « ${s.title} » ! Ouvrez le quiz pour contacter l\u2019administration.`, '#/quiz');
  });
  res.json({ ok: true });
});
A.post('/quiz-sessions/:id/message', (req, res) => {
  const p = db.prepare("SELECT * FROM quiz_participants WHERE session_id=? AND user_id=? AND status='gagnant'").get(req.params.id, req.body.user_id);
  if (!p) return res.status(400).json({ error: 'Ce participant n\u2019est pas un gagnant de cette session.' });
  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Écrivez un message.' });
  db.prepare('INSERT INTO quiz_messages(session_id, user_id, from_admin, body) VALUES(?,?,1,?)').run(p.session_id, p.user_id, body);
  notify(p.user_id, 'contenu', '💬 Message de l\u2019administration (quiz)', body.slice(0, 120), '#/quiz');
  res.json({ ok: true });
});
A.post('/quiz-sessions/:id/demander-photo', (req, res) => {
  const p = db.prepare("SELECT * FROM quiz_participants WHERE session_id=? AND user_id=? AND status='gagnant'").get(req.params.id, req.body.user_id);
  if (!p) return res.status(400).json({ error: 'Ce participant n\u2019est pas un gagnant de cette session.' });
  if (p.photo_consent === 'refuse') return res.status(400).json({ error: 'Ce gagnant a refusé : la demande ne peut pas être renvoyée.' });
  if (p.photo_consent === 'accepte') return res.status(400).json({ error: 'Ce gagnant a déjà accepté ✅.' });
  db.prepare('UPDATE quiz_participants SET photo_asked=1 WHERE id=?').run(p.id);
  notify(p.user_id, 'contenu', '📸 Demande de photo', 'L\u2019administration souhaite publier votre photo de gagnant. Ouvrez le quiz pour accepter ou refuser.', '#/quiz');
  res.json({ ok: true });
});
A.get('/game-plays', (req, res) => res.json(db.prepare('SELECT g.*, u.name, u.phone FROM game_plays g JOIN users u ON u.id=g.user_id ORDER BY g.id DESC LIMIT 200').all()));
A.get('/kdo', (req, res) => res.json(db.prepare('SELECT k.*, u.name used_by_name FROM kdo_codes k LEFT JOIN users u ON u.id=k.used_by ORDER BY k.id DESC').all()));
A.post('/kdo', (req, res) => {
  const { code, reward } = req.body || {};
  if (!code || !reward) return res.status(400).json({ error: 'Code et récompense requis.' });
  try { const info = db.prepare('INSERT INTO kdo_codes(code, reward) VALUES(?,?)').run(code.toUpperCase(), reward); res.json({ id: info.lastInsertRowid }); }
  catch { res.status(409).json({ error: 'Ce code existe déjà.' }); }
});
A.delete('/kdo/:id', (req, res) => { db.prepare('DELETE FROM kdo_codes WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// GESTION DES FICHIERS — les contenus de demandes, conversations et support sont regroupés
// par CLIENT. On ne déduit jamais un propriétaire à partir d'un nom de fichier aléatoire.
function uploadName(file) {
  if (!file || typeof file !== 'string' || !file.startsWith('/uploads/')) return null;
  const name = path.basename(file);
  return name && name === file.slice('/uploads/'.length) ? name : null;
}
function safeDownloadStem(s) {
  return String(s || 'client').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'client';
}
function contentKind(type) { return type === 'audio' ? 'audio' : type === 'photo' || type === 'image' ? 'image' : 'texte'; }
function parsePhotos(raw) { try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a.filter(uploadName) : []; } catch { return []; } }
function clientContentRows(clientId, max = 1000) {
  const out = [];
  // Demande initiale : texte, photos et vocal éventuel.
  const missions = db.prepare(`SELECT m.id, m.code, m.description, m.photos, m.audio, m.created_at, s.name service_name
    FROM missions m JOIN services s ON s.id=m.service_id WHERE m.client_id=? ORDER BY m.id DESC`).all(clientId);
  for (const m of missions) {
    if ((m.description || '').trim()) out.push({ source: 'mission', id: m.id, type: 'texte', content: m.description, created_at: m.created_at, label: `Demande ${m.code} — ${m.service_name}` });
    if (uploadName(m.audio)) out.push({ source: 'mission-audio', id: m.id, type: 'audio', file: m.audio, created_at: m.created_at, label: `Vocal de la demande ${m.code}` });
    parsePhotos(m.photos).forEach((file, index) => out.push({ source: 'mission-photo', id: `${m.id}-${index}`, type: 'image', file, created_at: m.created_at, label: `Photo de la demande ${m.code}` }));
  }
  // Messages client/pro : même lorsqu'un professionnel est l'expéditeur, le fil reste rangé sous le client de la mission.
  db.prepare(`SELECT msg.id, msg.type, msg.content, msg.file, msg.created_at, m.code, s.name service_name
    FROM messages msg JOIN missions m ON m.id=msg.mission_id JOIN services s ON s.id=m.service_id
    WHERE m.client_id=? ORDER BY msg.id DESC`).all(clientId).forEach(m => {
      const type = contentKind(m.type);
      if (type === 'texte' && !(m.content || '').trim()) return;
      if (type !== 'texte' && !uploadName(m.file)) return;
      out.push({ source: 'message', id: m.id, type, content: type === 'texte' ? m.content : null, file: type !== 'texte' ? m.file : null, created_at: m.created_at, label: `Discussion ${m.code} — ${m.service_name}` });
    });
  // Contact direct Klean Services : suggestion/préoccupation et leurs vocaux éventuels.
  db.prepare(`SELECT sm.id, sm.type, sm.content, sm.file, sm.created_at, sc.subject
    FROM support_messages sm JOIN support_conversations sc ON sc.id=sm.conversation_id
    WHERE sc.user_id=? ORDER BY sm.id DESC`).all(clientId).forEach(m => {
      const type = contentKind(m.type);
      if (type === 'texte' && !(m.content || '').trim()) return;
      if (type !== 'texte' && !uploadName(m.file)) return;
      out.push({ source: 'support', id: m.id, type, content: type === 'texte' ? m.content : null, file: type !== 'texte' ? m.file : null, created_at: m.created_at, label: `Contact Klean Services — ${m.subject === 'suggestion' ? 'Suggestion' : 'Préoccupation'}` });
    });
  return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, Math.max(1, Math.min(3000, max)));
}
function clientContentSummary(clientId) {
  const items = clientContentRows(clientId, 3000);
  return { items, texts: items.filter(i => i.type === 'texte').length, audios: items.filter(i => i.type === 'audio').length, images: items.filter(i => i.type === 'image').length, files: items.filter(i => i.file).length };
}
function physicalFilesList() {
  return fs.readdirSync(UPLOAD_DIR).map(f => {
    const st = fs.statSync(path.join(UPLOAD_DIR, f));
    return { name: f, size: st.size, mtime: st.mtime, age_days: Math.floor((Date.now() - st.mtimeMs) / 86400000) };
  }).sort((a, b) => b.mtime - a.mtime);
}
function filesInventory() {
  const files = physicalFilesList();
  return { total: files.length, total_size: files.reduce((s, f) => s + f.size, 0), retention_days: parseInt(getSetting('file_retention_days', '90'), 10) };
}
function clientFilterWhere(q, type, from, to) {
  const params = [];
  const dateParts = [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(from || '')) dateParts.push("created_at >= ?"), params.push(from + ' 00:00:00');
  if (/^\d{4}-\d{2}-\d{2}$/.test(to || '')) dateParts.push("created_at < datetime(?, '+1 day')"), params.push(to);
  const when = dateParts.length ? ' AND ' + dateParts.join(' AND ') : '';
  const typeSql = type === 'audio'
    ? `(EXISTS(SELECT 1 FROM missions m WHERE m.client_id=u.id AND m.audio IS NOT NULL AND m.audio!=''${when}) OR EXISTS(SELECT 1 FROM messages x JOIN missions m ON m.id=x.mission_id WHERE m.client_id=u.id AND x.type='audio'${when.replace(/created_at/g, 'x.created_at')}) OR EXISTS(SELECT 1 FROM support_messages x JOIN support_conversations sc ON sc.id=x.conversation_id WHERE sc.user_id=u.id AND x.type='audio'${when.replace(/created_at/g, 'x.created_at')}))`
    : type === 'image'
      ? `(EXISTS(SELECT 1 FROM missions m WHERE m.client_id=u.id AND m.photos IS NOT NULL AND m.photos!='[]'${when}) OR EXISTS(SELECT 1 FROM messages x JOIN missions m ON m.id=x.mission_id WHERE m.client_id=u.id AND x.type='photo'${when.replace(/created_at/g, 'x.created_at')}))`
      : type === 'texte'
        ? `(EXISTS(SELECT 1 FROM missions m WHERE m.client_id=u.id AND m.description IS NOT NULL AND trim(m.description)!=''${when}) OR EXISTS(SELECT 1 FROM messages x JOIN missions m ON m.id=x.mission_id WHERE m.client_id=u.id AND x.type='text' AND trim(x.content)!=''${when.replace(/created_at/g, 'x.created_at')}) OR EXISTS(SELECT 1 FROM support_messages x JOIN support_conversations sc ON sc.id=x.conversation_id WHERE sc.user_id=u.id AND x.type='text' AND trim(x.content)!=''${when.replace(/created_at/g, 'x.created_at')}))`
        : `(EXISTS(SELECT 1 FROM missions m WHERE m.client_id=u.id${when}) OR EXISTS(SELECT 1 FROM messages x JOIN missions m ON m.id=x.mission_id WHERE m.client_id=u.id${when.replace(/created_at/g, 'x.created_at')}) OR EXISTS(SELECT 1 FROM support_messages x JOIN support_conversations sc ON sc.id=x.conversation_id WHERE sc.user_id=u.id${when.replace(/created_at/g, 'x.created_at')}))`;
  // Les paramètres de date sont répétés pour chaque sous-requête EXISTS qui les utilise.
  const repeats = type === 'image' ? 2 : 3;
  const dateParams = Array.from({ length: repeats }, () => params).flat();
  const conditions = [typeSql];
  if (q) {
    const like = '%' + q.toLowerCase() + '%';
    conditions.push(`(lower(u.name) LIKE ? OR lower(COALESCE(u.phone,'')) LIKE ? OR EXISTS(SELECT 1 FROM missions m WHERE m.client_id=u.id AND lower(COALESCE(m.description,'')) LIKE ?) OR EXISTS(SELECT 1 FROM messages x JOIN missions m ON m.id=x.mission_id WHERE m.client_id=u.id AND lower(COALESCE(x.content,'')) LIKE ?) OR EXISTS(SELECT 1 FROM support_messages x JOIN support_conversations sc ON sc.id=x.conversation_id WHERE sc.user_id=u.id AND lower(COALESCE(x.content,'')) LIKE ?))`);
    dateParams.push(like, like, like, like, like);
  }
  return { where: conditions.join(' AND '), params: dateParams };
}
A.get('/files/clients', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  const type = ['all', 'texte', 'audio', 'image'].includes(req.query.type) ? req.query.type : 'all';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1), limit = Math.min(50, Math.max(10, parseInt(req.query.limit, 10) || 25));
  const filter = clientFilterWhere(q, type, String(req.query.from || ''), String(req.query.to || ''));
  const total = db.prepare(`SELECT COUNT(*) n FROM users u WHERE u.role='user' AND ${filter.where}`).get(...filter.params).n;
  const users = db.prepare(`SELECT u.id, u.name, u.phone, u.ville, u.quartier FROM users u WHERE u.role='user' AND ${filter.where} ORDER BY u.name COLLATE NOCASE ASC LIMIT ? OFFSET ?`).all(...filter.params, limit, (page - 1) * limit);
  const clients = users.map(u => ({ ...u, ...clientContentSummary(u.id) }));
  res.json({ ...filesInventory(), clients, total_clients: total, page, limit, pages: Math.max(1, Math.ceil(total / limit)), q, type });
});
A.get('/files/clients/:id', (req, res) => {
  const client = db.prepare("SELECT id, name, phone, ville, quartier FROM users WHERE id=? AND role='user'").get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client introuvable.' });
  const summary = clientContentSummary(client.id);
  res.json({ client, ...summary });
});
async function storedUpload(name) {
  const disk = path.join(UPLOAD_DIR, name);
  if (fs.existsSync(disk)) return fs.readFileSync(disk);
  if (persist.enabled()) return await persist.loadFile(name);
  return null;
}
function sendDownload(res, data, name, mime = 'application/octet-stream') {
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', data.length);
  res.setHeader('Content-Disposition', `attachment; filename="${safeDownloadStem(name).slice(0, 90)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(data);
}
function clientMediaItem(clientId, name) {
  const clean = uploadName('/uploads/' + path.basename(name));
  if (!clean) return null;
  return clientContentRows(clientId, 3000).find(i => uploadName(i.file) === clean) || null;
}
A.get('/files/clients/:id/media/:name/download', async (req, res) => {
  const client = db.prepare("SELECT id, name FROM users WHERE id=? AND role='user'").get(req.params.id);
  const item = client && clientMediaItem(client.id, req.params.name);
  if (!client || !item) return res.status(404).json({ error: 'Fichier associé au client introuvable.' });
  const name = uploadName(item.file), data = await storedUpload(name);
  if (!data) return res.status(404).json({ error: 'Le fichier n’est plus disponible.' });
  const ext = path.extname(name) || (item.type === 'audio' ? '.m4a' : '.jpg');
  sendDownload(res, data, `${safeDownloadStem(client.name)}_${item.type}_${String(item.created_at || '').slice(0, 10)}${ext}`);
});
A.get('/files/clients/:id/text/:source/:itemId/download', (req, res) => {
  const client = db.prepare("SELECT id, name FROM users WHERE id=? AND role='user'").get(req.params.id);
  const item = client && clientContentRows(client.id, 3000).find(i => !i.file && i.source === req.params.source && String(i.id) === String(req.params.itemId));
  if (!client || !item) return res.status(404).json({ error: 'Texte associé au client introuvable.' });
  const body = `Klean Services — ${item.label}
Client : ${client.name}
Date : ${item.created_at || ''}

${item.content || ''}
`;
  sendDownload(res, Buffer.from(body, 'utf8'), `${safeDownloadStem(client.name)}_texte_${String(item.created_at || '').slice(0, 10)}.txt`, 'text/plain; charset=utf-8');
});
// ZIP « sans compression » généré en Node, sans dépendance externe : photos/audios + export des textes.
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zipStore(entries) {
  let offset = 0; const locals = [], centrals = [];
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name); offset += local.length + name.length + data.length;
  }
  const centralBytes = centrals.reduce((n, b) => n + b.length, 0), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBytes, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}
A.get('/files/clients/:id/download', async (req, res) => {
  const client = db.prepare("SELECT id, name, phone FROM users WHERE id=? AND role='user'").get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client introuvable.' });
  const items = clientContentRows(client.id, 3000), entries = [];
  const texts = items.filter(i => !i.file && i.content).map(i => `[${i.created_at || ''}] ${i.label}\n${i.content}`).join('\n\n');
  entries.push({ name: 'messages-et-textes.txt', data: Buffer.from(`Klean Services — échanges de ${client.name}

${texts || 'Aucun texte.'}
`, 'utf8') });
  const seen = new Set(); let totalBytes = entries[0].data.length;
  for (const item of items.filter(i => i.file)) {
    const source = uploadName(item.file); if (!source || seen.has(source)) continue; seen.add(source);
    const data = await storedUpload(source); if (!data) continue;
    totalBytes += data.length;
    if (totalBytes > 200 * 1024 * 1024) return res.status(413).json({ error: 'Téléchargement trop volumineux (maximum 200 Mo). Téléchargez les éléments individuellement.' });
    const ext = path.extname(source) || (item.type === 'audio' ? '.m4a' : '.jpg');
    entries.push({ name: `${safeDownloadStem(client.name)}_${item.type}_${String(item.created_at || '').slice(0, 10)}_${entries.length}${ext}`, data });
  }
  sendDownload(res, zipStore(entries), `klean-services_${safeDownloadStem(client.name)}_echanges.zip`, 'application/zip');
});
// Cycle de vie vérifiable des fichiers : les références DB restent conservées, seul le binaire est
// réellement purgé après la période de récupération. Toutes ces routes sont derrière permission « sécurité ».
function fileRecord(name) { return db.prepare('SELECT * FROM file_records WHERE name=?').get(name); }
function ensureFileRecord(name) {
  let r = fileRecord(name); if (r) return r;
  const disk = path.join(UPLOAD_DIR, name); const size = fs.existsSync(disk) ? fs.statSync(disk).size : 0;
  db.prepare("INSERT OR IGNORE INTO file_records(name, size, state, note) VALUES(?,?,'active','Référencé avant l’activation du registre')").run(name, size);
  return fileRecord(name);
}
function fileProtectedReferences(name) {
  const active = ['acceptee', 'confirmee', 'en_cours', 'terminee', 'litige'];
  const marks = active.map(() => '?').join(',');
  const missions = db.prepare(`SELECT id, code, photos, audio FROM missions WHERE status IN (${marks}) AND (photos LIKE ? OR audio LIKE ?)`).all(...active, '%/uploads/' + name, '%/uploads/' + name)
    .filter(m => fileHasName(m.photos, name) || path.basename(m.audio || '') === name)
    .map(m => 'mission ' + m.code);
  const messages = db.prepare(`SELECT m.id, m.code FROM messages msg JOIN missions m ON m.id=msg.mission_id WHERE m.status IN (${marks}) AND msg.file LIKE ?`).all(...active, '%/uploads/' + name)
    .filter(m => !!m).map(m => 'conversation de la mission ' + m.code);
  return [...new Set([...missions, ...messages])];
}
async function purgeStoredFile(name, note) {
  const clean = uploadName('/uploads/' + name); if (!clean) throw new Error('Nom de fichier invalide.');
  try { fs.unlinkSync(path.join(UPLOAD_DIR, clean)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (persist.enabled()) await persist.deleteFile(clean).catch(() => {});
  db.prepare("UPDATE file_records SET state='purged', deleted_at=datetime('now'), delete_after=NULL, note=COALESCE(?,note), updated_at=datetime('now') WHERE name=?").run(note || null, clean);
}
A.get('/files/records', (req, res) => {
  const state = ['all','active','hidden','archived','recovery','purged'].includes(String(req.query.state || 'all')) ? String(req.query.state || 'all') : 'all';
  const q = String(req.query.q || '').trim().slice(0, 120);
  const where = [], args = [];
  if (state !== 'all') where.push('f.state=?'), args.push(state);
  if (q) { where.push("(lower(f.name) LIKE ? OR lower(COALESCE(u.name,'')) LIKE ?)"), args.push('%' + q.toLowerCase() + '%', '%' + q.toLowerCase() + '%'); }
  const sql = `SELECT f.*, u.name uploader_name FROM file_records f LEFT JOIN users u ON u.id=f.uploaded_by ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY f.id DESC LIMIT 300`;
  res.json({ records: db.prepare(sql).all(...args), recovery_days: settingInt('file_recovery_days', 7, 0, 365) });
});
A.post('/files/:name/state', async (req, res) => {
  const name = uploadName('/uploads/' + req.params.name);
  const state = String((req.body || {}).state || '');
  const note = String((req.body || {}).note || '').trim().slice(0, 500) || null;
  if (!name || !['active','hidden','archived','recovery','purged'].includes(state)) return res.status(400).json({ error: 'État de fichier invalide.' });
  const current = ensureFileRecord(name);
  if (state === 'purged') {
    if (!(req.body || {}).confirmed) return res.status(400).json({ error: 'Confirmez la suppression définitive : elle est irréversible.' });
    if (!['recovery', 'archived'].includes(current.state)) return res.status(409).json({ error: 'Archivez ou placez d’abord ce fichier en récupération avant une suppression définitive.' });
    const refs = fileProtectedReferences(name);
    if (refs.length) return res.status(409).json({ error: 'Suppression refusée : ce fichier est encore requis par ' + refs.join(', ') + '.' });
    await purgeStoredFile(name, note || 'Suppression définitive confirmée depuis le tableau de bord');
    return res.json({ ok: true, state: 'purged' });
  }
  if (state === 'recovery') {
    const days = settingInt('file_recovery_days', 7, 0, 365);
    const after = new Date(Date.now() + days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    db.prepare("UPDATE file_records SET state='recovery', archived_at=COALESCE(archived_at,datetime('now')), delete_after=?, note=?, updated_at=datetime('now') WHERE name=?").run(after, note, name);
  } else {
    db.prepare("UPDATE file_records SET state=?, hidden_at=CASE WHEN ?='hidden' THEN datetime('now') ELSE hidden_at END, archived_at=CASE WHEN ?='archived' THEN datetime('now') ELSE archived_at END, delete_after=NULL, note=?, updated_at=datetime('now') WHERE name=?").run(state, state, state, note, name);
  }
  res.json({ ok: true, state, record: fileRecord(name), previous_state: current.state });
});
A.get('/files/records/download', async (req, res) => {
  const requested = String(req.query.names || '').split(',').map(n => uploadName('/uploads/' + n)).filter(Boolean);
  const all = String(req.query.all || '') === '1';
  const names = all ? db.prepare("SELECT name FROM file_records WHERE state!='purged' ORDER BY id DESC LIMIT 300").all().map(r => r.name) : [...new Set(requested)].slice(0, 200);
  if (!names.length) return res.status(400).json({ error: 'Sélectionnez au moins un fichier disponible.' });
  const entries = []; let bytes = 0;
  for (const name of names) {
    const r = fileRecord(name); if (!r || r.state === 'purged') continue;
    const data = await storedUpload(name); if (!data) continue;
    bytes += data.length; if (bytes > 200 * 1024 * 1024) return res.status(413).json({ error: 'Archive trop volumineuse (maximum 200 Mo). Réduisez la sélection.' });
    entries.push({ name, data });
  }
  if (!entries.length) return res.status(404).json({ error: 'Aucun binaire disponible dans cette sélection.' });
  sendDownload(res, zipStore(entries), 'klean-services-fichiers-selection.zip', 'application/zip');
});
async function purgeRecoveryFiles() {
  const due = db.prepare("SELECT name FROM file_records WHERE state='recovery' AND delete_after IS NOT NULL AND delete_after <= datetime('now')").all();
  let purged = 0;
  for (const r of due) {
    const refs = fileProtectedReferences(r.name);
    if (refs.length) { // une mission/litige devenu actif protège à nouveau le fichier ; on reporte la purge.
      db.prepare("UPDATE file_records SET delete_after=datetime('now','+1 day'), note=? WHERE name=?").run('Purge reportée : fichier encore requis par ' + refs.join(', '), r.name);
      continue;
    }
    await purgeStoredFile(r.name, 'Délai de récupération expiré'); purged++;
  }
  return purged;
}

// Compatibilité API : l'ancien inventaire technique reste disponible, même si le dashboard utilise désormais le classement par client.
A.get('/files', (req, res) => { const files = physicalFilesList(); res.json({ files: files.slice(0, 300), total: files.length, total_size: files.reduce((s, f) => s + f.size, 0), retention_days: parseInt(getSetting('file_retention_days', '90'), 10) }); });
A.post('/files/cleanup', async (req, res) => res.json({ deleted: await purgeRecoveryFiles(), legacy_deleted: cleanupFiles() }));

app.use('/api/admin', A);

// Nettoyage automatique des fichiers (durée configurable par l'administration)
function cleanupFiles() {
  // Compatibilité : les anciens fichiers non encore inscrits restent soumis à la durée historique.
  // Les fichiers inscrits suivent le cycle active/archived/recovery et ne sont jamais supprimés sans délai.
  const days = parseInt(getSetting('file_retention_days', '90'), 10);
  if (!days || days < 1) return 0;
  const cutoff = Date.now() - days * 86400000; let deleted = 0;
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const tracked = fileRecord(f); if (tracked) continue;
    const fp = path.join(UPLOAD_DIR, f);
    try { if (fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); deleted++; } } catch {}
  }
  purgeRecoveryFiles().catch(() => {});
  // Les binaires PostgreSQL inscrits sont supprimés individuellement par purgeStoredFile après récupération.
  // On ne lance pas de purge globale distante, afin de ne pas contourner l’archive/récupération.
  return deleted;
}
setInterval(cleanupFiles, 12 * 3600 * 1000);

// Reprise des missions en recherche après redémarrage du serveur
for (const m of db.prepare("SELECT id FROM missions WHERE status='recherche'").all()) {
  const offered = db.prepare("SELECT 1 FROM mission_candidates WHERE mission_id=? AND status='offered'").get(m.id);
  if (offered) {
    const wait = Math.max(15, parseInt(getSetting('dispatch_wait_seconds', '60'), 10)) * 1000;
    startDispatchReminders(m.id);
    dispatchTimers.set(m.id, setTimeout(() => {
      const stale = db.prepare("SELECT pro_id FROM mission_candidates WHERE mission_id=? AND status='offered'").all(m.id);
      db.prepare("UPDATE mission_candidates SET status='expired' WHERE mission_id=? AND status='offered'").run(m.id);
      stale.forEach(row => clearAlertStatus(row.pro_id));
      clearDispatchTimers(m.id);
      offerNext(m.id);
    }, wait));
  } else offerNext(m.id);
}

// ---------- STATIQUE + AUTO-DIAGNOSTIC DES FICHIERS ----------
const REQUIRED_FILES = [
  'public/index.html', 'public/app.js', 'public/styles.css', 'public/modern-ui.css', 'public/category-request.css', 'public/sw.js',
  'public/manifest.json', 'public/admin/index.html', 'public/admin/admin.js', 'public/admin/admin.css'
];
const missingFiles = REQUIRED_FILES.filter(f => !fs.existsSync(path.join(__dirname, f)));
if (missingFiles.length) {
  console.error('⚠️  ATTENTION : fichiers manquants sur le serveur (structure du dépôt incomplète) :');
  missingFiles.forEach(f => console.error('   ✗ ' + f));
  console.error('   → Vérifiez que les dossiers public/ et public/admin/ ont bien été envoyés sur GitHub.');
}
function diagnosticPage(res) {
  res.status(500).send(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><title>Installation incomplète</title>
  <style>body{font-family:Arial,sans-serif;background:#0b7a6b;color:#fff;padding:30px;line-height:1.6}
  .box{background:rgba(0,0,0,.25);border-radius:14px;padding:20px;max-width:560px;margin:0 auto}
  code{background:rgba(255,255,255,.15);padding:2px 7px;border-radius:5px;display:inline-block;margin:2px 0}</style></head>
  <body><div class="box"><h2>⚠️ Installation incomplète</h2>
  <p>Le serveur Klean Services fonctionne, mais ces fichiers n'ont pas été trouvés :</p>
  <p>${missingFiles.map(f => '<code>' + f + '</code>').join('<br>')}</p>
  <p><b>Solution :</b> envoyez les dossiers <code>public/</code> et <code>public/admin/</code> complets
  dans votre dépôt GitHub (à côté de <code>server.js</code>), puis redéployez.</p></div></body></html>`);
}
app.use(express.static(path.join(__dirname, 'public')));
app.get(/^\/admin(\/.*)?$/, (req, res) => {
  const f = path.join(__dirname, 'public/admin/index.html');
  if (!fs.existsSync(f)) return diagnosticPage(res);
  res.sendFile(f);
});
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Ressource introuvable.' });
  const f = path.join(__dirname, 'public/index.html');
  if (!fs.existsSync(f)) return diagnosticPage(res);
  res.sendFile(f);
});
app.use((err, req, res, next) => {
  console.error('Erreur serveur :', err && err.message ? err.message : err);
  if (req.path && req.path.startsWith('/api/')) return res.status(500).json({ error: 'Une erreur est survenue. Veuillez réessayer.' });
  diagnosticPage(res);
});

app.listen(PORT, '0.0.0.0', () => console.log('Klean Services en écoute sur le port ' + PORT));
