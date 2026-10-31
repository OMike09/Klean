# Manifeste — COLIS 34 essentiel

## Fichiers d’application
- `db.js` — migration additive des codes provisoires et réglages Klean Kbine.
- `server.js` — authentification par code provisoire, gestion sécurisée d’accès, récapitulatifs Kbine et recherche d’offres sans exécution.
- `public/app.js` — formulaires et parcours public Kbine, confirmation de mot de passe, conservation du défilement.
- `public/admin/admin.js` — gestion des codes provisoires, échéances et réglages Kbine centralisés.
- `package.json` — commandes de validation COLIS 34.

## Tests inclus
- `test-colis34.js` — 16 contrôles API avec création et nettoyage de données de test.
- `test-colis34-ui.js` — 24 contrôles Playwright sur Bureau, Android et iPhone.
- `test-colis29-ui.js` — libellé Kbine mis à jour dans la régression d’ordre des raccourcis.
- `test-colis33.js` — récapitulatif Kbine mis à jour pour confirmation bénéficiaire et frais centralisés.
- `test-colis33-ui.js` — parcours Kbine sécurisé mis à jour.

## Documents d’intégrité
- `LIVRAISON-COLIS-34.md` — contenu, sécurité, tests et procédure de mise en service.
- `PATCH-COLIS-34.diff` — patch unifié COLIS 33 → COLIS 34.
- `COLIS-34-MANIFEST.md` — présent manifeste.

Les dépendances générées (`node_modules`), les caches, données de test et fichiers de travail temporaires ne font pas partie du colis.
