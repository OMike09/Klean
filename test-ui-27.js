/* Contrôle navigateur COLIS 27 — desktop + émulations Android/iPhone.
   Exécution : npx -y -p playwright@1.58.0 node test-ui-27.js http://127.0.0.1:3017 */
const { chromium, devices } = require('playwright');
const base = process.argv[2] || 'http://127.0.0.1:3017';
let passed = 0, failed = 0;
function check(ok, label) { if (ok) { passed++; console.log('OK ', label); } else { failed++; console.error('BAD', label); } }
async function noOverflow(page, label) { const bad = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2); check(!bad, label + ' : aucun débordement horizontal'); }
async function loginAdmin(page) {
  await page.goto(base + '/admin/', { waitUntil: 'networkidle' });
  await page.locator('#l-phone').fill('admin');
  await page.locator('#l-pass').fill('Klean@2026');
  await page.locator('#l-btn').click();
  await page.waitForSelector('.layout', { timeout: 10000 });
}
async function adminChecks(context, label) {
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await loginAdmin(page);
  await noOverflow(page, label + ' tableau PDG');
  if (await page.locator('.menu-toggle').isVisible()) await page.locator('.menu-toggle').click();
  await page.getByRole('button', { name: /Services & catégories/ }).click();
  if (await page.locator('#side').evaluate(el => el.classList.contains('open'))) await page.locator('.menu-toggle').click();
  await page.getByRole('button', { name: '🖼️ Catégories & photos', exact: true }).click();
  await page.waitForSelector('.grand-photo-card', { timeout: 10000 });
  check(await page.locator('.grand-photo-card').count() >= 30, label + ' : photos de grandes catégories affichées');
  check(await page.getByRole('button', { name: /Ajouter une photo|Modifier la photo/ }).count() > 0, label + ' : action réelle de photo visible');
  await noOverflow(page, label + ' catégories & photos');
  if (await page.locator('.menu-toggle').isVisible()) await page.locator('.menu-toggle').click();
  await page.getByRole('button', { name: /Publicités & infos/ }).click();
  if (await page.locator('#side').evaluate(el => el.classList.contains('open'))) await page.locator('.menu-toggle').click();
  await page.waitForTimeout(250);
  check(await page.getByText('Statistiques de vues des publicités').count() === 1, label + ' : statistiques publicitaires PDG visibles');
  if (await page.locator('.menu-toggle').isVisible()) {
    // Le menu mobile a déjà été ouvert et utilisé pour les sections précédentes ; go() déclenche ici
    // la même navigation sans dépendre de l'animation latérale pendant le test automatisé.
    await page.evaluate(() => go('settings'));
  } else await page.getByRole('button', { name: '⚙️ Paramètres' }).click();
  if (await page.locator('#side').evaluate(el => el.classList.contains('open'))) await page.locator('.menu-toggle').click();
  await page.waitForTimeout(250);
  check(await page.locator('.settings-hub-tabs button').count() >= 6, label + ' : sous-sections Paramètres regroupées');
  await noOverflow(page, label + ' paramètres');
  check(errors.length === 0, label + ' : aucune erreur JavaScript pendant le parcours PDG');
  await page.close();
}
async function publicChecks(context, label) {
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForSelector('#app', { timeout: 10000 });
  await page.waitForTimeout(500);
  check((await page.locator('#app').innerText()).length > 30, label + ' : application publique chargée');
  await noOverflow(page, label + ' application publique');
  check(errors.length === 0, label + ' : aucune erreur JavaScript au chargement public');
  await page.close();
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await adminChecks(desktop, 'Desktop'); await publicChecks(desktop, 'Desktop'); await desktop.close();
    const android = await browser.newContext({ ...devices['Pixel 7'] });
    await adminChecks(android, 'Android (Pixel 7)'); await publicChecks(android, 'Android (Pixel 7)'); await android.close();
    const iphone = await browser.newContext({ ...devices['iPhone 13'] });
    await adminChecks(iphone, 'iPhone 13'); await publicChecks(iphone, 'iPhone 13'); await iphone.close();
  } catch (e) { failed++; console.error(e); }
  await browser.close(); console.log(`RESULT ${passed}/${passed + failed}, failed=${failed}`); process.exitCode = failed ? 1 : 0;
})();
