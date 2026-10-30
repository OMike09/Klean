# Manifest — COLIS 30

## Portée

Évolution additive et non destructive de Klean Services : Braderie géolocalisée par ville/commune, catégories et alertes réellement persistantes, conditions d’achat contrôlées au serveur, et recherche de service vocale sans conservation d’audio.

## Changements garantis

- Ville réelle d’une annonce indépendante de la ville d’inscription du vendeur, via le référentiel central Klean.
- Commune uniquement rattachée à Abidjan ; ville, commune et quartier affichés sur les annonces.
- Diffusions ville, nationale, Abidjan et commune, avec règles globales et restrictions par catégorie.
- Catégories et sous-références Braderie centralisées, actives, ordonnées, administrables et protégées contre la suppression si liées à l’historique.
- Alertes géographiques et catégorielles créées, suspendues, supprimées et notifiées par le serveur à la validation/réactivation des annonces.
- Conditions d’achat distinctes, acceptation hashée et exigée côté API avant une offre ou une demande de contact quand le PDG l’impose.
- Coordonnées vendeur réellement absentes de l’API publique en mode Klean Services.
- Microphone d’accueil, permission navigateur, enregistrement temporaire local, réécoute, annulation, limite PDG plafonnée à 25 secondes et texte éditable.
- Aucun audio de recherche vocale envoyé ou sauvegardé ; texte non conservé par défaut et soumis à autorisation PDG explicite.
- Analyse vocale reliée au dictionnaire central et aux villes/communes existants ; aucun vocabulaire parallèle.
- Parcours vocal vers le formulaire existant avec ordre guidé photo → lieu → adresse → GPS → description.
- Action visible « Rechercher l’adresse » retirée sans supprimer la géolocalisation des missions.

## Fichiers ajoutés

- `LIVRAISON-COLIS-30.md`
- `COLIS-30-MANIFEST.md`
- `test-colis30.js`
- `test-colis30-ui.js`

## Fichiers mis à jour

- `db.js`
- `server.js`
- `public/app.js`
- `public/admin/admin.js`
- `public/sw.js`
- `package.json`
- `package-lock.json`
- `test-colis29.js`
- `test-colis29-ui.js`

## Validation

- Régression API COLIS 29 : **31/31**.
- Régression UI COLIS 29 : **18/18**.
- API/base COLIS 30 : **25/25**.
- UI desktop et mobile COLIS 30 : **16/16**.

Aucune donnée de démonstration de production, aucun faux contact et aucun audio vocal persistant ne sont introduits par ce colis.
