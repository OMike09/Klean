# Klean Services — Livraison COLIS 25

**Date :** 25 octobre 2026  
**Objet :** cartes catégories illustrées, références tarifaires traçables, localisation professionnelle et réattribution sécurisée.

## Évolutions livrées

### 1. Cartes de grandes catégories

- Les cartes de l’accueil sont désormais illustrées, plus hautes et plus lisibles.
- Le cadrage emploie `object-fit: cover`, sans déformation ; le texte et le prix restent superposés sur un dégradé contrasté.
- La grille est ajustée pour téléphone, tablette et ordinateur, avec protections contre les textes longs et les débordements.
- Cinq visuels photo locaux optimisés sont fournis pour les catégories mises en avant : nettoyage, plomberie, climatisation, électricité et beauté ; un visuel vectoriel local est également fourni pour agriculture et élevage.
- Le PDG peut définir une URL/chemin d’image ou **téléverser une image** dans l’éditeur de grande catégorie. Une image téléversée n’est rendue publique que lorsqu’elle est effectivement reliée à une grande catégorie active ; les médias privés de missions restent protégés.
- Le cache PWA est renouvelé en `ks-v8-public-shell`.

### 2. Tarifs publics par petite tâche

- Sous une tâche, le parcours catégorie affiche `À partir de X FCFA`, en rouge `#dc2626`, avec l’unité/condition lorsque celle-ci existe (par exemple « par climatiseur » ou « hors pièce »).
- Aucun montant n’est affiché sans provenance publique exploitable : note de source, URL HTTPS, date de source, date de vérification, prix positif et règle active sont nécessaires côté serveur.
- Les prix publiés initialement concernent uniquement des tâches pour lesquelles une référence ivoirienne traçable a été enregistrée (climatisation/plomberie à Abidjan). Les autres tâches restent sans montant public, sans texte trompeur « Prix à confirmer » dans ce parcours.
- Le PDG peut créer, corriger, désactiver et publier une règle depuis le tableau de bord, y compris son URL, sa date et l’unité/condition publique. Les règles internes sans URL publique servent aux estimations si nécessaire, mais ne sont jamais présentées comme prix public vérifié.

### 3. Ville, adresse et GPS

- Le formulaire de demande conserve ville et adresse/quartier libre ; le client peut ajouter son GPS.
- Une action volontaire « Rechercher l’adresse » permet le géocodage via OpenStreetMap. L’adresse n’est envoyée à ce fournisseur qu’après ce clic ; si le service est indisponible ou imprécis, la demande demeure possible avec ville/adresse ou GPS.
- Le classement de dispatch conserve les contrôles serveur : professionnel validé, non suspendu, réellement disponible et sans mission active ; même ville d’abord, proximité GPS ensuite, puis zones de repli explicitement localisées.
- Le professionnel dispose de **Ma zone d’intervention** : ville autorisée, quartiers/zone libre, ajout, mise à jour ou suppression volontaire de son GPS. Les villes additionnelles/toutes les villes restent une autorisation d’administration contrôlée côté serveur.

### 4. Itinéraire professionnel

- Après affectation, le professionnel voit **Itinéraire vers le client**.
- La mission est relue au serveur avant ouverture : destination GPS du client si consentie, sinon adresse/ville.
- L’origine privilégie le GPS courant du professionnel ; en cas de refus, sa position de service enregistrée est utilisée si disponible, sinon Google Maps choisit l’origine.
- Aucune coordonnée ni téléphone du professionnel n’est dévoilé au client.

### 5. Réattribution PDG avec intégrité historique

- Le tableau de bord propose recherche et filtrage de candidats compatibles/disponibles par nom, métier, ville et zone.
- La réattribution exige un motif ; les missions déjà commencées, terminées ou liées à un paiement demandent une confirmation renforcée.
- Une mission payée ou avec un paiement validé est bloquée : aucune affectation financière ou historique n’est réécrite.
- Chaque réattribution crée un enregistrement immuable dans `mission_reassignments` et un événement de mission (ancien professionnel, nouveau professionnel, acteur, motif, état précédent, horodatage).
- Les notifications client / ancien pro / nouveau pro sont envoyées ; l’ancien pro est libéré uniquement lorsqu’il n’a plus de mission active et le nouveau devient indisponible en mission.
- Les routes sont protégées au serveur : PDG systématiquement autorisé ; un autre membre doit posséder explicitement `reassign_missions`, en plus de son accès d’administration.

## Fichiers principaux

| Fichier | Rôle |
|---|---|
| `db.js` | migration non destructive COLIS 25 : image catégorie, GPS/service pro, unité tarifaire publique, table/index d’historique et références seedées |
| `server.js` | filtre strict des prix publics, géocodage explicitement consenti, dispatch géographique, contrôle médias de cartes, lieu pro et routes de réattribution |
| `public/app.js` | cartes illustrées, prix par tâche, adresse/GPS, zone pro et itinéraire Google Maps |
| `public/category-cards.css` | rendu responsive des cartes illustrées |
| `public/category-request.css` | prix de tâche rouge et unité/condition |
| `public/admin/admin.js` | téléversement/édition image catégorie, unité tarifaire, UI de réattribution |
| `public/index.html`, `public/sw.js` | chargement de la feuille cartes et cache PWA v8 |
| `test-update-25.js` | scénario E2E dédié COLIS 25 |

## Validation

Sur base SQLite neuve et serveur isolé :

- **COLIS 25 : 13/13** — migration, provenance prix, image locale et image téléversée publiée, GPS/ville, permissions, réattribution simple, mission sensible et verrou après paiement validé.
- Régressions finales : COLIS 10 **57/57**, COLIS 21 **21/21**, COLIS 22 **11/11**, COLIS 23 **9/9**, COLIS 24 **5/5**.
- La suite historique complémentaire a aussi été exécutée sur base neuve : COLIS 14/15 **16/16**, COLIS 16 **10/10**, COLIS 17 **17/17**, COLIS 18 **10/10**, COLIS 19 **9/9**, COLIS 20 **23/23**.

Commandes utiles :

```bash
DATA_DIR=/tmp/klean-colis25-data PORT=3125 node server.js
KLEAN_TEST_BASE=http://127.0.0.1:3125 npm run test:update25
```

Les migrations s’exécutent au démarrage et conservent les données existantes. Avant le déploiement Render, sauvegarder la base persistante, déployer ce colis, puis contrôler le catalogue et les paramètres du PDG avec un compte réel.
