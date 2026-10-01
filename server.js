// ============================================================
// KLEAN-SERVICES CI — Serveur (Express + SQLite + SSE)
// ============================================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { db, hashPassword, getSetting, setSetting } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '2mb' }));

// Secret de session persistant
let SECRET = getSetting('auth_secret');
if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); setSetting('auth_secret', SECRET); }

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
  if (user.suspended) return res.status(403).json({ error: 'Votre compte est suspendu. Contactez Klean-Services CI.' });
  req.user = user;
  next();
}
function admin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès réservé à l\u2019administration.' });
  next();
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
  db.prepare("SELECT id FROM users WHERE role='admin'").all().forEach(a => notify(a.id, category, title, body, link));
}

// ============================================================
// AUTHENTIFICATION & COMPTE (compte unique client + pro)
// ============================================================
app.post('/api/auth/register', (req, res) => {
  const { name, phone, password, address, lat, lng, accept_rules } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Veuillez indiquer votre nom.' });
  if (!phone || !/^[+0-9 ]{8,20}$/.test(phone.trim())) return res.status(400).json({ error: 'Numéro de téléphone invalide.' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
  if (!accept_rules) return res.status(400).json({ error: 'Vous devez accepter les règles d\u2019utilisation.' });
  const p = phone.trim().replace(/\s+/g, '');
  if (db.prepare('SELECT id FROM users WHERE phone=?').get(p)) return res.status(409).json({ error: 'Un compte existe déjà avec ce numéro. Connectez-vous.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const info = db.prepare(`INSERT INTO users(name, phone, password_hash, salt, address, lat, lng, rules_accepted_at) VALUES(?,?,?,?,?,?,?,datetime('now'))`)
    .run(name.trim(), p, hashPassword(password, salt), salt, address || null, lat || null, lng || null);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
  notify(user.id, 'compte', 'Bienvenue sur Klean-Services CI 👋', 'Votre compte est créé. Recherchez un service ou devenez professionnel depuis Mon compte.', '#/home');
  res.json({ token: sign({ id: user.id, exp: Date.now() + 90 * 86400000 }), user: me(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { phone, password } = req.body || {};
  const p = (phone || '').trim().replace(/\s+/g, '');
  const user = db.prepare('SELECT * FROM users WHERE phone=?').get(p);
  if (!user || user.password_hash !== hashPassword(password || '', user.salt))
    return res.status(401).json({ error: 'Téléphone ou mot de passe incorrect.' });
  if (user.suspended) return res.status(403).json({ error: 'Votre compte est suspendu. Contactez Klean-Services CI.' });
  res.json({ token: sign({ id: user.id, exp: Date.now() + 90 * 86400000 }), user: me(user) });
});

function me(u) {
  const pro = db.prepare('SELECT * FROM pro_profiles WHERE user_id=?').get(u.id);
  const r = db.prepare('SELECT AVG(rating) avg, COUNT(*) n FROM reviews WHERE target_id=?').get(u.id);
  return {
    id: u.id, name: u.name, phone: u.phone, photo: u.photo, address: u.address, lat: u.lat, lng: u.lng,
    role: u.role, is_pro: u.is_pro, pro_status: u.pro_status, verified: u.verified,
    rating: r.avg ? Math.round(r.avg * 10) / 10 : null, reviews_count: r.n,
    pro: pro ? { ...pro, services: JSON.parse(pro.services), documents: JSON.parse(pro.documents) } : null
  };
}
app.get('/api/me', auth, (req, res) => res.json(me(req.user)));

app.put('/api/me', auth, (req, res) => {
  const { name, photo, address, lat, lng } = req.body || {};
  db.prepare('UPDATE users SET name=COALESCE(?,name), photo=COALESCE(?,photo), address=COALESCE(?,address), lat=COALESCE(?,lat), lng=COALESCE(?,lng) WHERE id=?')
    .run(name || null, photo || null, address || null, lat ?? null, lng ?? null, req.user.id);
  res.json(me(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)));
});

app.put('/api/me/password', auth, (req, res) => {
  const { current, password } = req.body || {};
  if (req.user.password_hash !== hashPassword(current || '', req.user.salt)) return res.status(400).json({ error: 'Mot de passe actuel incorrect.' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 6 caractères.' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hashPassword(password, salt), salt, req.user.id);
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

// Upload générique (photos, audio, documents)
app.post('/api/upload', auth, upload.array('files', 8), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Aucun fichier reçu.' });
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
  const svcs = db.prepare('SELECT id, category_id, name, sort FROM services WHERE active=1 ORDER BY sort,id').all();
  res.json(cats.map(c => ({ ...c, services: svcs.filter(s => s.category_id === c.id) })));
});
app.get('/api/services/:id/questions', (req, res) => {
  const svc = db.prepare('SELECT s.*, c.name cat FROM services s JOIN service_categories c ON c.id=s.category_id WHERE s.id=? AND s.active=1').get(req.params.id);
  if (!svc) return res.status(404).json({ error: 'Service introuvable.' });
  const questions = db.prepare('SELECT * FROM service_questions WHERE service_id=? AND active=1 ORDER BY sort,id').all(svc.id)
    .map(q => ({ ...q, options: JSON.parse(q.options) }));
  res.json({ service: { id: svc.id, name: svc.name, category: svc.cat }, questions });
});
const STOPWORDS = new Set(['je', 'cherche', 'un', 'une', 'des', 'le', 'la', 'les', 'de', 'du', 'mon', 'ma', 'mes', 'pour', 'a', 'au', 'en', 'et', 'faire', 'veux', 'voudrais', 'besoin', 'il', 'me', 'faut', 'quelqu', 'qui', 'peut', 'sait']);
app.get('/api/search', (req, res) => {
  const words = normalize(req.query.q).split(/\s+/).filter(w => w.length > 1 && !STOPWORDS.has(w));
  const svcs = db.prepare('SELECT s.*, c.name cat, c.icon FROM services s JOIN service_categories c ON c.id=s.category_id WHERE s.active=1 AND c.active=1').all();
  const scored = svcs.map(s => {
    const hay = normalize(s.name + ' ' + s.cat + ' ' + s.keywords.replace(/,/g, ' '));
    const hayWords = hay.split(/\s+/);
    let score = 0;
    for (const w of words) {
      if (hayWords.includes(w)) score += 3;
      else if (hayWords.some(h => h.startsWith(w) || w.startsWith(h) && h.length > 2)) score += 1;
    }
    return { id: s.id, name: s.name, category: s.cat, icon: s.icon, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);
  res.json({ results: scored, query: req.query.q || '' });
});

// ============================================================
// ESPACE PROFESSIONNEL
// ============================================================
app.post('/api/pro/apply', auth, (req, res) => {
  const { profession, description, experience, zone, services, documents, accept_rules } = req.body || {};
  if (req.user.pro_status === 'approved') return res.status(400).json({ error: 'Vous êtes déjà professionnel.' });
  if (req.user.pro_status === 'pending') return res.status(400).json({ error: 'Votre demande est déjà en cours de validation.' });
  if (!profession || !profession.trim()) return res.status(400).json({ error: 'Indiquez votre profession.' });
  if (!Array.isArray(services) || !services.length) return res.status(400).json({ error: 'Sélectionnez au moins un service proposé.' });
  if (!zone || !zone.trim()) return res.status(400).json({ error: 'Indiquez votre zone d\u2019intervention.' });
  if (!accept_rules) return res.status(400).json({ error: 'Vous devez accepter les règles professionnelles.' });
  db.prepare(`INSERT INTO pro_profiles(user_id, profession, description, experience, zone, services, documents)
              VALUES(?,?,?,?,?,?,?)
              ON CONFLICT(user_id) DO UPDATE SET profession=excluded.profession, description=excluded.description,
                experience=excluded.experience, zone=excluded.zone, services=excluded.services, documents=excluded.documents, rejected_reason=NULL`)
    .run(req.user.id, profession.trim(), description || '', experience || '', zone.trim(), JSON.stringify(services), JSON.stringify(documents || []));
  db.prepare(`UPDATE users SET pro_status='pending', pro_rules_accepted_at=datetime('now') WHERE id=?`).run(req.user.id);
  notifyAdmins('compte', 'Nouvelle demande professionnelle', `${req.user.name} souhaite devenir professionnel (${profession}).`, 'admin:pros');
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
  const { profession, description, experience, zone, services, documents } = req.body || {};
  db.prepare(`UPDATE pro_profiles SET profession=COALESCE(?,profession), description=COALESCE(?,description),
              experience=COALESCE(?,experience), zone=COALESCE(?,zone),
              services=COALESCE(?,services), documents=COALESCE(?,documents) WHERE user_id=?`)
    .run(profession || null, description ?? null, experience ?? null, zone || null,
         services ? JSON.stringify(services) : null, documents ? JSON.stringify(documents) : null, req.user.id);
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
    documents_valides: JSON.parse(p.documents).length > 0, reviews
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
    .sort((a, b) => (b.available - a.available) || (a.dist - b.dist)); // 1. disponibilité 2. proximité
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

// Créer une demande
app.post('/api/missions', auth, (req, res) => {
  const { service_id, answers, description, address, lat, lng, urgence, date_souhaitee, photos, audio } = req.body || {};
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
  const info = db.prepare(`INSERT INTO missions(code, client_id, service_id, answers, description, address, lat, lng, urgence, date_souhaitee, photos, audio)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(code, req.user.id, service_id, JSON.stringify(answers || {}), description || '', address.trim(), lat || null, lng || null,
         urgence ? 1 : 0, date_souhaitee || null, JSON.stringify(photos || []), audio || null);
  addEvent(info.lastInsertRowid, 'recherche', req.user.id, 'Demande créée');
  startDispatch(info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid, code, status: 'recherche' });
});

function missionAccess(mission, user) {
  if (!mission) return null;
  if (user.role === 'admin') return 'admin';
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
    service: svc.name, icon: svc.icon, detail, description: mission.description,
    address: mission.address, lat: mission.lat, lng: mission.lng,
    urgence: mission.urgence, date_souhaitee: mission.date_souhaitee,
    photos: JSON.parse(mission.photos), audio: mission.audio,
    amount: mission.amount, created_at: mission.created_at, events, payment,
    client: publicUser(client, role !== 'client' && shareContact),
    pro: pro ? publicUser(pro, role === 'client' && shareContact) : null,
    my_review: myReview || null, unread_messages: unreadMsgs,
    candidates, offer_pending: offerPending,
    commission_rate: role !== 'client' ? parseFloat(getSetting('commission_rate', '25')) : undefined
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
  const strip = m => ({ id: m.id, code: m.code, status: m.status, service: m.service_name, icon: m.icon, address: m.address, urgence: m.urgence, amount: m.amount, created_at: m.created_at, updated_at: m.updated_at });
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
  db.prepare('UPDATE missions SET amount=? WHERE id=?').run(amount, mission.id);
  addEvent(mission.id, mission.status, req.user.id, `Montant fixé : ${amount} FCFA`);
  notify(mission.client_id, 'paiement', 'Montant de la mission', `Le professionnel a fixé le montant à ${amount.toLocaleString('fr-FR')} FCFA.`, '#/mission/' + mission.id);
  push(mission.client_id, 'mission', { id: mission.id, status: mission.status });
  res.json({ ok: true, amount });
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
  const rate = parseFloat(getSetting('commission_rate', '25'));
  const commission = Math.round(mission.amount * rate / 100);
  db.prepare("UPDATE missions SET status='terminee' WHERE id=?").run(mission.id);
  db.prepare(`INSERT INTO payments(mission_id, amount, method, commission_rate, commission_amount, pro_amount)
              VALUES(?,?,?,?,?,?) ON CONFLICT(mission_id) DO NOTHING`)
    .run(mission.id, mission.amount, 'especes', rate, commission, mission.amount - commission);
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
  return role && role !== 'admin' ? role : (user.role === 'admin' ? 'admin' : null);
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
  const list = db.prepare("SELECT a.*, u.name publisher FROM avis_recherche a JOIN users u ON u.id=a.user_id WHERE a.status='approved' OR a.user_id=? ORDER BY a.id DESC").all(req.user.id);
  res.json(list);
});
app.post('/api/avis-recherche', auth, (req, res) => {
  const b = req.body || {};
  if (!b.nom || !b.contact) return res.status(400).json({ error: 'Le nom et un contact sont obligatoires.' });
  const info = db.prepare(`INSERT INTO avis_recherche(user_id, nom, photo, description, date_disparition, heure_disparition, dernier_lieu, derniere_vue, description_physique, vetements, contact, infos)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, b.nom, b.photo || null, b.description || null, b.date_disparition || null, b.heure_disparition || null,
         b.dernier_lieu || null, b.derniere_vue || null, b.description_physique || null, b.vetements || null, b.contact, b.infos || null);
  notifyAdmins('information', 'Avis de recherche à modérer', `Publié par ${req.user.name} : ${b.nom}`, 'admin:contenu');
  notify(req.user.id, 'information', 'Avis de recherche envoyé', 'Votre avis sera publié après validation par l\u2019administration.', '#/avis-recherche');
  res.json({ ok: true, id: info.lastInsertRowid, status: 'pending' });
});

app.get('/api/jobs', auth, (req, res) => {
  const q = normalize(req.query.q || '');
  let list = db.prepare("SELECT j.*, u.name publisher FROM jobs j JOIN users u ON u.id=j.user_id WHERE j.status='approved' OR j.user_id=? ORDER BY j.id DESC").all(req.user.id);
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
  res.json({ quiz: getSetting('quiz_enabled') === '1', flipfizz: getSetting('flipfizz_enabled') === '1', kdo: getSetting('kdo_enabled') === '1' });
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

// Publicités actives (côté application)
app.get('/api/ads', (req, res) => {
  res.json(db.prepare("SELECT id, type, title, content, file, placement, duration FROM ads WHERE active=1 ORDER BY sort, id").all());
});

// ============================================================
// ADMINISTRATION
// ============================================================
const A = express.Router();
A.use(auth, admin);

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
  });
});

// UTILISATEURS
A.get('/users', (req, res) => {
  const f = req.query.filter || 'all';
  let where = "role='user'";
  if (f === 'pros') where += " AND pro_status='approved'";
  if (f === 'clients') where += " AND (pro_status IS NULL OR pro_status!='approved')";
  if (f === 'pending') where += " AND pro_status='pending'";
  if (f === 'suspended') where = "role='user' AND suspended=1";
  if (f === 'verified') where += ' AND verified=1';
  const rows = db.prepare(`SELECT id, name, phone, address, is_pro, pro_status, suspended, verified, created_at FROM users WHERE ${where} ORDER BY id DESC LIMIT 500`).all();
  res.json(rows);
});
A.get('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  const pro = db.prepare('SELECT * FROM pro_profiles WHERE user_id=?').get(u.id);
  const missions = db.prepare('SELECT COUNT(*) n FROM missions WHERE client_id=? OR pro_id=?').get(u.id, u.id).n;
  delete u.password_hash; delete u.salt;
  res.json({ ...u, pro: pro ? { ...pro, services: JSON.parse(pro.services), documents: JSON.parse(pro.documents) } : null, missions });
});
A.post('/users/:id/suspend', (req, res) => {
  db.prepare('UPDATE users SET suspended=? WHERE id=? AND role=\'user\'').run(req.body.suspended ? 1 : 0, req.params.id);
  if (!req.body.suspended) notify(parseInt(req.params.id), 'compte', 'Compte réactivé', 'Votre compte a été réactivé par l\u2019administration.', '#/home');
  res.json({ ok: true });
});
A.post('/users/:id/verify', (req, res) => {
  db.prepare('UPDATE users SET verified=? WHERE id=?').run(req.body.verified ? 1 : 0, req.params.id);
  if (req.body.verified) notify(parseInt(req.params.id), 'compte', '✅ Compte vérifié', 'Votre compte a été vérifié par l\u2019administration.', '#/account');
  res.json({ ok: true });
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
  notify(u.id, 'compte', '🎉 Vous êtes maintenant professionnel !', 'Votre espace professionnel est actif. Vous pouvez recevoir des missions. Votre compte reste aussi un compte client.', '#/pro');
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
  const svcs = db.prepare('SELECT * FROM services ORDER BY sort,id').all();
  const qs = db.prepare('SELECT * FROM service_questions ORDER BY sort,id').all().map(q => ({ ...q, options: JSON.parse(q.options) }));
  res.json({ categories: cats, services: svcs, questions: qs });
});
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
  const info = db.prepare('INSERT INTO services(category_id, name, keywords, sort) VALUES(?,?,?,?)').run(req.body.category_id, req.body.name, req.body.keywords || '', req.body.sort || 99);
  res.json({ id: info.lastInsertRowid });
});
A.put('/services/:id', (req, res) => {
  db.prepare('UPDATE services SET name=COALESCE(?,name), keywords=COALESCE(?,keywords), active=COALESCE(?,active), sort=COALESCE(?,sort), category_id=COALESCE(?,category_id) WHERE id=?')
    .run(req.body.name || null, req.body.keywords ?? null, req.body.active ?? null, req.body.sort ?? null, req.body.category_id || null, req.params.id);
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

// PARAMÈTRES
A.get('/settings', (req, res) => {
  const keys = ['commission_rate', 'dispatch_wait_seconds', 'file_retention_days', 'payment_especes', 'payment_mobile_money',
    'quiz_enabled', 'flipfizz_enabled', 'kdo_enabled', 'urgence_info', 'urgence_contacts', 'rules_client', 'rules_pro'];
  const out = {};
  keys.forEach(k => out[k] = getSetting(k));
  res.json(out);
});
A.put('/settings', (req, res) => {
  const allowed = ['commission_rate', 'dispatch_wait_seconds', 'file_retention_days', 'payment_especes', 'payment_mobile_money',
    'quiz_enabled', 'flipfizz_enabled', 'kdo_enabled', 'urgence_info', 'urgence_contacts', 'rules_client', 'rules_pro'];
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!allowed.includes(k)) continue;
    if (k === 'commission_rate') { const r = parseFloat(v); if (isNaN(r) || r < 0 || r > 100) return res.status(400).json({ error: 'Taux de commission invalide (0 à 100).' }); }
    if (k === 'dispatch_wait_seconds') { const s = parseInt(v, 10); if (isNaN(s) || s < 15 || s > 3600) return res.status(400).json({ error: 'Délai d\u2019attente invalide (15 à 3600 secondes).' }); }
    setSetting(k, v);
  }
  res.json({ ok: true });
});

// COMMUNICATION : publicités + message système
A.get('/ads', (req, res) => res.json(db.prepare('SELECT * FROM ads ORDER BY sort, id DESC').all()));
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
  if (req.body.status === 'approved') notify(a.user_id, 'information', 'Avis de recherche publié ✅', `L\u2019avis concernant « ${a.nom} » est maintenant visible.`, '#/avis-recherche');
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
  if (!question || !Array.isArray(options) || options.length < 2) return res.status(400).json({ error: 'Question et au moins 2 options requises.' });
  const info = db.prepare('INSERT INTO quiz_questions(question, options, answer) VALUES(?,?,?)').run(question, JSON.stringify(options), answer || 0);
  res.json({ id: info.lastInsertRowid });
});
A.delete('/quiz/:id', (req, res) => { db.prepare('DELETE FROM quiz_questions WHERE id=?').run(req.params.id); res.json({ ok: true }); });
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
