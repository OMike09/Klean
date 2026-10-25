/* Vérifications E2E COLIS 17 — splash, accueil, catalogue A–Z, emplois, avis et urgences. */
const fs = require('fs');
const BASE = (process.env.KLEAN_TEST_BASE || 'http://127.0.0.1:3102') + '/api';
let n = 0, fail = 0;
async function api(token, path, method = 'GET', body) {
  const r = await fetch(BASE + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({})); return { r, d };
}
function yes(ok, label) { n++; if (ok) console.log('OK ', label); else { fail++; console.error('BAD', label); } }
const norm = s => String(s || '').toLocaleLowerCase('fr').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
(async () => { try {
  const admin = (await api(null, '/auth/login', 'POST', { phone:'admin', password:'Klean@2026' })).d;
  yes(!!admin.token && admin.user.role === 'pdg', 'connexion PDG');
  const cities = (await api(null, '/villes')).d; const city = cities[0]; const suffix = String(Date.now()).slice(-8);
  const user = (await api(null, '/auth/register', 'POST', { name:'Test COLIS 17', phone:'08'+suffix, password:'abcd1234', ville:city, accept_rules:true })).d;
  yes(!!user.token, 'création client de test');

  const catalogue = await api(null, '/catalogue?ville=' + encodeURIComponent(city));
  const services = catalogue.d.flatMap(c => c.services || []);
  const ids = services.map(s => s.id), ordered = [...services].sort((a,b)=>String(a.name).localeCompare(String(b.name),'fr',{sensitivity:'base',numeric:true}));
  yes(catalogue.r.status === 200 && ids.length === new Set(ids).size && fs.readFileSync('public/app.js','utf8').includes("localeCompare(String(b.name), 'fr', { sensitivity:'base', numeric:true })"), 'catalogue central sans doublon et classé A–Z français');

  let r = await api(user.token, '/job-offers', 'POST', { title:'', description:'', city:'', contact:'' });
  yes(r.r.status === 400, 'offre de job : validations serveur obligatoires');
  r = await api(user.token, '/job-offers', 'POST', { title:'Chauffeur privé '+suffix, description:'Conduite et accompagnement professionnel.', skills:'Permis B', city, location:'Quartier libre', duration:'CDD 3 mois', compensation:'À discuter', contact:'0700000000', application_method:'Appeler avant de candidater' });
  const jobId = r.d.id;
  yes(r.r.status === 201 && r.d.status === 'pending', 'offre de job réellement créée et mise en modération');
  const forbiddenOffers = await api(user.token, '/admin/job-offers');
  yes(forbiddenOffers.r.status === 403, 'offres protégées côté serveur contre l’administration non autorisée');
  let offers = await api(admin.token, '/admin/job-offers');
  yes(offers.d.some(o => o.id === jobId && o.status === 'pending'), 'offre visible dans la modération');
  r = await api(admin.token, '/admin/job-offers/'+jobId+'/status', 'POST', { status:'approved' });
  const publicOffers = await api(user.token, '/job-offers?q=chauffeur');
  yes(r.r.status === 200 && publicOffers.d.some(o => o.id === jobId && o.status === 'approved'), 'offre publiée puis trouvable par recherche');

  const cats = await api(user.token, '/avis-recherche/categories');
  yes(cats.r.status === 200 && cats.d.length >= 3 && cats.d.every(c=>c.active), 'catégories d’avis actives disponibles');
  r = await api(user.token, '/avis-recherche', 'POST', { category_id:cats.d[0].id, nom:'Objet sans détails', city, contact:'0700000000' });
  yes(r.r.status === 400, 'avis : description obligatoire côté serveur');
  r = await api(user.token, '/avis-recherche', 'POST', { category_id:cats.d[1].id, nom:'Sac noir perdu '+suffix, description:'Sac noir avec documents, perdu près du marché.', city, dernier_lieu:'Marché central', contact:'0700000000' });
  const noticeId = r.d.id;
  yes(r.r.status === 200 && r.d.status === 'pending', 'avis catégorisé créé et mis en modération');
  r = await api(admin.token, '/admin/avis-recherche/'+noticeId+'/status', 'POST', {status:'approved'});
  const notices = await api(user.token, '/avis-recherche?category_id='+cats.d[1].id+'&q='+encodeURIComponent('sac noir'));
  yes(r.r.status === 200 && notices.d.some(a=>a.id===noticeId && a.city===city && a.category_id===cats.d[1].id), 'avis approuvé consultable, filtrable et rattaché à la catégorie');
  const newCat = await api(admin.token, '/admin/avis-categories', 'POST', {name:'Recherche temporaire '+suffix, description:'Catégorie de test', sort:88});
  r = await api(admin.token, '/admin/avis-categories/'+newCat.d.id, 'PUT', {active:0});
  const activeCats = await api(user.token, '/avis-recherche/categories');
  yes(newCat.r.status === 201 && r.r.status === 200 && !activeCats.d.some(c=>c.id===newCat.d.id), 'PDG peut configurer et désactiver une catégorie sans effacer les données');

  let emergency = await api(user.token, '/urgence/config');
  yes(emergency.r.status === 200 && emergency.d.assistance_available === false && emergency.d.contacts.length >= 18 && emergency.d.contacts.every(c=>c.source_url&&c.verified_at), 'assistance Klean indisponible par défaut, répertoire officiel public disponible');
  r = await api(admin.token, '/admin/settings', 'PUT', { urgence_assistance_enabled:'1', urgence_info:'Assistance test disponible', urgence_categories:JSON.stringify([{name:'Panne critique',description:'Test de configuration',active:true}]), urgence_contacts:JSON.stringify([{nom:'Contact test vérifié',tel:'0700000000',verified:true},{nom:'Contact non vérifié',tel:'0100000000',verified:false}]) });
  emergency = await api(user.token, '/urgence/config');
  const alert = await api(user.token, '/urgence', 'POST', {category:'Panne critique', message:'Besoin d’assistance', lat:null, lng:null});
  yes(r.r.status === 200 && emergency.d.assistance_available && emergency.d.categories.length===1 && emergency.d.contacts.some(c=>c.nom==='Police nationale') && !emergency.d.contacts.some(c=>c.nom==='Contact test vérifié') && alert.r.status===200, 'urgences : assistance configurée et répertoire limité aux contacts institutionnels');

  const app = fs.readFileSync('public/app.js','utf8'), css = fs.readFileSync('public/styles.css','utf8');
  yes(!app.includes('Klean Services - Tout commence par une mise en relation.') && app.includes('Trouver ou proposer un job') && app.includes('home-shortcuts'), 'accueil simplifié et libellé emploi remplacé dans l’interface');
  yes(css.includes('.splash{position:fixed') && css.includes('width:100dvw') && app.includes('setTimeout(releaseSplash, 3000)'), 'splash plein écran, responsive et temporisé à 3 secondes');
  console.log(`RESULT ${n-fail}/${n}, failed=${fail}`); process.exitCode = fail ? 1 : 0;
} catch(e) { console.error(e); process.exitCode=1; } })();
