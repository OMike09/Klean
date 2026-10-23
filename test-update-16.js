/* Vérifications E2E COLIS 16 — recherche intelligente, domaines pro et estimation locale. */
const BASE = (process.env.KLEAN_TEST_BASE || 'http://127.0.0.1:3000') + '/api';
let n = 0, fail = 0;
async function api(token, path, method = 'GET', body) {
  const r = await fetch(BASE + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({})); return { r, d };
}
function yes(ok, label) { n++; if (ok) console.log('OK ', label); else { fail++; console.error('BAD', label); } }
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
(async () => { try {
  const admin = (await api(null, '/auth/login', 'POST', { phone: 'admin', password: 'Klean@2026' })).d;
  yes(!!admin.token && admin.user.role === 'pdg', 'connexion PDG');
  const domains = await api(null, '/grand-categories');
  const plomberie = domains.d.find(x => norm(x.name) === 'plomberie');
  yes(domains.r.status === 200 && domains.d.length >= 20 && !!plomberie, 'catalogue central de grandes catégories disponible');

  const cities = (await api(null, '/villes')).d;
  const bouake = cities.find(v => norm(v) === 'bouake') || cities[0];
  const suffix = String(Date.now()).slice(-8);
  const pro = (await api(null, '/auth/register', 'POST', { name: 'Pro plomberie domaines', phone: '06' + suffix, password: 'abcd1234', ville: bouake, accept_rules: true })).d;
  let r = await api(pro.token, '/pro/apply', 'POST', { profession: 'Plombier', zone: bouake, domain_categories: [plomberie.id], accept_rules: true, pro_type: 'particulier' });
  yes(r.r.status === 200 && r.d.pro_status === 'pending', 'professionnel inscrit avec un seul domaine, sans liste de tâches');
  r = await api(admin.token, '/admin/pros/' + pro.user.id + '/approve', 'POST');
  const eligibility = await api(admin.token, '/admin/pros/' + pro.user.id + '/eligibility', 'PUT', { authorized_domain_categories: [plomberie.id], authorized_services: [], service_cities: [bouake], pro_type: 'particulier', capacity_level: 1 });
  yes(r.r.status === 200 && eligibility.r.status === 200 && eligibility.d.authorized_domain_categories.includes(plomberie.id), 'PDG approuve le domaine et la ville du professionnel');

  const searchLeak = await api(null, '/search?q=' + encodeURIComponent('mon eau coule') + '&ville=' + encodeURIComponent(bouake));
  const searchTypo = await api(null, '/search?q=' + encodeURIComponent('mon robine coule') + '&ville=' + encodeURIComponent(bouake));
  const leak = searchLeak.d.results && searchLeak.d.results.find(x => norm(x.category).includes('plomberie') && x.task_id);
  yes(searchLeak.r.status === 200 && !!leak && searchTypo.d.results.some(x => x.id === leak.id), 'recherche instantanée : expression familière et faute rapprochées de la plomberie');

  r = await api(admin.token, '/admin/taches', 'POST', { service_id: leak.id, name: 'Contrôle dynamique de fuite ' + suffix });
  const dynamicTaskId = r.d.id;
  const afterTask = await api(null, '/services/' + leak.id + '/questions');
  yes(r.r.status === 200 && afterTask.d.taches.some(t => t.id === dynamicTaskId), 'nouvelle tâche ajoutée au catalogue central');

  const ruleBouake = await api(admin.token, '/admin/estimation-rules', 'POST', { service_id: leak.id, task_id: leak.task_id, city: bouake, base_price: 6500, source_type: 'pdg', source_note: 'Référence validée par la direction pour le test.', active: true, priority: 10, factors: { includes: 'Main-d’œuvre de départ uniquement.' } });
  const ruleAbidjan = await api(admin.token, '/admin/estimation-rules', 'POST', { service_id: leak.id, task_id: leak.task_id, city: 'Abidjan', base_price: 8000, source_type: 'pdg', source_note: 'Référence direction Abidjan pour le test.', active: true, priority: 10, factors: {} });
  const estBouake = await api(null, `/estimates?service_id=${leak.id}&task_id=${leak.task_id}&city=${encodeURIComponent(bouake)}`);
  const estAbidjan = await api(null, `/estimates?service_id=${leak.id}&task_id=${leak.task_id}&city=Abidjan`);
  yes(ruleBouake.r.status === 201 && ruleAbidjan.r.status === 201 && estBouake.d.amount === 6500 && estAbidjan.d.amount === 8000 && estBouake.d.source.includes('direction'), 'prix de départ calculé avec règles PDG distinctes pour Bouaké et Abidjan');

  const serviceList = (await api(null, '/services?ville=' + encodeURIComponent(bouake))).d;
  const noDataService = serviceList.flatMap(c => c.services || []).find(s => s.id !== leak.id);
  await api(admin.token, '/admin/estimation-config', 'PUT', { fallback: 'confirmer', geo_enabled: true, history_min_samples: 3 });
  const noEstimate = await api(null, `/estimates?service_id=${noDataService.id}&city=${encodeURIComponent(bouake)}`);
  await api(admin.token, '/admin/estimation-config', 'PUT', { fallback: 'reference', geo_enabled: true, history_min_samples: 3 });
  yes(noEstimate.r.status === 200 && noEstimate.d.status === 'confirm', 'absence de donnée fiable : prix à confirmer au lieu d’un montant inventé');

  const client = (await api(null, '/auth/register', 'POST', { name: 'Client demande domaines', phone: '05' + suffix, password: 'abcd1234', ville: bouake, address: 'Quartier de test', accept_rules: true })).d;
  await api(admin.token, '/admin/settings', 'PUT', { request_image_limit: '3', request_audio_max_seconds: '25' });
  const limits = await api(null, '/services/' + leak.id + '/questions');
  const mission = await api(client.token, '/missions', 'POST', { service_id: leak.id, task_id: dynamicTaskId, description: 'Mon eau coule, contrôle dynamique demandé.', address: 'Quartier de test, ' + bouake, intervention_city: bouake, photos: [], schedule_type: 'asap', provider_type: 'particulier' });
  const proOffers = await api(pro.token, '/missions');
  yes(limits.d.limits.photos === 3 && limits.d.limits.audio_seconds === 25 && mission.r.status === 200 && mission.d.estimate && proOffers.d.offers.some(m => m.id === mission.d.id), 'formulaire universel limité à 3 photos et 25 secondes, puis demande dirigée vers le domaine professionnel');

  const requestChange = await api(pro.token, '/pro/domain-change-request', 'POST', { domain_categories: [plomberie.id] });
  yes(requestChange.r.status === 409, 'professionnel ne peut pas contourner les domaines déjà autorisés');

  console.log(`RESULT ${n - fail}/${n}, failed=${fail}`); process.exitCode = fail ? 1 : 0;
} catch (e) { console.error(e); process.exitCode = 1; } })();
