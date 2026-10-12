# Manifest — COLIS N°10

Archive de livraison : `../klean-COLIS-10.zip`  
Archive complète de secours : `../klean-services-COMPLET-COLIS-10.zip`

Contenu fonctionnel principal :
- migrations et initialisation : `db.js`
- API, sécurité, dispatch, quiz, fichiers, Web Push : `server.js`
- persistance PostgreSQL : `persist.js`
- client : `public/app.js`, `public/styles.css`, `public/sw.js`
- dashboard : `public/admin/admin.js`
- tests de cette livraison : `test-update-10.js`
- rapport : `LIVRAISON-COLIS-10.md`

Les dépendances installées sont déclarées dans `package.json` / `package-lock.json`.
`node_modules`, fichiers de base de données locale, uploads opérationnels et archives historiques ne font pas partie du colis afin d’éviter d’écraser les données au déploiement.
