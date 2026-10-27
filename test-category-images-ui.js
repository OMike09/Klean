/* COLIS 28 — contrôle visuel cartes catégories, dashboard PDG, desktop et mobiles.
   Exécution : npx -y -p playwright@1.58.0 node test-category-images-ui.js http://127.0.0.1:3131 */
'use strict';
const { chromium, devices } = require('playwright');
const base = process.argv[2] || 'http://127.0.0.1:3131';
let passed=0, failed=0;
function check(ok,label){ if(ok){passed++;console.log('OK ',label);}else{failed++;console.error('BAD',label);} }
async function noOverflow(page,label){ check(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+2),label+' : aucun débordement horizontal'); }
async function login(page){
  await page.goto(base+'/admin/',{waitUntil:'networkidle'});
  await page.locator('#l-phone').fill('admin'); await page.locator('#l-pass').fill('Klean@2026');
  await page.locator('#l-btn').click(); await page.waitForSelector('.layout',{timeout:10000});
}
async function admin(context,label){
  const page=await context.newPage(), errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await login(page); await page.evaluate(()=>go('catalog'));
  await page.getByRole('button',{name:'🖼️ Catégories & photos',exact:true}).click();
  await page.waitForSelector('.grand-photo-card',{timeout:10000});
  check(await page.locator('.grand-photo-card').count()>=30,label+' PDG : 30 cartes catégories affichées');
  check(await page.locator('.grand-photo-card img').count()>=30,label+' PDG : aperçus image réellement chargés');
  check(await page.getByRole('button',{name:/Modifier la photo/}).count()>=30,label+' PDG : remplacement photo disponible');
  await noOverflow(page,label+' tableau PDG'); check(errors.length===0,label+' tableau PDG : aucune erreur JavaScript');
  await page.close();
}
async function publicHome(context,label){
  const page=await context.newPage(), errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/',{waitUntil:'networkidle'}); await page.waitForSelector('.svc-card.has-image',{timeout:10000});
  const cards=page.locator('.svc-card.has-image'); await cards.last().scrollIntoViewIfNeeded(); await page.waitForTimeout(250);
  check(await cards.count()>0,label+' accueil : cartes populaires illustrées');
  check(await page.locator('.svc-card.has-image img').evaluateAll(imgs=>imgs.every(i=>i.complete&&i.naturalWidth>0)),label+' accueil : images valides issues de la base');
  await page.evaluate(()=>nav('#/categories')); await page.waitForSelector('.category-list-photo img',{timeout:10000});
  const allCategoryImages=page.locator('.category-list-photo img');
  for(let i=0;i<await allCategoryImages.count();i++) await allCategoryImages.nth(i).scrollIntoViewIfNeeded();
  check(await allCategoryImages.count()===30,label+' toutes catégories : 30 vignettes issues de la source centrale');
  check(await allCategoryImages.evaluateAll(imgs=>imgs.every(i=>i.complete&&i.naturalWidth>0)),label+' toutes catégories : 30 images chargées');
  await noOverflow(page,label+' accueil'); check(errors.length===0,label+' accueil : aucune erreur JavaScript');
  await page.close();
}
(async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const desktop=await browser.newContext({viewport:{width:1440,height:900}}); await admin(desktop,'Desktop'); await publicHome(desktop,'Desktop'); await desktop.close();
    const android=await browser.newContext({...devices['Pixel 7']}); await admin(android,'Android Pixel 7'); await publicHome(android,'Android Pixel 7'); await android.close();
    const iphone=await browser.newContext({...devices['iPhone 13']}); await admin(iphone,'iPhone 13'); await publicHome(iphone,'iPhone 13'); await iphone.close();
  } catch(e){failed++;console.error(e);}
  await browser.close(); console.log(`RESULT ${passed}/${passed+failed}, failed=${failed}`); process.exitCode=failed?1:0;
})();
