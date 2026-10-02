// ============================================================
// KLEAN-SERVICES CI — Migration des données legacy (app v1 → v2)
// ------------------------------------------------------------
// Exécutée UNE SEULE FOIS au démarrage de l'app (drapeau
// settings.legacy_migrated), puis inerte. 100 % idempotente :
// les téléphones déjà présents sont ignorés.
//
// Ce qu'elle fait :
//   1. Ajoute la colonne users.pw_legacy (format ancien des mots de passe).
//   2. Ré-ajoute les services manquants du catalogue v1 (Climatisation, Bricolage).
//   3. Recrée les 4 comptes clients AUJOURD'HUI (même numéro, MÊME mot de passe
//      — vérifié en format legacy au login, converti automatiquement au 1er login).
//   4. Recrée les 5 comptes professionnels (validés, profil + services,
//      mot de passe temporaire — à changer à la 1re connexion).
//   5. Recrée les 2 missions historiques (1 expirée, 1 annulée — aucune mission bloquée).
//   6. Sauvegarde la base dans PostgreSQL (si DATABASE_URL est définie).
// ============================================================
const path = require('path');
const fs = require('fs');
const { db, hashPassword, getSetting, setSetting, DB_PATH } = require('../db');

let persist = null;
try { persist = require('../persist'); } catch (e) { /* local sans persist */ }

function ensureColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
}

function svcIdByName(name) {
  const r = db.prepare('SELECT id FROM services WHERE name=?').get(name);
  return r ? r.id : null;
}

function run() {
  if (getSetting('legacy_migrated')) {
    console.log('ℹ️  Migration legacy déjà effectuée : rien à faire.');
    return;
  }

  const data = require('./legacy-data.json');
  const t0 = Date.now();
  const report = { clients: 0, clientsExistants: 0, pros: 0, prosExistants: 0, missions: 0, missionsExistantes: 0, servicesAjoutes: [] };

  // ---------- 1) Colonne legacy ----------
  ensureColumn('users', 'pw_legacy', 'INTEGER NOT NULL DEFAULT 0');

  // ---------- 2) Services manquants (catalogue v1) ----------
  const addCat = db.prepare('INSERT INTO service_categories(name, icon, sort) VALUES(?,?,?)');
  const addSvc = db.prepare('INSERT INTO services(category_id, name, keywords, sort) VALUES(?,?,?,?)');
  let sortCat = (db.prepare('SELECT MAX(sort) n FROM service_categories').get().n || 0) + 1;
  for (const ns of (data.newServices || [])) {
    let cat = db.prepare('SELECT id FROM service_categories WHERE name=?').get(ns.category);
    if (!cat) { cat = { id: addCat.run(ns.category, ns.icon, sortCat++).lastInsertRowid }; }
    for (const sname of ns.services) {
      if (!svcIdByName(sname)) {
        const kw = sname.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
        addSvc.run(cat.id, sname, kw, 99);
        report.servicesAjoutes.push(sname);
      }
    }
  }

  const insUser = db.prepare(`INSERT INTO users(name, phone, password_hash, salt, address, role, is_pro, pro_status, verified, rules_accepted_at, pro_rules_accepted_at, created_at, pw_legacy)
    VALUES(?,?,?,?,?,'user',?,?,?,?,?,?,?)`);
  const insProfile = db.prepare(`INSERT OR IGNORE INTO pro_profiles(user_id, profession, description, experience, zone, services, documents, available, validated_at)
    VALUES(?,?,?,?,?,?,'[]',1,?)`);

  // ---------- 3) Clients (mot de passe legacy conservé) ----------
  for (const c of (data.clients || [])) {
    const phone = String(c.phone).trim();
    const exists = db.prepare('SELECT id FROM users WHERE phone=?').get(phone);
    if (exists) { report.clientsExistants++; continue; }
    const created = (c.createdAt || new Date().toISOString()).replace('T', ' ').slice(0, 19);
    const info = insUser.run(c.name, phone, c.passHash, c.salt, c.address || null, 0, null, 0, created, null, created, 1);
    report.clients++;
  }

  // ---------- 4) Professionnels (validés + profil) ----------
  const tempPw = data.tempProPassword || 'Klean!2026';
  for (const p of (data.pros || [])) {
    const phone = String(p.phone).trim();
    const exists = db.prepare('SELECT id FROM users WHERE phone=?').get(phone);
    if (exists) { report.prosExistants++; continue; }
    const created = (p.createdAt || new Date().toISOString()).replace('T', ' ').slice(0, 19);
    const salt = 'legacy' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const svcIds = (p.services || []).map(svcIdByName).filter(Boolean);
    const profMain = (p.services || [])[0] || 'Professionnel Klean';
    const info = insUser.run(p.name, phone, hashPassword(tempPw, salt), salt, p.address || null, 1, 'approved', 1, created, created, created, 0);
    insProfile.run(info.lastInsertRowid, profMain, '', String(p.experience || ''), (p.address || '').split(',').pop() || '', JSON.stringify(svcIds), (p.approvedAt || p.createdAt || new Date().toISOString()).replace('T', ' ').slice(0, 19));
    report.pros++;
  }

  // ---------- 5) Missions historiques ----------
  const insM = db.prepare(`INSERT INTO missions(code, client_id, service_id, pro_id, status, answers, description, address, lat, lng, date_souhaitee, photos, created_at, updated_at)
    VALUES(?,?,?,?,?, '{}', ?, ?, ?, ?, ?, '[]', ?, ?)`);
  const insEv = db.prepare('INSERT INTO mission_events(mission_id, status, actor_id, note) VALUES(?,?,?,?)');
  for (const m of (data.missions || [])) {
    if (db.prepare('SELECT id FROM missions WHERE code=?').get(m.code)) { report.missionsExistantes++; continue; }
    const client = db.prepare('SELECT id FROM users WHERE phone=?').get(String(m.clientPhone).trim());
    const svc = svcIdByName(m.service);
    if (!client || !svc) { console.warn(`⚠️  Mission ${m.code} ignorée (client ou service introuvable).`); continue; }
    const created = (m.createdAt || new Date().toISOString()).replace('T', ' ').slice(0, 19);
    const dateFull = m.dateSouhaitee ? `${m.dateSouhaitee} ${m.time || '17:00'}` : created;
    const dateOnly = m.dateSouhaitee || null;
    const info = insM.run(m.code, client.id, svc, null, m.status, m.description || null, m.address || null, m.lat || null, m.lng || null, dateOnly, created, dateFull);
    insEv.run(info.lastInsertRowid, m.status, null, m.note || 'Migrée depuis l\'app Klean v1.');
    report.missions++;
  }

  // ---------- 5b) FILET DE SÉCURITÉ : les utilisateurs/missions déjà dans la nouvelle app ----------
  // Recréés UNIQUEMENT si absents (ex. disque Render vidé par un déploiement, base non sauvegardée).
  // S'ils existent déjà → aucun changement (leurs mots de passe d'origine sont conservés).
  let filetU = 0, filetUEx = 0, filetM = 0, filetMEx = 0;
  for (const u of (data.newAppUsers || [])) {
    const phone = String(u.phone).trim();
    if (db.prepare('SELECT id FROM users WHERE phone=?').get(phone)) { filetUEx++; continue; }
    const salt = 'net' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const created = (u.createdAt || new Date().toISOString()).replace('T', ' ').slice(0, 19);
    insUser.run(u.name, phone, hashPassword(tempPw, salt), salt, u.address || null, 0, null, u.verified ? 1 : 0, created, null, created, 0);
    filetU++;
  }
  const insM2 = db.prepare(`INSERT INTO missions(code, client_id, service_id, pro_id, status, answers, description, address, lat, lng, date_souhaitee, photos, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'[]',?,?)`);
  for (const m of (data.newAppMissions || [])) {
    if (db.prepare('SELECT id FROM missions WHERE code=?').get(m.code)) { filetMEx++; continue; }
    const client = db.prepare('SELECT id FROM users WHERE phone=?').get(String(m.clientPhone).trim());
    const svc = db.prepare('SELECT id FROM services WHERE name=?').get(m.serviceName);
    if (!client || !svc) { console.warn(`⚠️  Filet : mission ${m.code} ignorée (client ou service introuvable).`); continue; }
    const created = (m.createdAt || new Date().toISOString()).replace('T', ' ').slice(0, 19);
    const info = insM2.run(m.code, client.id, svc.id, null, m.status, JSON.stringify(m.answers || {}), m.description || null, m.address || null, m.lat || null, m.lng || null, null, created, created);
    insEv.run(info.lastInsertRowid, 'recherche', null, m.note || 'Migrée (filet de sécurité).');
    filetM++;
  }

  // ---------- 6) Drapeau + sauvegarde ----------
  setSetting('legacy_migrated', '1');
  if (persist && persist.enabled() && persist.backupDb) {
    try {
      persist.backupDb(fs.readFileSync(DB_PATH));
      report.persistee = true;
    } catch (e) { report.persistee = false; console.warn('⚠️  Sauvegarde PostgreSQL impossible :', e.message); }
  }

  console.log('📦 Migration legacy terminée en ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s :');
  console.log('   clients migrés   : ' + report.clients + (report.clientsExistants ? ' (' + report.clientsExistants + ' existaient déjà)' : ''));
  console.log('   pros migrés      : ' + report.pros + (report.prosExistants ? ' (' + report.prosExistants + ' existaient déjà)' : ''));
  console.log('   missions migrées : ' + report.missions + (report.missionsExistantes ? ' (' + report.missionsExistantes + ' existaient déjà)' : ''));
  console.log('   filet de sécurité: ' + filetU + ' utilisateur(s) recréé(s)' + (filetUEx ? ', ' + filetUEx + ' déjà présent(s)' : (filetU ? '' : ' (tous déjà présents — rien à faire)')) + ' | ' + filetM + ' mission(s) recréée(s)' + (filetMEx ? ', ' + filetMEx + ' déjà présente(s)' : (filetM ? '' : ' (toutes déjà présentes)')));
  console.log('   services ajoutés : ' + (report.servicesAjoutes.join(', ') || 'aucun'));
  console.log('   mot de passe pro (temporaire) : ' + tempPw);
}

try { run(); } catch (e) {
  console.error('❌ Erreur migration legacy :', e.message);
  console.error(e.stack);
}
