# LIVRAISON — COLIS 33
## Articles seconde main & Klean Cabine

Date : 30 octobre 2026

## Objet

Ce colis met directement à niveau l’application existante sans reconstruire ni supprimer les comptes, annonces, abonnements, transactions, négociations, historiques ou routes Braderie existants.

## 1. Articles seconde main

### Appellation et parcours

- L’entrée publique de l’accueil est désormais **« Articles seconde main »** et mène à `#/articles-seconde-main`.
- L’ancienne route `#/braderie` reste compatible et affiche la nouvelle vitrine. L’ancien lien de publication public redirige vers `Compte → Mon espace braderie`.
- L’entrée Compte reste **exactement** intitulée **« Mon espace braderie »**, sous « Mon espace professionnel / Devenir professionnel ».
- Klean Cabine apparaît directement sous Articles seconde main sur l’accueil.

### Vitrine publique et détail

- Vitrine découverte séparée des actions vendeurs : recherche par mot-clé, catégorie, ville, commune, quartier, prix, état, période et tri (récent, populaire, prix).
- Bouton de réinitialisation des filtres, rubriques récent / à la une / plus consulté quand les données existent.
- Les cartes affichent média, titre, prix FCFA, catégorie, localité, état et la fiche détail affiche toutes les photos/vidéos, date, informations complémentaires, vendeur protégé, conditions et similaires.
- Les articles non `available` ne sont pas proposés comme disponibles.
- Les actions acheteur sont : proposition, demande de contact selon les règles existantes, favori, partage et signalement. Les actions nécessitant une session préservent le retour vers l’élément demandé.

### Espaces acheteur et vendeur

- **Mon espace acheteur** : favoris persistants, consultations récentes connectées, négociations/propositions, signalements et alertes.
- Alertes enrichies : mot-clé ou catégories, zone, prix, état, canaux in-app/web-push, activation/suspension/suppression et modification. Les livraisons sont dédupliquées par alerte et article dans `braderie_alert_deliveries`.
- **Mon espace vendeur**, ses formules, paiements confirmés, quotas et publication restent les mécanismes serveur COLIS 32. Aucun raccourci de publication n’est exposé sur la vitrine publique.
- Brouillons persistants, privés et sans quota ajoutés à l’espace vendeur. Ils ne deviennent jamais automatiquement des publications.
- Les champs administratifs complémentaires (`extra_info`, mise à la une) sont additifs ; les données historiques ne sont pas supprimées.

### Administration

- Le menu d’administration est renommé **Articles seconde main** tout en conservant la rubrique centralisée existante, ses catégories, annonces, modération, espaces, formules, paiements, quotas, contacts, négociations, signalements, alertes et statistiques.

## 2. Klean Cabine — fondation contrôlée sans paiement ni exécution

### Ce qui existe réellement

- Raccourci accueil, vitrine `#/klean-cabine`, préparation d’un transfert/forfait, vérification serveur des numéros et des opérateurs configurés, et récapitulatif.
- Compte : **« Mes opérations Klean Cabine »** avec historique réel (vide tant qu’aucun prestataire n’est intégré).
- Administration PDG : paramètres, MTN/Orange/Moov de référence sans catalogue inventé, catégories, offres, prix/frais/conditions/visibilité, modèles de notification, audit et statistiques.
- Tables persistantes : opérateurs, services, offres, opérations, modèles de notification et audit.

### Verrouillage de sûreté obligatoire

- `POST /api/cabine/operations` répond **503 `PROVIDER_NOT_CONNECTED`** et ne crée aucune opération, transaction ou débit.
- Aucun écran ne revendique un paiement, une exécution, un transfert de crédit ou un achat de forfait réussi.
- Les prix, validités et offres sont vides par défaut ; seuls des éléments administrés peuvent être affichés comme catalogue, toujours marqués indisponibles.
- Même une tentative administrative d’activer `cabine_payment_enabled` est forcée à `false` côté serveur.
- L’activation future exige une intégration officielle vérifiée d’opérateur/agrégateur et de paiement, non fournie dans ce colis.

## 3. Migrations additives

`db.js` crée si nécessaire :

- `braderie_favorites`, `braderie_item_views`, `braderie_drafts`, `braderie_alert_deliveries` ;
- colonnes enrichies sur `braderie_alerts` et `braderie_items` ;
- `cabine_operators`, `cabine_services`, `cabine_offers`, `cabine_operations`, `cabine_notification_templates`, `cabine_audit` ;
- paramètres Klean Cabine initialisés sans paiement actif.

Aucune table, annonce, compte, abonnement ou historique existant n’est supprimé par la migration.

## 4. Contrôles exécutés

- COLIS 33 API : **22/22**.
- COLIS 33 UI Playwright : **9/9**.
- COLIS 32 API/UI : **22/22**, **9/9**.
- COLIS 29 API/UI : **31/31**, **18/18**.
- COLIS 30 API/UI : **25/25**, **16/16**.
- COLIS 31 API/UI : **16/16**, **10/10**.
- Vérification syntaxique : `server.js`, `db.js`, application, administration et suites COLIS 33.
- Nettoyage final : aucun utilisateur, espace, formule, abonnement, article, offre ou opération de fixture COLIS 29 à 33 ; `braderie_enabled=0` restauré.

## 5. Déploiement

1. Décompresser le colis à la racine du projet existant en conservant les fichiers non livrés.
2. Installer les dépendances de production : `npm ci --no-audit --no-fund`.
3. Démarrer l’application avec le mécanisme existant (`node server.js` ou `npm start`).
4. Les migrations additives s’exécutent automatiquement au chargement de `db.js`.
5. Ne pas activer ni brancher de paiement Klean Cabine avant réception des identifiants, contrats et API officielles vérifiées.
