# Manifest — COLIS N°19

Archives de livraison :

- `../klean-COLIS-19.zip` — code source complet, sans données opérationnelles ;
- `../klean-COLIS-19-ESSENTIEL.zip` — serveur, client, PWA, dashboard, tests et rapport ;
- `../klean-COLIS-19.sha256` et `../klean-COLIS-19-ESSENTIEL.sha256` — empreintes SHA-256.

## Contenu fonctionnel

- accès public sécurisé au catalogue et aux contenus de découverte ;
- protection serveur maintenue sur toutes les écritures et données privées ;
- masquage anonyme des coordonnées d’offres, profils et avis ;
- rubrique Compte visiteur avec création de compte et connexion ;
- reprise d’une demande de prestation après authentification ;
- bouton d’installation PWA réel, comportement Android/desktop, instructions iPhone/iPad et disparition après `appinstalled` ;
- manifeste PWA complété et cache réduit à la coque publique sans API, uploads ni données sensibles ;
- test de livraison : `test-update-19.js`.

Les archives excluent intentionnellement `node_modules`, les bases SQLite locales, les uploads opérationnels, les stages et les archives historiques. Elles ne doivent pas écraser les données de production Render.
