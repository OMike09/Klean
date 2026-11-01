/* COLIS 37 — registre image, URL versionnées, invalidation et PWA hors connexion. */
'use strict';
const { chromium }=require('playwright');
const { db }=require('./db');
const fs=require('fs'), path=require('path');
const BASE='http://127.0.0.1:3000', API=BASE+'/api';
let pass=0, fail=0, id=null, browser=null, uploadedName=null;
function ok(value,label){ if(value){pass++;console.log('✓',label);}else{fail++;console.error('✗',label);} }
async function api(token,path,method='GET',body){ const r=await fetch(API+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}); return {r,d:await r.json().catch(()=>({}))}; }
async function waitFor(fn,timeout=3500){ const end=Date.now()+timeout; while(Date.now()<end){if(await fn())return true;await new Promise(r=>setTimeout(r,80));}return false; }
function cleanup(){ try{if(id){db.prepare('DELETE FROM image_delivery_diagnostics WHERE asset_id IN (SELECT id FROM image_assets WHERE owner_type=\'grand_category\' AND owner_id=?)').run(id);db.prepare("DELETE FROM image_assets WHERE owner_type='grand_category' AND owner_id=?").run(id);db.prepare('DELETE FROM grand_categories WHERE id=?').run(id);}if(uploadedName){try{fs.unlinkSync(path.join(__dirname,'uploads',uploadedName));}catch{}db.prepare('DELETE FROM file_records WHERE name=?').run(uploadedName);}}catch{} }
(async()=>{
  let context,page,token,oldUrl,newUrl;
  try{
    const login=await api(null,'/auth/login','POST',{phone:'admin',password:'Klean@2026'}); token=login.d.token; ok(login.r.status===200&&!!token,'connexion de direction');
    const name='COLIS37 image temporaire '+Date.now();
    let x=await api(token,'/admin/grand-categories','POST',{name,short_label:'Test image',description:'Contrôle temporaire du registre image',icon:'🧪',sort:9999,popular:true,active:true,image_url:'/category-images/01-nettoyage-et-entretien.jpg'});
    id=Number(x.d.id); const first=x.d.category; oldUrl=first&&first.image_public_url;
    ok(x.r.status===201&&id>0&&/^\/category-images\/01-nettoyage-et-entretien\.jpg\?v=[a-f0-9]{12,}$/i.test(oldUrl||''),'création atomique : ID asset et URL publique versionnée');
    ok(first&&first.image_asset&&first.image_asset.id&&first.image_asset.width>0&&first.image_asset.height>0&&first.image_asset.format==='image/jpeg'&&first.image_asset.owner_id===id,'métadonnées persistées : association, format, dimensions et version');
    let head=await fetch(BASE+oldUrl,{method:'HEAD'}); ok(head.status===200&&/immutable/.test(head.headers.get('cache-control')||'')&&head.headers.get('x-klean-public-image')==='1','asset actif servable avec cache immuable autorisé');
    let publicRows=(await api(null,'/grand-categories')).d, publicFirst=publicRows.find(r=>r.id===id); ok(publicFirst&&publicFirst.image_url===oldUrl&&publicFirst.image_asset.id===first.image_asset.id,'API publique ne fournit que la version active associée');

    x=await api(token,'/admin/grand-categories/'+id,'PUT',{image_url:'/category-images/02-plomberie.jpg'});
    const second=x.d.category; newUrl=second&&second.image_public_url;
    ok(x.r.status===200&&newUrl&&newUrl!==oldUrl&&second.image_asset.id!==first.image_asset.id,'remplacement atomique : nouvel asset et nouvelle URL sans réemploi');
    ok(second.image_asset.invalidated_urls.includes(oldUrl),'référence de cache obsolète exposée pour purge sûre');
    head=await fetch(BASE+oldUrl,{method:'HEAD'}); ok(head.status===404,'ancienne URL versionnée ne peut plus être revalidée comme image courante');
    head=await fetch(BASE+newUrl,{method:'HEAD'}); ok(head.status===200&&head.headers.get('x-klean-public-image')==='1','nouvelle photo publique immédiatement disponible');

    browser=await chromium.launch({headless:true}); context=await browser.newContext({viewport:{width:390,height:844},isMobile:true});
    await context.addInitScript(value=>localStorage.setItem('ks_token',value),token); page=await context.newPage();
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.goto(BASE+'/#/home');
    await page.evaluate(()=>navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForSelector('.svc-card-media img');
    const visible=await page.locator('.svc-card-media img').evaluateAll(nodes=>nodes.map(n=>({src:n.getAttribute('src'),w:n.naturalWidth,h:n.naturalHeight,loading:n.getAttribute('loading')})));
    ok(visible.some(x=>x.src===newUrl&&x.w>0&&x.h>0),'mobile : la carte publique charge la nouvelle photo correcte');
    ok(visible.filter(x=>x.loading==='eager').length>0,'mobile : les photos au-dessus de la ligne de flottaison sont prioritaires');
    const cached=await waitFor(()=>page.evaluate(async url=>{const c=await caches.open('ks-v1-public-images');return !!(await c.match(url));},newUrl));
    ok(cached,'PWA : image publique versionnée enregistrée pour réutilisation');
    await page.evaluate(({active_urls,invalidated_urls})=>navigator.serviceWorker.controller.postMessage({type:'KS_IMAGE_CACHE_SYNC',active_urls,invalidated_urls}),{active_urls:[newUrl],invalidated_urls:[oldUrl]});
    const oldPurged=await waitFor(()=>page.evaluate(async url=>{const c=await caches.open('ks-v1-public-images');return !(await c.match(url));},oldUrl));
    ok(oldPurged,'PWA : ancienne entrée retirée sans vider les images valides');
    await context.setOffline(true);
    const offline=await page.evaluate(async url=>{const r=await fetch(url);return {status:r.status,type:r.headers.get('content-type')||'',bytes:(await r.arrayBuffer()).byteLength};},newUrl);
    ok(offline.status===200&&/^image\//.test(offline.type)&&offline.bytes>1000,'PWA hors connexion : photo courante déjà téléchargée réutilisable');
    await context.setOffline(false);
    ok(errors.length===0,'rendu mobile sans erreur JavaScript');

    const adminContext=await browser.newContext({viewport:{width:1180,height:800}});
    await adminContext.addInitScript(value=>{localStorage.setItem('ks_admin_token',value);sessionStorage.setItem('adm_cat_tab','photos');},token);
    const adminPage=await adminContext.newPage(); await adminPage.goto(BASE+'/admin/#catalog');
    await adminPage.waitForSelector('.grand-photo-card');
    const adminCard=adminPage.locator('.grand-photo-card').filter({hasText:'Test image'});
    ok(await adminCard.count()===1&&await adminCard.innerText().then(t=>/ID img_/.test(t))&&await adminCard.locator('img').getAttribute('src').then(src=>String(src||'').includes('?v=')),'tableau direction : aperçu, ID, dimensions/version et URL publiée synchronisés');
    await adminContext.close();

    const form=new FormData();
    form.append('files',new Blob([fs.readFileSync(path.join(__dirname,'public/category-images/03-electricite.jpg'))],{type:'image/jpeg'}),'categorie-colis37.jpg');
    const uploaded=await fetch(API+'/upload',{method:'POST',headers:{Authorization:'Bearer '+token},body:form});
    const uploadedBody=await uploaded.json(); const uploadUrl=uploadedBody.files&&uploadedBody.files[0]; uploadedName=uploadUrl&&uploadUrl.slice('/uploads/'.length);
    ok(uploaded.status===200&&/^\/uploads\/[a-z0-9.-]+$/i.test(uploadUrl||'')&&!!db.prepare('SELECT 1 FROM file_records WHERE name=?').get(uploadedName),'téléversement : binaire existant et file_records permanent réutilisés');
    x=await api(token,'/admin/grand-categories/'+id,'PUT',{image_url:uploadUrl});
    const uploadedCategory=x.d.category, uploadedPublic=uploadedCategory&&uploadedCategory.image_public_url;
    ok(x.r.status===200&&uploadedCategory&&uploadedCategory.image_asset&&uploadedCategory.image_asset.file_name===undefined&&uploadedCategory.image_asset.width>0&&uploadedPublic&&uploadedPublic.includes('?v='),'association upload → catégorie crée une nouvelle version avec dimensions');
    head=await fetch(BASE+uploadedPublic,{method:'HEAD'});
    ok(head.status===200&&/immutable/.test(head.headers.get('cache-control')||'')&&head.headers.get('x-klean-public-image')==='1','upload actif servi publiquement uniquement via sa version validée');
    const liveUpdated=await waitFor(()=>page.locator(`[data-grand-category-id="${id}"] img`).getAttribute('src').then(src=>src===uploadedPublic));
    ok(liveUpdated,'session connectée : signal serveur remplace la photo visible sans rechargement ni réinstallation');

    x=await api(token,'/admin/grand-categories/'+id,'PUT',{image_url:null});
    ok(x.r.status===200&&x.d.category&&x.d.category.image_url===null,'suppression : référence publique et asset actif retirés ensemble');
  }catch(e){fail++;console.error(e&&e.stack||e);}
  finally { try{if(context)await context.close();if(browser)await browser.close();}catch{} cleanup(); console.log(`COLIS 37 images : ${pass}/${pass+fail}`); process.exitCode=fail?1:0; }
})();
