// ============================================================
// KLEAN-SERVICES CI — Point d'entrée
// 1. Si PostgreSQL est configuré (DATABASE_URL), restaure la base
//    de données depuis la dernière sauvegarde avant de démarrer.
// 2. Démarre ensuite le serveur.
// ============================================================
const fs = require('fs');
const path = require('path');
const persist = require('./persist');

(async () => {
  try {
    const ok = await persist.init();
    if (ok) {
      const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
      const dbPath = path.join(DATA_DIR, 'klean.db');
      if (!fs.existsSync(dbPath)) {
        const restored = await persist.restoreDb(dbPath);
        if (!restored) console.log('🐘 Aucune sauvegarde trouvée : nouvelle base (première utilisation).');
      } else {
        console.log('🐘 Base locale déjà présente (disque persistant) : pas de restauration nécessaire.');
      }
    } else {
      console.log('ℹ️  DATABASE_URL non définie : fonctionnement sans sauvegarde PostgreSQL.');
    }
  } catch (e) {
    console.error('⚠️  PostgreSQL inaccessible (' + e.message + ') — démarrage sans sauvegarde.');
  }
  // Récupération (une seule fois) des comptes de l'ANCIENNE application (table klean_state)
  try { await require('./import-ancien').run(persist); }
  catch (e) { console.error('Import ancien impossible :', e.message); }
  require('./server');
})();
