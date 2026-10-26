/* COLIS 26 — complément : photos de grandes catégories et recherche familière administrable. */
const fs=require('fs');
const BASE=(process.env.KLEAN_TEST_BASE||'http://127.0.0.1:3129')+'/api';
let n=0,fail=0; const yes=(ok,label)=>{n++; if(ok) console.log('OK ',label); else {fail++;console.error('BAD',label);}};
async function api(token,path,method='GET',body){const r=await fetch(BASE+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return{r,d:await r.json().catch(()=>({}))};}
async function upload(token){
  const f=new FormData(), image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
  f.append('files',new Blob([image],{type:'image/png'}),'photo-categorie.png');
  const r=await fetch(BASE+'/upload',{method:'POST',headers:{Authorization:'Bearer '+token},body:f}); return {r,d:await r.json().catch(()=>({}))};
}
(async()=>{try{
  const app=fs.readFileSync('public/app.js','utf8'),admin=fs.readFileSync('public/admin/admin.js','utf8'),db=fs.readFileSync('db.js','utf8'),server=fs.readFileSync('server.js','utf8');
  yes(db.includes('search_dictionary_entries') && server.includes('dictionaryTarget') && server.includes('context_category_id'), 'dictionnaire central multi-niveaux et recherche contextualisée présents');
  yes(admin.includes('previewGrandCategoryImage') && admin.includes('prepareGrandCategoryImage') && admin.includes('Supprimer la photo'), 'PDG : aperçu local, préparation, remplacement et retrait de photo présents');
  yes(app.includes('applyTranscribedNeed') && app.includes('requestNeedHints') && app.includes('search_terms'), 'description, transcription reçue et sélecteur de besoins utilisent le moteur de langage');

  const login=(await api(null,'/auth/login','POST',{phone:'admin',password:'Klean@2026'})).d;
  yes(!!login.token,'connexion PDG de validation disponible');
  const categories=(await api(null,'/grand-categories')).d, plomberie=categories.find(c=>c.name==='Plomberie'), nettoyage=categories.find(c=>c.name==='Nettoyage et entretien');
  const expected={
    'mon eau coule partout':'Plomberie', 'plus de courant le disjoncteur saute':'Électricité',
    'ma clim souffle chaud':'Climatisation et froid', 'maison a faire briller':'Nettoyage et entretien',
    'moto ne demarre pas':'Mécanique et automobile', 'voiture en panne':'Mécanique et automobile',
    'arranger ma maison mur abime':'Bâtiment et construction'
  };
  let familiarOk=true;
  for(const [q,domain] of Object.entries(expected)) { const r=(await api(null,'/search?q='+encodeURIComponent(q))).d; familiarOk &&=r.categories?.[0]?.name===domain && r.results?.length>0; }
  yes(familiarOk,'formulations familières, fautes et descriptions obligatoires orientent vers le bon domaine');
  const ambiguous=(await api(null,'/search?q=fuite')).d;
  yes((ambiguous.categories||[]).length>=2 && (ambiguous.results||[]).length>=2,'besoin ambigu : plusieurs résultats classés sont conservés, sans choix imposé');

  const photo=await upload(login.token); const oldImage=plomberie.image_url||null;
  const saveImage=await api(login.token,'/admin/grand-categories/'+plomberie.id,'PUT',{image_url:photo.d.files&&photo.d.files[0]});
  const withImage=(await api(null,'/grand-categories/'+plomberie.id+'/catalogue')).d;
  const imageUrl=withImage.image_url;
  const publicImage=imageUrl ? await fetch('http://127.0.0.1:3129'+imageUrl) : {status:0};
  const removeImage=await api(login.token,'/admin/grand-categories/'+plomberie.id,'PUT',{image_url:''});
  const afterRemove=(await api(null,'/grand-categories/'+plomberie.id+'/catalogue')).d;
  if(oldImage) await api(login.token,'/admin/grand-categories/'+plomberie.id,'PUT',{image_url:oldImage});
  yes(photo.r.status===200 && saveImage.r.status===200 && imageUrl===photo.d.files[0] && publicImage.status===200 && removeImage.r.status===200 && afterRemove.image_url===null, 'photo importée, persistée, publiée publiquement puis dissociée sans supprimer la catégorie');

  const targetTask=plomberie.categories.flatMap(c=>c.services).flatMap(s=>s.taches.map(t=>({...t,service_id:s.id}))).find(t=>/fuite/i.test(t.name));
  const term='verification langage '+String(Date.now()).slice(-8);
  const added=await api(login.token,'/admin/search-terms','POST',{term,target_type:'task',target_id:targetTask.id});
  const found=(await api(null,'/search?q='+encodeURIComponent(term))).d;
  const modified=await api(login.token,'/admin/search-terms/'+added.d.id,'PUT',{term:term+' modifie',target_type:'grand',target_id:nettoyage.id,active:true});
  const moved=(await api(null,'/search?q='+encodeURIComponent(term+' modifie'))).d;
  const inactive=await api(login.token,'/admin/search-terms/'+added.d.id,'PUT',{active:false});
  const hidden=(await api(null,'/search?q='+encodeURIComponent(term+' modifie'))).d;
  const deleted=await api(login.token,'/admin/search-terms/'+added.d.id,'DELETE');
  yes(added.r.status===201 && found.results?.some(x=>Number(x.task_id)===Number(targetTask.id)) && modified.r.status===200 && moved.categories?.some(c=>Number(c.id)===Number(nettoyage.id)) && inactive.r.status===200 && !hidden.categories?.some(c=>Number(c.id)===Number(nettoyage.id)&&Number(c.score)>=70) && deleted.r.status===200, 'PDG : ajout, modification de cible, activation/désactivation et suppression d’expression fonctionnent');
  console.log(`RESULT ${n-fail}/${n}, failed=${fail}`); process.exitCode=fail?1:0;
}catch(e){console.error(e);process.exitCode=1;}})();
