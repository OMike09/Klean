# Manifest — COLIS 26

## Portée

Organisation du catalogue Klean Services en 30 grandes catégories professionnelles actives, avec un nom complet et un libellé court pour l’affichage mobile.

## Changements

- Ajout de `grand_categories.short_label`, administrable uniquement par le PDG.
- Les cartes accueil, la liste des catégories et l’en-tête de demande utilisent le libellé court sans troncature.
- Passage de 20 à 30 grandes catégories actives, toutes rattachées à au moins une prestation centrale réelle.
- Ferronnerie, solaire, électroménager, vitrerie, imprimerie, audiovisuel, toiture, eau/forage, entretien auto et immobilier sont désormais des domaines visibles.
- Réorganisation sans duplication des métiers déjà présents : les identifiants de services, tâches et missions sont conservés.
- Ajout ciblé de services réels pour les domaines auparavant absents : groupes électrogènes, signalétique, toiture/étanchéité, pompage/traitement d’eau et conciergerie immobilière.
- Préservation des autorisations de domaines professionnelles lors des séparations de catégories.
- Désactivation contrôlée de la racine historique `Autres services` lorsqu’elle est remplacée par `Artisanat et réparations diverses`, afin de garder exactement 30 catégories actives.

## Garanties

- Pas de carte autonome pour une tâche ; seules les grandes catégories actives alimentent l’accueil et « Voir tous les services ».
- Pas de données de démonstration : chaque nouvelle catégorie est rattachée à des prestations/tâches réelles du catalogue central.
- Prix, disponibilité, matching, permissions et historiques restent contrôlés au serveur.
- Le dashboard conserve l’édition sécurisée des catégories, des images et des libellés.

## Fichiers ajoutés

- `test-update-26.js`
- `LIVRAISON-COLIS-26.md`
- `COLIS-26-MANIFEST.md`

## Fichiers mis à jour

- `db.js`
- `server.js`
- `public/app.js`
- `public/admin/admin.js`
- `public/admin/index.html`
- `public/admin/admin.css`
- `package.json`
- `test-update-23.js`
- `test-update-24.js`

## Validation

- COLIS 26 : **7/7**.
- Régressions COLIS 10 à 25 : toutes réussies sur base neuve, notamment COLIS 10 **57/57**, COLIS 21 **21/21** et COLIS 25 **13/13**.

---

## Complément photos et recherche familière

### Fichiers mis à jour

- `db.js` — table centrale `search_dictionary_entries`, reprise non destructive du dictionnaire historique et expressions familières éditables.
- `server.js` — recherche classée/contextuelle, demande de précision, CRUD PDG multi-niveaux, contrôle serveur de la photo publiée.
- `public/app.js` — recherche de besoin dans les descriptions, suggestions à confirmer, alias dans le sélecteur de tâches et prise en charge du texte transcrit.
- `public/admin/admin.js` — cycle complet d’image de catégorie (aperçu, préparation, import, remplacement, retrait, publication) et éditeur du dictionnaire à cinq niveaux.
- `package.json` — script `test:update26:complement`.
- `test-update-26-complement.js` — contrôle E2E dédié (8/8).
- `LIVRAISON-COLIS-26.md` — procédure PDG et garanties de livraison.

### Garanties supplémentaires

- Aucune image IA générée n’est reliée au produit ni intégrée à cette archive ; seules les fonctions de gestion sont livrées.
- Une photo de catégorie est rendue publique uniquement lorsqu’elle est effectivement associée à une catégorie active. Les autres fichiers restent soumis aux règles existantes.
- Les destinations du dictionnaire sont des identifiants du catalogue réel, non des textes libres ni une seconde liste de services.
- Les suggestions n’écrasent pas la décision utilisateur : plusieurs pistes sont classées et les formulations vagues reçoivent une demande de précision.

### Validation complémentaire

- Recherche et photos : **8/8**.
- Régressions COLIS 10, 14–26 : réussies sur base neuve.
