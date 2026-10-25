# Manifest — COLIS 24

## Portée

Correction ciblée de l’affichage du sélecteur de besoins de la page unique de catégorie.

## Changements fonctionnels

- Suppression du menu natif « catégorie — prestation » qui répétait le nom de la grande catégorie.
- Affichage direct des tâches dans un panneau compact.
- Regroupement visuel uniquement par prestation.
- Recherche et sélection conservées.
- Sélection multiple conservée sous la règle serveur d’une seule prestation par demande.
- Cache PWA renouvelé en `ks-v7-public-shell`.

## Garanties conservées

- Le nom de la grande catégorie est rendu une seule fois dans l’en-tête vert.
- Toutes les tâches viennent du catalogue central et restent inchangées.
- Le parcours réel `POST /api/missions`, les contrôles serveur, le brouillon et l’authentification tardive sont conservés.
- Aucun prix, contact ou comportement métier n’est simulé côté interface.

## Fichiers

Ajoutés :
- `test-update-24.js`
- `LIVRAISON-COLIS-24.md`
- `COLIS-24-MANIFEST.md`

Mis à jour :
- `public/app.js`
- `public/category-request.css`
- `public/sw.js`
- `package.json`
- `test-update-19.js`
- `test-update-22.js`
- `test-update-23.js`
