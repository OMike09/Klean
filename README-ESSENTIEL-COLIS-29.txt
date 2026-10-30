KLEAN SERVICES — COLIS 29 ESSENTIEL

Ce fichier est un PATCH à appliquer sur une installation complète déjà issue du COLIS 28.
Il ne contient pas la base SQLite, les uploads ni les 30 JPEG de catégories, car ces éléments
sont déjà présents dans le COLIS 28 complet et ne doivent pas être écrasés avec des données de démonstration.

Fichiers à remplacer en conservant les chemins inclus :
- db.js
- server.js
- package.json / package-lock.json
- public/app.js
- public/admin/admin.js

Le patch contient aussi :
- LIVRAISON-COLIS-29.md
- test-colis29.js
- test-colis29-ui.js

Après extraction dans la racine du projet existant :
1. npm ci --no-audit --no-fund
2. Redémarrer l’application (la migration SQLite COLIS 29 est automatique au démarrage).
3. Pour vérifier :
   KLEAN_TEST_BASE=http://127.0.0.1:PORT npm run test:update29

Le COLIS 29 complet doit être utilisé si le destinataire ne possède pas déjà le COLIS 28 complet.
