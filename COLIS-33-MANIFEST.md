# COLIS 33 — Manifest essentiel

Base de comparaison : COLIS 32.

| Fichier | Rôle dans le colis |
|---|---|
| `db.js` | Migrations additives Articles seconde main, favoris/vues/brouillons/alertes et fondations Klean Cabine. |
| `server.js` | API publiques, acheteur, vendeur, administration et verrouillage serveur Klean Cabine. |
| `public/app.js` | Accueil, vitrine Articles seconde main, espaces acheteur/vendeur, alertes, Klean Cabine et récapitulatif non exécutable. |
| `public/admin/admin.js` | Menu Articles seconde main et administration centralisée Gestion de Klean Cabine. |
| `package.json` | Scripts `test:colis33` et `test:colis33:ui`. |
| `test-colis29-ui.js` | Régression adaptée à la nouvelle appellation et à l’insertion de Klean Cabine. |
| `test-colis33.js` | Suite API 22 contrôles. |
| `test-colis33-ui.js` | Suite Playwright 9 contrôles. |
| `LIVRAISON-COLIS-33.md` | Notes de livraison, décision fournisseur/paiement et déploiement. |
| `COLIS-33-MANIFEST.md` | Inventaire du colis. |
| `PATCH-COLIS-33.diff` | Diff unifié applicable depuis la base COLIS 32 ; les nouveaux tests sont ajoutés. |

## Intégrité attendue

Après extraction, contrôler l’archive avec `unzip -tq`, puis comparer le SHA-256 inscrit dans le fichier compagnon `.sha256`.

## Point de conformité Klean Cabine

L’archive ne contient ni clé opérateur, ni clé de paiement, ni simulation de succès. Les routes d’exécution restent bloquées par le serveur tant qu’une intégration officielle n’est pas apportée.
