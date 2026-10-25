/* Vérifications COLIS 22 — modernisation responsive et stabilité des interfaces. */
const fs = require('fs');
const BASE = process.env.KLEAN_TEST_BASE || 'http://127.0.0.1:3000';
let n = 0, fail = 0;
function yes(ok, label) { n++; if (ok) console.log('OK ', label); else { fail++; console.error('BAD', label); } }
async function get(path) { const r = await fetch(BASE + path); return { r, text: await r.text() }; }
(async () => { try {
  const [home, modern, admin, adminCss, sw] = await Promise.all([
    get('/'), get('/modern-ui.css'), get('/admin/'), get('/admin/admin.css'), get('/sw.js')
  ]);
  yes(home.r.status === 200 && home.text.includes('/styles.css') && home.text.includes('/modern-ui.css'), 'la coque client charge les styles historiques et la couche moderne');
  yes(modern.r.status === 200 && modern.text.includes('linear-gradient(135deg,#0b7a6b') && modern.text.includes('prefers-reduced-motion') && modern.text.includes('var(--safe-b)'), 'la couche client conserve l’identité Klean et gère accessibilité, animations et encoches');
  yes(modern.text.includes('@media (min-width:700px)') && modern.text.includes('@media (max-width:380px)') && modern.text.includes('.bottomnav'), 'les mises en page téléphone, tablette et ordinateur sont explicitement couvertes');
  yes(modern.text.includes('.menu-item>div') && modern.text.includes('overflow-wrap:anywhere') && modern.text.includes('overflow-x:hidden'), 'les textes longs et débordements horizontaux sont protégés');
  yes(admin.r.status === 200 && admin.text.includes('/admin/admin.css') && adminCss.r.status === 200 && adminCss.text.includes('@media(max-width:520px)'), 'le dashboard charge sa modernisation et son adaptation mobile');
  yes(sw.r.status === 200 && sw.text.includes("ks-v5-public-shell") && sw.text.includes("'/modern-ui.css'") && sw.text.includes("url.pathname.startsWith('/api/')"), 'le cache PWA est renouvelé sans mettre en cache les données privées');

  const app = fs.readFileSync('public/app.js', 'utf8');
  const appCss = fs.readFileSync('public/styles.css', 'utf8');
  const adminJs = fs.readFileSync('public/admin/admin.js', 'utf8');
  yes(app.includes('type="button" class="back-btn"') && app.includes('aria-label="Voir les notifications"') && app.includes('aria-label="${lb}"'), 'les actions de navigation principales possèdent des boutons explicites et des libellés accessibles');
  yes(app.includes("fetch('/api' + path") && !app.includes('fetch(\'http://localhost'), 'le client utilise des appels relatifs compatibles avec Render et les aperçus');
  yes(appCss.includes('.estimate-box:empty{display:none}') && app.includes('navStack') && app.includes('showLeaveConfirm'), 'l’interface garde les estimations discrètes, la navigation fluide et la protection des brouillons');
  yes(adminJs.includes('Gestion des catégories et des tâches') && adminJs.includes('adminBack()') && adminJs.includes('adminArmDraft'), 'le dashboard moderne conserve ses retours et la protection des modifications non enregistrées');

  const categories = await fetch(BASE + '/api/grand-categories').then(r => r.json());
  const detail = categories[0] ? await fetch(BASE + '/api/grand-categories/' + categories[0].id + '/catalogue').then(r => r.json()) : null;
  yes(Array.isArray(categories) && categories.length > 0 && detail && Array.isArray(detail.categories), 'les écrans modernisés restent branchés au catalogue réel et navigable');
  console.log(`RESULT ${n - fail}/${n}, failed=${fail}`); process.exitCode = fail ? 1 : 0;
} catch (e) { console.error(e); process.exitCode = 1; } })();
