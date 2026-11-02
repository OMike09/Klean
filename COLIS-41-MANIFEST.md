# COLIS 41 ESSENTIEL — Réorganisation centrale du catalogue

Date de préparation : 2 novembre 2026.

## Choisir le patch

| Base de départ | Fichier à appliquer |
|---|---|
| COLIS 40 | `PATCH-COLIS-40-A-41-INCREMENTAL.diff` |
| COLIS 37 | `PATCH-COLIS-37-A-41-CUMULATIF.diff` (COLIS 38 à 41 inclus) |

Le patch cumulatif concatène le correctif cumulatif COLIS 37→40 validé et le diff COLIS41. Il ne faut pas appliquer les deux patchs.

## Contenu fonctionnel

- `db.js` : migration idempotente COLIS41, audit de reclassement, sauvegarde des historiques, protection définitive des anciennes racines et seed cohérent.
- `seed-metiers.js` : taxonomie initiale désormais canonique ; aucun transit par Nettoyage pour la vidange, ni mélange coiffure homme/femme, cours/formation/coaching.
- `server.js` : API à source unique, chemins incluant les sous-catégories, contrôles de racines retirées et événement SSE `catalogue`.
- `public/app.js` : invalidation du cache catalogue à l’événement SSE et affichage des chemins de sous-catégories.
- `public/admin/admin.js` : structure centrale administrable, droits pro par sous-catégorie et revue des profils historiques.
- `test-colis41-catalogue.js` : contrôle de base fraîche, API, recherche, création direction, SSE, candidature/validation/matching pro, rôles équipe et interfaces navigateur.

## Installation

```bash
patch -p1 --dry-run < PATCH-COLIS-40-A-41-INCREMENTAL.diff
patch -p1 < PATCH-COLIS-40-A-41-INCREMENTAL.diff
npm ci
npm run test:colis41
```

Redémarrer ensuite le service. La migration est exécutée automatiquement au démarrage, sans supprimer les demandes, missions, factures, évaluations ou historiques. Les prix restent indicatifs et administrables côté Klean Services.

## Vérification livrée

- `npm run test:colis41` : **39/39**.
- `npm run test:colis40` : **27/27** (régression).
- Analyse finale : racines historiques inactives, 0 compte/missions temporaires, 0 profil pointant vers une sous-catégorie inactive.
