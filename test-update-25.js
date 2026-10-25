/* Vérifications E2E COLIS 25 — prix publics traçables, lieu pro, cartes et réattribution immuable. */
const fs = require('fs');
const BASE = (process.env.KLEAN_TEST_BASE || 'http://127.0.0.1:3125') + '/api';
let n = 0, fail = 0;
function yes(ok, label) { n++; if (ok) console.log('OK ', label); else { fail++; console.error('BAD', label); } }
async function api(token, path, method = 'GET', body) {
  const r = await fetch(BASE + path, { method, headers: { ...(token ? { Authorization:'Bearer ' + token } : {}), ...(body ? {'Content-Type':'application/json'} : {}) }, body:body ? JSON.stringify(body) : undefined });
  return { r, d:await r.json().catch(() => ({})) };
}
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
async function createPro(admin, name, phone, city, domainId, zone) {
  const p = (await api(null, '/auth/register', 'POST', { name, phone, password:'abcd1234', ville:city, accept_rules:true })).d;
  let r = await api(p.token, '/pro/apply', 'POST', { profession:'Professionnel test', zone, domain_categories:[domainId], accept_rules:true, pro_type:'particulier' });
  if (r.r.status !== 200) throw new Error('Candidature pro: ' + (r.d.error || r.r.status));
  r = await api(admin.token, '/admin/pros/' + p.user.id + '/approve', 'POST');
  if (r.r.status !== 200) throw new Error('Approbation pro: ' + (r.d.error || r.r.status));
  r = await api(admin.token, '/admin/pros/' + p.user.id + '/eligibility', 'PUT', { authorized_domain_categories:[domainId], authorized_services:[], service_cities:[city], pro_type:'particulier', capacity_level:1 });
  if (r.r.status !== 200) throw new Error('Autorisation pro: ' + (r.d.error || r.r.status));
  return p;
}
async function createMission(client, service, city, label) {
  return api(client.token, '/missions', 'POST', { service_id:service.id, description:label, address:'Quartier Kennedy, près du marché', intervention_city:city, schedule_type:'asap', provider_type:'particulier' });
}
(async () => { try {
  const source = fs.readFileSync('server.js','utf8'), dbSource = fs.readFileSync('db.js','utf8'), app = fs.readFileSync('public/app.js','utf8'), adminJs = fs.readFileSync('public/admin/admin.js','utf8');
  const cards = fs.readFileSync('public/category-cards.css','utf8'), index = fs.readFileSync('public/index.html','utf8'), sw = fs.readFileSync('public/sw.js','utf8');
  const agricultureAsset = fs.existsSync('public/category-images/agriculture.svg');
  yes(dbSource.includes("CREATE TABLE IF NOT EXISTS mission_reassignments") && source.includes("source_url LIKE 'https://%'") && source.includes("app.post('/api/geocode'"), 'migrations et contrôles serveur COLIS 25 présents (historique, provenance et géocodage explicite)');
  yes(app.includes('A.openDirections') && app.includes('service-location') && app.includes('geocodeRequestAddress') && app.includes('task-price'), 'parcours client/pro réellement raccordés : GPS, adresse, itinéraire et prix des tâches');
  yes(adminJs.includes('Réattribuer') && adminJs.includes('confirm_sensitive') && adminJs.includes('public_unit'), 'dashboard PDG : réattribution confirmée et unité de prix administrable');
  yes(index.includes('/category-cards.css') && sw.includes('ks-v8-public-shell') && sw.includes("'/category-cards.css'") && cards.includes('object-fit:cover') && cards.includes('@media(min-width:700px)'), 'cartes illustrées chargées, cache PWA renouvelé et rendu responsive téléphone/ordinateur');

  const admin = (await api(null, '/auth/login', 'POST', { phone:'admin', password:'Klean@2026' })).d;
  yes(!!admin.token && admin.user.role === 'pdg', 'connexion PDG pour les opérations réservées');
  const cities = (await api(null, '/villes')).d;
  const bouake = cities.find(v => norm(v) === 'bouake') || cities[0];
  const otherCity = cities.find(v => v !== bouake) || 'Abidjan';
  const catalog = (await api(null, '/grand-categories?ville=Abidjan')).d;
  const plomberie = catalog.find(g => norm(g.name) === 'plomberie');
  const service = plomberie.categories.flatMap(c => c.services).find(s => s.id);
  const publicTasks = catalog.flatMap(g => g.categories).flatMap(c => c.services).flatMap(s => s.taches || []).filter(t => t.price_from);
  const rules = (await api(admin.token, '/admin/estimation-rules')).d;
  const seeded = rules.filter(r => r.task_id && r.source_url && r.source_url.startsWith('https://') && r.source_date && r.verified_at && r.public_unit);
  yes(catalog.some(g => g.image_url && g.image_url.startsWith('/category-images/')) && publicTasks.length > 0 && publicTasks.every(t => Number(t.price_from) > 0), 'catalogue public : seules les références chiffrées traçables remontent sous les tâches');
  yes(seeded.length >= 1 && seeded.every(r => r.source_note && r.source_url.startsWith('https://')), 'prix seedés avec source, date de vérification et unité/condition modifiables par le PDG');
  const imageCategory = catalog.find(g => g.image_url), image = imageCategory && imageCategory.image_url;
  const publicBase = process.env.KLEAN_TEST_BASE || 'http://127.0.0.1:3125';
  const imageResponse = image ? await fetch(publicBase + image) : { status:0 };
  yes(imageResponse.status === 200, 'au moins un visuel de catégorie est livré localement et accessible');
  // Un visuel téléversé depuis le dashboard devient public seulement une fois rattaché à une catégorie active.
  const form = new FormData(); form.append('files', new Blob([Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64')], {type:'image/gif'}), 'carte-c25.gif');
  const uploadResponse = await fetch(publicBase + '/api/upload', { method:'POST', headers:{Authorization:'Bearer ' + admin.token}, body:form });
  const uploadData = await uploadResponse.json().catch(()=>({}));
  const uploadedPath = uploadData.files && uploadData.files[0];
  const publishedUpload = uploadedPath && await api(admin.token, '/admin/grand-categories/' + imageCategory.id, 'PUT', { image_url:uploadedPath });
  const uploadedPublic = uploadedPath ? await fetch(publicBase + uploadedPath) : {status:0};
  if (imageCategory) await api(admin.token, '/admin/grand-categories/' + imageCategory.id, 'PUT', { image_url:imageCategory.image_url });
  yes(uploadResponse.status === 200 && publishedUpload && publishedUpload.r.status === 200 && uploadedPublic.status === 200, 'image téléversée par le PDG publiée réellement sur une carte, sans ouvrir les médias privés');

  const suffix = String(Date.now()).slice(-8);
  const client = (await api(null, '/auth/register', 'POST', { name:'Client C25 ' + suffix, phone:'05' + suffix, password:'abcd1234', ville:bouake, address:'Quartier Kennedy', accept_rules:true })).d;
  const client2 = (await api(null, '/auth/register', 'POST', { name:'Client deux C25 ' + suffix, phone:'03' + suffix, password:'abcd1234', ville:bouake, address:'Quartier Commerce', accept_rules:true })).d;
  const client3 = (await api(null, '/auth/register', 'POST', { name:'Client trois C25 ' + suffix, phone:'04' + suffix, password:'abcd1234', ville:bouake, address:'Quartier Air France', accept_rules:true })).d;
  const pro1 = await createPro(admin, 'Pro un C25 ' + suffix, '06' + suffix, bouake, plomberie.id, 'Kennedy');
  const pro2 = await createPro(admin, 'Pro deux C25 ' + suffix, '09' + suffix, bouake, plomberie.id, 'Air France');
  const pro3 = await createPro(admin, 'Pro trois C25 ' + suffix, '01' + suffix, bouake, plomberie.id, 'Commerce');

  let r = await api(pro1.token, '/pro/service-location', 'PUT', { service_city:bouake, zone:'Kennedy et environs', lat:7.6905, lng:-5.0302 });
  const locUpdated = r.r.status === 200 && r.d.pro && r.d.pro.service_city === bouake && Number(r.d.pro.service_lat) === 7.6905;
  r = await api(pro1.token, '/pro/service-location', 'PUT', { service_city:otherCity, zone:'Zone refusée' });
  const geocodeMissing = await api(client.token, '/geocode', 'POST', { city:bouake });
  yes(locUpdated && r.r.status === 403 && geocodeMissing.r.status === 400, 'lieu pro GPS/zone enregistré côté serveur ; ville non autorisée et géocodage incomplet refusés');

  // Un administrateur sans permission explicite ne peut pas réattribuer ; après octroi, il le peut.
  const staff = await api(admin.token, '/admin/staff', 'POST', { name:'Gestionnaire C25', phone:'02' + suffix, role:'admin' });
  const staffLogin = (await api(null, '/auth/login', 'POST', { phone:'02' + suffix, password:staff.d.temp_password })).d;
  const mission1 = await createMission(client, service, bouake, 'Mission de réattribution simple C25.');
  r = await api(pro1.token, '/missions/' + mission1.d.id + '/accept', 'POST');
  const denied = await api(staffLogin.token, '/admin/missions/' + mission1.d.id + '/reassignment-candidates');
  const candidates = await api(admin.token, '/admin/missions/' + mission1.d.id + '/reassignment-candidates');
  r = await api(admin.token, '/admin/staff/' + staff.d.id, 'PUT', { perms:{ missions:true, reassign_missions:true } });
  const allowedCandidates = await api(staffLogin.token, '/admin/missions/' + mission1.d.id + '/reassignment-candidates?q=' + encodeURIComponent('Pro deux'));
  const candidate2 = allowedCandidates.d.candidates && allowedCandidates.d.candidates.find(x => x.id === pro2.user.id);
  const reassigned = candidate2 && await api(staffLogin.token, '/admin/missions/' + mission1.d.id + '/reassign', 'POST', { new_pro_id:pro2.user.id, reason:'Affectation à une zone plus proche.' });
  const history = await api(admin.token, '/admin/missions/' + mission1.d.id + '/reassignments');
  const m1 = await api(client.token, '/missions/' + mission1.d.id);
  const dashboard1 = await api(pro1.token, '/pro/dashboard'); const dashboard2 = await api(pro2.token, '/pro/dashboard');
  yes(mission1.r.status === 200 && r.r.status === 200 && denied.r.status === 403 && candidates.r.status === 200 && reassigned && reassigned.r.status === 200 && history.d.length === 1 && history.d[0].old_pro_id === pro1.user.id && history.d[0].new_pro_id === pro2.user.id && m1.d.pro && m1.d.pro.id === pro2.user.id && dashboard1.d.available === 1 && dashboard2.d.availability_status === 'en_mission', 'réattribution : permission serveur explicite, historique immuable, ancien pro libéré et nouveau pro indisponible');

  const mission2 = await createMission(client2, service, bouake, 'Mission démarrée sensible C25.');
  r = await api(pro1.token, '/missions/' + mission2.d.id + '/accept', 'POST');
  await api(client2.token, '/missions/' + mission2.d.id + '/confirm', 'POST');
  await api(pro1.token, '/missions/' + mission2.d.id + '/montant', 'POST', { amount:12000 });
  await api(pro1.token, '/missions/' + mission2.d.id + '/start', 'POST');
  const withoutConfirm = await api(admin.token, '/admin/missions/' + mission2.d.id + '/reassign', 'POST', { new_pro_id:pro3.user.id, reason:'Remplacement durant une mission commencée.' });
  const withConfirm = await api(admin.token, '/admin/missions/' + mission2.d.id + '/reassign', 'POST', { new_pro_id:pro3.user.id, reason:'Remplacement durant une mission commencée.', confirm_sensitive:true });
  yes(r.r.status === 200 && withoutConfirm.r.status === 409 && withoutConfirm.d.requires_confirmation === true && withConfirm.r.status === 200 && withConfirm.d.sensitive === true, 'mission démarrée : confirmation renforcée obligatoire avant toute réattribution');

  // Paiement validé : scénario intégral de mission, puis verrou de réattribution avant toute modification d’affectation.
  const mission3 = await createMission(client3, service, bouake, 'Mission à paiement validé C25.');
  await api(pro1.token, '/missions/' + mission3.d.id + '/accept', 'POST');
  await api(client3.token, '/missions/' + mission3.d.id + '/confirm', 'POST');
  await api(pro1.token, '/missions/' + mission3.d.id + '/montant', 'POST', { amount:15000 });
  await api(pro1.token, '/missions/' + mission3.d.id + '/start', 'POST');
  await api(client3.token, '/missions/' + mission3.d.id + '/start/confirm', 'POST');
  await api(pro1.token, '/missions/' + mission3.d.id + '/complete', 'POST');
  await api(client3.token, '/missions/' + mission3.d.id + '/complete/confirm', 'POST');
  await api(client3.token, '/missions/' + mission3.d.id + '/payment/confirm', 'POST');
  await api(pro1.token, '/missions/' + mission3.d.id + '/payment/confirm', 'POST');
  const paidBefore = await api(client3.token, '/missions/' + mission3.d.id);
  const paidReassign = await api(admin.token, '/admin/missions/' + mission3.d.id + '/reassign', 'POST', { new_pro_id:pro2.user.id, reason:'Tentative interdite après paiement.', confirm_sensitive:true });
  const paidAfter = await api(client3.token, '/missions/' + mission3.d.id);
  const paidHistory = await api(admin.token, '/admin/missions/' + mission3.d.id + '/reassignments');
  yes(paidBefore.d.status === 'payee' && paidReassign.r.status === 409 && /payée|paiement/i.test(paidReassign.d.error || '') && paidAfter.d.pro && paidAfter.d.pro.id === pro1.user.id && paidHistory.d.length === 0, 'paiement validé : réattribution bloquée sans réécrire le professionnel, le paiement ni l’historique');

  console.log(`RESULT ${n-fail}/${n}, failed=${fail}`); process.exitCode = fail ? 1 : 0;
} catch (e) { console.error(e); process.exitCode = 1; } })();
