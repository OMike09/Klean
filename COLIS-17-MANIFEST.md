# Manifest — COLIS N°17

Archives de livraison :

- `../klean-COLIS-17.zip` — code source complet, sans données opérationnelles ;
- `../klean-COLIS-17-ESSENTIEL.zip` — serveur, migrations, client, dashboard, tests et rapport ;
- `../klean-COLIS-17.sha256` et `../klean-COLIS-17-ESSENTIEL.sha256` — empreintes SHA-256.

## Contenu fonctionnel

- splash officiel réellement plein écran, responsive et temporisé à trois secondes ;
- accueil allégé avec services populaires, accès au catalogue unique A–Z et trois cartes fonctionnelles ;
- parcours réel des offres « Trouver ou proposer un job », en parallèle des profils candidats historiques ;
- catégories d’avis de recherche, publication/filtre/signalement/modération ;
- configuration administrable et vérifiée des urgences, sans faux contact ;
- migrations non destructives `job_offers`, `search_notice_categories` et compléments d’avis ;
- test de livraison : `test-update-17.js`.

Les archives excluent intentionnellement `node_modules`, les bases SQLite locales, les uploads opérationnels, les stages et les archives historiques. Elles ne doivent pas écraser les données de production lors du déploiement Render. Les dépendances restent déclarées dans `package.json` et verrouillées dans `package-lock.json`.
