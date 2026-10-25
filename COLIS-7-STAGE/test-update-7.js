/* Vérifications E2E — mise à jour Klean Services (COLIS 7) */
const BASE = 'http://localhost:3000/api';
let pass = 0, fail = 0;
function ok(label, value, detail = '') { if (value) { pass++; console.log('  ✅ ' + label + (detail ? ' — ' + detail : '')); } else { fail++; console.log('  ❌ ' + label + (detail ? ' — ' + detail : '')); } }
async function call(token, path, method = 'GET', body, allowed = false) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok && !allowed) throw new Error(method + ' ' + path + ' -> ' + r.status + ' ' + (d.error || ''));
  return { r, d };
}
function answersFor(qs) { const a = {}; for (const q of qs) a[q.id] = q.type === 'bool' ? true : q.type === 'number' ? 2 : q.type === 'select' ? q.options[0] : q.type === 'date' ? '2026-10-08' : 'Précision test'; return a; }
(async () => {
  const s = String(Date.now()).slice(-8);
  console.log('\n========== TESTS COLIS 7 ==========' );
  const admin = (await call(null, '/auth/login', 'POST', { phone: 'admin', password: 'Klean@2026' })).d;
  const cities = (await call(null, '/villes')).d;
  const communes = ['Abidjan / Abobo','Abidjan / Adjamé','Abidjan / Anyama','Abidjan / Attécoubé','Abidjan / Bingerville','Abidjan / Cocody','Abidjan / Koumassi','Abidjan / Marcory','Abidjan / Plateau','Abidjan / Port-Bouët','Abidjan / Songon','Abidjan / Treichville','Abidjan / Yopougon'];
  ok('13 communes du district d’Abidjan sont disponibles', communes.every(c => cities.includes(c)), cities.filter(c => c.startsWith('Abidjan /')).length + ' communes');
  ok('La valeur générique « Abidjan » n’est plus proposée', !cities.includes('Abidjan'));

  const cocody = (await call(null, '/auth/register', 'POST', { name: 'Client Cocody', phone: '07' + s + '11', password: 'Test@1234', ville: 'Abidjan / Cocody', quartier: 'Angré', accept_rules: true })).d;
  const bouake = (await call(null, '/auth/register', 'POST', { name: 'Client Bouaké', phone: '05' + s + '12', password: 'Test@1234', ville: 'Bouaké', quartier: 'Air France', accept_rules: true })).d;
  ok('Inscription avec commune Abidjan / Cocody', cocody.user.ville === 'Abidjan / Cocody');

  // Ciblage géographique de publicité, contrôlé serveur (pas un simple filtrage écran).
  const targeted = (await call(admin.token, '/admin/ads', 'POST', { type: 'texte', title: 'Test ciblage Bouaké', content: 'Visible uniquement à Bouaké', placement: 'accueil', duration: 6, zones: ['Bouaké'] })).d;
  const adBouake = (await call(bouake.token, '/ads')).d;
  const adCocody = (await call(cocody.token, '/ads')).d;
  ok('Publicité ciblée visible à Bouaké', adBouake.some(a => a.id === targeted.id));
  ok('Publicité ciblée cachée à Abidjan / Cocody', !adCocody.some(a => a.id === targeted.id));
  const nationwide = (await call(admin.token, '/admin/ads', 'POST', { type: 'texte', title: 'Test national', content: 'Toute la Côte d’Ivoire', placement: 'accueil', duration: 6, zones: [] })).d;
  const nationalCocody = (await call(cocody.token, '/ads')).d;
  ok('Publicité nationale visible dans toutes les villes', nationalCocody.some(a => a.id === nationwide.id));
  const badZone = await call(admin.token, '/admin/ads', 'POST', { type: 'texte', title: 'Zone invalide', content: 'x', zones: ['Ville Inventée'] }, true);
  ok('Zone publicitaire invalide refusée côté serveur', badZone.r.status === 400);

  // Prix administré : une seule source de vérité, l’API client renvoie immédiatement la nouvelle valeur.
  const catalog = (await call(admin.token, '/admin/catalog')).d;
  const svc = catalog.services.find(x => x.price_show) || catalog.services[0];
  const before = (await call(cocody.token, '/services')).d.flatMap(c => c.services).find(x => x.id === svc.id);
  await call(admin.token, '/admin/services/' + svc.id, 'PUT', { price_from: 12345, price_prefix: 'Dès', price_show: 1 });
  const after = (await call(cocody.token, '/services')).d.flatMap(c => c.services).find(x => x.id === svc.id);
  ok('Prix accueil/catalogue synchronisé après modification PDG', before.price_from !== after.price_from && after.price_from === 12345, String(after.price_from));

  // Conversation directe : création, réponse auto, visibilité dashboard et réponse agent.
  const contact = (await call(cocody.token, '/support/conversations', 'POST', { subject: 'suggestion', content: 'Ajouter un créneau de rendez-vous.' })).d;
  ok('Suggestion créée avec réponse automatique', contact.messages.length === 2 && contact.messages[1].is_auto === 1 && /Merci pour votre suggestion/.test(contact.messages[1].content));
  const supports = (await call(admin.token, '/admin/support/conversations')).d;
  ok('Suggestion visible dans le tableau de bord', supports.some(c => c.id === contact.id && c.subject === 'suggestion'));
  await call(admin.token, '/admin/support/conversations/' + contact.id + '/messages', 'POST', { type: 'text', content: 'Merci, notre équipe étudie votre idée.' });
  const contactAfter = (await call(cocody.token, '/support/conversations/' + contact.id)).d;
  ok('Réponse de Klean Services synchronisée chez le client', contactAfter.messages.some(m => /notre équipe étudie/.test(m.content || '')));
  const hidden = await call(bouake.token, '/support/conversations/' + contact.id, 'GET', undefined, true);
  ok('Une conversation privée ne peut pas être lue par un autre client', hidden.r.status === 404);
  const concern = (await call(cocody.token, '/support/conversations', 'POST', { subject: 'preoccupation', content: 'Je souhaite être rappelé.' })).d;
  ok('Préoccupation reçoit le bon accusé automatique', /Un agent Klean Services/.test(concern.messages[1].content));

  // Professionnel : catégories/services, lieu de service courant et recherche client.
  const pro = (await call(null, '/auth/register', 'POST', { name: 'Pro Cocody', phone: '01' + s + '13', password: 'Test@1234', ville: 'Bouaké', accept_rules: true })).d;
  const catalogue = (await call(pro.token, '/catalogue')).d;
  const multi = catalogue.flatMap(c => c.services).find(x => x.taches && x.taches.length >= 2);
  await call(pro.token, '/pro/apply', 'POST', { profession: 'Professionnel test', zone: 'Bouaké', services: [multi.id], documents: [], accept_rules: true });
  await call(admin.token, '/admin/pros/' + pro.user.id + '/approve', 'POST');
  const newCity = (await call(pro.token, '/pro/service-location', 'PUT', { service_city: 'Abidjan / Cocody' })).d;
  ok('Le pro change son lieu de service sans changer sa ville d’inscription', newCity.pro.service_city === 'Abidjan / Cocody' && newCity.ville === 'Bouaké');
  const questionSet = (await call(cocody.token, '/services/' + multi.id + '/questions')).d;
  const created = (await call(cocody.token, '/missions', 'POST', { service_id: multi.id, answers: answersFor(questionSet.questions), address: 'Abidjan / Cocody, Angré', taches: [{ id: multi.taches[0].id, detail: 'Premier élément' }, { id: multi.taches[1].id, detail: 'Deuxième élément' }] })).d;
  const mission = (await call(cocody.token, '/missions/' + created.id)).d;
  ok('Deux tâches sont conservées dans une seule demande', mission.taches.length === 2 && mission.taches[0].detail === 'Premier élément');
  ok('Pro reçu comme opportunité selon son lieu de service actuel', mission.candidates && mission.candidates.some(c => c.id === pro.user.id));
  const other = (await call(null, '/auth/register', 'POST', { name: 'Client Korhogo', phone: '27' + s + '14', password: 'Test@1234', ville: 'Korhogo', accept_rules: true })).d;
  const qOther = (await call(other.token, '/services/' + multi.id + '/questions')).d;
  const wrongPlace = (await call(other.token, '/missions', 'POST', { service_id: multi.id, answers: answersFor(qOther.questions), address: 'Korhogo centre', taches: [{ id: multi.taches[0].id }] })).d;
  const miss = (await call(other.token, '/missions/' + wrongPlace.id)).d;
  ok('Pro non proposé hors de son lieu de service déclaré', !miss.candidates || !miss.candidates.some(c => c.id === pro.user.id));

  // Audio server compatibility for iPhone-friendly m4a upload and mission conversation.
  const fake = new FormData(); fake.append('files', new Blob(['m4a'], { type: 'audio/mp4' }), 'vocal.m4a');
  const up = await fetch(BASE + '/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + cocody.token }, body: fake }); const audio = (await up.json()).files[0];
  await call(cocody.token, '/missions/' + created.id + '/messages', 'POST', { type: 'audio', file: audio });
  const audioMsgs = (await call(cocody.token, '/missions/' + created.id + '/messages')).d;
  ok('Note vocale M4A (format iPhone) envoyée et restituée', audioMsgs.some(m => m.type === 'audio' && m.file === audio));

  console.log('\n========== RÉSULTAT COLIS 7 ==========' );
  console.log('  ' + pass + ' réussis, ' + fail + ' échec(s)');
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
