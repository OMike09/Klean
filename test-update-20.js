/* Vérifications E2E COLIS 20 — urgences officielles, lieu/commune et tarifs fiables. */
const fs = require('fs');
const BASE = (process.env.KLEAN_TEST_BASE || 'http://127.0.0.1:3107') + '/api';
let n = 0, fail = 0;
function yes(ok, label) { n++; if (ok) console.log('OK ', label); else { fail++; console.error('BAD', label); } }
async function api(token, path, method = 'GET', body) {
  const r = await fetch(BASE + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({})); return { r, d };
}
(async () => { try {
  const emergency = await api(null, '/urgence/config');
  const contacts = emergency.d.contacts || [], vital = contacts.filter(c => c.group === 'vital'), assistance = contacts.filter(c => c.group === 'public_assistance');
  const nums = new Set(contacts.map(c => c.tel));
  yes(emergency.r.status === 200 && vital.length >= 14 && assistance.length >= 4, 'répertoire public séparé entre urgences vitales et services publics / assistance');
  yes(['170','110','111','145','180','185','100'].every(x => nums.has(x)), 'police, gendarmerie, GSPM, SAMU et police secours officiels sont présents');
  yes(['01 01 80 13 28','01 03 01 90 94','07 89 32 32 32','05 74 32 32 32','01 50 32 32 32','07 78 43 76 46','01 03 79 91 44'].every(x => nums.has(x)), 'tous les numéros détaillés ONPC/GSPM/Police secours sont conservés');
  yes(['179','175','101','27 22 59 90 00'].every(x => nums.has(x)), 'CIE, SODECI et Allô Gouvernement sont classés hors urgences vitales');
  yes(!contacts.some(c => /Klean Services/i.test(c.nom)) && contacts.every(c => c.source_name && c.source_url.startsWith('https://') && c.verified_at === '2026-10-25' && c.last_modified), 'aucun faux contact Klean n’est publié et chaque numéro porte source, vérification et dernière modification');
  yes(contacts.filter(c => c.nom === 'Police nationale').every(c => /divergente/.test(c.label)), 'la divergence ONPC / Affaires étrangères est explicitée sans fausse certitude');

  const cities = (await api(null, '/villes')).d;
  const communes = (await api(null, '/communes?city=Abidjan')).d;
  const expectedCommunes = ['Abobo','Adjamé','Anyama','Attécoubé','Bingerville','Cocody','Koumassi','Marcory','Plateau','Port-Bouët','Songon','Treichville','Yopougon'];
  yes(cities.includes('Abidjan') && !cities.some(c => c.startsWith('Abidjan /')), 'Abidjan est une ville distincte des anciennes localités composées');
  yes(expectedCommunes.every(c => communes.includes(c)) && communes.length === 13, 'les treize communes attendues sont administrées depuis la source centrale');

  const catalogue = (await api(null, '/catalogue')).d;
  const services = (await api(null, '/services')).d;
  const flat = catalogue.flatMap(c => c.services || []), direct = services.flatMap(c => c.services || []);
  yes(flat.length > 0 && !JSON.stringify(catalogue).includes('price_from') && !JSON.stringify(direct).includes('price_from'), 'le catalogue et les catégories publiques ne divulguent aucune donnée tarifaire');
  const service = flat.find(s => (s.taches || []).length) || flat[0], task = service.taches && service.taches[0];
  const noDetails = await api(null, '/estimates?service_id=' + service.id + '&city=Abidjan&zone=Cocody');
  const noCity = await api(null, '/estimates?service_id=' + service.id + '&details=Besoin%20detaillé');
  const noCommune = await api(null, '/estimates?service_id=' + service.id + '&city=Abidjan&details=Besoin%20detaillé');
  yes(noDetails.d.status === 'confirm' && noDetails.d.needs_description && !('amount' in noDetails.d), 'aucune estimation n’est retournée avant la description');
  yes(noCity.d.status === 'confirm' && noCity.d.needs_city, 'la ville est obligatoire avant une estimation');
  yes(noCommune.d.status === 'confirm' && noCommune.d.needs_commune, 'la commune est obligatoire pour Abidjan avant une estimation');
  const insufficient = await api(null, '/estimates?service_id=' + service.id + '&city=Abidjan&zone=Cocody&details=Besoin%20detaillé');
  yes(insufficient.d.status === 'confirm' && !('amount' in insufficient.d), 'sans règle/référence/historique fiable, le moteur retourne Prix à confirmer sans montant inventé');

  const login = await api(null, '/auth/login', 'POST', { phone:'admin', password:'Klean@2026' });
  const admin = login.d;
  const suffix = String(Date.now()).slice(-8);
  const client = (await api(null, '/auth/register', 'POST', { name:'Client C20 ' + suffix, phone:'08' + suffix, password:'abcd1234', ville:'Abidjan', accept_rules:true })).d;
  const clientReadContacts = await api(client.token, '/admin/emergency-contacts');
  const clientCreateRule = await api(client.token, '/admin/estimation-rules', 'POST', { service_id:service.id, base_price:7200, source_note:'Test non autorisé', verified_at:'2026-10-25' });
  yes(login.r.status === 200 && admin.user.role === 'pdg' && clientReadContacts.r.status === 403 && clientCreateRule.r.status === 403, 'gestion des contacts et des tarifs est contrôlée côté serveur et réservée au PDG');

  const newRule = await api(admin.token, '/admin/estimation-rules', 'POST', { service_id:service.id, city:'Abidjan', base_price:7200, source_type:'pdg', source_note:'Référence interne validée pour le test COLIS 20', source_url:'', source_date:'2026-10-25', verified_at:'2026-10-25', active:true, priority:99, factors:'{}' });
  yes(newRule.r.status === 201 && newRule.d.id, 'le PDG peut ajouter une règle tarifaire documentée et datée');
  const estimated = await api(null, '/estimates?service_id=' + service.id + (task ? '&task_id=' + task.id : '') + '&city=Abidjan&zone=Cocody&details=Besoin%20detaillé');
  yes(estimated.d.status === 'estimated' && estimated.d.amount === 7200 && !('source' in estimated.d) && !('provisional' in estimated.d), 'une estimation fiable n’expose au client que le montant utile, sans commentaire ni fourchette');
  const history = await api(admin.token, '/admin/estimation-rules/' + newRule.d.id + '/history');
  yes(history.r.status === 200 && history.d.some(h => h.action === 'creation'), 'la création d’une règle tarifaire est historisée');
  const disabled = await api(admin.token, '/admin/estimation-rules/' + newRule.d.id, 'PUT', { active:false });
  const history2 = await api(admin.token, '/admin/estimation-rules/' + newRule.d.id + '/history');
  yes(disabled.r.status === 200 && history2.d.some(h => h.action === 'désactivation'), 'une règle est désactivée et historisée au lieu d’être supprimée');

  const legacyNoDescription = await api(client.token, '/missions', 'POST', { service_id:service.id, task_id:task && task.id, description:'', address:'Quartier test', intervention_city:'Abidjan', intervention_commune:'Cocody' });
  const invalidNoCommune = await api(client.token, '/missions', 'POST', { service_id:service.id, task_id:task && task.id, description:'Besoin réel', address:'Quartier test', intervention_city:'Abidjan' });
  yes(legacyNoDescription.r.status === 200 && legacyNoDescription.d.estimate && legacyNoDescription.d.estimate.status === 'confirm', 'compatibilité API conservée : une ancienne demande sans description part sans prix inventé');
  yes(invalidNoCommune.r.status === 400 && /commune/.test(invalidNoCommune.d.error || ''), 'le serveur bloque une demande Abidjan sans commune, même si le client contourne l’interface');

  const app = fs.readFileSync('public/app.js','utf8'), css = fs.readFileSync('public/styles.css','utf8'), adminJs = fs.readFileSync('public/admin/admin.js','utf8');
  yes(app.includes('Je décris mon besoin ci-dessous.') && app.includes('Je choisis mon/mes besoins') && app.includes('Trouver un professionnel') && app.includes('requestLocationChanged') && app.includes('communePick'), 'nouveau parcours client : tâche facultative, description, pièces jointes, ville, localisation, disponibilité et estimation');
  yes(app.includes("zone.innerHTML = r.status === 'estimated' && r.amount ? `<div class=\"estimate-price\">Estimation disponible : à partir de ${fmtFCFA(r.amount)}</div>` : ''") && !app.includes("'<div class=\"estimate-price\">Prix à confirmer</div>'"), 'le nouveau parcours affiche seulement une estimation fiable, sans prix à confirmer');
  yes(app.includes('function prixHtml() { return \'\'; }') && css.includes('.estimate-box:empty{display:none}') && adminJs.includes('Gestion des tarifs'), 'prix masqués sur les listes ordinaires et bloc d’estimation invisible tant qu’il est vide');
  console.log(`RESULT ${n-fail}/${n}, failed=${fail}`); process.exitCode = fail ? 1 : 0;
} catch (e) { console.error(e); process.exitCode = 1; } })();
