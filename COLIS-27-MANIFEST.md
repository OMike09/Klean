# Manifest — COLIS 27

## Portée

Évolution non destructive de Klean Services : administration PDG des photos de grandes catégories, compétences professionnelles par sous-catégorie, nettoyage exact et audité du catalogue, analytique publicitaire persistante et hub unique « Paramètres ».

## Changements garantis

- Photo de catégorie liée uniquement à `grand_categories.id`, importable depuis mobile/ordinateur, prévisualisée, confirmée lors d’un remplacement, retirable sans effacer de données métier.
- Écran PDG visible de gestion des photos, avec propagation par l’API centrale sur les cartes applicatives.
- Tables `pro_profile_catalogue_reviews`, `catalogue_merge_audit` et `ad_view_events` persistantes.
- Dédoublonnage limité aux égalités de noms certaines normalisées ; références services/tâches/prix/missions/profils/options préservées et auditables.
- Sélection pro hiérarchique grande catégorie → sous-catégories à l’inscription et en modification ; autorisation côté serveur et matching filtré.
- Migration prudente des anciens profils : uniquement les correspondances service → sous-catégorie certaines ; les autres cas reviennent au PDG.
- Statistiques publicitaires : total, uniques, liste connectée autorisée et agrégat anonyme respectueux de la confidentialité.
- Une entrée principale « Paramètres » avec sous-sections application/comptes, catégories, notifications, publicités, commercial, prix et sécurité.

## Fichiers ajoutés

- `LIVRAISON-COLIS-27.md`
- `COLIS-27-MANIFEST.md`
- `test-update-27.js`
- `test-ui-27.js`

## Fichiers mis à jour

- `db.js`
- `server.js`
- `public/app.js`
- `public/styles.css`
- `public/admin/admin.js`
- `public/admin/index.html`
- `public/admin/admin.css`
- `package.json`

## Validation

- COLIS 27 API/base : **10/10**.
- COLIS 26 catalogue : **7/7**.
- COLIS 26 photo/recherche : **8/8**.
- Contrôle navigateur desktop, Pixel 7 et iPhone 13 : **33/33**.

Aucune image IA et aucune donnée de démonstration de production ne sont introduites par ce colis.
