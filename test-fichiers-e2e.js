/* Test E2E — tableau Professionnels + échanges/fichiers classés par client */
const BASE = 'http://localhost:3000/api';
const fs = require('fs');
const { execFileSync } = require('child_process');
let pass = 0, fail = 0;
function ok(name, yes, extra = '') { if (yes) { pass++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); } else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); } }
async function call(token, path, method = 'GET', body, allow = false) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !allow) throw new Error(`${method} ${path} → ${res.status}: ${data.error || ''}`);
  return { res, data };
}
async function upload(token, name, text, mime) {
  const fd = new FormData(); fd.append('files', new Blob([text], { type: mime }), name);
  const res = await fetch(BASE + '/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  if (!res.ok) throw new Error('Upload impossible'); return (await res.json()).files[0];
}
function answers(qs) { const a = {}; qs.forEach(q => a[q.id] = q.type === 'bool' ? true : q.type === 'number' ? 2 : q.type === 'select' ? q.options[0] : q.type === 'date' ? '2026-10-08' : 'Message de test'); return a; }
(async () => {
  const s = String(Date.now()).slice(-8);
  console.log('\n========== TEST GESTION FICHIERS ==========' );
  const admin = (await call(null, '/auth/login', 'POST', { phone: 'admin', password: 'Klean@2026' })).data;
  const client = (await call(null, '/auth/register', 'POST', { name: 'Awa Fichiers', phone: '07' + s + '41', password: 'Test@1234', ville: 'Bouaké', accept_rules: true })).data;
  const pro = (await call(null, '/auth/register', 'POST', { name: 'Pro Fichiers', phone: '05' + s + '42', password: 'Test@1234', ville: 'Bouaké', accept_rules: true })).data;
  const catalog = (await call(client.token, '/catalogue')).data;
  const service = catalog.flatMap(c => c.services).find(svc => svc.taches && svc.taches.length);
  await call(pro.token, '/pro/apply', 'POST', { profession: 'Technicien dossiers', zone: 'Bouaké', services: [service.id], documents: [], accept_rules: true });
  await call(admin.token, '/admin/pros/' + pro.user.id + '/approve', 'POST');
  const pros = (await call(admin.token, '/admin/users?filter=pros&sort=nom')).data;
  const proRow = pros.find(u => u.id === pro.user.id);
  ok('Colonne/API Service pro résolue depuis le profil', proRow && proRow.services.includes(service.name) && proRow.pro_profession === 'Technicien dossiers', (proRow && proRow.services || []).join(', '));

  const photo = await upload(client.token, 'photo-client.jpg', 'photo-client', 'image/jpeg');
  const vocal = await upload(client.token, 'vocal-client.m4a', 'vocal-client', 'audio/mp4');
  const qs = (await call(client.token, '/services/' + service.id + '/questions')).data;
  const mission = (await call(client.token, '/missions', 'POST', { service_id: service.id, answers: answers(qs.questions), address: 'Bouaké centre', description: 'Texte de demande recherché', photos: [photo], audio: vocal })).data;
  await call(client.token, '/missions/' + mission.id + '/messages', 'POST', { type: 'text', content: 'Message texte client recherché' });
  const chatImage = await upload(client.token, 'image-chat.jpg', 'image-chat', 'image/jpeg');
  await call(client.token, '/missions/' + mission.id + '/messages', 'POST', { type: 'photo', file: chatImage });
  const chatAudio = await upload(client.token, 'audio-chat.m4a', 'audio-chat', 'audio/mp4');
  await call(client.token, '/missions/' + mission.id + '/messages', 'POST', { type: 'audio', file: chatAudio });
  const support = (await call(client.token, '/support/conversations', 'POST', { subject: 'suggestion', content: 'Suggestion texte recherché' })).data;
  await call(client.token, '/support/conversations/' + support.id + '/messages', 'POST', { type: 'text', content: 'Suite de la suggestion' });

  const legacyInventory = (await call(admin.token, '/admin/files')).data;
  ok('Inventaire technique historique conservé', Array.isArray(legacyInventory.files) && legacyInventory.total >= 4);
  const grouped = (await call(admin.token, '/admin/files/clients?q=Awa%20Fichiers')).data;
  const row = grouped.clients.find(c => c.id === client.user.id);
  ok('Recherche client trouve les échanges', !!row && row.texts >= 3 && row.audios >= 2 && row.images >= 2, row ? `${row.texts} textes, ${row.audios} audios, ${row.images} images` : '');
  const byText = (await call(admin.token, '/admin/files/clients?q=message%20texte%20client')).data;
  ok('Recherche dans le contenu texte', byText.clients.some(c => c.id === client.user.id));
  const byAudio = (await call(admin.token, '/admin/files/clients?type=audio')).data;
  ok('Filtre Audio / message vocal', byAudio.clients.some(c => c.id === client.user.id));
  const byImage = (await call(admin.token, '/admin/files/clients?type=image')).data;
  ok('Filtre Image / photo', byImage.clients.some(c => c.id === client.user.id));
  const byDate = (await call(admin.token, '/admin/files/clients?type=audio&from=2020-01-01&to=2099-01-01')).data;
  const outsideDate = (await call(admin.token, '/admin/files/clients?from=2099-01-01')).data;
  ok('Filtre par date côté serveur', byDate.clients.some(c => c.id === client.user.id) && !outsideDate.clients.some(c => c.id === client.user.id));
  const detail = (await call(admin.token, '/admin/files/clients/' + client.user.id)).data;
  ok('Détail client contient texte, audio et images', detail.items.some(i => i.type === 'texte') && detail.items.some(i => i.type === 'audio') && detail.items.some(i => i.type === 'image'));

  const mediaName = photo.split('/').pop();
  const one = await fetch(BASE + '/admin/files/clients/' + client.user.id + '/media/' + encodeURIComponent(mediaName) + '/download', { headers: { Authorization: 'Bearer ' + admin.token } });
  ok('Téléchargement individuel média', one.status === 200 && /attachment/i.test(one.headers.get('content-disposition') || '') && (await one.arrayBuffer()).byteLength > 0);
  const text = detail.items.find(i => i.type === 'texte' && i.source === 'message');
  const oneText = await fetch(BASE + '/admin/files/clients/' + client.user.id + '/text/' + text.source + '/' + text.id + '/download', { headers: { Authorization: 'Bearer ' + admin.token } });
  const txt = await oneText.text();
  ok('Téléchargement individuel texte', oneText.status === 200 && /Message texte client/.test(txt));
  const zip = await fetch(BASE + '/admin/files/clients/' + client.user.id + '/download', { headers: { Authorization: 'Bearer ' + admin.token } });
  const zipPath = '/tmp/klean-client-test.zip'; fs.writeFileSync(zipPath, Buffer.from(await zip.arrayBuffer()));
  let listing = ''; try { listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }); } catch { }
  ok('Téléchargement global client en ZIP', zip.status === 200 && /^PK/.test(fs.readFileSync(zipPath).toString('ascii', 0, 2)) && /messages-et-textes\.txt/.test(listing) && /audio|photo|image/.test(listing));
  const denied = await call(client.token, '/admin/files/clients', 'GET', undefined, true);
  ok('Espace fichiers réservé à l’administration', denied.res.status === 403);
  console.log(`\n========== RÉSULTAT ==========`); console.log(`  ${pass} réussis, ${fail} échec(s)`); process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
