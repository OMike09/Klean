# Klean Services — COLIS 32 essentiel

Ce colis contient uniquement les fichiers applicatifs et tests nécessaires à l’évolution COLIS 32.

## Application du patch

1. Sauvegarder le projet Klean Services existant.
2. Copier les fichiers en conservant leur arborescence (`public/` inclus).
3. Installer les dépendances si nécessaire : `npm ci --no-audit --no-fund`.
4. Redémarrer l’application : `npm start` ou `node server.js` selon l’environnement.
5. Les migrations additives se jouent automatiquement au chargement de `db.js`.

## Validation

```bash
npm run test:colis32
npm run test:colis32:ui
npm run test:update29
npm run test:update29:ui
npm run test:update30
npm run test:update30:ui
npm run test:update31
npm run test:update31:ui
```

La documentation détaillée figure dans `LIVRAISON-COLIS-32.md` et l’inventaire dans `COLIS-32-MANIFEST.md`.
