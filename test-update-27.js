/* COLIS 27 — validation intégrée : catalogue pro, photos, dédoublonnage et vues publicitaires.
   Lancer avec KLEAN_TEST_BASE=http://127.0.0.1:PORT npm run test:update27 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const Database = require('better-sqlite3');
const BASE = (process.env.KLEAN_TEST_BASE || 'http://127.0.0.1:3017') + '/api';
let total = 0, failed = 0;
function yes(ok, label) { total++; if (ok) console.log('OK ', label); else { failed++; console.error('BAD', label); } }
async function api(token, path, method = 'GET', body) {
  const r = await fetch(BASE + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { r, d: await r.json().catch(() => ({})) };
}
async function upload(token) {
  const f = new FormData();
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  f.append('files', new Blob([image], { type: 'image/png' }), 'colis27-categorie.png');
  const r = await fetch(BASE + '/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: f });
  return { r, d: await r.json().catch(() => ({})) };
}
function exactDedupMigrationTest() {
  const data = '/tmp/klean-colis27-exact-dedup-' + Date.now();
  fs.mkdirSync(data, { recursive: true });
  const env = { ...process.env, DATA_DIR: data };
  cp.execFileSync(process.execPath, ['-e', "require('./db')"], { cwd: __dirname, env, stdio: 'pipe' });
  const sqlite = new Database(path.join(data, 'klean.db'));
  const original = sqlite.prepare('SELECT * FROM service_categories LIMIT 1').get();
  const duplicateId = sqlite.prepare('INSERT INTO service_categories(name,icon,active,sort,grand_category_id) VALUES(?,?,?,?,?)')
    .run(original.name, original.icon, 1, 9999, original.grand_category_id).lastInsertRowid;
  // Une prestation existante est reliée au doublon : la migration doit la réaligner, pas la perdre.
  const service = sqlite.prepare('SELECT id,sub_id FROM services WHERE category_id=? AND sub_id IS NOT NULL LIMIT 1').get(original.id);
  sqlite.prepare('UPDATE services SET category_id=? WHERE id=?').run(duplicateId, service.id);
  // Ancien profil : une référence de prestation certaine migre vers la sous-catégorie ;
  // une référence inconnue va dans la file PDG sans compétence imaginée.
  sqlite.prepare("INSERT OR REPLACE INTO pro_profiles(user_id,profession,services,documents,selected_subcategories,authorized_subcategories) VALUES(1,'Profil historique',?,'[]','[]',NULL)").run(JSON.stringify([service.id, 999999]));
  sqlite.prepare("DELETE FROM settings WHERE key='colis27_catalogue_exact_dedup_v1'").run();
  sqlite.close();
  cp.execFileSync(process.execPath, ['-e', "require('./db')"], { cwd: __dirname, env, stdio: 'pipe' });
  const check = new Database(path.join(data, 'klean.db'));
  const gone = !check.prepare('SELECT 1 FROM service_categories WHERE id=?').get(duplicateId);
  const relinked = check.prepare('SELECT category_id FROM services WHERE id=?').get(service.id).category_id === original.id;
  const audit = check.prepare("SELECT 1 FROM catalogue_merge_audit WHERE entity_type='category' AND merged_id=?").get(duplicateId);
  const profile = check.prepare('SELECT selected_subcategories,authorized_subcategories FROM pro_profiles WHERE user_id=1').get();
  const migrated = JSON.parse(profile.selected_subcategories).includes(service.sub_id) && JSON.parse(profile.authorized_subcategories).includes(service.sub_id);
  const review = check.prepare("SELECT 1 FROM pro_profile_catalogue_reviews WHERE user_id=1 AND legacy_service_id=999999 AND status='a_verifier'").get();
  check.close(); fs.rmSync(data, { recursive: true, force: true });
  return gone && relinked && !!audit && migrated && !!review;
}
(async () => { try {
  const app = fs.readFileSync('public/app.js', 'utf8');
  const admin = fs.readFileSync('public/admin/admin.js', 'utf8');
  const dbjs = fs.readFileSync('db.js', 'utf8');
  const server = fs.readFileSync('server.js', 'utf8');
  yes(dbjs.includes('pro_profile_catalogue_reviews') && dbjs.includes('catalogue_merge_audit') && dbjs.includes('ad_view_events'), 'schéma persistant : file PDG, audit de fusion et vues publicitaires');
  yes(app.includes('proSkillPicker') && app.includes('selectedProSubcategories') && server.includes("/api/pro-skill-catalogue"), 'sélecteur pro hiérarchique réellement relié à l’API');
  yes(admin.includes('grandCategoryPhotoForm') && admin.includes('saveGrandCategoryPhoto') && admin.includes('deleteGrandCategoryPhoto'), 'PDG : ajout, aperçu, remplacement confirmé et retrait de photo disponibles');
  yes(admin.includes("SETTINGS_SECTIONS") && admin.includes("settingsTabs") && server.includes("/ads/analytics"), 'entrée Paramètres organisée et analytique publicitaire côté serveur');

  const login = (await api(null, '/auth/login', 'POST', { phone: 'admin', password: 'Klean@2026' })).d;
  yes(!!login.token, 'connexion PDG disponible');
  const skills = (await api(login.token, '/pro-skill-catalogue')).d;
  const allSubs = skills.flatMap(root => root.categories.flatMap(cat => cat.subcategories));
  yes(Array.isArray(skills) && skills.length === 30 && allSubs.length > 0 && allSubs.every(x => Number.isInteger(x.id)), 'catalogue de compétences : 30 grandes catégories et sous-catégories identifiées');

  const cats = (await api(null, '/grand-categories')).d;
  const photoCategory = cats.find(x => !x.image_url) || cats[0];
  const originalPhoto = photoCategory.image_url || '';
  const imported = await upload(login.token);
  const setPhoto = await api(login.token, '/admin/grand-categories/' + photoCategory.id, 'PUT', { image_url: imported.d.files && imported.d.files[0] });
  const saved = (await api(null, '/grand-categories/' + photoCategory.id + '/catalogue')).d;
  const unsetPhoto = await api(login.token, '/admin/grand-categories/' + photoCategory.id, 'PUT', { image_url: '' });
  const removed = (await api(null, '/grand-categories/' + photoCategory.id + '/catalogue')).d;
  if (originalPhoto) await api(login.token, '/admin/grand-categories/' + photoCategory.id, 'PUT', { image_url: originalPhoto });
  yes(imported.r.status === 200 && setPhoto.r.status === 200 && saved.image_url === imported.d.files[0] && unsetPhoto.r.status === 200 && (removed.image_url === null || removed.image_url === ''), 'photo liée à l’identifiant : import, persistance, publication et retrait sans supprimer la catégorie');

  const suffix = String(Date.now()).slice(-8);
  const registered = (await api(null, '/auth/register', 'POST', { name: 'Pro COLIS 27 ' + suffix, phone: '05' + suffix, password: 'secret27', ville: 'Abidjan', quartier: 'Cocody', accept_rules: true })).d;
  const noSub = await api(registered.token, '/pro/apply', 'POST', { profession: 'Test', zone: 'Abidjan', accept_rules: true, domain_categories: [skills[0].id] });
  const apply = await api(registered.token, '/pro/apply', 'POST', { profession: 'Test sous-catégorie', zone: 'Abidjan', accept_rules: true, selected_subcategories: [allSubs[0].id] });
  const me = (await api(registered.token, '/me')).d;
  yes(noSub.r.status === 400 && /sous-catégorie/i.test(noSub.d.error || '') && apply.r.status === 200 && me.pro && me.pro.selected_subcategories.includes(allSubs[0].id), 'inscription pro : sous-catégorie obligatoire, identifiant sauvegardé et domaine parent déduit');

  const title = 'Annonce analytique COLIS 27 ' + suffix;
  const ad = await api(login.token, '/admin/ads', 'POST', { type: 'texte', title, content: 'Validation persistante des vues', placement: 'accueil', active: true });
  const adKey = 'ad:' + ad.d.id;
  const anon = await api(null, '/ad-views', 'POST', { keys: [adKey], anonymous_key: 'anonymous_colis27_' + suffix + 'xy' });
  const known = await api(login.token, '/ad-views', 'POST', { keys: [adKey] });
  const analytics = await api(login.token, '/admin/ads/analytics');
  const item = analytics.d.find(x => x.kind === 'ad' && x.id === ad.d.id);
  const detail = await api(login.token, '/admin/ads/analytics/ad/' + ad.d.id + '/views');
  yes(ad.r.status === 200 && anon.d.recorded === 1 && known.d.recorded === 1 && item && item.total_views === 2 && item.unique_viewers === 2 && detail.d.known.some(x => x.name === 'Administrateur') && detail.d.anonymous.views === 1, 'vues publicitaires : total, uniques, utilisateur connecté et agrégat anonyme persistants');
  await api(login.token, '/admin/ads/' + ad.d.id, 'DELETE');

  yes(exactDedupMigrationTest(), 'dédoublonnage/migration : référence réalignée, compétence certaine migrée, cas inconnu en file PDG et audit conservé');
  console.log(`RESULT ${total - failed}/${total}, failed=${failed}`);
  process.exitCode = failed ? 1 : 0;
} catch (e) { console.error(e); process.exitCode = 1; } })();
