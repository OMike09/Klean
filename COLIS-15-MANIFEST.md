# Manifest — COLIS N°15

Archives de livraison :
- `../klean-COLIS-15.zip` — paquet complet de code source ;
- `../klean-COLIS-15-ESSENTIEL.zip` — fichiers nécessaires au déploiement et à la validation ;
- `../klean-COLIS-15.sha256` et `../klean-COLIS-15-ESSENTIEL.sha256` — empreintes SHA-256.

## Correctif principal

- ville d’intervention professionnelle réellement sélectionnable depuis la liste centrale, avec autorisations supplémentaires strictement administratives ;
- migration des profils historiques vers `service_cities` ;
- planning pro couvrant les états du cycle de prestation ;
- critères de jeux et statistiques de partage mesurables ;
- périodes de fréquentation et aperçu des messages généraux ;
- test de livraison `test-update-15.js`.

Les archives excluent volontairement `node_modules`, les bases de données locales, les uploads opérationnels et les archives/stages historiques : ils ne doivent pas écraser les données lors d’un déploiement. Les dépendances sont déclarées dans `package.json` et verrouillées dans `package-lock.json`.
