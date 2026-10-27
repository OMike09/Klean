# COLIS 28 — Intégration des images de catégories Klean Services

## Objet

Les 30 images HD validées de Klean Services sont désormais intégrées à l’application et associées aux 30 grandes catégories actives.

## Source de vérité et synchronisation

- Une photo principale est enregistrée dans `grand_categories.image_url` pour **chaque identifiant unique de grande catégorie**.
- Les 30 JPEG sont inclus dans `public/category-images/`.
- L’accueil, la liste « Voir tous les services » et le tableau de bord PDG lisent cette même valeur `image_url` : aucune liste parallèle de noms de fichiers n’est utilisée dans l’interface.
- La migration de démarrage ne remplace que les anciennes images système ou les valeurs vides. Une photo explicitement remplacée par le PDG (`/uploads/...` ou URL HTTPS) est conservée.

## Tableau de bord PDG

Dans **Services & catégories → Catégories & photos**, le PDG peut :

1. voir les 30 photos principales ;
2. téléverser et publier une nouvelle image ;
3. remplacer l’image existante ;
4. retirer l’association de la photo ;
5. constater l’état de publication sur chaque carte.

Les actions d’association, de remplacement et de retrait sont contrôlées côté serveur par `pdgOnly` et inscrites dans le journal d’administration. Une image téléversée n’est publique que lorsqu’elle est réellement associée à une grande catégorie active.

## Catalogue

- Aucun doublon exact n’a été trouvé parmi les grandes catégories actives, les métiers d’une même grande catégorie ou les sous-catégories d’un même métier.
- Aucune catégorie, prestation, compétence professionnelle, mission, prix ou historique n’a été supprimé.
- Les catégories aux noms proches ne sont pas fusionnées automatiquement.

## Vérifications réalisées

- `test-category-images.js` : **8/8**
  - 30 grandes catégories actives ;
  - 30 associations identifiant → JPEG ;
  - 30 fichiers JPEG HTTP 200 ;
  - identité des URL entre cartes d’accueil et source centrale ;
  - import, remplacement, retrait et restauration par le PDG ;
  - journal serveur.
- `test-category-images-ui.js` : **33/33**
  - tableau PDG, accueil et liste complète des catégories ;
  - Desktop, Android Pixel 7 et iPhone 13 ;
  - chargement des photos, absence de débordement horizontal et absence d’erreur JavaScript.

## Fichiers principaux

- `public/category-images/01-nettoyage-et-entretien.jpg` à `30-immobilier-et-conciergerie.jpg`
- `db.js` — migration d’associations par identifiant
- `server.js` — contrôle PDG et journalisation des changements de photos
- `public/admin/admin.js` — galerie PDG et téléversement/remplacement/retrait
- `public/app.js` et `public/category-cards.css` — affichage public synchronisé
- `test-category-images.js`
- `test-category-images-ui.js`
