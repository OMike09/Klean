# Klean Services — COLIS N°10

**Date :** 9 octobre 2026  
**Nature :** mise à jour additive complète (backend, base SQLite, application client, tableau de bord et tests). Aucune fonction hors périmètre n’a été retirée volontairement.

## Éléments livrés

### Prix et synchronisation
- Les services continuent d’être lus depuis SQLite ; la mise à jour PDG actualise aussi `services.price_updated_at`.
- Toute réponse `/api/*` est servie avec `Cache-Control: no-store, no-cache, must-revalidate, private`.
- Le client affiche les prix de départ en rouge `#dc2626`, au format **« Dès [prix] FCFA »**.
- Le test vérifie une modification PDG immédiatement visible via l’API, sans cache HTTP obsolète.

### Confidentialité et mission automatique
- Le client ne reçoit jamais le téléphone du professionnel dans le détail de mission.
- Le téléphone du client n’est transmis qu’au professionnel effectivement attribué, après acceptation.
- Les administrateurs autorisés conservent la vue de gestion.
- La sélection directe `/choisir/:proId` est définitivement désactivée (410).
- Attribution par vagues paramétrables : compatibilité service, ville/zone, disponibilité persistée, coordonnées disponibles et priorité de visibilité facultative.
- L’acceptation est transactionnelle : un seul professionnel peut gagner une mission.
- Le professionnel passe à `en_mission` / indisponible à l’acceptation et revient disponible à la terminaison ou annulation.
- Tableau de bord PDG : délai, taille première vague et taille des vagues suivantes configurables.

### Paiement, conversation et quotas
- À la validation de paiement par les deux parties, la mission passe à `payee`, un verrou de conversation horodaté est inscrit et les messages normaux sont refusés côté serveur.
- Les conversations annulées ou en litige sont également en lecture seule ; le support Klean Services reste séparé.
- Limites appliquées côté serveur : nombre de textes, images, activation/suspension images et vocaux, durée réelle des audios contrôlée avec `music-metadata` (20 s par défaut, réglable).
- Le client affiche les compteurs, des messages prédéfinis et un enregistrement vocal avec arrêt automatique/chronomètre.

### Médias et fichiers
- Les uploads privés passent par contrôle d’autorisation ; seule une image d’une publicité active peut être obtenue anonymement.
- Les médias privés sont chargés avec un jeton via `mediaUrl()` dans le client et le dashboard.
- Registre `file_records` : propriétaire, MIME, taille, état (`active`, `hidden`, `archived`, `recovery`, `purged`) et dates de cycle de vie.
- Dashboard sécurité : gestion par état, restauration, sélection de fichiers, ZIP de la sélection ou de tous les fichiers disponibles, avec progression réelle de réception lors du téléchargement.
- « À supprimer » déclenche une période de récupération paramétrable ; la purge supprime réellement le binaire local et PostgreSQL si ce stockage est activé.

### Options professionnelles
- Table `pro_account_options` et usages `pro_option_usage`.
- Écran PDG exclusif : CRUD, clé technique, description, cible particulier/entreprise/tous, catégories autorisées, ordre, caractère obligatoire, activation/suspension.
- Écran professionnel : seules les options actives et compatibles avec son profil/catégories sont affichées.
- Toute tentative d’utilisation d’une option inactive, suspendue ou non applicable est refusée par le serveur.

### Quiz unifié et synchronisé
- Le QCM autonome est désormais fusionné dans les sessions Quiz synchronisées : aucune partie parallèle hors session.
- Chronologie basée sur l’heure serveur, révélé de réponse entre questions, élimination et mode spectateur côté serveur.
- Compteurs distincts participants / spectateurs actifs, mise à jour de vues dans `quiz_views`.
- Commandes dashboard : lancer, pause, reprendre, arrêter, désigner les gagnants, demander le consentement photo et messagerie gagnant.
- Réinitialisation uniquement sur confirmation serveur : une archive immuable est créée dans `quiz_archives` avant nettoyage des réponses/participants.

### Splash et notifications
- Splash vert plein écran avec logo sans « CI », texte « Klean Services » et slogan demandé ; temporisation configurée à **3 000 ms**.
- Web Push réel préparé : souscriptions en base, service worker `push` / clic notification, UI d’autorisation navigateur et émission lors des notifications internes.

## Tests exécutés

Commande exécutée sur une instance temporaire neuve :

```bash
DATA_DIR=/tmp/klean-final PORT=3100 node start.js
KLEAN_TEST_BASE=http://127.0.0.1:3100 npm run test:update10
```

**Résultat : 33 / 33 réussis, 0 échec.**

Le script `test-update-10.js` couvre :
- splash 3 s (contrôle de configuration), prix DB/no-cache ;
- inscription, validation pro, dispatch automatique, acceptation atomique, disponibilité ;
- confidentialité des téléphones et désactivation du choix direct ;
- quota texte, rejet d’un WAV de 21 s, verrou du chat après paiement ;
- accès upload anonyme/tiers/publicité active ;
- récupération fichier et ZIP de sélection ;
- CRUD/refus serveur d’option pro inactive ;
- lancement quiz, compteurs, pause/reprise et archive lors de la réinitialisation confirmée.

Les contrôles de syntaxe ont aussi réussi pour `server.js`, `db.js`, `persist.js`, `public/app.js`, `public/admin/admin.js` et `public/sw.js`.

## Configuration Render / externe restante

Les composants Web Push sont codés et testables, mais un envoi vers un vrai téléphone n’est pas déclaré vérifié sans :

```text
VAPID_PUBLIC_KEY=<clé publique VAPID>
VAPID_PRIVATE_KEY=<clé privée VAPID>
VAPID_SUBJECT=mailto:contact@votre-domaine.tld
```

1. Générer les clés une fois, par exemple avec `npx web-push generate-vapid-keys`.
2. Ajouter ces trois variables dans Render, puis redéployer.
3. L’utilisateur doit cliquer sur « Notifications sur cet appareil » et accepter la permission navigateur.
4. Pour conserver SQLite et les fichiers entre redéploiements, garder `DATABASE_URL` configurée (stockage PostgreSQL déjà pris en charge par `persist.js`).

Les tests ci-dessus ont volontairement utilisé une base SQLite neuve locale et n’ont pas envoyé de notification à un fournisseur Push réel ni à une API SMS.

## Fichiers principaux modifiés

- `db.js`
- `server.js`
- `persist.js`
- `public/app.js`
- `public/admin/admin.js`
- `public/styles.css`
- `public/sw.js`
- `package.json`, `package-lock.json`
- `test-update-10.js`
