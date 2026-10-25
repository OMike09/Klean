/* Vérifications E2E COLIS 19 — découverte publique, sécurité des actions et PWA installable. */
const fs=require('fs');
const BASE=(process.env.KLEAN_TEST_BASE||'http://127.0.0.1:3105')+'/api';
let n=0,fail=0;function yes(ok,label){n++;if(ok)console.log('OK ',label);else{fail++;console.error('BAD',label)}}
async function api(token,path,method='GET',body){const r=await fetch(BASE+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const d=await r.json().catch(()=>({}));return{r,d}}
(async()=>{try{
  const publicPaths=['/services','/catalogue','/services/populaires','/avis-recherche/categories','/avis-recherche','/jobs','/job-offers','/urgence/config','/about'];
  const publicResults=await Promise.all(publicPaths.map(p=>api(null,p)));
  yes(publicResults.every(x=>x.r.status===200),'visiteur sans compte consulte les contenus publics sans redirection API');
  const [services,catalogue,popular,avisCats,avis,jobs,offers,urgence]=publicResults.map(x=>x.d);
  yes(services.length>0&&catalogue.length>0&&popular.length>0&&avisCats.length>0&&Array.isArray(avis)&&Array.isArray(jobs)&&Array.isArray(offers)&&Object.prototype.hasOwnProperty.call(urgence,'assistance_available'),'catalogue, offres, avis et urgences publics renvoient uniquement leur contenu de consultation');
  const blocked=await Promise.all(['/missions','/job-offers','/avis-recherche','/urgence'].map(p=>api(null,p,'POST',{})));
  yes(blocked.every(x=>x.r.status===401),'actions sensibles sans compte restent bloquées côté serveur');
  const admin=(await api(null,'/auth/login','POST',{phone:'admin',password:'Klean@2026'})).d;
  const cities=(await api(null,'/villes')).d, city=cities[0], suffix=String(Date.now()).slice(-8);
  const author=(await api(null,'/auth/register','POST',{name:'Auteur public '+suffix,phone:'09'+suffix,password:'abcd1234',ville:city,accept_rules:true})).d;
  const created=await api(author.token,'/job-offers','POST',{title:'Offre publique '+suffix,description:'Description de test consultable sans compte.',skills:'Compétence',city,location:'Quartier',duration:'1 mois',compensation:'À discuter',contact:'0700000000',application_method:'Appelez'});
  await api(admin.token,'/admin/job-offers/'+created.d.id+'/status','POST',{status:'approved'});
  const anon=await api(null,'/job-offers?q='+encodeURIComponent('offre publique'));
  const identified=await api(author.token,'/job-offers?q='+encodeURIComponent('offre publique'));
  const ao=anon.d.find(x=>x.id===created.d.id), io=identified.d.find(x=>x.id===created.d.id);
  yes(anon.r.status===200&&ao&&ao.contact===null&&ao.application_method===null&&io&&io.contact==='0700000000','coordonnées d’offre protégées pour un visiteur, accessibles seulement après authentification');
  const app=fs.readFileSync('public/app.js','utf8'), sw=fs.readFileSync('public/sw.js','utf8'), manifest=JSON.parse(fs.readFileSync('public/manifest.json','utf8'));
  yes(app.includes("if (!location.hash) location.hash = '#/home';")&&app.includes("const publicRoutes = ['home','search','services','categories','request','jobs','avis-recherche','urgence','about','login','register','account']"),'ouverture par défaut sur l’accueil et routes de découverte publiques');
  yes(app.includes('Installer l’application')&&app.includes("beforeinstallprompt")&&app.includes("appinstalled")&&app.includes('Sur l’écran d’accueil'),'bouton PWA réel, déclencheur natif et instructions iPhone présents');
  yes(app.includes('Pour effectuer cette action, veuillez créer un compte ou vous connecter.')&&app.includes('ks_pending_request_draft')&&app.includes('resumeAfterAuth'),'demande de compte tardive et conservation de brouillon avant authentification');
  yes(app.includes('function guestAccount()')&&app.includes('Créer un compte')&&app.includes('Se connecter'),'rubrique Compte propose inscription et connexion aux visiteurs');
  yes(manifest.name==='Klean Services'&&manifest.display==='standalone'&&manifest.icons.length>=2&&manifest.scope==='/'&&sw.includes("ks-v7-public-shell")&&sw.includes("url.pathname.startsWith('/api/')")&&sw.includes("SAFE_ASSETS"),'manifeste PWA complet et cache limité à la coque publique');
  console.log(`RESULT ${n-fail}/${n}, failed=${fail}`);process.exitCode=fail?1:0;
}catch(e){console.error(e);process.exitCode=1;}})();
