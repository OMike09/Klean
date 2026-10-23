# Manifest — COLIS N°16

Archives de livraison :

- `../klean-COLIS-16.zip` — code source complet, sans données opérationnelles ;
- `../klean-COLIS-16-ESSENTIEL.zip` — serveur, base, client, dashboard, tests et rapport ;
- `../klean-COLIS-16.sha256` et `../klean-COLIS-16-ESSENTIEL.sha256` — empreintes SHA-256.

## Contenu fonctionnel

- migration non destructive des grandes catégories, domaines professionnels, dictionnaire de recherche et règles d’estimation ;
- recherche instantanée normalisée, expressions familières éditables et tolérance aux fautes proches ;
- inscription professionnelle par grandes catégories et validation administrative des changements de domaines ;
- moteur serveur d’estimation par tâche et ville, règles PDG et repli transparent ;
- formulaire universel (texte libre, 3 photos maximum, vocal 25 secondes maximum) ;
- test de livraison : `test-update-16.js`.

Les archives excluent intentionnellement `node_modules`, bases SQLite locales, uploads opérationnels, stages et archives historiques. Ces éléments ne doivent jamais écraser les données lors du déploiement Render. Les dépendances restent déclarées dans `package.json` et verrouillées dans `package-lock.json`.
