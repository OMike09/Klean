# COLIS 22 — Manifest de modernisation

## Périmètre

Modernisation responsive, ergonomique et accessible de l’interface Klean Services. Aucune reconstruction applicative : le backend, les routes, les contrôles serveur et les fonctionnalités précédentes sont préservés.

## Fichiers créés

- `public/modern-ui.css` — couche moderne de l’application client.
- `public/admin/admin.css` — couche moderne responsive de l’administration.
- `test-update-22.js` — harnais de validation interface/PWA/stabilité.
- `LIVRAISON-COLIS-22.md` — rapport de livraison.
- `COLIS-22-MANIFEST.md` — présent manifest.

## Fichiers adaptés

- `public/index.html` — métadonnées mobile/description et chargement de `modern-ui.css`.
- `public/admin/index.html` — viewport sécurisé, thème mobile et chargement de `admin.css`.
- `public/app.js` — boutons de navigation explicitement typés et libellés ARIA.
- `public/admin/admin.js` — intitulé du menu de gestion catégories/tâches.
- `public/sw.js` — cache PWA `ks-v5-public-shell`, styles modernes inclus.
- `server.js` — vérification de présence des nouveaux fichiers d’interface.
- `package.json` — script `test:update22`.
- `test-update-19.js` — version de cache PWA actualisée.

## Garanties

- Couleurs de marque préservées.
- Prix rouge préservé.
- API relatives et contrôles côté serveur inchangés.
- Compatibilité téléphone Android/iPhone, tablette et ordinateur ajoutée par media queries.
- Cache limité à la coque publique ; données privées/API exclues.

## Validation

- `npm run test:update22` : **11/11**.
- Régressions COLIS 18, 19, 20 et 21 : réussies, résultats détaillés dans `LIVRAISON-COLIS-22.md`.
