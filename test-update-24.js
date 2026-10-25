/* Vérifications COLIS 24 — tâches directes sans répétition du nom de grande catégorie. */
const fs = require('fs');
const BASE = (process.env.KLEAN_TEST_BASE || 'http://127.0.0.1:3124') + '/api';
let n=0, fail=0;
function yes(ok,label){n++;if(ok)console.log('OK ',label);else{fail++;console.error('BAD',label);}}
async function api(token,path,method='GET',body){const r=await fetch(BASE+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return{r,d:await r.json().catch(()=>({}))};}
(async()=>{try{
  const app=fs.readFileSync('public/app.js','utf8'), css=fs.readFileSync('public/category-request.css','utf8'), sw=fs.readFileSync('public/sw.js','utf8');
  const start=app.indexOf('  openCategoryNeeds() {'), end=app.indexOf('  toggleCategoryNeed(taskId)',start), picker=app.slice(start,end);
  yes(start>0 && picker.includes('Recherchez ou sélectionnez directement les besoins concernés') && picker.includes('category-task-group'), 'le panneau affiche directement les besoins dans une liste organisée');
  yes(!picker.includes('category-service-select') && !picker.includes('[s.category,s.name]') && !picker.includes('service.category'), 'le sélecteur ne répète plus le nom de la catégorie devant chaque ligne');
  yes(picker.includes('esc(service.name)') && picker.includes('category-task-q') && picker.includes('filterCategoryNeeds()'), 'les tâches restent regroupées par prestation, sélectionnables et recherchables');
  yes(app.includes("header(cat.name") && app.includes('Plusieurs besoins') && css.includes('.category-task-group') && sw.includes('ks-v7-public-shell'), 'le nom de la grande catégorie reste dans l’en-tête et le rendu est mobile/PWA');

  const cats=(await api(null,'/grand-categories')).d;
  const grand=cats.find(g=>g.categories.some(c=>c.services.some(s=>s.taches.length)));
  const detail=(await api(null,'/grand-categories/'+grand.id+'/catalogue')).d;
  const service=detail.categories.flatMap(c=>c.services).find(s=>s.taches.length), task=service.taches[0];
  const suffix=String(Date.now()).slice(-8);
  const client=(await api(null,'/auth/register','POST',{name:'Client selection directe '+suffix,phone:'08'+suffix,password:'abcd1234',ville:'Bouaké',accept_rules:true})).d;
  const mission=await api(client.token,'/missions','POST',{service_id:service.id,task_id:task.id,taches:[{id:task.id}],description:'Besoin sélectionné dans la liste directe C24.',address:'Quartier test — adresse C24',intervention_city:'Bouaké',schedule_type:'asap'});
  yes(mission.r.status===200 && mission.d.id, 'une tâche directe sélectionnée reste envoyée par le parcours réel de mission');
  console.log(`RESULT ${n-fail}/${n}, failed=${fail}`);process.exitCode=fail?1:0;
}catch(e){console.error(e);process.exitCode=1;}})();
