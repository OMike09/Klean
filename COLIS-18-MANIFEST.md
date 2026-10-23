# Manifest — COLIS N°18

Archives de livraison :

- `../klean-COLIS-18.zip` — code source complet, sans données opérationnelles ;
- `../klean-COLIS-18-ESSENTIEL.zip` — serveur, client, dashboard, tests et rapport ;
- `../klean-COLIS-18.sha256` et `../klean-COLIS-18-ESSENTIEL.sha256` — empreintes SHA-256.

## Contenu fonctionnel

- gestion centralisée de l’historique client, retour par flèche, navigateur et Android ;
- balayage tactile vers l’arrière depuis le bord gauche, sans conflit avec défilement, formulaires, boutons, médias ou zones horizontales ;
- confirmation des modifications non enregistrées, protection des opérations d’écriture en cours ;
- historique, bouton Retour, confirmation et geste compatible dans le tableau de bord PDG/admin ;
- test ciblé de navigation : `test-update-18.js` ;
- toutes les fonctions COLIS 17 et antérieures préservées.

Les archives excluent intentionnellement `node_modules`, les bases SQLite locales, les uploads opérationnels, les stages et les archives historiques. Elles ne doivent pas écraser les données de production lors du déploiement Render.
