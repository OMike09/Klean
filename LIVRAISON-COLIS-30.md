# Klean Services — LIVRAISON COLIS 30

**Date :** 30 octobre 2026  
**Objet :** Braderie géolocalisée, catégories et alertes ; recherche de services par voix respectueuse de la confidentialité.

## 1. Braderie : ville réelle, commune et diffusion

- Un vendeur choisit la **ville réelle de l’article** dans le référentiel central Klean, indépendamment de sa ville d’inscription.
- Lorsqu’il choisit Abidjan, il peut préciser une **commune rattachée à Abidjan** ou « toutes les communes / non précisée » selon le mode de diffusion.
- Le quartier reste un champ libre, soumis au réglage PDG.
- Les annonces affichent, lorsque disponible : **ville · commune · quartier**.
- Les quatre diffusions sont gérées et contrôlées côté serveur :
  - ville sélectionnée ;
  - Côte d’Ivoire entière ;
  - Abidjan uniquement ;
  - commune sélectionnée.
- Le PDG peut activer ou désactiver les modes globalement et, pour chaque catégorie, appliquer un ensemble plus restrictif de modes autorisés.
- Les anciens articles restent conservés : les colonnes `commune`, `category_id` et `visibility_mode` sont additives. La colonne historique `visibility` demeure compatible avec sa contrainte historique ville/national.

## 2. Catégories, villes et communes administrables

- Nouvelle table centrale `braderie_categories` avec catégories et sous-références : nom, description, icône, image URL, parent, ordre, activation et règles de diffusion.
- Chaque nouvel article exige une catégorie active ; les annonces historiques restent lisibles sans migration destructive.
- Le dashboard PDG permet de créer, modifier, activer/désactiver et supprimer une référence non liée.
- Une suppression est refusée si la catégorie est liée à des annonces ou à des sous-références : l’historique est préservé.
- Les suppressions de villes et communes sont également bloquées lorsqu’elles sont liées à l’historique Braderie ou aux alertes. La désactivation reste disponible.
- Les villes et communes continuent d’utiliser les sources centrales Klean : aucune liste parallèle côté client.

## 3. Alertes acheteurs et conditions d’achat

- Les utilisateurs connectés peuvent créer, modifier, suspendre ou supprimer une alerte « M’alerter lorsqu’un article est disponible ».
- Une alerte peut cibler une ville, tout le pays, Abidjan, une commune d’Abidjan et une ou plusieurs catégories.
- Lors de la première validation ou réactivation PDG d’une annonce, le serveur notifie exclusivement les comptes concernés ; le vendeur n’est pas notifié de sa propre annonce.
- Le PDG peut activer/suspendre le système d’alertes et consulter la liste des alertes.
- Les **conditions de publication** et les **conditions d’achat** sont distinctes dans le dashboard PDG.
- Lorsque le PDG l’exige, l’acheteur doit confirmer les conditions d’achat avant une offre ou une demande de contact. L’acceptation est hashée et historisée côté serveur.
- En mode « Contact via Klean Services », aucun téléphone ni lien vendeur n’est envoyé dans les réponses publiques/API. Cette confidentialité reste appliquée au serveur.

## 4. Recherche de services par voix

- Le microphone est intégré à la grande recherche de l’accueil sans supprimer la recherche écrite.
- Le navigateur enregistre localement, avec permission explicite, puis propose démarrage, arrêt, annulation et réécoute.
- L’arrêt est imposé à la durée PDG, plafonnée techniquement à **25 secondes**.
- L’audio n’est ni transmis ni conservé par le serveur.
- Lorsque la reconnaissance native du navigateur est disponible, le texte reconnu est éditable avant validation. En cas de refus de permission ou d’incompatibilité, un message clair invite à utiliser la recherche écrite.
- L’API analyse le texte avec le dictionnaire central existant — métiers, grandes catégories, prestations, tâches, synonymes et localités — sans créer de vocabulaire parallèle.
- Vérifications réalisées : plomberie/robinet, nettoyage/canapé, électricité/courant, mécanicien à Bouaké, jardinier à Cocody.
- La demande issue de la voix ouvre le formulaire existant avec les éléments fiables préremplis. Pour ce parcours, l’ordre visible est : **photo → ville/commune/quartier → adresse précise → GPS avec permission → description**.
- Une adresse ou une position GPS n’est jamais déduite de la voix. La carte n’est proposée qu’après une position GPS réellement accordée par l’utilisateur.
- L’ancienne action visible « Rechercher l’adresse » est retirée. Les fonctions GPS nécessaires aux missions sont conservées.
- Le texte de transcription n’est pas conservé par défaut. Le PDG doit explicitement autoriser cette conservation ; l’audio reste toujours exclu.

## 5. Dashboard PDG

### Braderie d’articles

- Activation, visibilité accueil, limites, photos, contact, quartier et durées.
- Modes de diffusion globaux et règles de diffusion par catégorie.
- Conditions de publication et conditions d’achat séparées.
- Gestion des catégories/sous-références, alertes, annonces, contacts, signalements et statistiques.

### Recherche vocale

- Activation/suspension du module.
- Visibilité du microphone sur l’accueil.
- Durée maximale entre 1 et 25 secondes.
- Réglage explicite de la conservation du texte.
- Statistiques par résultat et liste des recherches incertaines ou non reconnues.
- Les enrichissements linguistiques utilisent le dictionnaire de recherche central déjà administrable.

## 6. Sécurité et persistance

Nouvelles tables :

- `braderie_categories`
- `braderie_alerts`
- `braderie_purchase_acknowledgements`
- `voice_search_events`

Toutes les restrictions sensibles sont vérifiées par l’API et la base : catégories actives, villes/communes, modes de diffusion, conditions d’achat, alertes, quotas existants, confidentialité des coordonnées et limite vocale.

Le service worker public passe en cache `ks-v9-public-shell` afin que la coque COLIS 30 soit renouvelée après déploiement.

## 7. Fichiers principaux

- `db.js` — migration additive COLIS 30 et réglages initiaux.
- `server.js` — API Braderie, alertes, conditions d’achat, catégories, géographie, analyse vocale et gouvernance PDG.
- `public/app.js` — Braderie publique, publication, alertes, parcours vocal et formulaire guidé.
- `public/admin/admin.js` — réglages PDG Braderie et recherche vocale.
- `public/sw.js` — version de cache renouvelée.
- `package.json` / `package-lock.json` — tests Playwright reproductibles.
- `test-colis30.js` / `test-colis30-ui.js` — contrôles COLIS 30.
- `test-colis29.js` / `test-colis29-ui.js` — adaptés au contrat COLIS 30 sans perdre leurs contrôles précédents.

## 8. Vérifications exécutées

Sur `http://127.0.0.1:3000` :

1. `npm run test:update29` : **31/31**.
2. `npm run test:update29:ui` : **18/18**.
3. `npm run test:update30` : **25/25**.
4. `npm run test:update30:ui` : **16/16**.
5. Vérification syntaxique : `db.js`, `server.js`, `public/app.js`, `public/admin/admin.js` et les quatre scripts de tests.

Les tests créent et suppriment leurs comptes, annonces, médias, alertes et paramètres de contrôle. Aucune donnée de démonstration métier n’est livrée.

## 9. Mise en service Render

Après déploiement :

1. Laisser l’application démarrer une fois afin d’exécuter la migration additive.
2. Se connecter en PDG.
3. Ouvrir **Contenu → 🏷️ Braderie d’articles** pour activer la Braderie, régler les diffusions, les conditions et les catégories.
4. Ouvrir **Contenu → 🎤 Recherche vocale** pour activer le microphone, fixer la durée et choisir la confidentialité du texte.
5. Pour exécuter les contrôles navigateur en environnement CI/local : `npx playwright install chromium`, puis `npm run test:update30:ui`.
