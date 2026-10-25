# Manifest — COLIS 25

## Portée

Évolution non destructive de Klean Services : modernisation des cartes de grandes catégories, tarifs publics traçables par tâche, localisation ville/adresse/GPS, itinéraire professionnel et réattribution sécurisée par le PDG.

## Changements fonctionnels

- Cartes de grandes catégories illustrées, plus lisibles, responsives et branchées uniquement sur les grandes catégories actives de la base.
- Visuels locaux pour cinq catégories ; image de catégorie administrable par URL/chemin ou téléversement PDG.
- Prix rouge par tâche, publié seulement avec une référence publique complète : URL HTTPS, note, date de source, date de vérification et valeur positive.
- Unité/condition publique administrable depuis les règles tarifaires.
- Références initiales limitées aux tâches dont la provenance ivoirienne a été documentée ; absence de montant plutôt qu’un tarif inventé.
- Recherche d’adresse OpenStreetMap explicite et consentie, avec repli conservant l’adresse/ville ou le GPS.
- Ville, zone libre et GPS professionnel réellement enregistrés ; contrôles d’autorisation de ville côté serveur.
- Itinéraire Google Maps réservé au professionnel affecté, destination client GPS/adresse et origine GPS courant/enregistré avec repli.
- Table `mission_reassignments`, événement immuable, candidats compatibles, confirmations renforcées et notifications de réattribution.
- Blocage de toute réattribution dès qu’un paiement est validé ou que la mission est payée.
- Permission serveur dédiée `reassign_missions` ; elle n’est pas incluse par défaut dans le rôle administrateur.
- Cache PWA renouvelé en `ks-v8-public-shell`.

## Garanties conservées

- Architecture Express, routes existantes, authentification et source centrale de catalogue préservées.
- Les contrôles de disponibilité, permission, affectation, confidentialité et paiement sont tous côté serveur.
- Les téléphones professionnels ne sont jamais exposés au client.
- Une image téléversée reste privée tant qu’elle n’est pas explicitement rattachée à une catégorie active ; les médias de mission ne deviennent pas publics.
- Les affectations précédentes, événements, offres et paiements ne sont pas supprimés pendant une réattribution.
- Les tâches ne deviennent jamais des cartes autonomes de l’accueil.

## Fichiers ajoutés

- `public/category-cards.css`
- `public/category-images/nettoyage.jpg`
- `public/category-images/plomberie.jpg`
- `public/category-images/climatisation.jpg`
- `public/category-images/electricite.jpg`
- `public/category-images/beaute.jpg`
- `public/category-images/agriculture.svg`
- `test-update-25.js`
- `LIVRAISON-COLIS-25.md`
- `COLIS-25-MANIFEST.md`

## Fichiers mis à jour

- `db.js`
- `server.js`
- `package.json`
- `public/index.html`
- `public/sw.js`
- `public/app.js`
- `public/category-request.css`
- `public/admin/admin.js`
- `test-update-19.js`
- `test-update-21.js`
- `test-update-22.js`
- `test-update-23.js`
- `test-update-24.js`

## Validation

- COLIS 25 : **13/13** sur base neuve.
- Régressions : COLIS 10 **57/57**, 14/15 **16/16**, 16 **10/10**, 17 **17/17**, 18 **10/10**, 19 **9/9**, 20 **23/23**, 21 **21/21**, 22 **11/11**, 23 **9/9**, 24 **5/5**.
