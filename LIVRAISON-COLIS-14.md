# Klean Services — Livraison COLIS 14

**Mise à jour incrémentale** de l’application existante. Aucune fonction existante n’a été supprimée ; les nouveaux écrans utilisent les mêmes API, utilisateurs, services, villes, missions et notifications centralisés.

## Livré et réellement relié

### 1. Compte, À propos et partage
- Ajout dans **Mon compte** de **À propos de Klean Services** puis **Partager l’application**.
- Texte initial demandé intégré sous forme de paragraphes administrables.
- API publique de lecture : `GET /api/about`.
- Pour le **PDG uniquement**, dans **Règles & conditions**, juste après les conditions :
  - titre et paragraphes de brouillon ;
  - ajout, modification, suppression ;
  - aperçu ;
  - enregistrement brouillon ;
  - publication explicite.
- Le titre et le contenu publiés sont séparés du brouillon : aucun changement ne fuit dans l’application avant publication.
- Lien officiel et texte de partage configurables par le PDG.
- Partage natif `navigator.share` quand il est fourni par l’appareil ; sinon copie honnête du lien avec consigne de le coller dans le canal souhaité.

### 2. Mesure honnête des partages et règles de jeux
- `share_events` enregistre séparément : ouverture de l’action de partage, ouverture mesurée d’un lien d’invitation et inscription attribuée à ce lien.
- Une feuille de partage ouverte **n’est jamais présentée comme un envoi externe confirmé**.
- Les critères des jeux Quiz / Flip Fizz / Kdo sont désormais cumulables et contrôlés côté serveur :
  - type de compte ;
  - ouverture mesurable du lien ou inscription acquise ;
  - mission réalisée ou non réalisée.
- Le tableau PDG explique explicitement ces limites et permet les réglages.

### 3. Statistiques de fréquentation et confidentialité
- Nouvelle permission `frequentation` et écran **Statistiques de fréquentation** pour PDG et personnes autorisées.
- Périodes 7, 30 et 90 jours ; actifs jour/semaine/mois, clients/pros actifs, inscriptions, retours, villes et graphique quotidien.
- La liste récente distingue **actif au premier plan**, **arrière-plan** et **inactif**.
- L’activité est alimentée par interactions explicites (toucher, clavier, focus/visibilité), avec granularité limitée à une trace active toutes les 15 minutes ; aucun rafraîchissement automatique n’est compté comme activité humaine.
- Seuil « récemment actif » configurable (1 à 120 minutes).

### 4. Messages généraux ciblés
- L’ancien broadcast est conservé pour compatibilité, mais passe maintenant par le nouveau stockage historisé.
- Nouvel écran **Messages généraux** : brouillon, modification, suppression de brouillon, aperçu de ciblage, envoi immédiat, programmation, historique.
- Ciblage par comptes clients/pros et une ou plusieurs villes issues de la table centrale `villes`.
- Les livraisons ont une contrainte d’unicité : un même destinataire ne reçoit jamais deux fois le même message.
- L’historique annonce uniquement ce qui est réellement connu : notification enregistrée dans l’application et nombre lu ; il ne prétend pas confirmer une réception Push système.
- Les programmations sont reprises au démarrage et vérifiées toutes les 30 secondes par le serveur.

### 5. Compte professionnel et villes
- Conversion client → pro et validation exceptionnelle pro incomplète, avec contrôle serveur des permissions, identité minimale préservée, motif obligatoire, journal administratif et profil indisponible tant que les services ne sont pas autorisés.
- Une ville de service par défaut reste la règle.
- Une liste `service_cities` permet au PDG/administrateur d’autoriser plusieurs villes ou toutes les villes ; les gestionnaires ne peuvent pas outrepasser cette règle.
- Cette règle est utilisée dans le matching, les offres et la révocation des offres devenues inadmissibles.

### 6. Demande et cycle de prestation
- Demande par service : tâches propres au service, questions administrables, description, GPS facultatif/adresse libre, urgence et anti-doublon conservés.
- Ajout de la disponibilité : **dès que possible**, **aujourd’hui**, ou **date précise**.
- Limites configurables côté serveur : photos de demande (0 à 12) et vocal (1 à 20 secondes). Le client voit les limites, mais le serveur les vérifie aussi.
- Chronologie de prestation désormais mutuelle et auditée :
  1. pro demande le démarrage ;
  2. client confirme ou conteste ;
  3. pro demande la fin ;
  4. client confirme ou conteste ;
  5. paiement déclaré, puis confirmé par les deux parties.
- Les désaccords de fin ouvrent un litige et génèrent une alerte administration.

### 7. Alertes missions à intervalle rapproché
- Le seuil de rappel accepte maintenant **2 secondes**.
- À ce rythme, les rappels sont uniquement badge/son via l’application au premier plan (SSE).
- Les rappels rapprochés ne génèrent pas une rafale de Web Push : aucune promesse de sonnerie répétée en appareil verrouillé ou application en arrière-plan n’est faite, conformément aux limites Android/iOS.

## Migrations ajoutées
- `app_about` (brouillon/publication séparés, y compris titre) ;
- `share_events` ;
- `user_activity_events` et champs d’état d’activité utilisateur ;
- `general_messages` et `general_message_deliveries` ;
- villes de service pro autorisées ;
- statut de planification et confirmations de cycle de mission.

Les migrations sont idempotentes dans `db.js` et préservent les données existantes.

## Tests exécutés

1. `KLEAN_TEST_BASE=http://127.0.0.1:3000 npm run test:update10`
   - **57/57, 0 échec** lors de la vérification de régression (flux existants, dispatch, sécurité des fichiers, paiement, quiz).
   - La suite a été ajustée au nouveau cycle de confirmations mutuelles.

2. `KLEAN_TEST_BASE=http://127.0.0.1:3000 npm run test:update14`
   - **14/14, 0 échec**.
   - Vérifie publication différée À propos, partage mesuré et attribution d’inscription, activité, messages ciblés sans doublon, conversion pro exceptionnelle et réglages serveur.

## Configuration externe restant nécessaire
- **Web Push** : toujours conditionnel à `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` et à l’autorisation de l’appareil. Sans ces variables, les notifications dans l’application/SSE restent fonctionnelles, mais pas le Push système.
- Le partage natif dépend du navigateur/OS. L’application distingue volontairement « fenêtre de partage ouverte », « lien ouvert » et « inscription acquise ».
- Les alertes toutes les 2 secondes ne peuvent pas forcer une sonnerie persistante sur iPhone/Android verrouillé ; seul le premier plan est garanti par l’application web.
