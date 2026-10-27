/* COLIS 28 — intégration réelle des images de grandes catégories.
   Lancer avec KLEAN_TEST_BASE=http://127.0.0.1:PORT node test-category-images.js */
'use strict';
const BASE = (process.env.KLEAN_TEST_BASE || 'http://127.0.0.1:3131').replace(/\/$/, '');
const API = BASE + '/api';
const expected = [
  [1,'01-nettoyage-et-entretien.jpg'], [2,'02-plomberie.jpg'], [3,'03-electricite.jpg'], [4,'04-batiment-et-construction.jpg'], [5,'05-menuiserie-et-aluminium.jpg'],
  [6,'06-climatisation-et-froid.jpg'], [7,'07-transport-et-demenagement.jpg'], [8,'08-mecanique-et-automobile.jpg'], [9,'09-informatique-et-telephonie.jpg'], [10,'10-beaute-coiffure-et-bien-etre.jpg'],
  [11,'11-couture-et-mode.jpg'], [12,'12-restauration-et-alimentation.jpg'], [13,'13-jardinage-et-espaces-verts.jpg'], [14,'14-securite-et-surveillance.jpg'], [15,'15-aide-a-domicile-et-services-familiaux.jpg'],
  [16,'16-evenementiel.jpg'], [17,'17-services-professionnels-et-administratifs.jpg'], [18,'18-cours-et-formation.jpg'], [19,'19-agriculture-et-elevage.jpg'], [320,'20-artisanat-et-reparations-diverses.jpg'],
  [321,'21-ferronnerie-et-soudure.jpg'], [322,'22-energie-solaire-et-secours-electrique.jpg'], [323,'23-electromenager-et-appareils-domestiques.jpg'], [324,'24-vitrerie-et-miroiterie.jpg'], [325,'25-imprimerie-et-signaletique.jpg'],
  [326,'26-photo-video-et-sonorisation.jpg'], [327,'27-toiture-et-etancheite.jpg'], [328,'28-forage-et-traitement-de-leau.jpg'], [329,'29-entretien-automobile.jpg'], [330,'30-immobilier-et-conciergerie.jpg']
];
let total = 0, failed = 0;
function check(ok, label) { total++; if (ok) console.log('OK ', label); else { failed++; console.error('BAD', label); } }
async function api(path, method='GET', body, token='') {
  const r = await fetch(API + path, { method, headers:{ ...(token ? { Authorization:'Bearer ' + token } : {}), ...(body ? {'Content-Type':'application/json'} : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { r, d:await r.json().catch(()=>({})) };
}
async function upload(token) {
  const form = new FormData();
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  form.append('files', new Blob([image], {type:'image/png'}), 'controle-photo-categorie.png');
  const r = await fetch(API + '/upload', { method:'POST', headers:{Authorization:'Bearer '+token}, body:form });
  return { r, d:await r.json().catch(()=>({})) };
}
(async () => {
  try {
    const all = await api('/grand-categories');
    // L’API publique ne renvoie déjà que les racines actives : le statut interne n’est pas exposé.
    const active = Array.isArray(all.d) ? all.d : [];
    const byId = new Map(active.map(x=>[Number(x.id),x]));
    const expectedBySort = new Map(expected.map(([,file], index) => [index + 1, file]));
    check(all.r.status === 200 && active.length === 30, 'API publique : 30 grandes catégories actives');
    const exact = active.every(category => expectedBySort.get(Number(category.sort)) && category.image_url === '/category-images/' + expectedBySort.get(Number(category.sort)));
    check(exact, 'source unique : chaque identifiant de catégorie référence son JPEG validé');
    check(new Set(active.map(x=>x.image_url)).size === 30, 'aucune image de catégorie active n’est dupliquée par erreur');

    const responses = await Promise.all(expected.map(([,file]) => fetch(BASE + '/category-images/' + file)));
    check(responses.length === 30 && responses.every(r => r.status === 200 && /^image\/jpeg/i.test(r.headers.get('content-type') || '')), '30 visuels publics : fichiers JPEG accessibles');

    const popular = await api('/grand-categories/populaires');
    check(popular.r.status === 200 && Array.isArray(popular.d) && popular.d.length > 0 && popular.d.every(c => c.image_url === byId.get(Number(c.id))?.image_url), 'cartes d’accueil : mêmes URL que les catégories centrales');

    const login = await api('/auth/login','POST',{phone:'admin',password:'Klean@2026'});
    check(login.r.status === 200 && !!login.d.token, 'connexion PDG de contrôle');
    const category = active.find(x => Number(x.sort) === 1), original = category.image_url;
    const imported = await upload(login.d.token);
    const replace = await api('/admin/grand-categories/' + category.id,'PUT',{image_url:imported.d.files?.[0]},login.d.token);
    const afterReplace = await api('/grand-categories/' + category.id + '/catalogue');
    const remove = await api('/admin/grand-categories/' + category.id,'PUT',{image_url:''},login.d.token);
    const afterRemove = await api('/grand-categories/' + category.id + '/catalogue');
    const restore = await api('/admin/grand-categories/' + category.id,'PUT',{image_url:original},login.d.token);
    const afterRestore = await api('/grand-categories/' + category.id + '/catalogue');
    const journal = await api('/admin/journal?q=photo', 'GET', undefined, login.d.token);
    check(imported.r.status === 200 && replace.r.status === 200 && afterReplace.d.image_url === imported.d.files?.[0] && remove.r.status === 200 && !afterRemove.d.image_url && restore.r.status === 200 && afterRestore.d.image_url === original, 'PDG : téléversement, remplacement, retrait et restauration persistent réellement par identifiant');
    check(journal.r.status === 200 && journal.d.some(x => Number(x.target_id) === Number(category.id) && /photo/i.test(x.action || '')), 'journal : modification de photo de catégorie tracée côté serveur');
  } catch (e) { failed++; console.error(e); }
  console.log(`RESULT ${total-failed}/${total}, failed=${failed}`);
  process.exitCode = failed ? 1 : 0;
})();
