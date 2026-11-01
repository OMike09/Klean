# COLIS 39 ESSENTIEL — Cumulatif COLIS 38 + correctif publication

Ce colis est **autonome et cumulatif** : il comprend tout le COLIS 38 (centre universel de gestion des fonctionnalités) et le correctif COLIS 39 qui répare le bouton de publication des publicités.

## Utiliser le bon patch

| État de votre code | Patch à appliquer |
|---|---|
| Vous êtes au **COLIS 37** | `PATCH-COLIS-37-A-39-CUMULATIF.diff` — recommandé, applique COLIS 38 et COLIS 39 en une seule fois. |
| Vous avez déjà appliqué le **COLIS 38** | `PATCH-COLIS-38-A-39.diff` — applique seulement le correctif publication. |

`PATCH-COLIS-38.diff` est inclus pour la traçabilité du contenu livré dans le COLIS 38 ; ne l’appliquez pas après le patch cumulatif.

## Sources incluses

| Élément | Objet |
|---|---|
| `db.js` | Migration additive du registre de fonctionnalités COLIS 38. |
| `server.js` | Catalogue, permission, API et protections serveur COLIS 38. |
| `public/app.js` | Flags publics, routes et synchronisation COLIS 38. |
| `public/admin/admin.js` | Centre PDG COLIS 38 **et** fonction `busy()` réparée COLIS 39. |
| `package.json` | Commandes de test COLIS 38 et COLIS 39. |
| `test-colis38-features.js` | Tests API/sécurité du centre de fonctionnalités. |
| `test-colis38-ui.js` | Tests interface bureau, Android et iPhone. |
| `test-colis39-busy.js` | Régression du bouton Publier sans créer de publicité. |

## Installation depuis COLIS 37

```bash
patch -p1 --dry-run < PATCH-COLIS-37-A-39-CUMULATIF.diff
patch -p1 < PATCH-COLIS-37-A-39-CUMULATIF.diff
npm run test:colis38
npm run test:colis38:ui
npm run test:colis39
```

Redémarrez ensuite le service : la migration COLIS 38 est additive et ne reconstruit aucune table métier. `SHA256SUMS.txt` contient les empreintes de contrôle du colis.
