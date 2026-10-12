# COLIS N°7 — Klean Services

## Fichiers à téléverser sur GitHub

| N° | Fichier du colis | Dossier GitHub cible |
|---:|---|---|
| 1 | `db.js` | racine du dépôt |
| 2 | `server.js` | racine du dépôt |
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

Les autres fichiers du zip (`SPEC-MISE-A-JOUR-COLIS-7.md`, `test-update-7.js`, ce guide) sont de la documentation et des preuves de test : ils ne sont pas nécessaires au déploiement.

## Déploiement Render

1. Téléverser/remplacer les 12 fichiers ci-dessus, en gardant strictement les dossiers indiqués.
2. Committer les changements sur la branche de déploiement.
3. Attendre le redéploiement Render.
4. Sur un iPhone réel : fermer l’ancienne PWA si elle est installée, ouvrir le site dans Safari, puis recharger une fois. Tester le splash, une demande avec deux tâches, Contact Klean Services, une publicité ciblée et l’autorisation microphone.

Les migrations base de données sont additives et se lancent automatiquement au redémarrage : aucune action SQL manuelle n’est nécessaire.
