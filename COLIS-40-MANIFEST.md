# COLIS 40 ESSENTIEL — Cumulatif COLIS 38, 39 et 40

Ce colis autonome inclut le **COLIS 38** (centre universel de fonctionnalités), le **COLIS 39** (publication de publicité) et le **COLIS 40** (contacts publicitaires, logo progressif et recherche épurée).

## Choisir le patch

| Votre base | Patch à appliquer |
|---|---|
| Code au COLIS 37 | `PATCH-COLIS-37-A-40-CUMULATIF.diff` — recommandé ; installe COLIS 38 + 39 + 40 en une fois. |
| Code déjà au COLIS 39 | `PATCH-COLIS-39-A-40.diff` — correctifs COLIS 40 seulement. |

Les patchs antérieurs `PATCH-COLIS-38.diff` et `PATCH-COLIS-38-A-39.diff` sont inclus pour traçabilité. Ne les appliquez pas après le patch cumulatif.

## Sources essentielles

- `db.js` — migrations additives, y compris les coordonnées privées de publicité et la marque versionnée.
- `server.js` — règles de visibilité serveur, formatage de numéros, API publiques/PDG et logo versionné.
- `public/app.js`, `public/index.html`, `public/styles.css`, `public/sw.js` — boutons de contact, démarrage animé, préchargement, PWA et barre de recherche épurée.
- `public/admin/admin.js` — configuration par publicité, politique PDG et publication du logo officiel.
- `test-colis38-*.js`, `test-colis39-busy.js`, `test-colis40-contacts-logo-search.js` — régressions.

## Application directe depuis COLIS 37

```bash
patch -p1 --dry-run < PATCH-COLIS-37-A-40-CUMULATIF.diff
patch -p1 < PATCH-COLIS-37-A-40-CUMULATIF.diff
npm run test:colis38
npm run test:colis38:ui
npm run test:colis39
npm run test:colis40
```

Redémarrez ensuite le service. Les migrations sont additives et les publicités existantes restent préservées.
