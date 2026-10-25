/* Vérifications E2E COLIS 21 — grandes catégories, tâches facultatives et parcours tarifaire fiable. */
const fs = require('fs');
const BASE = (process.env.KLEAN_TEST_BASE || 'http://127.0.0.1:3121') + '/api';
let n = 0, fail = 0;
function yes(ok, label) { n++; if (ok) console.log('OK ', label); else { fail++; console.error('BAD', label); } }
async function api(token, path, method = 'GET', body) {
  const r = await fetch(BASE + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({})); return { r, d };
}
(async () => { try {
  const all = (await api(null, '/grand-categories')).d;
  const popular = (await api(null, '/grand-categories/populaires')).d;
  yes(Array.isArray(all) && all.length > 0 && all.every(g => g.id && g.name && Array.isArray(g.categories)), 'les grandes catégories publiques sont chargées depuis la base');
  yes(all.map(g => g.name).join('|') === all.map(g => g.name).slice().sort((a,b)=>a.localeCompare(b, 'fr')).join('|'), 'Voir tous les services est classé A–Z par grandes catégories');
  yes(popular.length > 0 && popular.every(g => g.id && g.categories && !('service_id' in g) && !('task_id' in g)), 'les cartes populaires sont uniquement des grandes catégories, sans prestation ni tâche autonome');
  yes(new Set(popular.map(g => g.id)).size === popular.length, 'aucun doublon parmi les grandes catégories populaires');

  const category = all.find(g => g.categories.some(c => c.services.some(s => s.taches.length))) || all.find(g => g.categories.some(c => c.services.length));
  const service = category.categories.flatMap(c => c.services).find(s => s.taches.length) || category.categories.flatMap(c => c.services)[0];
  const detail = await api(null, '/grand-categories/' + category.id + '/catalogue');
  yes(detail.r.status === 200 && detail.d.id === category.id && detail.d.categories.every(c => c.services.every(s => Array.isArray(s.taches))), 'un clic catégorie ouvre son détail avec ses prestations et tâches rattachées');
  const search = await api(null, '/search?q=' + encodeURIComponent(category.name));
  yes(search.r.status === 200 && Array.isArray(search.d.categories) && search.d.categories.some(g => g.id === category.id), 'la recherche distingue et retourne une grande catégorie');

  const login = await api(null, '/auth/login', 'POST', { phone:'admin', password:'Klean@2026' });
  const admin = login.d;
  yes(login.r.status === 200 && admin.user && admin.user.role === 'pdg', 'le PDG est authentifié pour la gestion des catégories et tâches');
  const suffix = String(Date.now()).slice(-8);
  const client = (await api(null, '/auth/register', 'POST', { name:'Client C21 ' + suffix, phone:'07' + suffix, password:'abcd1234', ville:'Abidjan', accept_rules:true })).d;
  const denied = await api(client.token, '/admin/taches', 'POST', { service_id:service.id, name:'Interdit C21' });
  yes(denied.r.status === 403, 'la gestion des tâches est contrôlée côté serveur et réservée au PDG');

  const newTask = await api(admin.token, '/admin/taches', 'POST', { service_id:service.id, name:'Tâche C21 ' + suffix, description:'Description documentée COLIS 21' });
  const taskId = newTask.d.id;
  const serviceDetail = await api(null, '/services/' + service.id + '/questions');
  yes(newTask.r.status === 201 && serviceDetail.d.taches.some(t => t.id === taskId && t.description === 'Description documentée COLIS 21'), 'le PDG crée une tâche avec sa description, publiée côté client');
  const moved = await api(admin.token, '/admin/taches/' + taskId, 'PUT', { service_id:service.id, description:'Description modifiée C21', active:false });
  const disabledTask = await api(null, '/services/' + service.id + '/questions');
  yes(moved.r.status === 200 && !disabledTask.d.taches.some(t => t.id === taskId), 'une tâche peut être modifiée et désactivée sans être effacée');
  const deleted = await api(admin.token, '/admin/taches/' + taskId, 'DELETE');
  yes(deleted.r.status === 200, 'une tâche sans historique peut être supprimée après confirmation client');
  const catDelete = await api(admin.token, '/admin/grand-categories/' + category.id, 'DELETE');
  yes(catDelete.r.status === 400 && /réaffect|contient/i.test(catDelete.d.error || ''), 'une grande catégorie utilisée exige une réaffectation ou désactivation avant suppression');

  const rule = await api(admin.token, '/admin/estimation-rules', 'POST', { service_id:service.id, base_price:5432, source_type:'pdg', source_note:'Référence vérifiée COLIS 21', source_url:'', source_date:'2026-10-25', verified_at:'2026-10-25', active:true, priority:77, factors:'{}' });
  const withPrice = await api(null, '/grand-categories/' + category.id + '/catalogue');
  yes(rule.r.status === 201 && withPrice.d.price_from === 5432, 'une carte de grande catégorie expose seulement la référence fiable « À partir de »');
  await api(admin.token, '/admin/estimation-rules/' + rule.d.id, 'PUT', { active:false });
  const withoutPrice = await api(null, '/grand-categories/' + category.id + '/catalogue');
  yes(withoutPrice.d.price_from === null, 'sans règle fiable, aucune valeur ni texte de confirmation n’est retourné pour la carte catégorie');

  const mission = await api(client.token, '/missions', 'POST', { service_id:service.id, description:'Besoin libre COLIS 21, sans tâche prédéfinie.', address:'Quartier test C21', intervention_city:'Abidjan', intervention_commune:'Cocody', schedule_type:'asap' });
  yes(mission.r.status === 200 && mission.d.id, 'une demande complète sans tâche prédéfinie est réellement acceptée et mise en relation');
  const historicTask = (serviceDetail.d.taches || [])[0];
  if (historicTask) {
    const missionWithTask = await api(client.token, '/missions', 'POST', { service_id:service.id, task_id:historicTask.id, description:'Besoin avec tâche historique C21.', address:'Quartier test C21', intervention_city:'Abidjan', intervention_commune:'Cocody', schedule_type:'asap', duplicate_confirmed:true });
    const historyProtected = await api(admin.token, '/admin/taches/' + historicTask.id, 'DELETE');
    yes(missionWithTask.r.status === 200 && historyProtected.r.status === 409, 'une tâche liée à une demande historique est protégée de la suppression');
  }

  const desired = [category.id];
  const order = await api(admin.token, '/admin/grand-categories/populaires/ordre', 'PUT', { ids: desired });
  const persisted = await api(null, '/grand-categories/populaires');
  yes(order.r.status === 200 && persisted.d.map(g => g.id).join(',') === desired.join(','), 'la sélection et l’ordre des catégories populaires sont persistés côté serveur');

  const app = fs.readFileSync('public/app.js', 'utf8'), adminJs = fs.readFileSync('public/admin/admin.js', 'utf8'), server = fs.readFileSync('server.js','utf8');
  yes(app.includes("api('/grand-categories/populaires'") && app.includes("nav('#/categories')") && app.includes('Je décris mon besoin ci-dessous.') && app.includes('Trouver un professionnel'), 'l’accueil et le nouveau formulaire utilisent le parcours catégories avec le libellé et CTA demandés');
  yes(app.includes('requestToggleTask') && app.includes("zone.innerHTML = r.status === 'estimated' && r.amount") && !app.includes("'<div class=\"estimate-price\">Prix à confirmer</div>'"), 'tâche facultative et estimation client silencieuse en absence de donnée fiable');
  yes(adminJs.includes('Gestion des catégories et des tâches') && adminJs.includes('Catégories populaires') && adminJs.includes('Déplacer vers une prestation'), 'le dashboard PDG gère catégories populaires, recherche/description et déplacement des tâches');
  yes(server.includes("A.put('/grand-categories/populaires/ordre', pdgOnly") && server.includes("A.delete('/taches/:id', pdgOnly"), 'les opérations PDG de réorganisation et suppression sont protégées côté serveur');

  console.log(`RESULT ${n-fail}/${n}, failed=${fail}`); process.exitCode = fail ? 1 : 0;
} catch (e) { console.error(e); process.exitCode = 1; } })();
