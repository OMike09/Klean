/* COLIS 41 — réorganisation centrale des catégories, parcours et synchronisation. */
'use strict';
const fs=require('fs'), os=require('os'), path=require('path'), {execFileSync}=require('child_process');
const {chromium}=require('playwright');
const {db}=require('./db');
const BASE=process.env.TEST_BASE_URL||'http://127.0.0.1:3000', API=BASE+'/api';
let pass=0,fail=0,browser;
const saved={users:[],missions:[],root:null,metier:null,sub:null,service:null,adminLog:0};
function ok(value,label){if(value){pass++;console.log('✓',label);}else{fail++;console.error('✗',label);}}
function assert(value,label){ok(value,label);if(!value)throw new Error(label);}
async function api(token,route,method='GET',body){
  const res=await fetch(API+route,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await res.json().catch(()=>({})); return {res,data};
}
function testPhone(tag){return '07'+tag+String(Date.now()).slice(-6);}
function tableExists(name){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
function cleanup(){
  try {
    // Les éléments temporaires du catalogue sont retirés dans l'ordre des dépendances.
    if(saved.service) db.prepare('DELETE FROM services WHERE id=?').run(saved.service);
    if(saved.sub) db.prepare('DELETE FROM sous_categories WHERE id=?').run(saved.sub);
    if(saved.metier) db.prepare('DELETE FROM service_categories WHERE id=?').run(saved.metier);
    if(saved.root) db.prepare('DELETE FROM grand_categories WHERE id=?').run(saved.root);
    for(const id of saved.missions){
      ['mission_messages','mission_events','mission_candidates','mission_price_changes','mission_files','mission_status_history'].forEach(t=>{if(tableExists(t))try{db.prepare(`DELETE FROM ${t} WHERE mission_id=?`).run(id)}catch{}});
      try{db.prepare('DELETE FROM missions WHERE id=?').run(id)}catch{}
    }
    for(const id of saved.users){
      // Les tests ne suppriment jamais de comptes de production : uniquement les ids créés dans ce script.
      ['notifications','user_sessions','pro_domain_change_requests','pro_option_usage','availability_slots','service_availability','voice_search_events'].forEach(t=>{if(tableExists(t))try{db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(id)}catch{}});
      try{db.prepare('DELETE FROM users WHERE id=?').run(id)}catch{}
    }
    if(saved.adminLog) db.prepare('DELETE FROM admin_log WHERE id>?').run(saved.adminLog);
  }catch(e){console.error('Restauration COLIS41:',e.message);}
}
function freshMigrationCheck(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ks-colis41-fresh-'));
  try{
    const code=`const {db}=require(${JSON.stringify(path.join(__dirname,'db.js'))});\nconst roots=db.prepare(\"SELECT name FROM grand_categories WHERE active=1\").all().map(x=>x.name);\nconst legacy=db.prepare(\"SELECT COUNT(*) n FROM grand_categories WHERE active=1 AND name IN ('Beauté, coiffure et bien-être','Cours et formation')\").get().n;\nconst paths=db.prepare(\"SELECT s.name,g.name grand,sc.name sub FROM services s JOIN service_categories c ON c.id=s.category_id LEFT JOIN grand_categories g ON g.id=c.grand_category_id LEFT JOIN sous_categories sc ON sc.id=s.sub_id WHERE lower(s.name) LIKE '%vidange%fosse%' OR lower(s.name) LIKE '%coiffure homme%' OR lower(s.name) LIKE '%soutien scolaire%' OR lower(s.name) LIKE '%sport%'\").all();\nconsole.log('COLIS41_JSON:'+JSON.stringify({roots,legacy,paths}));`;
    const out=execFileSync(process.execPath,['-e',code],{cwd:__dirname,env:{...process.env,DATA_DIR:dir},encoding:'utf8',timeout:120000});
    const row=out.split(/\r?\n/).find(x=>x.startsWith('COLIS41_JSON:'));
    const r=JSON.parse(row.slice('COLIS41_JSON:'.length));
    const required=['Vidange et assainissement','Beauté et coiffure femme','Beauté et coiffure homme','Cours à domicile','Formation et coaching'];
    assert(required.every(x=>r.roots.includes(x))&&r.legacy===0,'base neuve : migration COLIS41 crée seulement les racines canoniques actives');
    const has=(word,root)=>r.paths.some(x=>x.name.toLowerCase().includes(word)&&x.grand===root&&x.sub);
    assert(has('vidange','Vidange et assainissement')&&has('coiffure homme','Beauté et coiffure homme')&&has('soutien scolaire','Cours à domicile')&&has('sport','Formation et coaching'),'base neuve : prestations critiques rattachées à une sous-catégorie et à la bonne racine');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
async function register(name,tag){
  const phone=testPhone(tag),r=await api(null,'/auth/register','POST',{name,phone,password:'Colis41!2026',address:'Cocody, Abidjan',ville:'Abidjan',quartier:'Cocody',accept_rules:true});
  assert(r.res.status===200&&r.data.token&&r.data.user&&r.data.user.id,`inscription API du compte temporaire ${tag}`); saved.users.push(r.data.user.id); return r.data;
}
function waitSse(token){
  return new Promise((resolve,reject)=>{
    const controller=new AbortController(); let text='',done=false;
    const timer=setTimeout(()=>{controller.abort();reject(new Error('événement SSE catalogue absent'));},7000);
    fetch(API+'/stream?token='+encodeURIComponent(token),{signal:controller.signal,headers:{accept:'text/event-stream'}}).then(async res=>{
      const reader=res.body.getReader();
      while(!done){const {value,done:ended}=await reader.read();if(ended)break;text+=Buffer.from(value).toString('utf8');
        if(/event: catalogue\ndata:/.test(text)){done=true;clearTimeout(timer);controller.abort();resolve(text);}
      }
    }).catch(e=>{if(!done&&e.name!=='AbortError'){clearTimeout(timer);reject(e);}});
  });
}
(async()=>{try{
  saved.adminLog=db.prepare('SELECT COALESCE(MAX(id),0) n FROM admin_log').get().n;
  freshMigrationCheck();

  let x=await api(null,'/auth/login','POST',{phone:'admin',password:'Klean@2026'}); assert(x.res.status===200&&x.data.user.role==='pdg','connexion direction pour les contrôles COLIS41'); const pdg=x.data.token;
  const [roots,catalogue]=await Promise.all([api(null,'/grand-categories'),api(null,'/catalogue')]);
  const canonical=['Vidange et assainissement','Beauté et coiffure femme','Beauté et coiffure homme','Cours à domicile','Formation et coaching'];
  assert(roots.res.status===200&&canonical.every(n=>roots.data.some(g=>g.name===n))&&!roots.data.some(g=>['Beauté, coiffure et bien-être','Cours et formation'].includes(g.name)),'API publique : cinq branches canoniques et aucune racine historique active');
  const catalogueServices=catalogue.data.flatMap(category=>category.services.map(service=>({...service,grand_category:category.grand_category,category:category.name,category_id:category.id})));
  const findService=(n)=>catalogueServices.find(s=>Number(s.id)===n);
  assert([25,85,86,16,100,116].every(id=>{const s=findService(id);return s&&s.sub_id&&s.sub_category&&s.grand_category;}),'catalogue public : chaque service critique expose le chemin de sous-catégorie');
  assert(findService(25).grand_category==='Vidange et assainissement'&&findService(85).grand_category==='Beauté et coiffure femme'&&findService(86).grand_category==='Beauté et coiffure homme'&&findService(16).grand_category==='Cours à domicile'&&findService(100).grand_category==='Formation et coaching'&&findService(116).grand_category==='Formation et coaching','catalogue public : vidange, coiffure, cours et coaching suivent les racines imposées');
  for(const [query,grand] of [['vidange','Vidange et assainissement'],['coiffeur homme','Beauté et coiffure homme'],['cours a domicile','Cours à domicile'],['coach sportif','Formation et coaching']]){
    x=await api(null,'/search?q='+encodeURIComponent(query)); assert(x.res.status===200&&Array.isArray(x.data.results)&&x.data.results.some(s=>s.grand_category===grand&&s.sub_category),`recherche « ${query} » utilise le catalogue central et sa sous-catégorie`);
  }

  // Direction : une modification passe par l'API puis devient publique et est signalée en SSE.
  const beforeSse=waitSse(pdg);
  x=await api(pdg,'/admin/grand-categories','POST',{name:'Contrôle temporaire COLIS41',short_label:'Contrôle 41',description:'Créé uniquement pour la vérification automatisée.',icon:'🧪',sort:999});
  assert(x.res.status===201&&Number.isInteger(Number(x.data.id)),'direction : création d’une grande catégorie depuis l’API'); saved.root=x.data.id;
  await beforeSse; ok(true,'SSE : création de catégorie notifiée aux clients connectés');
  x=await api(pdg,'/admin/categories','POST',{name:'Métier temporaire COLIS41',icon:'🧪',sort:999,grand_category_id:saved.root}); assert(x.res.status===200&&x.data.id,'direction : création du métier lié à sa racine'); saved.metier=x.data.id;
  x=await api(pdg,'/admin/sous-categories','POST',{name:'Spécialité temporaire COLIS41',metier_id:saved.metier,sort:999}); assert(x.res.status===200&&x.data.id,'direction : création de la sous-catégorie centrale'); saved.sub=x.data.id;
  x=await api(pdg,'/admin/services','POST',{name:'Prestation temporaire COLIS41',category_id:saved.metier,sub_id:saved.sub,keywords:'colis41 test',sort:999}); assert(x.res.status===200&&x.data.id,'direction : création d’une prestation rattachée à la sous-catégorie'); saved.service=x.data.id;
  x=await api(pdg,'/admin/grand-categories/'+saved.root,'PUT',{name:'Contrôle COLIS41 synchronisé'}); assert(x.res.status===200,'direction : renommage central enregistré');
  x=await api(null,'/catalogue'); const temporary=x.data.flatMap(category=>category.services.map(service=>({...service,grand_category:category.grand_category,category:category.name}))).find(s=>Number(s.id)===Number(saved.service)); assert(temporary&&temporary.grand_category==='Contrôle COLIS41 synchronisé'&&temporary.category==='Métier temporaire COLIS41'&&temporary.sub_category==='Spécialité temporaire COLIS41','modification direction répercutée dans l’API publique sans taxonomie parallèle');

  // Professionnel : spécialité déclarée, validation, autorisation fine et matching réel.
  const pro=await register('Pro coiffure homme COLIS41','41');
  const skill=await api(pro.token,'/pro-skill-catalogue'); const male=skill.data.find(g=>g.name==='Beauté et coiffure homme');
  const maleMetier=male&&male.categories.find(c=>c.name&&/coiffure homme|barbier/i.test(c.name)); const maleSub=maleMetier&&maleMetier.subcategories[0];
  assert(skill.res.status===200&&male&&maleMetier&&maleSub,'formulaire professionnel : catalogue de spécialités contient la branche coiffure homme');
  x=await api(pro.token,'/pro/apply','POST',{profession:'Barbier COLIS41',description:'Coupe et barbe homme.',experience:'3 ans',zone:'Abidjan',services:[86],domain_categories:[male.id],selected_subcategories:[maleSub.id],documents:[],accept_rules:true});
  assert(x.res.status===200&&x.data.pro_status==='pending','candidature pro : sous-catégorie homme obligatoire et acceptée');
  x=await api(pdg,'/admin/pros/'+pro.user.id+'/approve','POST',{}); assert(x.res.status===200,'validation d’un professionnel coiffure homme');
  x=await api(pdg,'/admin/pros/'+pro.user.id+'/eligibility','PUT',{authorized_domain_categories:[male.id],authorized_subcategories:[maleSub.id],authorized_services:[],pro_type:'particulier',capacity_level:1,service_cities:['Abidjan']});
  assert(x.res.status===200&&x.data.authorized_subcategories.includes(Number(maleSub.id))&&x.data.authorized_domain_categories.includes(Number(male.id)),'direction : autorisation professionnelle affinée par sous-catégorie');
  x=await api(pro.token,'/pro/dashboard'); assert(x.res.status===200&&x.data.profile&&x.data.profile.authorized_subcategories.includes(Number(maleSub.id)),'espace professionnel : spécialité autorisée synchronisée depuis la direction');

  const client=await register('Client matching COLIS41','42');
  x=await api(client.token,'/missions','POST',{service_id:86,description:'Coupe homme classique, besoin aujourd’hui.',address:'Cocody Angré',intervention_city:'Abidjan',intervention_commune:'Cocody',schedule_type:'today',provider_type:'particulier',answers:{}});
  assert(x.res.status===200&&x.data.id&&x.data.status==='recherche','création d’une demande coiffure homme depuis le parcours client'); saved.missions.push(x.data.id);
  const candidate=db.prepare('SELECT * FROM mission_candidates WHERE mission_id=? AND pro_id=?').get(x.data.id,pro.user.id);
  assert(!!candidate&&candidate.status==='offered','matching : seul profil validé avec spécialité homme reçoit l’offre correspondante');

  // Les comptes équipe relisent bien la source catalogue ; les écritures restent contrôlées par permissions.
  const staff=[];
  for(const [role,tag] of [['gestionnaire','43'],['agent','44']]){
    const r=await api(pdg,'/admin/staff','POST',{name:`${role} COLIS41`,phone:testPhone(tag),role}); assert(r.res.status===201&&r.data.temporary_code,'direction : création contrôlée du compte '+role); saved.users.push(r.data.id);
    const login=await api(null,'/auth/login','POST',{phone:r.data.phone,password:r.data.temporary_code}); assert(login.res.status===200&&login.data.user.role===role,'connexion '+role+' avec accès provisoire'); staff.push(login.data);
  }
  for(const member of staff){x=await api(member.token,'/catalogue'); assert(x.res.status===200&&x.data.some(category=>category.grand_category==='Beauté et coiffure homme'&&category.services.some(s=>Number(s.id)===86&&s.sub_category)),'équipe '+member.user.role+' : lecture du même catalogue central');}
  x=await api(staff.find(s=>s.user.role==='agent').token,'/admin/services','POST',{name:'Interdit',category_id:saved.metier}); assert(x.res.status===403,'agent : écriture catalogue refusée sans permission dédiée');

  // Contrôles UI : les vues client, pro et direction consomment les réponses réelles du serveur.
  browser=await chromium.launch({headless:true});
  const publicCtx=await browser.newContext({viewport:{width:390,height:844},isMobile:true}),publicPage=await publicCtx.newPage(),publicErrors=[]; publicPage.on('pageerror',e=>publicErrors.push(e.message));
  await publicPage.goto(BASE+'/#/home'); await publicPage.waitForSelector('#home-q');
  await publicPage.getByText('Voir tous les services',{exact:true}).click(); await publicPage.waitForTimeout(350);
  const homeText=await publicPage.locator('#app').innerText(); assert(homeText.includes('Assainissement')&&homeText.includes('Beauté homme')&&homeText.includes('Cours à domicile')&&homeText.includes('Formation & coaching')&&!homeText.includes('Beauté, coiffure et bien-être'),'interface client mobile : racines réorganisées rendues depuis l’API');
  await publicPage.goto(BASE+'/#/home'); await publicPage.waitForSelector('#home-q'); await publicPage.locator('#home-q').fill('coiffeur homme'); await publicPage.keyboard.press('Enter'); await publicPage.waitForTimeout(450); assert((await publicPage.locator('#app').innerText()).includes('Beauté et coiffure homme'),'interface client : recherche affiche la branche homme'); assert(!publicErrors.length,'interface client : aucun échec JavaScript de catalogue'); await publicCtx.close();
  const proCtx=await browser.newContext({viewport:{width:1280,height:850}}); await proCtx.addInitScript(t=>localStorage.setItem('ks_token',t),pro.token); const proPage=await proCtx.newPage(),proErrors=[];proPage.on('pageerror',e=>proErrors.push(e.message)); await proPage.goto(BASE+'/#/pro'); await proPage.waitForTimeout(500); assert((await proPage.locator('#app').innerText()).includes('Barbier COLIS41')||!proErrors.length,'interface professionnel : profil spécialisé charge sans rupture'); await proCtx.close();
  const adminCtx=await browser.newContext({viewport:{width:1280,height:850}});await adminCtx.addInitScript(t=>localStorage.setItem('ks_admin_token',t),pdg);const adminPage=await adminCtx.newPage(),adminErrors=[];adminPage.on('pageerror',e=>adminErrors.push(e.message));await adminPage.goto(BASE+'/admin/#catalog');await adminPage.waitForTimeout(600);const adminText=await adminPage.locator('#root').innerText();assert(adminText.includes('Structure centrale synchronisée')&&adminText.includes('Beauté et coiffure homme'),'interface direction : structure centrale et branche homme administrables');assert(!adminErrors.length,'interface direction : catalogue sans erreur JavaScript');await adminCtx.close();
}catch(e){fail++;console.error(e.stack||e);}finally{
  try{if(browser)await browser.close();}catch{}
  cleanup();
  console.log(`COLIS 41 catalogue : ${pass}/${pass+fail}`);
  process.exitCode=fail?1:0;
}})();
