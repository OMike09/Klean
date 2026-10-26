/* Vérifications COLIS 26 — 30 catégories professionnelles et libellés courts mobiles. */
const fs=require('fs');
const BASE=(process.env.KLEAN_TEST_BASE||'http://127.0.0.1:3129')+'/api';
let n=0,fail=0;const yes=(ok,label)=>{n++;if(ok)console.log('OK ',label);else{fail++;console.error('BAD',label);}};
async function api(token,path,method='GET',body){const r=await fetch(BASE+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return{r,d:await r.json().catch(()=>({}))};}
(async()=>{try{
  const app=fs.readFileSync('public/app.js','utf8'), admin=fs.readFileSync('public/admin/admin.js','utf8'), db=fs.readFileSync('db.js','utf8'), server=fs.readFileSync('server.js','utf8');
  yes(db.includes("colis26_catalogue30_structure_v1") && db.includes("Ferronnerie et soudure") && db.includes("Immobilier et conciergerie") && db.includes("short_label"), 'migration non destructive des 30 domaines et libellés courts présente');
  yes(app.includes('function grandLabel(category)') && app.includes('esc(grandLabel(s))') && admin.includes('Libellé court') && admin.includes('gc-short'), 'cartes client et éditeur PDG utilisent le libellé court administrable');
  yes(server.includes('short_label') && server.includes("INSERT INTO grand_categories(name,short_label"), 'API PDG enregistre le libellé court côté serveur');

  const categories=(await api(null,'/grand-categories')).d;
  const names=['Ferronnerie et soudure','Énergie solaire et secours électrique','Électroménager et appareils domestiques','Vitrerie et miroiterie','Imprimerie et signalétique','Photo, vidéo et sonorisation','Toiture et étanchéité','Forage et traitement de l’eau','Entretien automobile','Immobilier et conciergerie'];
  yes(categories.length===30 && names.every(name=>categories.some(c=>c.name===name)), 'les dix nouveaux domaines portent le catalogue à trente catégories actives');
  yes(new Set(categories.map(c=>c.name)).size===30 && categories.every(c=>c.short_label && c.short_label.length<=60 && c.categories.some(sub=>(sub.services||[]).length)), 'aucun doublon, chaque catégorie a un libellé court et au moins une prestation réelle');
  const pairs={
    'Ferronnerie et soudure':'Ferronnerie', 'Énergie solaire et secours électrique':'Solaire & énergie',
    'Électroménager et appareils domestiques':'Électroménager','Vitrerie et miroiterie':'Vitrerie',
    'Imprimerie et signalétique':'Imprimerie','Photo, vidéo et sonorisation':'Photo, vidéo & son',
    'Toiture et étanchéité':'Toiture & étanchéité','Forage et traitement de l’eau':'Eau & forage',
    'Entretien automobile':'Entretien auto','Immobilier et conciergerie':'Immobilier'
  };
  yes(Object.entries(pairs).every(([name,label])=>categories.find(c=>c.name===name).short_label===label), 'les libellés courts validés sont correctement publiés sur l’API client');

  const login=(await api(null,'/auth/login','POST',{phone:'admin',password:'Klean@2026'})).d;
  const suffix=String(Date.now()).slice(-8);
  const user=(await api(null,'/auth/register','POST',{name:'Client C26 '+suffix,phone:'04'+suffix,password:'abcd1234',ville:'Bouaké',accept_rules:true})).d;
  const ferronnerie=categories.find(c=>c.name==='Ferronnerie et soudure');
  const denied=await api(user.token,'/admin/grand-categories/'+ferronnerie.id,'PUT',{short_label:'Interdit'});
  const update=await api(login.token,'/admin/grand-categories/'+ferronnerie.id,'PUT',{short_label:'Ferronnerie CI'});
  const after=(await api(null,'/grand-categories/'+ferronnerie.id+'/catalogue')).d;
  const reset=await api(login.token,'/admin/grand-categories/'+ferronnerie.id,'PUT',{short_label:'Ferronnerie'});
  yes(denied.r.status===403 && update.r.status===200 && after.short_label==='Ferronnerie CI' && reset.r.status===200, 'seul le PDG peut modifier le libellé court, appliqué immédiatement au catalogue public');

  console.log(`RESULT ${n-fail}/${n}, failed=${fail}`);process.exitCode=fail?1:0;
}catch(e){console.error(e);process.exitCode=1;}})();
