# COLIS N°8 — Logo fourni par le client

Ce colis est **cumulatif** : il contient toutes les mises à jour du COLIS 7, avec le logo image fourni le 8 octobre 2026.

## Fichiers de déploiement

| N° | Fichier | Dossier GitHub cible |
|---:|---|---|
| 1 | `db.js` | racine |
| 2 | `server.js` | racine |
| 3 | `public/app.js` | `public/` |
| 4 | `public/styles.css` | `public/` |
| 5 | `public/index.html` | `public/` |
| 6 | `public/manifest.json` | `public/` |
| 7 | `public/sw.js` | `public/` |
| 8 | `public/logo.png` | `public/` |
| 9 | `public/icon-192.png` | `public/` |
| 10 | `public/icon-512.png` | `public/` |
| 11 | `public/icon.svg` | `public/` |
| 12 | `public/admin/admin.js` | `public/admin/` |

## Logo appliqué

- `public/logo.png` : symbole goutte verte provenant de l’image fournie.
- Les mots « KLEAN » visibles dans la capture n’ont pas été dupliqués dans le fichier du logo : l’application affiche déjà le nom **Klean Services** sous le symbole sur l’écran de lancement et dans ses en-têtes.
- `icon-192.png` et `icon-512.png` ont été régénérés à partir du même symbole pour iPhone et l’installation PWA.

Après le déploiement, ouvrir l’application dans Safari iPhone et recharger une fois afin que le Service Worker `ks-v3` récupère les nouveaux visuels.
