/* COLIS 39 — régression publication publicité : verrouillage du bouton administration. */
'use strict';
const { chromium }=require('playwright');
const BASE='http://127.0.0.1:3000'; let pass=0, fail=0;
function ok(value,label){if(value){pass++;console.log('✓',label)}else{fail++;console.error('✗',label)}}
(async()=>{let browser;try{
  const login=await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:'admin',password:'Klean@2026'})});
  const {token}=await login.json(); ok(!!token,'connexion de direction');
  browser=await chromium.launch({headless:true}); const context=await browser.newContext({viewport:{width:1280,height:850}});
  await context.addInitScript(t=>localStorage.setItem('ks_admin_token',t),token);
  const page=await context.newPage(),errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(BASE+'/admin/#ads'); await page.getByText('Créer une publicité').click(); await page.waitForSelector('#ade-preview');
  await page.locator('#ade-title').fill('Contrôle publication sans écriture'); await page.locator('#ade-content').fill('Cette requête est interceptée par le test.');
  let publicationIntercepted=false;
  await page.route('**/api/admin/ads',route=>{if(route.request().method()==='POST'){publicationIntercepted=true;return route.fulfill({status:200,contentType:'application/json',body:'{}'});}return route.continue();});
  await page.getByRole('button',{name:'Publier',exact:true}).click(); await page.waitForTimeout(250);
  ok(publicationIntercepted,'clic Publier atteint bien le flux d’enregistrement');
  ok(await page.locator('#modal').count()===0,'publication termine et ferme le formulaire');
  ok(!errors.some(message=>/busy is not defined/i.test(message))&&!errors.length,'aucune erreur JavaScript busy is not defined');
}catch(e){fail++;console.error(e.stack||e)}finally{try{if(browser)await browser.close()}catch{}console.log(`COLIS 39 publication : ${pass}/${pass+fail}`);process.exitCode=fail?1:0;}})();
