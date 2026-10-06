// ============================================================
// KLEAN-SERVICES CI — Serveur (Express + SQLite + SSE)
// ============================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { db, hashPassword, getSetting, setSetting, DB_PATH } = require('./db');
const persist = require('./persist'); // sauvegarde PostgreSQL (activée si DATABASE_URL est définie)

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '2mb' }));

// Secret de session persistant
let SECRET = getSetting('auth_secret');
if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); setSetting('auth_secret', SECRET); }

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
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
// Si un fichier manque en local (après redéploiement), on le restaure depuis PostgreSQL
app.use('/uploads/:name', async (req, res, next) => {
  if (!persist.enabled()) return res.status(404).end();
  try {
    const name = path.basename(req.params.name);
    const data = await persist.loadFile(name);
    if (!data) return res.status(404).end();
    fs.writeFileSync(path.join(UPLOAD_DIR, name), data); // remis en cache local
    res.sendFile(path.join(UPLOAD_DIR, name));
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
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Session expirée. Veuillez vous reconnecter.' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(payload.id);
  if (!user) return res.status(401).json({ error: 'Compte introuvable.' });
  if (user.role !== 'pdg') { // le compte PDG reste TOUJOURS accessible
    if (user.blocked) return res.status(403).json({ error: 'Votre compte est bloqué. Contactez Klean-Services CI.' });
    if (user.suspended) return res.status(403).json({ error: 'Votre compte est suspendu. Contactez Klean-Services CI.' });
    if (user.disabled_until && user.disabled_until > new Date().toISOString().slice(0, 19).replace('T', ' '))
      return res.status(403).json({ error: 'Votre compte est temporairement désactivé jusqu\u2019au ' + user.disabled_until.slice(0, 16).replace('T', ' ') + '.' });
  }
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
  journal: 'Journal des actions',
};
// Valeurs par défaut par rôle (modifiables par le PDG, compte par compte)
const DEFAULT_PERMS = {
  pdg: Object.keys(PERM_KEYS),
  admin: Object.keys(PERM_KEYS).filter(k => k !== 'comptes_suppr'),
  gestionnaire: ['comptes', 'pros', 'missions', 'contenu'],
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
function notify(userId, category, title, body, link) {
  const info = db.prepare('INSERT INTO notifications(user_id, category, title, body, link) VALUES(?,?,?,?,?)').run(userId, category, title, body || '', link || '');
  const unread = db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0').get(userId).n;
  push(userId, 'notification', { id: info.lastInsertRowid, category, title, body, link, unread });
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
  return m.message || 'Klean-Services est temporairement en maintenance. Nous revenons très vite. Merci de votre patience.';
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
  const { name, phone, password, address, ville, quartier, lat, lng, accept_rules } = req.body || {};
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
  notify(user.id, 'compte', 'Bienvenue sur Klean-Services CI 👋', 'Votre compte est créé. Recherchez un service ou devenez professionnel depuis Mon compte.', '#/home');
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
    if (user.blocked) return res.status(403).json({ error: 'Votre compte est bloqué. Contactez Klean-Services CI.' });
    if (user.suspended) return res.status(403).json({ error: 'Votre compte est suspendu. Contactez Klean-Services CI.' });
    if (user.disabled_until && user.disabled_until > new Date().toISOString().slice(0, 19).replace('T', ' '))
      return res.status(403).json({ error: 'Votre compte est temporairement désactivé jusqu\u2019au ' + user.disabled_until.slice(0, 16) + '.' });
  }
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
    pro: pro ? { ...pro, services: JSON.parse(pro.services), documents: JSON.parse(pro.documents) } : null,
    perms: isStaff(u) ? effectivePerms(u) : undefined
  };
}
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
  if (recentes >= 3) return res.status(429).json({ error: 'Trop de demandes. Réessayez dans une heure ou contactez Klean-Services CI.' });
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
  notify(user.id, 'compte', '🔑 Mot de passe modifié', 'Votre mot de passe a été modifié grâce au code de vérification. Si ce n\u2019était pas vous, contactez immédiatement Klean-Services CI.', '#/account');
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
  if (persist.enabled()) {
    try {
      for (const f of req.files) await persist.saveFile(f.filename, fs.readFileSync(f.path));
    } catch (e) { console.error('Copie PostgreSQL du fichier échouée :', e.message); }
  }
  res.json({ files: req.files.map(f => '/uploads/' + f.filename) });
});

// Règles (textes gérés par l'administration)
app.get('/api/rules', (req, res) => res.json({ client: getSetting('rules_client'), pro: getSetting('rules_pro') }));

// ============================================================
// SERVICES & RECHERCHE INTELLIGENTE
// ============================================================
function normalize(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ');
}
app.get('/api/services', (req, res) => {
  const cats = db.prepare('SELECT * FROM service_categories WHERE active=1 ORDER BY sort,id').all();
  const svcs = db.prepare('SELECT id, category_id, sub_id, name, sort, popular, seasonal, cities, price_from, price_prefix, price_show FROM services WHERE active=1 ORDER BY sort,id').all()
    .filter(s => villeOk(s, req.query.ville));
  res.json(cats.map(c => ({ ...c, services: svcs.filter(s => s.category_id === c.id) })).filter(c => c.services.length));
});
// Un service est-il proposé dans la ville demandée ? ([] = partout)
function villeOk(s, ville) {
  if (!ville) return true;
  const cities = typeof s.cities === 'string' ? JSON.parse(s.cities || '[]') : (s.cities || []);
  return !cities.length || cities.some(c => normalize(c) === normalize(ville));
}
// Catalogue complet : CATÉGORIES → SERVICES (avec leurs tâches)
app.get('/api/catalogue', (req, res) => {
  const cats = db.prepare('SELECT * FROM service_categories WHERE active=1 ORDER BY sort,id').all();
  const svcs = db.prepare('SELECT * FROM services WHERE active=1 ORDER BY sort,id').all().filter(s => villeOk(s, req.query.ville));
  const tas = db.prepare('SELECT * FROM taches WHERE active=1 ORDER BY sort,id').all();
  res.json(cats.map(c => ({
    id: c.id, name: c.name, icon: c.icon,
    services: svcs.filter(s => s.category_id === c.id).map(s => ({
      id: s.id, name: s.name, popular: s.popular, seasonal: s.seasonal,
      price_from: s.price_from, price_prefix: s.price_prefix, price_show: s.price_show,
      taches: tas.filter(t => t.service_id === s.id).map(t => ({ id: t.id, name: t.name }))
    }))
  })).filter(c => c.services.length));
});
// Services populaires (accueil) — sélection de la même liste de services,
// dans l'ordre choisi par l'administration (popular_sort)
app.get('/api/services/populaires', (req, res) => {
  const svcs = db.prepare(`SELECT s.id, s.name, s.cities, s.price_from, s.price_prefix, s.price_show, c.icon, c.name cat FROM services s
    JOIN service_categories c ON c.id=s.category_id
    WHERE s.active=1 AND c.active=1 AND s.popular=1
    ORDER BY CASE WHEN s.popular_sort IS NULL THEN 1 ELSE 0 END, s.popular_sort, s.sort, s.id LIMIT 12`).all()
    .filter(s => villeOk(s, req.query.ville)).map(({ cities, ...s }) => s);
  res.json(svcs);
});
// Villes de Côte d'Ivoire (liste sélectionnable, avec recherche côté application)
app.get('/api/villes', (req, res) => {
  res.json(db.prepare('SELECT name FROM villes WHERE active=1 ORDER BY name').all().map(v => v.name));
});
app.get('/api/services/:id/questions', (req, res) => {
  const svc = db.prepare('SELECT s.*, c.name cat FROM services s JOIN service_categories c ON c.id=s.category_id WHERE s.id=? AND s.active=1').get(req.params.id);
  if (!svc) return res.status(404).json({ error: 'Service introuvable.' });
  const questions = db.prepare('SELECT * FROM service_questions WHERE service_id=? AND active=1 ORDER BY sort,id').all(svc.id)
    .map(q => ({ ...q, options: JSON.parse(q.options) }));
  const taches = db.prepare('SELECT id, name FROM taches WHERE service_id=? AND active=1 ORDER BY sort,id').all(svc.id);
  res.json({ service: { id: svc.id, name: svc.name, category: svc.cat, price_from: svc.price_from, price_prefix: svc.price_prefix, price_show: svc.price_show }, questions, taches });
});
const STOPWORDS = new Set(['je', 'cherche', 'un', 'une', 'des', 'le', 'la', 'les', 'de', 'du', 'mon', 'ma', 'mes', 'pour', 'a', 'au', 'en', 'et', 'faire', 'veux', 'voudrais', 'besoin', 'il', 'me', 'faut', 'quelqu', 'qui', 'peut', 'sait']);
app.get('/api/search', (req, res) => {
  const words = normalize(req.query.q).split(/\s+/).filter(w => w.length > 1 && !STOPWORDS.has(w));
  const svcs = db.prepare(`SELECT s.*, c.name cat, c.icon, sc.name sous_cat FROM services s
    JOIN service_categories c ON c.id=s.category_id
    LEFT JOIN sous_categories sc ON sc.id=s.sub_id
    WHERE s.active=1 AND c.active=1`).all().filter(s => villeOk(s, req.query.ville));
  const tachesBySvc = {};
  db.prepare('SELECT service_id, name FROM taches WHERE active=1').all()
    .forEach(t => { (tachesBySvc[t.service_id] = tachesBySvc[t.service_id] || []).push(t.name); });
  const scored = svcs.map(s => {
    const tches = tachesBySvc[s.id] || [];
    const hay = normalize(s.name + ' ' + s.cat + ' ' + (s.sous_cat || '') + ' ' + s.keywords.replace(/,/g, ' ') + ' ' + tches.join(' '));
    const hayWords = hay.split(/\s+/);
    let score = 0;
    for (const w of words) {
      if (hayWords.includes(w)) score += 3;
      else if (hayWords.some(h => h.startsWith(w) || w.startsWith(h) && h.length > 2)) score += 1;
    }
    // La tâche qui correspond le mieux à la recherche est proposée au client
    let tache = null;
    for (const t of tches) { if (words.some(w => normalize(t).includes(w))) { tache = t; break; } }
    return { id: s.id, name: s.name, category: s.cat, icon: s.icon, price_from: s.price_from, price_prefix: s.price_prefix, price_show: s.price_show, tache_suggeree: tache, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);
  res.json({ results: scored, query: req.query.q || '' });
});

// ============================================================
// ESPACE PROFESSIONNEL
// ============================================================
app.post('/api/pro/apply', auth, (req, res) => {
  const { profession, description, experience, zone, services, documents, accept_rules } = req.body || {};
  const proType = req.body.pro_type === 'entreprise' ? 'entreprise' : 'particulier';
  if (req.user.pro_status === 'approved') return res.status(400).json({ error: 'Vous êtes déjà professionnel.' });
  if (req.user.pro_status === 'pending') return res.status(400).json({ error: 'Votre demande est déjà en cours de validation.' });
  if (!profession || !profession.trim()) return res.status(400).json({ error: proType === 'entreprise' ? 'Indiquez le domaine d\u2019activité de l\u2019entreprise.' : 'Indiquez votre profession.' });
  if (!Array.isArray(services) || !services.length) return res.status(400).json({ error: 'Sélectionnez au moins un service proposé.' });
  if (!zone || !zone.trim()) return res.status(400).json({ error: 'Indiquez votre zone d\u2019intervention.' });
  if (!accept_rules) return res.status(400).json({ error: 'Vous devez accepter les règles professionnelles.' });
  const companyName = (req.body.company_name || '').trim();
  if (proType === 'entreprise' && !companyName) return res.status(400).json({ error: 'Indiquez le nom de votre entreprise.' });
  // Condition de validation activable depuis le tableau de bord : justificatif requis selon le type de compte
  if (getSetting('pro_doc_' + proType) === '1' && !(Array.isArray(documents) && documents.length))
    return res.status(400).json({ error: proType === 'entreprise'
      ? 'Un document justificatif est requis pour un compte Entreprise (registre de commerce, pièce du responsable…).'
      : 'Un document justificatif est requis (CNI, attestation…).' });
  db.prepare(`INSERT INTO pro_profiles(user_id, profession, description, experience, zone, services, documents, pro_type, company_name, company_rccm, company_size)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(user_id) DO UPDATE SET profession=excluded.profession, description=excluded.description,
                experience=excluded.experience, zone=excluded.zone, services=excluded.services, documents=excluded.documents,
                pro_type=excluded.pro_type, company_name=excluded.company_name, company_rccm=excluded.company_rccm,
                company_size=excluded.company_size, rejected_reason=NULL`)
    .run(req.user.id, profession.trim(), description || '', experience || '', zone.trim(), JSON.stringify(services), JSON.stringify(documents || []),
      proType, companyName || null, (req.body.company_rccm || '').trim() || null, (req.body.company_size || '').trim() || null);
  db.prepare(`UPDATE users SET pro_status='pending', pro_rules_accepted_at=datetime('now') WHERE id=?`).run(req.user.id);
  notifyAdmins('compte', 'Nouvelle demande professionnelle', `${req.user.name} souhaite devenir professionnel (${proType === 'entreprise' ? '🏢 Entreprise « ' + companyName + ' » — ' : '👤 Particulier — '}${profession}).`, 'admin:pros');
  notify(req.user.id, 'compte', 'Demande envoyée ✅', 'Votre demande professionnelle est en cours de validation par l\u2019administration.', '#/pro');
  res.json({ ok: true, pro_status: 'pending' });
});

app.put('/api/pro/availability', auth, (req, res) => {
  if (req.user.pro_status !== 'approved') return res.status(403).json({ error: 'Espace réservé aux professionnels validés.' });
  db.prepare('UPDATE pro_profiles SET available=? WHERE user_id=?').run(req.body.available ? 1 : 0, req.user.id);
  res.json({ available: req.body.available ? 1 : 0 });
});

app.put('/api/pro/profile', auth, (req, res) => {
  if (!db.prepare('SELECT 1 FROM pro_profiles WHERE user_id=?').get(req.user.id)) return res.status(404).json({ error: 'Profil professionnel introuvable.' });
  const { profession, description, experience, zone, services, documents, company_name, company_rccm, company_size } = req.body || {};
  db.prepare(`UPDATE pro_profiles SET profession=COALESCE(?,profession), description=COALESCE(?,description),
              experience=COALESCE(?,experience), zone=COALESCE(?,zone),
              services=COALESCE(?,services), documents=COALESCE(?,documents),
              company_name=COALESCE(?,company_name), company_rccm=COALESCE(?,company_rccm), company_size=COALESCE(?,company_size) WHERE user_id=?`)
    .run(profession || null, description ?? null, experience ?? null, zone || null,
         services ? JSON.stringify(services) : null, documents ? JSON.stringify(documents) : null,
         company_name ?? null, company_rccm ?? null, company_size ?? null, req.user.id);
  res.json(me(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)));
});

app.get('/api/pro/dashboard', auth, (req, res) => {
  if (req.user.pro_status !== 'approved') return res.status(403).json({ error: 'Espace réservé aux professionnels validés.' });
  const uid = req.user.id;
  const pro = db.prepare('SELECT * FROM pro_profiles WHERE user_id=?').get(uid);
  const missions = db.prepare(`SELECT m.*, s.name service_name FROM missions m JOIN services s ON s.id=m.service_id WHERE m.pro_id=? ORDER BY m.updated_at DESC`).all(uid);
  const offers = db.prepare(`SELECT m.*, s.name service_name, mc.offered_at FROM mission_candidates mc
    JOIN missions m ON m.id=mc.mission_id JOIN services s ON s.id=m.service_id
    WHERE mc.pro_id=? AND mc.status='offered' AND m.status='recherche' ORDER BY mc.offered_at DESC`).all(uid);
  const pays = db.prepare(`SELECT p.* FROM payments p JOIN missions m ON m.id=p.mission_id WHERE m.pro_id=? AND p.status='valide'`).all(uid);
  const revenus = pays.reduce((s, p) => s + p.pro_amount, 0);
  const r = db.prepare('SELECT AVG(rating) avg, COUNT(*) n FROM reviews WHERE target_id=?').get(uid);
  res.json({
    available: pro.available, profile: { ...pro, services: JSON.parse(pro.services), documents: JSON.parse(pro.documents) },
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
    zone: p.zone, available: p.available, services: svcNames, missions_done: missionsDone,
    documents_valides: JSON.parse(p.documents).length > 0, mis_en_avant: visibiliteNiveau(u.id) > 0, reviews
  });
});

// ============================================================
// MISSIONS — cycle complet + moteur de mise en relation
// ============================================================
const dispatchTimers = new Map(); // missionId -> timeout

function haversine(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(v => v == null)) return 99999;
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findMatchingPros(mission) {
  const pros = db.prepare(`SELECT u.*, p.services svc, p.available, p.zone FROM users u JOIN pro_profiles p ON p.user_id=u.id
    WHERE u.pro_status='approved' AND u.suspended=0 AND u.id != ?`).all(mission.client_id);
  return pros
    .filter(p => JSON.parse(p.svc).includes(mission.service_id))
    .map(p => ({ ...p, dist: haversine(mission.lat, mission.lng, p.lat, p.lng) }))
    .sort((a, b) => (b.available - a.available) || (visibiliteNiveau(b.id) - visibiliteNiveau(a.id)) || (a.dist - b.dist)); // 1. disponibilité 2. visibilité payante (bonus facultatif, jamais bloquant) 3. proximité
}

function addEvent(missionId, status, actorId, note) {
  db.prepare('INSERT INTO mission_events(mission_id,status,actor_id,note) VALUES(?,?,?,?)').run(missionId, status, actorId || null, note || null);
  db.prepare("UPDATE missions SET updated_at=datetime('now') WHERE id=?").run(missionId);
}

function offerNext(missionId) {
  const mission = db.prepare('SELECT * FROM missions WHERE id=?').get(missionId);
  if (!mission || mission.status !== 'recherche') return;
  const next = db.prepare(`SELECT mc.*, p.available FROM mission_candidates mc JOIN pro_profiles p ON p.user_id=mc.pro_id
    WHERE mc.mission_id=? AND mc.status='pending' ORDER BY p.available DESC, mc.rank ASC LIMIT 1`).get(missionId);
  if (!next) {
    db.prepare("UPDATE missions SET status='sans_pro' WHERE id=?").run(missionId);
    addEvent(missionId, 'sans_pro', null, 'Aucun professionnel n\u2019a répondu');
    notify(mission.client_id, 'mission', 'Aucun professionnel disponible pour le moment',
      'Vous pouvez relancer la recherche ou contacter directement un professionnel depuis votre demande.', '#/mission/' + missionId);
    push(mission.client_id, 'mission', { id: missionId, status: 'sans_pro' });
    return;
  }
  const svc = db.prepare('SELECT name FROM services WHERE id=?').get(mission.service_id);
  db.prepare("UPDATE mission_candidates SET status='offered', offered_at=datetime('now') WHERE id=?").run(next.id);
  notify(next.pro_id, 'mission', '🔔 Nouvelle mission : ' + svc.name,
    (mission.urgence ? 'URGENT — ' : '') + (mission.address || 'Localisation fournie') + '. Touchez pour voir la demande et répondre.',
    '#/mission/' + missionId);
  push(next.pro_id, 'mission', { id: missionId, status: 'offre' });
  const wait = Math.max(15, parseInt(getSetting('dispatch_wait_seconds', '60'), 10)) * 1000;
  clearTimeout(dispatchTimers.get(missionId));
  dispatchTimers.set(missionId, setTimeout(() => {
    const cand = db.prepare('SELECT * FROM mission_candidates WHERE id=?').get(next.id);
    if (cand && cand.status === 'offered') {
      db.prepare("UPDATE mission_candidates SET status='expired', responded_at=datetime('now') WHERE id=?").run(next.id);
      notify(next.pro_id, 'mission', 'Mission expirée', 'Le délai de réponse est dépassé, la mission a été proposée à un autre professionnel.', '#/pro');
      offerNext(missionId);
    }
  }, wait));
}

function startDispatch(missionId) {
  const mission = db.prepare('SELECT * FROM missions WHERE id=?').get(missionId);
  const pros = findMatchingPros(mission);
  const ins = db.prepare('INSERT OR IGNORE INTO mission_candidates(mission_id, pro_id, rank) VALUES(?,?,?)');
  pros.forEach((p, i) => ins.run(missionId, p.id, i));
  if (!pros.length) {
    db.prepare("UPDATE missions SET status='sans_pro' WHERE id=?").run(missionId);
    addEvent(missionId, 'sans_pro', null, 'Aucun professionnel compatible trouvé');
    notify(mission.client_id, 'mission', 'Recherche sans résultat',
      'Aucun professionnel ne propose encore ce service dans votre zone. Nous avons alerté l\u2019administration ; vous pourrez relancer la recherche.', '#/mission/' + missionId);
    notifyAdmins('mission', 'Demande sans professionnel', `Demande #${mission.code} : aucun professionnel compatible.`, 'admin:missions');
    return;
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
  // Transparence : prix total, commission Klean-Services et part du professionnel.
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
  notify(req.user.id, 'information', '⭐ Souscription enregistrée', `Réglez ${plan.price.toLocaleString('fr-FR')} FCFA à Klean-Services : votre visibilité sera activée dès confirmation du paiement.`, '#/visibilite');
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
  const prio = pubNiveauPourBudget(budget); // priorité déterminée côté serveur selon le budget
  const cid = db.prepare(`INSERT INTO ad_campaigns(user_id, type, title, content, file, link, placement, zone, budget, duration_days, priorite)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, type, b.title.trim(), (b.content || '').trim() || null, b.file || null, (b.link || '').trim() || null,
         b.placement === 'services' ? 'services' : 'accueil', (b.zone || '').trim() || null, budget, duration, prio).lastInsertRowid;
  addTransaction({ user_id: req.user.id, kind: 'publicite', ref_id: cid, label: `Campagne « ${b.title.trim()} »`, amount: budget, ville: req.user.ville, categorie: prio });
  notifyAdmins('information', '📣 Nouvelle campagne publicitaire', `${req.user.name} : « ${b.title.trim()} » — budget ${budget.toLocaleString('fr-FR')} FCFA, ${duration} j.`, 'admin:payments');
  notify(req.user.id, 'information', '📣 Campagne enregistrée', `Réglez ${budget.toLocaleString('fr-FR')} FCFA à Klean-Services. Après confirmation du paiement, votre campagne sera examinée puis diffusée.`, '#/pub');
  res.json({ ok: true, id: cid, status: 'attente_paiement', priorite: prio });
});

// Créer une demande
app.post('/api/missions', auth, (req, res) => {
  const { service_id, answers, description, address, lat, lng, urgence, date_souhaitee, photos, audio, tache } = req.body || {};
  const svc = db.prepare('SELECT * FROM services WHERE id=? AND active=1').get(service_id);
  if (!svc) return res.status(400).json({ error: 'Service invalide.' });
  if (!address || !address.trim()) return res.status(400).json({ error: 'Indiquez votre localisation (GPS ou saisie manuelle).' });
  // Questions obligatoires du service
  const required = db.prepare('SELECT * FROM service_questions WHERE service_id=? AND active=1 AND required=1').all(service_id);
  for (const rq of required) {
    const v = (answers || {})[rq.id];
    if (v === undefined || v === null || String(v).trim() === '') return res.status(400).json({ error: `Veuillez répondre à : « ${rq.label} »` });
  }
  // Anti-doublon : même service, même client, demande active récente
  const dup = db.prepare(`SELECT id FROM missions WHERE client_id=? AND service_id=? AND status IN ('recherche','sans_pro','acceptee','confirmee')
    AND created_at > datetime('now','-2 hours')`).get(req.user.id, service_id);
  if (dup) return res.status(409).json({ error: 'Vous avez déjà une demande en cours pour ce service. Consultez-la dans « Demandes ».', mission_id: dup.id });

  const code = 'KS' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 90 + 10);
  const info = db.prepare(`INSERT INTO missions(code, client_id, service_id, answers, description, address, lat, lng, urgence, date_souhaitee, photos, audio, tache)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(code, req.user.id, service_id, JSON.stringify(answers || {}), description || '', address.trim(), lat || null, lng || null,
         urgence ? 1 : 0, date_souhaitee || null, JSON.stringify(photos || []), audio || null, tache || null);
  addEvent(info.lastInsertRowid, 'recherche', req.user.id, 'Demande créée');
  startDispatch(info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid, code, status: 'recherche' });
});

function missionAccess(mission, user) {
  if (!mission) return null;
  if (isStaff(user) && hasPerm(user, 'missions')) return 'admin';
  if (mission.client_id === user.id) return 'client';
  if (mission.pro_id === user.id) return 'pro';
  const cand = db.prepare("SELECT * FROM mission_candidates WHERE mission_id=? AND pro_id=? AND status IN ('offered','accepted')").get(mission.id, user.id);
  if (cand) return 'candidat';
  return null;
}
function missionFull(mission, role, user) {
  const svc = db.prepare('SELECT s.name, c.icon FROM services s JOIN service_categories c ON c.id=s.category_id WHERE s.id=?').get(mission.service_id);
  const questions = db.prepare('SELECT id, label, type FROM service_questions WHERE service_id=?').all(mission.service_id);
  const answers = JSON.parse(mission.answers);
  const detail = questions.filter(q => answers[q.id] !== undefined && String(answers[q.id]).trim() !== '')
    .map(q => ({ label: q.label, value: q.type === 'bool' ? (answers[q.id] ? 'Oui' : 'Non') : answers[q.id] }));
  const events = db.prepare('SELECT status, note, created_at FROM mission_events WHERE mission_id=? ORDER BY id').all(mission.id);
  const payment = db.prepare('SELECT * FROM payments WHERE mission_id=?').get(mission.id);
  const client = db.prepare('SELECT * FROM users WHERE id=?').get(mission.client_id);
  const pro = mission.pro_id ? db.prepare('SELECT * FROM users WHERE id=?').get(mission.pro_id) : null;
  const myReview = db.prepare('SELECT * FROM reviews WHERE mission_id=? AND author_id=?').get(mission.id, user.id);
  const unreadMsgs = db.prepare('SELECT COUNT(*) n FROM messages WHERE mission_id=? AND sender_id!=? AND read=0').get(mission.id, user.id).n;
  const shareContact = ['acceptee', 'confirmee', 'en_cours', 'terminee', 'payee'].includes(mission.status);
  let candidates = null, offerPending = null;
  if (role === 'client' && ['recherche', 'sans_pro'].includes(mission.status)) {
    candidates = db.prepare(`SELECT mc.status cstatus, u.* FROM mission_candidates mc JOIN users u ON u.id=mc.pro_id WHERE mc.mission_id=? ORDER BY mc.rank`).all(mission.id)
      .map(u => {
        const pp = db.prepare('SELECT profession, zone, available FROM pro_profiles WHERE user_id=?').get(u.id);
        return { ...publicUser(u), cstatus: u.cstatus, profession: pp.profession, zone: pp.zone, available: pp.available };
      });
  }
  if (role === 'candidat') {
    offerPending = db.prepare("SELECT 1 FROM mission_candidates WHERE mission_id=? AND pro_id=? AND status='offered'").get(mission.id, user.id) ? true : false;
  }
  return {
    id: mission.id, code: mission.code, status: mission.status, role,
    service: svc.name, icon: svc.icon, tache: mission.tache || null, detail, description: mission.description,
    address: mission.address, lat: mission.lat, lng: mission.lng,
    urgence: mission.urgence, date_souhaitee: mission.date_souhaitee,
    photos: JSON.parse(mission.photos), audio: mission.audio,
    amount: mission.amount, created_at: mission.created_at, events, payment,
    client: publicUser(client, role !== 'client' && shareContact),
    pro: pro ? publicUser(pro, role === 'client' && shareContact) : null,
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
      WHERE mc.pro_id=? AND mc.status='offered' AND m.status='recherche' ORDER BY mc.offered_at DESC`).all(req.user.id);
  }
  const strip = m => ({ id: m.id, code: m.code, status: m.status, service: m.service_name, icon: m.icon, tache: m.tache || null, address: m.address, urgence: m.urgence, amount: m.amount, created_at: m.created_at, updated_at: m.updated_at });
  res.json({ client: asClient.map(strip), pro: asPro.map(strip), offers: offers.map(strip) });
});

app.get('/api/missions/:id', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=?').get(req.params.id);
  const role = missionAccess(mission, req.user);
  if (!role) return res.status(404).json({ error: 'Demande introuvable ou accès non autorisé.' });
  res.json(missionFull(mission, role === 'admin' ? 'client' : role, req.user));
});

// Le professionnel accepte
app.post('/api/missions/:id/accept', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=?').get(req.params.id);
  if (!mission) return res.status(404).json({ error: 'Demande introuvable.' });
  if (mission.status !== 'recherche' && mission.status !== 'sans_pro') return res.status(409).json({ error: 'Cette demande n\u2019est plus disponible.' });
  const cand = db.prepare("SELECT * FROM mission_candidates WHERE mission_id=? AND pro_id=? AND status IN ('offered','pending')").get(mission.id, req.user.id);
  if (!cand) return res.status(403).json({ error: 'Cette mission ne vous a pas été proposée.' });
  clearTimeout(dispatchTimers.get(mission.id)); dispatchTimers.delete(mission.id);
  db.prepare("UPDATE mission_candidates SET status='accepted', responded_at=datetime('now') WHERE id=?").run(cand.id);
  db.prepare("UPDATE mission_candidates SET status='expired' WHERE mission_id=? AND id!=? AND status IN ('pending','offered')").run(mission.id, cand.id);
  db.prepare("UPDATE missions SET status='acceptee', pro_id=? WHERE id=?").run(req.user.id, mission.id);
  addEvent(mission.id, 'acceptee', req.user.id, 'Professionnel : ' + req.user.name);
  const svc = db.prepare('SELECT name FROM services WHERE id=?').get(mission.service_id);
  notify(mission.client_id, 'mission', '✅ Un professionnel a accepté votre demande',
    `${req.user.name} a accepté « ${svc.name} ». Consultez son profil et confirmez pour démarrer.`, '#/mission/' + mission.id);
  push(mission.client_id, 'mission', { id: mission.id, status: 'acceptee' });
  res.json({ ok: true, status: 'acceptee' });
});

// Le professionnel refuse
app.post('/api/missions/:id/refuse', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=?').get(req.params.id);
  if (!mission) return res.status(404).json({ error: 'Demande introuvable.' });
  const cand = db.prepare("SELECT * FROM mission_candidates WHERE mission_id=? AND pro_id=? AND status='offered'").get(mission.id, req.user.id);
  if (!cand) return res.status(409).json({ error: 'Aucune offre en attente pour cette mission.' });
  db.prepare("UPDATE mission_candidates SET status='refused', responded_at=datetime('now') WHERE id=?").run(cand.id);
  clearTimeout(dispatchTimers.get(mission.id));
  offerNext(mission.id);
  res.json({ ok: true });
});

// Le client contacte/choisit directement un professionnel candidat
app.post('/api/missions/:id/choisir/:proId', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=? AND client_id=?').get(req.params.id, req.user.id);
  if (!mission) return res.status(404).json({ error: 'Demande introuvable.' });
  if (!['recherche', 'sans_pro'].includes(mission.status)) return res.status(409).json({ error: 'Cette demande a déjà un professionnel.' });
  const cand = db.prepare('SELECT * FROM mission_candidates WHERE mission_id=? AND pro_id=?').get(mission.id, req.params.proId);
  if (!cand) return res.status(404).json({ error: 'Ce professionnel ne correspond pas à la demande.' });
  clearTimeout(dispatchTimers.get(mission.id));
  db.prepare("UPDATE missions SET status='recherche' WHERE id=?").run(mission.id);
  db.prepare("UPDATE mission_candidates SET status='offered', offered_at=datetime('now') WHERE id=?").run(cand.id);
  const svc = db.prepare('SELECT name FROM services WHERE id=?').get(mission.service_id);
  notify(cand.pro_id, 'mission', '🔔 Un client vous sollicite directement', `Demande « ${svc.name} » — touchez pour voir les détails et répondre.`, '#/mission/' + mission.id);
  push(cand.pro_id, 'mission', { id: mission.id, status: 'offre' });
  res.json({ ok: true });
});

// Relancer la recherche
app.post('/api/missions/:id/relancer', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=? AND client_id=?').get(req.params.id, req.user.id);
  if (!mission) return res.status(404).json({ error: 'Demande introuvable.' });
  if (mission.status !== 'sans_pro') return res.status(409).json({ error: 'La recherche est déjà en cours.' });
  db.prepare("UPDATE missions SET status='recherche' WHERE id=?").run(mission.id);
  db.prepare("UPDATE mission_candidates SET status='pending', offered_at=NULL, responded_at=NULL WHERE mission_id=? AND status IN ('expired','refused')").run(mission.id);
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

// Démarrer la mission
app.post('/api/missions/:id/start', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=? AND pro_id=?').get(req.params.id, req.user.id);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable.' });
  if (mission.status !== 'confirmee') return res.status(409).json({ error: 'La mission doit d\u2019abord être confirmée par le client.' });
  db.prepare("UPDATE missions SET status='en_cours' WHERE id=?").run(mission.id);
  addEvent(mission.id, 'en_cours', req.user.id, 'Mission démarrée');
  notify(mission.client_id, 'mission', '🛠️ Mission en cours', 'Le professionnel a démarré la mission.', '#/mission/' + mission.id);
  push(mission.client_id, 'mission', { id: mission.id, status: 'en_cours' });
  res.json({ ok: true, status: 'en_cours' });
});

// Terminer la mission → création du paiement (jamais payé automatiquement)
app.post('/api/missions/:id/complete', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=? AND pro_id=?').get(req.params.id, req.user.id);
  if (!mission) return res.status(404).json({ error: 'Mission introuvable.' });
  if (mission.status !== 'en_cours') return res.status(409).json({ error: 'La mission doit être en cours pour être terminée.' });
  if (!mission.amount) return res.status(400).json({ error: 'Fixez d\u2019abord le montant de la mission avant de la terminer.' });
  if (db.prepare(`SELECT 1 FROM mission_price_changes WHERE mission_id=? AND status='en_attente'`).get(mission.id))
    return res.status(409).json({ error: 'Une modification de prix attend la réponse du client. Attendez sa décision avant de terminer la mission.' });
  const fin = missionFinance(mission); // commission calculée côté serveur (règles par type de pro / catégorie / zone), impossible à contourner
  db.prepare("UPDATE missions SET status='terminee' WHERE id=?").run(mission.id);
  db.prepare(`INSERT INTO payments(mission_id, amount, method, commission_rate, commission_amount, pro_amount)
              VALUES(?,?,?,?,?,?) ON CONFLICT(mission_id) DO NOTHING`)
    .run(mission.id, mission.amount, 'especes', fin.commission_rate, fin.commission, fin.pro_amount);
  addEvent(mission.id, 'terminee', req.user.id, 'Mission terminée — en attente de paiement');
  notify(mission.client_id, 'paiement', '✅ Mission terminée — paiement attendu',
    `Montant : ${mission.amount.toLocaleString('fr-FR')} FCFA (espèces). Confirmez le paiement une fois effectué.`, '#/mission/' + mission.id);
  push(mission.client_id, 'mission', { id: mission.id, status: 'terminee' });
  res.json({ ok: true, status: 'terminee' });
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
    db.prepare("UPDATE missions SET status='payee' WHERE id=?").run(mission.id);
    addEvent(mission.id, 'payee', req.user.id, 'Paiement validé par les deux parties');
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
  return role && role !== 'admin' ? role : (isStaff(user) && hasPerm(user, 'missions') ? 'admin' : null);
}
app.get('/api/missions/:id/messages', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=?').get(req.params.id);
  if (!mission || !chatAccess(mission, req.user)) return res.status(404).json({ error: 'Conversation introuvable.' });
  db.prepare('UPDATE messages SET read=1 WHERE mission_id=? AND sender_id!=?').run(mission.id, req.user.id);
  const msgs = db.prepare(`SELECT m.*, u.name sender_name, u.photo sender_photo FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.mission_id=? ORDER BY m.id`).all(mission.id);
  res.json(msgs);
});
app.post('/api/missions/:id/messages', auth, (req, res) => {
  const mission = db.prepare('SELECT * FROM missions WHERE id=?').get(req.params.id);
  const role = chatAccess(mission, req.user);
  if (!mission || !role) return res.status(404).json({ error: 'Conversation introuvable.' });
  const { type, content, file } = req.body || {};
  if (!['text', 'photo', 'audio'].includes(type)) return res.status(400).json({ error: 'Type de message invalide.' });
  if (type === 'text' && (!content || !content.trim())) return res.status(400).json({ error: 'Message vide.' });
  if (type !== 'text' && !file) return res.status(400).json({ error: 'Fichier manquant.' });
  const info = db.prepare('INSERT INTO messages(mission_id, sender_id, type, content, file) VALUES(?,?,?,?,?)')
    .run(mission.id, req.user.id, type, (content || '').slice(0, 2000), file || null);
  const msg = db.prepare('SELECT m.*, u.name sender_name, u.photo sender_photo FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?').get(info.lastInsertRowid);
  // Destinataires : l'autre partie (client ↔ pro assigné ou candidats actifs)
  let recipients = [];
  if (req.user.id === mission.client_id) {
    if (mission.pro_id) recipients = [mission.pro_id];
    else recipients = db.prepare("SELECT pro_id FROM mission_candidates WHERE mission_id=? AND status='offered'").all(mission.id).map(r => r.pro_id);
  } else recipients = [mission.client_id];
  const svc = db.prepare('SELECT name FROM services WHERE id=?').get(mission.service_id);
  for (const rid of recipients) {
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
app.get('/api/avis-recherche', auth, (req, res) => {
  const list = db.prepare(`SELECT a.*, u.name publisher FROM avis_recherche a JOIN users u ON u.id=a.user_id
    WHERE (a.status='approved' AND (a.expire_at IS NULL OR a.expire_at >= datetime('now'))) OR a.user_id=?
    ORDER BY CASE WHEN a.paid=1 AND a.formule='urgent' THEN 0 WHEN a.paid=1 AND a.formule='avant' THEN 1 ELSE 2 END, a.id DESC`).all(req.user.id);
  res.json(list);
});
app.post('/api/avis-recherche', auth, (req, res) => {
  const b = req.body || {};
  if (!b.nom || !b.contact) return res.status(400).json({ error: 'Le nom et un contact sont obligatoires.' });
  // Formule : normal (gratuit ou payant selon le paramètre du PDG) | mis en avant | urgent
  let formule = ['avant', 'urgent'].includes(b.formule) ? b.formule : 'normal';
  if (formule === 'avant' && getSetting('avis_avant_enabled', '1') !== '1') formule = 'normal';
  if (formule === 'urgent' && getSetting('avis_urgent_enabled', '1') !== '1') formule = 'normal';
  const prixAvis = parseInt(getSetting('avis_prix_' + formule, '0'), 10) || 0;
  const info = db.prepare(`INSERT INTO avis_recherche(user_id, nom, photo, description, date_disparition, heure_disparition, dernier_lieu, derniere_vue, description_physique, vetements, contact, infos, formule, paid)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, b.nom, b.photo || null, b.description || null, b.date_disparition || null, b.heure_disparition || null,
         b.dernier_lieu || null, b.derniere_vue || null, b.description_physique || null, b.vetements || null, b.contact, b.infos || null,
         formule, prixAvis === 0 ? 1 : 0);
  if (prixAvis > 0) addTransaction({ user_id: req.user.id, kind: 'avis_recherche', ref_id: info.lastInsertRowid, label: `Avis de recherche « ${b.nom} » — formule ${formule}`, amount: prixAvis, ville: req.user.ville, categorie: formule });
  notifyAdmins('information', 'Avis de recherche à modérer', `Publié par ${req.user.name} : ${b.nom}${prixAvis > 0 ? ` (formule ${formule} — ${prixAvis.toLocaleString('fr-FR')} FCFA à encaisser)` : ''}`, 'admin:contenu');
  notify(req.user.id, 'information', 'Avis de recherche envoyé', prixAvis > 0
    ? `Réglez ${prixAvis.toLocaleString('fr-FR')} FCFA à Klean-Services : la mise en avant sera appliquée après confirmation du paiement. L\u2019avis sera publié après validation.`
    : 'Votre avis sera publié après validation par l\u2019administration.', '#/avis-recherche');
  res.json({ ok: true, id: info.lastInsertRowid, status: 'pending', formule, prix: prixAvis });
});

app.get('/api/jobs', auth, (req, res) => {
  const q = normalize(req.query.q || '');
  let list = db.prepare(`SELECT j.*, u.name publisher FROM jobs j JOIN users u ON u.id=j.user_id WHERE j.status='approved' OR j.user_id=?
    ORDER BY CASE WHEN j.boost != 'normal' AND (j.boost_until IS NULL OR j.boost_until >= datetime('now'))
      THEN (CASE j.boost WHEN 'prioritaire' THEN 0 ELSE 1 END) ELSE 2 END, j.id DESC`).all(req.user.id);
  if (q) list = list.filter(j => normalize([j.metier, j.competences, j.localisation, j.description].join(' ')).includes(q));
  res.json(list);
});
app.post('/api/jobs', auth, (req, res) => {
  const b = req.body || {};
  if (!b.metier || !b.contact) return res.status(400).json({ error: 'Le métier recherché et un contact sont obligatoires.' });
  const info = db.prepare(`INSERT INTO jobs(user_id, metier, competences, experience, localisation, disponibilite, contact, cv, photo, description)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, b.metier, b.competences || null, b.experience || null, b.localisation || null, b.disponibilite || null, b.contact, b.cv || null, b.photo || null, b.description || null);
  notifyAdmins('information', 'Profil « Je cherche un job » à modérer', `${req.user.name} : ${b.metier}`, 'admin:contenu');
  notify(req.user.id, 'information', 'Profil envoyé', 'Votre profil sera visible après validation par l\u2019administration.', '#/jobs');
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
  notify(req.user.id, 'information', '⭐ Demande enregistrée', `Réglez ${prix.toLocaleString('fr-FR')} FCFA à Klean-Services : la mise en avant sera activée dès confirmation du paiement.`, '#/jobs');
  res.json({ ok: true, status: 'attente_paiement', prix });
});

app.get('/api/ecole-famille', auth, (req, res) => res.json(db.prepare('SELECT * FROM ecole_famille WHERE user_id=? ORDER BY id DESC').all(req.user.id)));
app.post('/api/ecole-famille', auth, (req, res) => {
  const { type, details, contact } = req.body || {};
  if (!type) return res.status(400).json({ error: 'Choisissez le type de demande.' });
  if (!details || !details.trim()) return res.status(400).json({ error: 'Décrivez votre besoin.' });
  const info = db.prepare('INSERT INTO ecole_famille(user_id, type, details, contact) VALUES(?,?,?,?)').run(req.user.id, type, details.trim(), contact || req.user.phone);
  notifyAdmins('information', 'Nouvelle demande École & famille', `${req.user.name} : ${type}`, 'admin:contenu');
  notify(req.user.id, 'information', 'Demande École & famille envoyée ✅', 'L\u2019équipe Klean-Services CI va vous recontacter.', '#/ecole-famille');
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.get('/api/urgence/config', auth, (req, res) => {
  res.json({ info: getSetting('urgence_info', ''), contacts: JSON.parse(getSetting('urgence_contacts', '[]')) });
});
app.post('/api/urgence', auth, (req, res) => {
  const { message, lat, lng } = req.body || {};
  const info = db.prepare('INSERT INTO urgences(user_id, message, lat, lng) VALUES(?,?,?,?)').run(req.user.id, message || '', lat || null, lng || null);
  notifyAdmins('urgence', '🚨 ALERTE URGENCE', `${req.user.name} (${req.user.phone}) a déclenché une urgence${message ? ' : ' + message : ''}.`, 'admin:securite');
  notify(req.user.id, 'urgence', '🚨 Alerte envoyée', 'Votre alerte a été transmise à l\u2019équipe Klean-Services CI.', '#/urgence');
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
app.get('/api/games/quiz', auth, (req, res) => {
  if (getSetting('quiz_enabled') !== '1') return res.status(403).json({ error: 'Le quiz est désactivé.' });
  const qs = db.prepare('SELECT id, question, options FROM quiz_questions WHERE active=1 ORDER BY RANDOM() LIMIT 5').all();
  res.json(qs.map(q => ({ ...q, options: JSON.parse(q.options) })));
});
app.post('/api/games/quiz', auth, (req, res) => {
  if (getSetting('quiz_enabled') !== '1') return res.status(403).json({ error: 'Le quiz est désactivé.' });
  const answers = req.body.answers || {};
  let score = 0, total = 0;
  for (const [qid, ans] of Object.entries(answers)) {
    const q = db.prepare('SELECT answer FROM quiz_questions WHERE id=?').get(qid);
    if (q) { total++; if (q.answer === parseInt(ans, 10)) score++; }
  }
  db.prepare("INSERT INTO game_plays(user_id, game, score, result) VALUES(?,'quiz',?,?)").run(req.user.id, score, `${score}/${total}`);
  res.json({ score, total });
});

// ----- QUIZ CONCOURS : sessions animées depuis le tableau de bord -----
function quizAudienceOk(user) {
  const aud = getSetting('quiz_audience') || 'tous';
  if (aud === 'clients') return user.pro_status !== 'approved';
  if (aud === 'clients_servis') // réservé aux clients ayant déjà bénéficié d'un service (mission terminée ou payée)
    return db.prepare("SELECT COUNT(*) n FROM missions WHERE client_id=? AND status IN ('terminee','payee')").get(user.id).n > 0;
  return true; // 'tous' et 'clients_pros' : tout compte connecté
}
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
  const el = Date.now() - startMs;
  const endMs = (n - 1) * C + q; // fermeture de la dernière question (pas de pause après)
  if (!n || el >= endMs) return { over: true, n };
  const i = Math.floor(el / C), t = el % C;
  if (t < q) return { over: false, n, phase: 'question', index: i, remaining_ms: q - t, qStartMs: startMs + i * C };
  return { over: false, n, phase: 'pause', index: i, next_in_ms: C - t };
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
  const getAns = qi => db.prepare('SELECT answer, correct FROM quiz_answers WHERE session_id=? AND user_id=? AND question_id=?').get(s.id, userId, qids[qi]);
  const mine = getAns(tl.index);
  const prev = tl.index > 0 ? getAns(tl.index - 1) : null;
  const okPrev = tl.index === 0 || !s.elimination || !!(prev && prev.correct === 1);
  const base = { phase: tl.phase, index: tl.index, total: tl.n, time_per_q: s.time_per_q, interval_s: s.interval_s };
  if (tl.phase === 'question') {
    const q = db.prepare('SELECT id, question, options FROM quiz_questions WHERE id=?').get(qids[tl.index]);
    return { ...base, remaining_ms: tl.remaining_ms,
      question: q ? { id: q.id, question: q.question, options: JSON.parse(q.options).slice(0, 4) } : null,
      answered: !!mine, my_answer: mine ? mine.answer : null,
      can_answer: !mine && okPrev, spectator: !mine && !okPrev };
  }
  const q = db.prepare('SELECT question, options, answer FROM quiz_questions WHERE id=?').get(qids[tl.index]);
  return { ...base, next_in_ms: tl.next_in_ms, next_index: tl.index + 1, last_question: tl.index + 1 >= tl.n,
    reveal: q ? { question: q.question, options: JSON.parse(q.options).slice(0, 4), correct: q.answer,
      my_answer: mine ? mine.answer : null, my_correct: !!(mine && mine.correct === 1) } : null,
    spectator_next: s.elimination ? !(mine && mine.correct === 1) : false };
}

// État du concours pour l'utilisateur connecté
app.get('/api/games/concours', auth, (req, res) => {
  if (getSetting('quiz_enabled') !== '1') return res.json({ enabled: false });
  const audience = getSetting('quiz_audience') || 'tous';
  const allowed = quizAudienceOk(req.user);
  let s = db.prepare("SELECT * FROM quiz_sessions WHERE status='en_cours' ORDER BY id DESC LIMIT 1").get();
  if (s && quizTimeline(s).over) { quizFinalize(s); s = null; } // série finie -> finalisation auto
  let p = null;
  if (s) p = quizParticipant(s.id, req.user.id);
  else {
    // dernière session terminée à laquelle l'utilisateur a participé (résultats, gagnant…)
    s = db.prepare(`SELECT s.* FROM quiz_sessions s JOIN quiz_participants pp ON pp.session_id=s.id
                    WHERE s.status='terminee' AND pp.user_id=? ORDER BY s.id DESC LIMIT 1`).get(req.user.id);
    if (s) p = quizParticipant(s.id, req.user.id);
  }
  if (!s) return res.json({ enabled: true, allowed, audience, session: null });
  const winnersDone = db.prepare("SELECT COUNT(*) n FROM quiz_participants WHERE session_id=? AND status='gagnant'").get(s.id).n > 0;
  const out = {
    enabled: true, allowed, audience,
    session: {
      id: s.id, title: s.title, status: s.status, nb_questions: JSON.parse(s.qids || '[]').length || s.nb_questions,
      time_per_q: s.time_per_q, interval_s: s.interval_s, elimination: !!s.elimination, nb_winners: s.nb_winners, winners_designated: winnersDone
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
  if (!quizAudienceOk(req.user)) return res.status(403).json({ error: (getSetting('quiz_audience') === 'clients_servis')
    ? 'Ce quiz est réservé aux clients ayant déjà bénéficié d\u2019un service sur Klean-Services.'
    : 'Ce quiz est réservé aux clients.' });
  const s = db.prepare("SELECT * FROM quiz_sessions WHERE id=? AND status='en_cours'").get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Ce quiz n\u2019est pas (ou plus) en cours.' });
  if (quizParticipant(s.id, req.user.id)) return res.status(400).json({ error: 'Vous participez déjà à ce quiz.' });
  db.prepare('INSERT INTO quiz_participants(session_id, user_id) VALUES(?,?)').run(s.id, req.user.id);
  res.json({ ok: true });
});

// Question en cours (le chrono est contrôlé côté serveur)
app.get('/api/games/concours/:id/question', auth, (req, res) => {
  const s = db.prepare("SELECT * FROM quiz_sessions WHERE id=? AND status='en_cours'").get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Ce quiz n\u2019est pas (ou plus) en cours.' });
  let p = quizParticipant(s.id, req.user.id);
  if (!p) return res.status(400).json({ error: 'Rejoignez d\u2019abord le quiz.' });
  const limitMs = s.time_per_q * 1000;
  // temps écoulé sur une question laissée ouverte -> fermeture automatique, enregistrée comme non répondue
  if (p.status === 'en_lice' && p.q_started_at && Date.now() - p.q_started_at > limitMs + 2000)
    p = quizRecord(s, p, -1, limitMs);
  if (p.status !== 'en_lice')
    return res.json({ done: true, status: p.status, score: p.score });
  const qids = JSON.parse(s.qids || '[]');
  if (!p.q_started_at) {
    db.prepare('UPDATE quiz_participants SET q_started_at=? WHERE id=?').run(Date.now(), p.id);
    p.q_started_at = Date.now();
  }
  const q = db.prepare('SELECT id, question, options FROM quiz_questions WHERE id=?').get(qids[p.current_q]);
  res.json({
    done: false, index: p.current_q, total: qids.length, time_per_q: s.time_per_q,
    remaining_ms: Math.max(0, limitMs - (Date.now() - p.q_started_at)),
    question: { id: q.id, question: q.question, options: JSON.parse(q.options).slice(0, 4) }
  });
});

// Réponse : UNE seule par compte et par quiz, acceptée uniquement pendant la fenêtre de la question
app.post('/api/games/concours/:id/repondre', auth, (req, res) => {
  if (getSetting('quiz_enabled') !== '1') return res.status(403).json({ error: 'Le quiz est désactivé.' });
  if (!quizAudienceOk(req.user)) return res.status(403).json({ error: 'Ce quiz ne vous est pas ouvert.' });
  const s = db.prepare("SELECT * FROM quiz_sessions WHERE id=? AND status='en_cours'").get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Ce quiz n\u2019est pas (ou plus) en cours.' });
  const tl = quizTimeline(s);
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
  db.prepare('UPDATE quiz_participants SET score=score+?, total_ms=total_ms+?, current_q=? WHERE session_id=? AND user_id=?')
    .run(correct, ms, index + 1, s.id, req.user.id);
  res.json({ ok: true, locked: true });
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
  const code = (req.body.code || '').trim().toUpperCase();
  const row = db.prepare('SELECT * FROM kdo_codes WHERE code=? AND active=1').get(code);
  if (!row) return res.status(404).json({ error: 'Code invalide.' });
  if (row.used_by) return res.status(409).json({ error: 'Ce code a déjà été utilisé.' });
  db.prepare("UPDATE kdo_codes SET used_by=?, used_at=datetime('now') WHERE id=?").run(req.user.id, row.id);
  notifyAdmins('information', '🎁 Code Kdo utilisé', `${req.user.name} a utilisé le code ${code} (${row.reward}).`, 'admin:contenu');
  res.json({ ok: true, reward: row.reward });
});

// Publicités actives (côté application), avec leur nombre de vues (1 vue par compte maximum)
app.get('/api/ads', (req, res) => {
  pubTick(); // expiration + promotion automatique de la file d'attente des campagnes
  const rows = db.prepare(`SELECT a.id, a.type, a.title, a.content, a.file, a.placement, a.duration,
    (SELECT COUNT(*) FROM view_seen v WHERE v.key = 'ad:' || a.id) AS views
    FROM ads a WHERE a.active=1 ORDER BY a.sort, a.id`).all();
  if (getSetting('pub_campagnes_enabled', '1') === '1') {
    const dur = Math.max(3, parseInt(getSetting('pub_duree_affichage', '6'), 10) || 6);
    for (const c of db.prepare(`SELECT * FROM ad_campaigns WHERE status='active' ORDER BY id`).all()) {
      const entry = { id: 'c' + c.id, type: c.type, title: c.title, content: c.content, file: c.file, placement: c.placement, duration: dur, views: 0, sponsor: true };
      for (let i = 0; i < pubPoids(c.priorite); i++) rows.push(entry); // la priorité augmente la fréquence, sans monopole (max ×3)
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
  [/^\/maintenance/, 'PDG'], // mode maintenance : réservé au PDG
  [/^\/journal/, 'journal'],
  [/^\/users\/\d+$/, 'comptes'], [/^\/users/, 'comptes'],
  [/^\/pros/, 'pros'],
  [/^\/(catalog|categories|sous-categories|services|taches|villes)/, 'catalogue'],
  [/^\/questions/, 'questions'],
  [/^\/missions/, 'missions'],
  [/^\/payments/, 'paiements'],
  [/^\/(finances|transactions|prix-modifs|visibilite|pub)/, 'paiements'],
  [/^\/commissions/, 'parametres'],
  [/^\/(ads|broadcast|annonces)/, 'communication'],
  [/^\/(signalements|urgences|files|rules)/, 'securite'],
  [/^\/(avis-recherche|jobs|ecole-famille|quiz|kdo|game-plays|quiz-sessions)/, 'contenu'],
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
  [/^(POST|PUT|DELETE) \/categories/, 'Catalogue : métier'],
  [/^(POST|PUT|DELETE) \/sous-categories/, 'Catalogue : sous-catégorie'],
  [/^(POST|PUT|DELETE) \/services/, 'Catalogue : service'],
  [/^(POST|PUT|DELETE) \/taches/, 'Catalogue : tâche'],
  [/^(POST|PUT|DELETE) \/villes/, 'Catalogue : ville'],
  [/^(POST|PUT|DELETE) \/questions/, 'Question dynamique'],
  [/^PUT \/settings/, 'Modification des paramètres'],
  [/^POST \/broadcast/, 'Message système envoyé'],
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

// UTILISATEURS
A.get('/users', (req, res) => {
  const f = req.query.filter || 'all';
  let where = "role='user'";
  if (f === 'pros') where += " AND pro_status='approved'";
  if (f === 'clients') where += " AND (pro_status IS NULL OR pro_status!='approved')";
  if (f === 'pending') where += " AND pro_status='pending'";
  if (f === 'suspended') where = "role='user' AND (suspended=1 OR blocked=1 OR (disabled_until IS NOT NULL AND disabled_until > datetime('now')))";
  if (f === 'verified') where += ' AND verified=1';
  if (f === 'incomplete') where += ' AND profile_incomplete=1';
  const sort = req.query.sort === 'nom' ? 'name COLLATE NOCASE ASC' : 'id DESC'; // alphabétique ou date d'inscription (récents d'abord)
  const rows = db.prepare(`SELECT id, name, phone, email, address, ville, quartier, is_pro, pro_status, kp_code, suspended, blocked, disabled_until, must_change_password, profile_incomplete, verified, created_at FROM users WHERE ${where} ORDER BY ${sort} LIMIT 500`).all();
  res.json(rows);
});
A.get('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  const pro = db.prepare('SELECT * FROM pro_profiles WHERE user_id=?').get(u.id);
  const missions = db.prepare('SELECT COUNT(*) n FROM missions WHERE client_id=? OR pro_id=?').get(u.id, u.id).n;
  const history = db.prepare("SELECT admin_name, admin_role, action, details, reason, created_at FROM admin_log WHERE target_type='users' AND target_id=? ORDER BY id DESC LIMIT 50").all(u.id);
  delete u.password_hash; delete u.salt; delete u.perms;
  res.json({ ...u, pro: pro ? { ...pro, services: JSON.parse(pro.services), documents: JSON.parse(pro.documents) } : null, missions, history });
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
  notify(info.lastInsertRowid, 'compte', 'Bienvenue sur Klean-Services CI 👋',
    'Votre compte a été créé par notre équipe. Connectez-vous, choisissez votre mot de passe et complétez votre profil.' +
    (type === 'pro' ? ' Pour devenir professionnel, faites votre demande depuis Mon compte (validation normale).' : ''), '#/account');
  res.json({ id: info.lastInsertRowid, temp_password: temp });
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
  if (!req.body.suspended) notify(u.id, 'compte', 'Compte réactivé', 'Votre compte a été réactivé par l\u2019administration.', '#/home');
  res.json({ ok: true });
});
A.post('/users/:id/block', (req, res) => {
  const u = cibleUtilisateur(req, res); if (!u) return;
  db.prepare('UPDATE users SET blocked=? WHERE id=?').run(req.body.blocked ? 1 : 0, u.id);
  if (!req.body.blocked) notify(u.id, 'compte', 'Compte débloqué', 'Votre compte a été débloqué par l\u2019administration.', '#/home');
  res.json({ ok: true });
});
A.post('/users/:id/disable-temp', (req, res) => {
  const u = cibleUtilisateur(req, res); if (!u) return;
  const { until } = req.body || {}; // date/heure ISO, ou null pour réactiver
  if (until && isNaN(Date.parse(until))) return res.status(400).json({ error: 'Date invalide.' });
  db.prepare('UPDATE users SET disabled_until=? WHERE id=?').run(until ? until.replace('T', ' ').slice(0, 19) : null, u.id);
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
  res.json(rows.map(r => ({ ...r, services: JSON.parse(r.services), documents: JSON.parse(r.documents) })));
});
A.post('/pros/:id/approve', (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=? AND pro_status='pending'").get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Demande introuvable.' });
  db.prepare("UPDATE users SET pro_status='approved', is_pro=1, verified=1 WHERE id=?").run(u.id);
  db.prepare("UPDATE pro_profiles SET validated_at=datetime('now') WHERE user_id=?").run(u.id);
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
A.get('/catalog', (req, res) => {
  const cats = db.prepare('SELECT * FROM service_categories ORDER BY sort,id').all();
  const subs = db.prepare('SELECT * FROM sous_categories ORDER BY sort,id').all();
  const svcs = db.prepare('SELECT * FROM services ORDER BY sort,id').all().map(s => ({ ...s, cities: JSON.parse(s.cities || '[]') }));
  const tas = db.prepare('SELECT * FROM taches ORDER BY sort,id').all();
  const qs = db.prepare('SELECT * FROM service_questions ORDER BY sort,id').all().map(q => ({ ...q, options: JSON.parse(q.options) }));
  res.json({ categories: cats, sous_categories: subs, services: svcs, taches: tas, questions: qs });
});
A.delete('/categories/:id', (req, res) => {
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
// TÂCHES
A.post('/taches', (req, res) => {
  if (!req.body.name || !req.body.service_id) return res.status(400).json({ error: 'Nom et service requis.' });
  const info = db.prepare('INSERT INTO taches(service_id, name, sort) VALUES(?,?,?)').run(req.body.service_id, req.body.name, req.body.sort ?? 99);
  res.json({ id: info.lastInsertRowid });
});
A.put('/taches/:id', (req, res) => {
  db.prepare('UPDATE taches SET name=COALESCE(?,name), active=COALESCE(?,active), sort=COALESCE(?,sort) WHERE id=?')
    .run(req.body.name || null, req.body.active ?? null, req.body.sort ?? null, req.params.id);
  res.json({ ok: true });
});
A.delete('/taches/:id', (req, res) => { db.prepare('DELETE FROM taches WHERE id=?').run(req.params.id); res.json({ ok: true }); });
// VILLES
A.get('/villes', (req, res) => res.json(db.prepare('SELECT * FROM villes ORDER BY name').all()));
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
A.post('/categories', (req, res) => {
  const info = db.prepare('INSERT INTO service_categories(name, icon, sort) VALUES(?,?,?)').run(req.body.name, req.body.icon || '🔹', req.body.sort || 99);
  res.json({ id: info.lastInsertRowid });
});
A.put('/categories/:id', (req, res) => {
  db.prepare('UPDATE service_categories SET name=COALESCE(?,name), icon=COALESCE(?,icon), active=COALESCE(?,active), sort=COALESCE(?,sort) WHERE id=?')
    .run(req.body.name || null, req.body.icon || null, req.body.active ?? null, req.body.sort ?? null, req.params.id);
  res.json({ ok: true });
});
A.post('/services', (req, res) => {
  if (!req.body.name || !req.body.category_id) return res.status(400).json({ error: 'Nom et catégorie requis.' });
  const info = db.prepare('INSERT INTO services(category_id, sub_id, name, keywords, sort, price_from, price_prefix, price_show) VALUES(?,?,?,?,?,?,?,?)')
    .run(req.body.category_id, req.body.sub_id || null, req.body.name, req.body.keywords || '', req.body.sort || 99,
      req.body.price_from ?? null, req.body.price_prefix || 'Dès', req.body.price_show ?? 1);
  res.json({ id: info.lastInsertRowid });
});
A.put('/services/:id', (req, res) => {
  db.prepare(`UPDATE services SET name=COALESCE(?,name), keywords=COALESCE(?,keywords), active=COALESCE(?,active), sort=COALESCE(?,sort),
    category_id=COALESCE(?,category_id), sub_id=COALESCE(?,sub_id), popular=COALESCE(?,popular), seasonal=COALESCE(?,seasonal), cities=COALESCE(?,cities),
    price_from=COALESCE(?,price_from), price_prefix=COALESCE(?,price_prefix), price_show=COALESCE(?,price_show) WHERE id=?`)
    .run(req.body.name || null, req.body.keywords ?? null, req.body.active ?? null, req.body.sort ?? null,
      req.body.category_id || null, req.body.sub_id || null, req.body.popular ?? null, req.body.seasonal ?? null,
      req.body.cities !== undefined ? JSON.stringify(req.body.cities) : null,
      req.body.price_from ?? null, req.body.price_prefix || null, req.body.price_show ?? null, req.params.id);
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

// PARAMÈTRES
A.get('/settings', (req, res) => {
  const keys = ['commission_rate', 'dispatch_wait_seconds', 'file_retention_days', 'payment_especes', 'payment_mobile_money',
    'quiz_enabled', 'flipfizz_enabled', 'kdo_enabled', 'quiz_audience', 'bandeau_enabled', 'bandeau_speed', 'urgence_info', 'urgence_contacts', 'rules_client', 'rules_pro', 'admin_font_size',
    'pro_doc_particulier', 'pro_doc_entreprise',
    'commission_enabled', 'visibilite_enabled', 'pub_campagnes_enabled', 'pub_max_actives', 'pub_budgets', 'pub_niveaux', 'avis_prix_normal', 'avis_prix_avant', 'avis_prix_urgent', 'avis_avant_enabled', 'avis_urgent_enabled', 'avis_duree_jours', 'emploi_boost_enabled', 'emploi_prix_avant', 'emploi_prix_prioritaire', 'emploi_boost_duree_jours', 'pays', 'devise'];
  const out = {};
  keys.forEach(k => out[k] = getSetting(k));
  res.json(out);
});
A.put('/settings', (req, res) => {
  const allowed = ['commission_rate', 'dispatch_wait_seconds', 'file_retention_days', 'payment_especes', 'payment_mobile_money',
    'quiz_enabled', 'flipfizz_enabled', 'kdo_enabled', 'quiz_audience', 'bandeau_enabled', 'bandeau_speed', 'urgence_info', 'urgence_contacts', 'rules_client', 'rules_pro', 'admin_font_size',
    'pro_doc_particulier', 'pro_doc_entreprise',
    'commission_enabled', 'visibilite_enabled', 'pub_campagnes_enabled', 'pub_max_actives', 'pub_budgets', 'pub_niveaux', 'avis_prix_normal', 'avis_prix_avant', 'avis_prix_urgent', 'avis_avant_enabled', 'avis_urgent_enabled', 'avis_duree_jours', 'emploi_boost_enabled', 'emploi_prix_avant', 'emploi_prix_prioritaire', 'emploi_boost_duree_jours', 'pays', 'devise'];
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!allowed.includes(k)) continue;
    if (k === 'admin_font_size') { // taille du tableau de bord : réservée au PDG
      if (req.user.role !== 'pdg') return res.status(403).json({ error: 'La taille du tableau de bord est définie par le PDG uniquement.' });
      const f = parseInt(v, 10); if (isNaN(f) || f < 14 || f > 26) return res.status(400).json({ error: 'Taille invalide (14 à 26).' });
    }
    if (k === 'commission_rate') { const r = parseFloat(v); if (isNaN(r) || r < 0 || r > 100) return res.status(400).json({ error: 'Taux de commission invalide (0 à 100).' }); }
    if (k === 'dispatch_wait_seconds') { const s = parseInt(v, 10); if (isNaN(s) || s < 15 || s > 3600) return res.status(400).json({ error: 'Délai d\u2019attente invalide (15 à 3600 secondes).' }); }
    if (k === 'pub_max_actives') { const n = parseInt(v, 10); if (isNaN(n) || n < 1 || n > 200) return res.status(400).json({ error: 'Nombre d\u2019emplacements publicitaires invalide (1 à 200).' }); }
    const ancienneValeur = getSetting(k);
    setSetting(k, v);
    // Sécurité financière : chaque modification de paramètre est journalisée (qui, ancienne valeur, nouvelle valeur, quand)
    if (String(ancienneValeur) !== String(v)) logAction(req.user, 'Paramètre « ' + k + ' » modifié', { details: `Ancienne valeur : ${ancienneValeur === null ? '(vide)' : ancienneValeur} → Nouvelle valeur : ${v}` });
  }
  res.json({ ok: true });
});

// COMMUNICATION : publicités + message système
A.get('/ads', (req, res) => res.json(db.prepare(`SELECT a.*,
  (SELECT COUNT(*) FROM view_seen v WHERE v.key = 'ad:' || a.id) AS views
  FROM ads a ORDER BY a.sort, a.id DESC`).all()));
A.get('/game-plays/vues', (req, res) => {
  const gv = k => db.prepare('SELECT COUNT(*) n FROM view_seen WHERE key=?').get(k).n;
  res.json({ quiz: gv('game:quiz'), flipfizz: gv('game:flipfizz'), kdo: gv('game:kdo') });
});
A.post('/ads', (req, res) => {
  const { type, title, content, file, placement, duration, active } = req.body || {};
  const info = db.prepare('INSERT INTO ads(type, title, content, file, placement, duration, active) VALUES(?,?,?,?,?,?,?)')
    .run(type || 'texte', title || '', content || '', file || null, placement || 'accueil', duration || 6, active ?? 1);
  res.json({ id: info.lastInsertRowid });
});
A.put('/ads/:id', (req, res) => {
  const { title, content, placement, duration, active, sort } = req.body || {};
  db.prepare('UPDATE ads SET title=COALESCE(?,title), content=COALESCE(?,content), placement=COALESCE(?,placement), duration=COALESCE(?,duration), active=COALESCE(?,active), sort=COALESCE(?,sort) WHERE id=?')
    .run(title ?? null, content ?? null, placement || null, duration ?? null, active ?? null, sort ?? null, req.params.id);
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
A.post('/broadcast', (req, res) => {
  const { title, body } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Titre requis.' });
  const users = db.prepare("SELECT id FROM users WHERE role='user' AND suspended=0").all();
  users.forEach(u => notify(u.id, 'information', title, body || '', '#/notifications'));
  res.json({ ok: true, sent: users.length });
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
A.get('/avis-recherche', (req, res) => res.json(db.prepare('SELECT a.*, u.name publisher, u.phone FROM avis_recherche a JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200').all()));
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
A.get('/jobs', (req, res) => res.json(db.prepare('SELECT j.*, u.name publisher, u.phone FROM jobs j JOIN users u ON u.id=j.user_id ORDER BY j.id DESC LIMIT 200').all()));
A.post('/jobs/:id/status', (req, res) => {
  const j = db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Profil introuvable.' });
  db.prepare('UPDATE jobs SET status=? WHERE id=?').run(req.body.status, j.id);
  if (req.body.status === 'approved') notify(j.user_id, 'information', 'Profil emploi publié ✅', 'Votre profil « Je cherche un job » est maintenant visible.', '#/jobs');
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
    (SELECT COUNT(*) FROM quiz_participants p WHERE p.session_id=s.id AND p.status='gagnant') AS gagnants
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
  if (s.status === 'en_cours') return res.status(400).json({ error: 'Arrêtez d\u2019abord ce quiz avant de le supprimer.' });
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
  db.prepare("UPDATE quiz_sessions SET status='en_cours', qids=?, started_at=datetime('now'), started_ms=? WHERE id=?").run(JSON.stringify(qids), Date.now(), s.id);
  res.json({ ok: true });
});
// Rejouer / Reprendre : réinitialise les réponses et les statuts, et relance la même série
A.post('/quiz-sessions/:id/rejouer', (req, res) => {
  const s = db.prepare('SELECT * FROM quiz_sessions WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session introuvable.' });
  if (s.status === 'brouillon') return res.status(400).json({ error: 'Lancez d\u2019abord cette session.' });
  if (db.prepare("SELECT COUNT(*) n FROM quiz_sessions WHERE status='en_cours' AND id!=?").get(s.id).n)
    return res.status(400).json({ error: 'Un autre quiz est déjà en cours. Arrêtez-le d\u2019abord.' });
  if (getSetting('quiz_enabled') !== '1') return res.status(400).json({ error: 'Activez d\u2019abord le quiz (bouton Activation ci-dessus).' });
  db.prepare('DELETE FROM quiz_answers WHERE session_id=?').run(s.id);
  db.prepare('DELETE FROM quiz_participants WHERE session_id=?').run(s.id);
  db.prepare("UPDATE quiz_sessions SET status='en_cours', started_at=datetime('now'), started_ms=?, ended_at=NULL WHERE id=?").run(Date.now(), s.id);
  res.json({ ok: true });
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
  res.json({ ...s, elimination: !!s.elimination, participants, messages, questions });
});
A.post('/quiz-sessions/:id/gagnants', (req, res) => {
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

// GESTION DES FICHIERS
A.get('/files', (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR).map(f => {
    const st = fs.statSync(path.join(UPLOAD_DIR, f));
    return { name: f, size: st.size, mtime: st.mtime, age_days: Math.floor((Date.now() - st.mtimeMs) / 86400000) };
  }).sort((a, b) => b.mtime - a.mtime);
  res.json({ files: files.slice(0, 300), total: files.length, total_size: files.reduce((s, f) => s + f.size, 0), retention_days: parseInt(getSetting('file_retention_days', '90'), 10) });
});
A.post('/files/cleanup', (req, res) => res.json({ deleted: cleanupFiles() }));

app.use('/api/admin', A);

// Nettoyage automatique des fichiers (durée configurable par l'administration)
function cleanupFiles() {
  const days = parseInt(getSetting('file_retention_days', '90'), 10);
  if (!days || days < 1) return 0;
  const cutoff = Date.now() - days * 86400000;
  let deleted = 0;
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const fp = path.join(UPLOAD_DIR, f);
    try { if (fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); deleted++; } } catch {}
  }
  if (persist.enabled()) persist.deleteFilesOlderThan(days).catch(() => { });
  return deleted;
}
setInterval(cleanupFiles, 12 * 3600 * 1000);

// Reprise des missions en recherche après redémarrage du serveur
for (const m of db.prepare("SELECT id FROM missions WHERE status='recherche'").all()) {
  const offered = db.prepare("SELECT 1 FROM mission_candidates WHERE mission_id=? AND status='offered'").get(m.id);
  if (offered) {
    const wait = Math.max(15, parseInt(getSetting('dispatch_wait_seconds', '60'), 10)) * 1000;
    dispatchTimers.set(m.id, setTimeout(() => {
      db.prepare("UPDATE mission_candidates SET status='expired' WHERE mission_id=? AND status='offered'").run(m.id);
      offerNext(m.id);
    }, wait));
  } else offerNext(m.id);
}

// ---------- STATIQUE + AUTO-DIAGNOSTIC DES FICHIERS ----------
const REQUIRED_FILES = [
  'public/index.html', 'public/app.js', 'public/styles.css', 'public/sw.js',
  'public/manifest.json', 'public/admin/index.html', 'public/admin/admin.js'
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
  <p>Le serveur Klean-Services CI fonctionne, mais ces fichiers n'ont pas été trouvés :</p>
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

app.listen(PORT, '0.0.0.0', () => console.log('Klean-Services CI en écoute sur le port ' + PORT));
