/* COLIS 31 — Maintenance générale : exceptions persistantes, API étanche et historique.
   Lancer : KLEAN_TEST_BASE=http://127.0.0.1:3000 node test-colis31.js */
'use strict';
const BASE=(process.env.KLEAN_TEST_BASE||'http://127.0.0.1:3000').replace(/\/$/,''),API=BASE+'/api';
let total=0,failed=0;const yes=(ok,label)=>{total++;console.log(ok?'OK ':'BAD',label);if(!ok)failed++;};
async function call(token,url,method='GET',body){const r=await fetch(API+url,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {r,d:await r.json().catch(()=>({}))};}
(async()=>{let admin,oldMaintenance='',users=[],tokens=[];const stamp=String(Date.now()).slice(-8),pass='KleanMaint31!';try{
 const dbmod=require('./db');oldMaintenance=dbmod.getSetting('maintenance','')||'';
 admin=(await call(null,'/auth/login','POST',{phone:'admin',password:'Klean@2026'})).d.token;yes(!!admin,'connexion PDG');
 for(let i=0;i<4;i++){const x=await call(null,'/auth/register','POST',{name:`Maintenance test COLIS 31 ${i+1}`,phone:`0${i+1}${stamp}`,password:pass,ville:'Abidjan',quartier:'Cocody',accept_rules:true});users.push({id:x.d.user&&x.d.user.id,phone:`0${i+1}${stamp}`});tokens.push(x.d.token);}
 yes(tokens.every(Boolean)&&users.every(u=>u.id),'quatre comptes de contrôle créés');
 const cfg={active:1,scope:'F',reason:'Contrôle automatisé COLIS 31',title:'MAINTENANCE EN COURS',message:'Maintenance COLIS 31 en cours.',precision:'Retour très bientôt.',background_color:'#b91c1c',icon:'⚠️',logo_url:'/logo.png'};
 let on=await call(admin,'/admin/maintenance','POST',cfg);yes(on.r.status===200&&on.d.config.active,'activation réelle de la maintenance générale');
 let publicState=await call(null,'/maintenance');yes(publicState.r.status===200&&publicState.d.active&&publicState.d.blocked&&publicState.d.title==='MAINTENANCE EN COURS','état public bloque par défaut un visiteur non autorisé');
 let oldSession=await call(tokens[0],'/me');yes(oldSession.r.status===503&&oldSession.d.maintenance,'ancienne session bloquée côté API');
 let directApi=await call(null,'/services');yes(directApi.r.status===503&&directApi.d.maintenance,'lien direct / API publique bloqué pendant maintenance générale');
 let blockedLogin=await call(null,'/auth/login','POST',{phone:users[0].phone,password:pass});yes(blockedLogin.r.status===503&&blockedLogin.d.maintenance,'connexion refusée pour un compte non autorisé');
 let allow=await call(admin,'/admin/maintenance/allowed','PUT',{user_ids:users.slice(0,3).map(u=>u.id),allowed:true});yes(allow.r.status===200&&allow.d.allowed_ids.length===3,'trois comptes autorisés de façon persistante');
 let allowedChecks=await Promise.all(tokens.slice(0,3).map(t=>call(t,'/me')));yes(allowedChecks.every(x=>x.r.status===200),'seuls les comptes autorisés retrouvent leurs API normales');
 let stillBlocked=await call(tokens[3],'/me');yes(stillBlocked.r.status===503,'le quatrième compte reste bloqué');
 let pdg=await call(admin,'/admin/maintenance');yes(pdg.r.status===200&&pdg.d.stats.allowed===3&&pdg.d.stats.test_connections>=3,'PDG conserve l’accès complet et voit les statistiques d’accès de test');
 let remove=await call(admin,'/admin/maintenance/allowed','PUT',{user_ids:[users[1].id],allowed:false});let removed=await call(tokens[1],'/me');yes(remove.r.status===200&&removed.r.status===503,'retrait d’autorisation bloque immédiatement une session existante');
 let hist=await call(admin,'/admin/maintenance/history');yes(hist.r.status===200&&hist.d.history.some(h=>['activated','accounts_authorized','accounts_blocked'].includes(h.action)),'historique activation et autorisations conservé');
 let schedule=await call(admin,'/admin/maintenance','POST',{...cfg,start_at:new Date(Date.now()+3600000).toISOString().slice(0,16),duration_minutes:30,reason:'Maintenance programmée COLIS 31'});yes(schedule.r.status===200&&schedule.d.config.scheduled,'maintenance programmable avec durée et état programmé');
 let scheduledAccess=await call(tokens[3],'/me');yes(scheduledAccess.r.status===200,'avant l’heure programmée les comptes restent accessibles');
 let off=await call(admin,'/admin/maintenance','POST',{active:0,reason:'Fin contrôle COLIS 31'});let normal=await call(tokens[3],'/me');yes(off.r.status===200&&normal.r.status===200,'désactivation restaure les accès selon le statut habituel');
}catch(e){failed++;console.error(e.stack||e);}finally{
 try{const {db,setSetting}=require('./db');setSetting('maintenance',oldMaintenance);const ids=users.map(u=>u.id).filter(Boolean);if(ids.length){const q=ids.map(()=>'?').join(',');db.prepare(`DELETE FROM maintenance_allowed_accounts WHERE user_id IN (${q})`).run(...ids);db.prepare(`DELETE FROM maintenance_access_events WHERE user_id IN (${q})`).run(...ids);db.prepare(`DELETE FROM users WHERE id IN (${q})`).run(...ids);}db.prepare("DELETE FROM maintenance_history WHERE config_json LIKE '%COLIS 31%' OR details LIKE '%COLIS 31%'").run();}catch(e){console.error('Nettoyage',e.message);}}
 console.log(`RESULT ${total-failed}/${total}, failed=${failed}`);process.exitCode=failed?1:0;
})();
