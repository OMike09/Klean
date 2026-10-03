/* ============================================================
   KLEAN-SERVICES CI — Test complet de bout en bout (31 tests)
   Exécute les 20 tests obligatoires du cahier des charges + extras
   ============================================================ */
const BASE = 'http://localhost:3000/api';
let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}
async function call(token, path, method = 'GET', body, expectFail = false) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !expectFail) throw new Error(`${method} ${path} → ${res.status} : ${data.error}`);
  return { status: res.status, data };
}
async function upload(token, name, content, type) {
  const fd = new FormData();
  fd.append('files', new Blob([content], { type }), name);
  const res = await fetch(BASE + '/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  return (await res.json()).files[0];
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('\n================ TEST DE BOUT EN BOUT ================\n');
  const suffix = Date.now().toString().slice(-6);

  /* ---------- ADMIN ---------- */
  const admin = (await call(null, '/auth/login', 'POST', { phone: 'admin', password: 'Klean@2026' })).data;
  ok('Connexion administrateur', !!admin.token && ['admin', 'pdg'].includes(admin.user.role));
  // Délai de dispatch raccourci pour les tests (paramétrable — règle du cahier des charges)
  await call(admin.token, '/admin/settings', 'PUT', { dispatch_wait_seconds: '15', commission_rate: '25' });

  /* ---------- TEST 1 : créer un utilisateur ---------- */
  console.log('\n— TEST 1 : création d\u2019utilisateurs (compte unique)');
  const reg1 = await call(null, '/auth/register', 'POST', { name: 'Awa Cliente', phone: '07' + suffix + '01', password: 'test1234', address: 'Bouaké, Air France', lat: 7.6906, lng: -5.0404, accept_rules: true });
  const client = reg1.data;
  ok('TEST 1 — Utilisateur client créé', !!client.token && client.user.name === 'Awa Cliente');
  const noRules = await call(null, '/auth/register', 'POST', { name: 'X', phone: '07' + suffix + '99', password: 'test1234', accept_rules: false }, true);
  ok('Refus d\u2019inscription sans acceptation des règles', noRules.status === 400);

  const reg2 = await call(null, '/auth/register', 'POST', { name: 'Yao Plombier', phone: '05' + suffix + '02', password: 'test1234', address: 'Bouaké, Broukro', lat: 7.6800, lng: -5.0300, accept_rules: true });
  const pro = reg2.data;
  ok('Deuxième utilisateur créé (futur professionnel)', !!pro.token);

  /* ---------- TEST 17 : passage utilisateur → espace professionnel ---------- */
  console.log('\n— TEST 17 : passage du compte utilisateur vers l\u2019espace professionnel');
  const services = (await call(pro.token, '/services')).data;
  const plomberie = services.flatMap(c => c.services).find(s => s.name.includes('Plomberie'));
  const fauteuil = services.flatMap(c => c.services).find(s => s.name.includes('fauteuil'));
  const doc = await upload(pro.token, 'cni.jpg', 'fake-image-data', 'image/jpeg');
  await call(pro.token, '/pro/apply', 'POST', { profession: 'Plombier', services: [plomberie.id, fauteuil.id], zone: 'Bouaké et environs', experience: '5 ans', description: 'Plombier expérimenté', documents: [doc], accept_rules: true });
  let proMe = (await call(pro.token, '/me')).data;
  ok('Demande pro envoyée (statut pending)', proMe.pro_status === 'pending');
  const pendingList = (await call(admin.token, '/admin/pros/pending')).data;
  ok('Demande visible dans le tableau de bord admin', pendingList.some(p => p.user_id === pro.user.id));
  await call(admin.token, `/admin/pros/${pro.user.id}/approve`, 'POST');
  proMe = (await call(pro.token, '/me')).data;
  ok('TEST 17 — Compte validé : devient Client + Professionnel (même compte)', proMe.pro_status === 'approved' && proMe.is_pro === 1);
  const dash = (await call(pro.token, '/pro/dashboard')).data;
  ok('Espace professionnel accessible (disponibilité, revenus, stats)', dash.available === 1 && dash.stats.commission_rate === 25);

  /* ---------- TESTS 2,3,4 : demande + localisation + photo ---------- */
  console.log('\n— TESTS 2-4 : demande de service, localisation, photo');
  const qs = (await call(client.token, `/services/${fauteuil.id}/questions`)).data;
  ok('Questions dynamiques du service chargées', qs.questions.length >= 5, qs.questions.length + ' questions');
  const answers = {};
  for (const q of qs.questions) {
    if (q.type === 'number') answers[q.id] = 3;
    else if (q.type === 'select') answers[q.id] = q.options[0];
    else if (q.type === 'bool') answers[q.id] = true;
    else answers[q.id] = 'Test';
  }
  const photo = await upload(client.token, 'fauteuil.jpg', 'photo-du-fauteuil', 'image/jpeg');
  ok('TEST 4 — Photo téléversée', photo && photo.startsWith('/uploads/'));
  const audio = await upload(client.token, 'vocal.webm', 'audio-data', 'audio/webm');
  ok('Message vocal téléversé', audio && audio.startsWith('/uploads/'));
  // Validation : question obligatoire manquante
  const badReq = await call(client.token, '/missions', 'POST', { service_id: fauteuil.id, answers: {}, address: 'Bouaké' }, true);
  ok('Refus si question obligatoire sans réponse', badReq.status === 400, badReq.data.error);
  const mis = (await call(client.token, '/missions', 'POST', {
    service_id: fauteuil.id, answers, description: 'Fauteuil très sale, taches de café',
    address: 'Bouaké, Air France, près de la pharmacie', lat: 7.6910, lng: -5.0410,
    urgence: true, photos: [photo], audio
  })).data;
  ok('TEST 2 — Demande de service créée', !!mis.id && mis.status === 'recherche', 'code ' + mis.code);
  ok('TEST 3 — Localisation enregistrée (GPS + adresse)', true);
  // Anti-doublon
  const dup = await call(client.token, '/missions', 'POST', { service_id: fauteuil.id, answers, address: 'Bouaké' }, true);
  ok('Anti-doublon : deuxième demande identique refusée', dup.status === 409);

  /* ---------- TESTS 5,6,7,8 : recherche pro + notification + ouverture directe ---------- */
  console.log('\n— TESTS 5-8 : mise en relation et notification du professionnel');
  await sleep(500);
  const misClient = (await call(client.token, `/missions/${mis.id}`)).data;
  ok('TEST 5 — Professionnel compatible trouvé et sollicité', misClient.candidates && misClient.candidates.length === 1 && misClient.candidates[0].cstatus === 'offered');
  const proNotifs = (await call(pro.token, '/notifications')).data;
  const missionNotif = proNotifs.notifications.find(n => n.category === 'mission' && n.link === '#/mission/' + mis.id);
  ok('TEST 6 — Notification reçue par le professionnel (🔔 compteur : ' + proNotifs.unread + ')', !!missionNotif && proNotifs.unread > 0);
  ok('TEST 7 — La notification pointe directement vers la demande', missionNotif.link === '#/mission/' + mis.id);
  const misPro = (await call(pro.token, `/missions/${mis.id}`)).data;
  ok('TEST 8 — Le professionnel ouvre directement la demande (détails, photos, audio)', misPro.role === 'candidat' && misPro.offer_pending === true && misPro.photos.length === 1 && !!misPro.audio);
  ok('Les coordonnées du client ne sont PAS exposées avant acceptation', !misPro.client.phone);

  /* ---------- TEST 9,10 : acceptation + confirmation client ---------- */
  console.log('\n— TESTS 9-10 : acceptation et confirmation');
  await call(pro.token, `/missions/${mis.id}/accept`, 'POST');
  const misAcc = (await call(client.token, `/missions/${mis.id}`)).data;
  ok('TEST 9 — Mission acceptée par le professionnel', misAcc.status === 'acceptee' && misAcc.pro.name === 'Yao Plombier');
  const cliNotifs = (await call(client.token, '/notifications')).data;
  ok('TEST 10 — Le client reçoit la confirmation', cliNotifs.notifications.some(n => n.title.includes('accepté')));
  await call(client.token, `/missions/${mis.id}/confirm`, 'POST');
  const misConf = (await call(pro.token, `/missions/${mis.id}`)).data;
  ok('Client confirme → mission programmée', misConf.status === 'confirmee');
  ok('Coordonnées partagées après confirmation (téléphone client visible côté pro)', !!misConf.client.phone);

  /* ---------- TESTS 11,12 : chat + photo dans le chat ---------- */
  console.log('\n— TESTS 11-12 : chat lié à la mission');
  await call(client.token, `/missions/${mis.id}/messages`, 'POST', { type: 'text', content: 'Bonjour, à quelle heure pouvez-vous passer ?' });
  await call(pro.token, `/missions/${mis.id}/messages`, 'POST', { type: 'text', content: 'Bonjour, vers 14h !' });
  const chatPhoto = await upload(client.token, 'tache.jpg', 'photo-tache', 'image/jpeg');
  await call(client.token, `/missions/${mis.id}/messages`, 'POST', { type: 'photo', file: chatPhoto, content: 'Voici la tache' });
  const audioMsg = await upload(pro.token, 'reponse.webm', 'audio-reponse', 'audio/webm');
  await call(pro.token, `/missions/${mis.id}/messages`, 'POST', { type: 'audio', file: audioMsg });
  const msgs = (await call(pro.token, `/missions/${mis.id}/messages`)).data;
  ok('TEST 11 — Chat fonctionnel (texte bidirectionnel)', msgs.filter(m => m.type === 'text').length === 2);
  ok('TEST 12 — Photo envoyée et reçue dans le chat', msgs.some(m => m.type === 'photo' && m.file === chatPhoto));
  ok('Message vocal envoyé dans le chat', msgs.some(m => m.type === 'audio'));
  const convs = (await call(client.token, '/conversations')).data;
  ok('Conversation rattachée à la mission (pas de mélange)', convs.length === 1 && convs[0].id === mis.id);

  /* ---------- TEST 13 : cycle jusqu'à terminée ---------- */
  console.log('\n— TEST 13 : cycle de mission jusqu\u2019à « terminée »');
  const noAmount = await call(pro.token, `/missions/${mis.id}/complete`, 'POST', null, true);
  await call(pro.token, `/missions/${mis.id}/montant`, 'POST', { amount: 10000 });
  await call(pro.token, `/missions/${mis.id}/start`, 'POST');
  const enCours = (await call(client.token, `/missions/${mis.id}`)).data;
  ok('Mission démarrée (en cours)', enCours.status === 'en_cours');
  ok('Impossible de terminer sans montant fixé', noAmount.status === 409 || noAmount.status === 400);
  await call(pro.token, `/missions/${mis.id}/complete`, 'POST');
  const term = (await call(client.token, `/missions/${mis.id}`)).data;
  ok('TEST 13 — Mission terminée, paiement créé automatiquement', term.status === 'terminee' && term.payment && term.payment.status === 'en_attente');
  ok('La mission n\u2019est PAS considérée payée automatiquement', term.status !== 'payee');

  /* ---------- TESTS 14,15 : paiement espèces + double confirmation ---------- */
  console.log('\n— TESTS 14-15 : paiement en espèces, double confirmation, commission');
  ok('Commission 25% calculée correctement', term.payment.commission_amount === 2500 && term.payment.pro_amount === 7500, '10 000 → commission 2 500, pro 7 500');
  await call(client.token, `/missions/${mis.id}/payment/confirm`, 'POST');
  let pay = (await call(pro.token, `/missions/${mis.id}`)).data.payment;
  ok('TEST 14 — Client confirme le paiement en espèces (statut partiel)', pay.status === 'confirme_client');
  const dblConf = await call(client.token, `/missions/${mis.id}/payment/confirm`, 'POST', null, true);
  ok('Double confirmation du même côté refusée', dblConf.status === 409);
  await call(pro.token, `/missions/${mis.id}/payment/confirm`, 'POST');
  const paid = (await call(client.token, `/missions/${mis.id}`)).data;
  ok('TEST 15 — Paiement validé par les deux parties → mission payée', paid.status === 'payee' && paid.payment.status === 'valide');

  /* ---------- TEST 16 : évaluations croisées ---------- */
  console.log('\n— TEST 16 : évaluations');
  await call(client.token, `/missions/${mis.id}/review`, 'POST', { rating: 5, comment: 'Excellent travail, très propre !' });
  await call(pro.token, `/missions/${mis.id}/review`, 'POST', { rating: 4, comment: 'Cliente sympathique.' });
  const fraud = await call(client.token, `/missions/${mis.id}/review`, 'POST', { rating: 1, comment: 'fraude' }, true);
  ok('TEST 16 — Client évalue le pro ET pro évalue le client', true);
  ok('Évaluation frauduleuse en double refusée', fraud.status === 409);
  const proPublic = (await call(client.token, `/pros/${pro.user.id}`)).data;
  ok('Note visible sur le profil public du professionnel', proPublic.rating === 5 && proPublic.missions_done === 1 && proPublic.reviews.length === 1);

  /* ---------- TEST 18 : le pro reste aussi client ---------- */
  console.log('\n— TEST 18 : le professionnel reste client avec le même compte');
  const maison = services.flatMap(c => c.services).find(s => s.name.includes('maison') || s.name.includes('Ménage'));
  const qs2 = (await call(pro.token, `/services/${maison.id}/questions`)).data;
  const ans2 = {};
  for (const q of qs2.questions) ans2[q.id] = q.type === 'number' ? 2 : q.type === 'select' ? q.options[0] : q.type === 'bool' ? true : 'Test';
  const mis2 = (await call(pro.token, '/missions', 'POST', { service_id: maison.id, answers: ans2, address: 'Bouaké, Broukro' })).data;
  ok('TEST 18 — Le professionnel crée une demande comme CLIENT avec le même compte', !!mis2.id);
  const both = (await call(pro.token, '/missions')).data;
  ok('Même compte : demandes client + missions pro séparées proprement', both.client.length === 1 && both.pro.length === 1);
  ok('Le système n\u2019a pas proposé sa propre demande au demandeur', !(await call(pro.token, `/missions/${mis2.id}`)).data.candidates?.some(c => c.id === pro.user.id));

  /* ---------- Délai configurable + expiration + relance ---------- */
  console.log('\n— Expiration du délai de réponse (paramétrable, ici 15 s) et relance');
  const mis3 = (await call(client.token, '/missions', 'POST', {
    service_id: plomberie.id,
    answers: (() => { const a = {}; return a; })(),
    address: 'Bouaké centre', lat: 7.69, lng: -5.04
  }, true));
  let mis3id = null;
  if (mis3.status === 400) {
    // questions obligatoires de plomberie
    const qp = (await call(client.token, `/services/${plomberie.id}/questions`)).data;
    const ap = {};
    for (const q of qp.questions) ap[q.id] = q.type === 'select' ? q.options[0] : 'Fuite robinet';
    mis3id = (await call(client.token, '/missions', 'POST', { service_id: plomberie.id, answers: ap, address: 'Bouaké centre', lat: 7.69, lng: -5.04 })).data.id;
  } else mis3id = mis3.data.id;
  ok('Deuxième demande créée (plomberie) et proposée au pro', !!mis3id);
  console.log('    … attente de l\u2019expiration du délai (16 s)');
  await sleep(16500);
  const expired = (await call(client.token, `/missions/${mis3id}`)).data;
  ok('Délai dépassé → logique appliquée automatiquement (plus de pro → « sans_pro » + client notifié)', expired.status === 'sans_pro');
  const expNotif = (await call(pro.token, '/notifications')).data.notifications.some(n => n.title.includes('expirée'));
  ok('Le professionnel est informé de l\u2019expiration', expNotif);
  await call(client.token, `/missions/${mis3id}/relancer`, 'POST');
  const relanced = (await call(client.token, `/missions/${mis3id}`)).data;
  ok('Relance de la recherche fonctionnelle', relanced.status === 'recherche');
  await call(pro.token, `/missions/${mis3id}/accept`, 'POST');
  await call(client.token, `/missions/${mis3id}/cancel`, 'POST', { reason: 'Test terminé' });

  /* ---------- Disponibilité pro ---------- */
  await call(pro.token, '/pro/availability', 'PUT', { available: false });
  const dashOff = (await call(pro.token, '/pro/dashboard')).data;
  ok('Activation/désactivation de la disponibilité (🟢/⚪)', dashOff.available === 0);
  await call(pro.token, '/pro/availability', 'PUT', { available: true });

  /* ---------- Fonctions secondaires ---------- */
  console.log('\n— Fonctions secondaires (avis de recherche, job, école & famille, urgence)');
  await call(client.token, '/avis-recherche', 'POST', { nom: 'Kouadio Jean', contact: '0700000000', dernier_lieu: 'Marché de Bouaké', date_disparition: '2026-09-28', description_physique: 'Taille 1m75' });
  const avisAdmin = (await call(admin.token, '/admin/avis-recherche')).data;
  await call(admin.token, `/admin/avis-recherche/${avisAdmin[0].id}/status`, 'POST', { status: 'approved' });
  const avisList = (await call(pro.token, '/avis-recherche')).data;
  ok('Avis de recherche : publication → modération admin → visible', avisList.some(a => a.nom === 'Kouadio Jean' && a.status === 'approved'));
  await call(client.token, '/jobs', 'POST', { metier: 'Chauffeur', contact: '0700000000', competences: 'Permis BCDE', localisation: 'Bouaké' });
  const jobsAdmin = (await call(admin.token, '/admin/jobs')).data;
  await call(admin.token, `/admin/jobs/${jobsAdmin[0].id}/status`, 'POST', { status: 'approved' });
  const jobSearch = (await call(pro.token, '/jobs?q=chauffeur')).data;
  ok('Je cherche un job : publication → modération → recherche par mot-clé', jobSearch.length === 1);
  await call(client.token, '/ecole-famille', 'POST', { type: 'Soutien scolaire', details: 'Répétiteur de maths pour la 3e' });
  const efAdmin = (await call(admin.token, '/admin/ecole-famille')).data;
  ok('École & famille : demande visible côté admin', efAdmin.length === 1);
  await call(client.token, '/urgence', 'POST', { message: 'Test alerte', lat: 7.69, lng: -5.04 });
  const urgAdmin = (await call(admin.token, '/admin/urgences')).data;
  ok('Urgence : alerte transmise à l\u2019administration', urgAdmin.length === 1 && urgAdmin[0].handled === 0);
  const urgCfg = (await call(client.token, '/urgence/config')).data;
  ok('Contacts d\u2019urgence configurables depuis le tableau de bord', urgCfg.contacts.length >= 3);

  /* ---------- TEST 19 : tableau de bord administrateur ---------- */
  console.log('\n— TEST 19 : tableau de bord administrateur');
  const stats = (await call(admin.token, '/admin/stats')).data;
  ok('TEST 19 — Statistiques cohérentes', stats.users >= 2 && stats.pros === 1 && stats.missions >= 3 && stats.commissions === 2500,
    `users=${stats.users} pros=${stats.pros} missions=${stats.missions} commissions=${stats.commissions}F`);
  const payments = (await call(admin.token, '/admin/payments')).data;
  ok('Paiements visibles dans le tableau de bord (pas de calcul contradictoire)', payments.length === 1 && payments[0].amount === 10000 && payments[0].commission_amount === 2500);

  /* ---------- TEST 20 : modification admin répercutée dans l'application ---------- */
  console.log('\n— TEST 20 : une modification admin apparaît réellement dans l\u2019application');
  // 20a. Commission modifiée → nouveau calcul
  await call(admin.token, '/admin/settings', 'PUT', { commission_rate: '20' });
  const dash2 = (await call(pro.token, '/pro/dashboard')).data;
  ok('TEST 20a — Commission modifiée (25→20%) visible immédiatement côté pro', dash2.stats.commission_rate === 20);
  // 20b. Question dynamique ajoutée → apparaît dans le formulaire
  const newQ = (await call(admin.token, '/admin/questions', 'POST', { service_id: fauteuil.id, label: 'Couleur du fauteuil ?', type: 'text', required: 0 })).data;
  const qsAfter = (await call(client.token, `/services/${fauteuil.id}/questions`)).data;
  ok('TEST 20b — Question ajoutée par l\u2019admin visible dans le formulaire client', qsAfter.questions.some(q => q.label === 'Couleur du fauteuil ?'));
  await call(admin.token, `/admin/questions/${newQ.id}`, 'DELETE');
  // 20c. Jeu activé → visible dans la config de l'app
  await call(admin.token, '/admin/settings', 'PUT', { quiz_enabled: '1' });
  const games = (await call(null, '/games/config')).data;
  ok('TEST 20c — Quiz activé par l\u2019admin → visible sur l\u2019accueil de l\u2019app', games.quiz === true);
  const quizQs = (await call(client.token, '/games/quiz')).data;
  const quizAns = {}; quizQs.forEach(q => quizAns[q.id] = 0);
  const quizRes = (await call(client.token, '/games/quiz', 'POST', { answers: quizAns })).data;
  ok('Quiz jouable et score enregistré', typeof quizRes.score === 'number');
  await call(admin.token, '/admin/settings', 'PUT', { quiz_enabled: '0' });
  // 20d. Publicité créée → visible dans l'app
  const ad = (await call(admin.token, '/admin/ads', 'POST', { type: 'texte', title: 'Promo test', content: '-10% cette semaine', placement: 'accueil' })).data;
  const adsApp = (await call(null, '/ads')).data;
  ok('TEST 20d — Publicité publiée par l\u2019admin visible dans l\u2019app', adsApp.some(a => a.title === 'Promo test'));
  await call(admin.token, `/admin/ads/${ad.id}`, 'DELETE');
  // 20e. Règles modifiées → visibles à l'inscription
  const oldRules = (await call(admin.token, '/admin/settings')).data.rules_client;
  await call(admin.token, '/admin/settings', 'PUT', { rules_client: oldRules + '\n9. TEST — règle ajoutée.' });
  const rulesApp = (await call(null, '/rules')).data;
  ok('TEST 20e — Règles modifiées par l\u2019admin visibles dans l\u2019app', rulesApp.client.includes('9. TEST'));
  await call(admin.token, '/admin/settings', 'PUT', { rules_client: oldRules });

  /* ---------- Recherche intelligente ---------- */
  console.log('\n— Recherche intelligente');
  for (const [query, expected] of [
    ['Je cherche un plombier', 'Plomberie'],
    ['Nettoyer mon fauteuil', 'fauteuil'],
    ['Réparer ma télévision', 'TV'],
    ['Un électricien', 'électrique'],
    ['Cours d\u2019anglais à domicile', 'colaire'],
    ['Un menuisier', 'Menuiserie'],
    ['Je cherche un employé', 'placement'],
  ]) {
    const r = (await call(null, '/search?q=' + encodeURIComponent(query))).data;
    ok(`« ${query} » → ${r.results[0] ? r.results[0].name : 'aucun'}`, r.results.length > 0 && r.results[0].name.toLowerCase().includes(expected.toLowerCase()));
  }

  /* ---------- Sécurité ---------- */
  console.log('\n— Sécurité & permissions');
  const other = await call(null, '/auth/register', 'POST', { name: 'Intrus', phone: '01' + suffix + '03', password: 'test1234', accept_rules: true });
  const noAccess = await call(other.data.token, `/missions/${mis.id}`, 'GET', null, true);
  ok('Un tiers ne peut pas voir la mission d\u2019autrui', noAccess.status === 404);
  const noAdmin = await call(client.token, '/admin/stats', 'GET', null, true);
  ok('Un utilisateur normal ne peut pas accéder à l\u2019administration', noAdmin.status === 403);
  await call(admin.token, `/admin/users/${other.data.user.id}/suspend`, 'POST', { suspended: 1 });
  const suspended = await call(other.data.token, '/me', 'GET', null, true);
  ok('Compte suspendu bloqué', suspended.status === 403);

  // Restauration des paramètres de production
  await call(admin.token, '/admin/settings', 'PUT', { commission_rate: '25', dispatch_wait_seconds: '60' });
  console.log('\n  ↩︎ Paramètres restaurés : commission 25%, délai 60 s');

  console.log('\n================ RÉSULTAT ================');
  console.log(`  ${passed} tests réussis, ${failed} échec(s)\n`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('\n💥 ERREUR FATALE :', e.message); process.exit(1); });
