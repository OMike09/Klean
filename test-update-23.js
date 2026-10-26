/* Vérifications COLIS 23 — page unique de demande après clic sur grande catégorie. */
const fs = require('fs');
const BASE = (process.env.KLEAN_TEST_BASE || 'http://127.0.0.1:3123') + '/api';
let n = 0, fail = 0;
function yes(ok, label) { n++; if (ok) console.log('OK ', label); else { fail++; console.error('BAD', label); } }
async function api(token, path, method='GET', body) { const r=await fetch(BASE+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}); return {r,d:await r.json().catch(()=>({}))}; }
(async()=>{try {
  const cats=(await api(null,'/grand-categories')).d;
  const cat=cats.find(g=>g.categories.some(c=>c.services.some(s=>s.taches.length))) || cats.find(g=>g.categories.some(c=>c.services.length));
  const detail=await api(null,'/grand-categories/'+cat.id+'/catalogue');
  const services=detail.d.categories.flatMap(c=>c.services);
  const service=services.find(s=>s.taches.length)||services[0];
  yes(detail.r.status===200 && detail.d.id===cat.id && service && Array.isArray(service.taches), 'une grande catégorie fournit les tâches réelles nécessaires à la page unique');
  yes(new Set(services.map(s=>s.id)).size===services.length && services.every(s=>typeof s.name==='string'), 'les prestations proposées viennent du catalogue central sans liste UI statique');

  const app=fs.readFileSync('public/app.js','utf8'), css=fs.readFileSync('public/category-request.css','utf8'), index=fs.readFileSync('public/index.html','utf8'), sw=fs.readFileSync('public/sw.js','utf8');
  const form=app.slice(app.indexOf('function renderCategoryRequestForm'),app.indexOf('/* ---------- Grandes catégories',app.indexOf('function renderCategoryRequestForm')));
  yes(form.includes('header(grandLabel(cat)') && form.includes('need-picker') && form.includes('A.openCategoryNeeds()'), 'le libellé compact de catégorie est porté par l’en-tête et les besoins sont derrière une seule option compacte');
  yes(!form.includes('cat.categories.map') && form.includes('Je décris mon besoin ci-dessous.') && form.includes('Photos') && form.includes('Message vocal') && form.includes('Ville d’intervention') && form.includes('Quartier / repère') && form.includes('Disponibilité') && form.includes('Trouver un professionnel'), 'la page unique contient le parcours complet sans liste initiale de tâches');
  const ordered=['Je choisis mon/mes besoins','Je décris mon besoin ci-dessous.','Photos','Message vocal','Ville d’intervention','Quartier / repère','Disponibilité','category-price-reference','Trouver un professionnel'];
  yes(ordered.every((x,i)=>form.indexOf(x)>=0 && (!i || form.indexOf(x)>form.indexOf(ordered[i-1]))), 'les sections suivent l’ordre simplifié demandé, jusqu’au bouton final');
  yes(app.includes('saveCategoryDraft()') && app.includes("authRequired('#/categories/'") && app.includes("'categories'") && app.includes('showLeaveConfirm'), 'le brouillon catégorie est préservé pour retour et authentification');
  yes(app.includes('chooseProviderForRequest()') && app.includes("api('/missions'") && app.includes('submitCategoryRequest'), 'le bouton final utilise le parcours réel de demande et de mise en relation');
  yes(css.includes('.need-picker') && css.includes('.category-task-list') && css.includes('@media(min-width:700px)') && index.includes('/category-request.css') && sw.includes('ks-v8-public-shell'), 'la page est stylée pour téléphone, tablette, ordinateur et PWA');

  const suffix=String(Date.now()).slice(-8);
  const client=(await api(null,'/auth/register','POST',{name:'Client page unique '+suffix,phone:'09'+suffix,password:'abcd1234',ville:'Abidjan',accept_rules:true})).d;
  const mission=await api(client.token,'/missions','POST',{service_id:service.id,description:'Demande libre depuis la page catégorie simplifiée.',address:'Kounahiri — adresse de test C23',intervention_city:'Abidjan',intervention_commune:'Cocody',schedule_type:'asap'});
  yes(mission.r.status===200 && mission.d.id, 'une demande libre sans tâche est envoyée jusqu’au parcours de mise en relation existant');
  console.log(`RESULT ${n-fail}/${n}, failed=${fail}`);process.exitCode=fail?1:0;
}catch(e){console.error(e);process.exitCode=1;}})();
