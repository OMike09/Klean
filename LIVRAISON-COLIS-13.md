# Klean Services — COLIS N°13

**Date :** 10 octobre 2026  
**Objet :** amélioration réelle des demandes, types de prestataires et alertes de mission.

## Résumé de livraison

Cette livraison prolonge le moteur de missions existant : aucune fonction en service n’a été supprimée. Les demandes restent indépendantes, le chat/paiement/quiz/fichiers existants sont conservés et la distribution a été renforcée côté base de données et backend.

## Fonctions livrées

### 1. Plusieurs demandes indépendantes

- Un client peut créer autant de demandes que nécessaire, pour des services différents.
- Chaque demande garde son propre identifiant, code, statut, prestataire, historique et suivi.
- L’écran **Mes demandes** conserve toutes les demandes et propose désormais explicitement **« + Nouvelle demande »**.
- L’anti-doublon est devenu un **avertissement souple** : une demande semblable récente affiche une confirmation, sans empêcher une nouvelle demande légitime et indépendante.

### 2. Choix client très simple

Après le clic sur **« Envoyer ma demande »**, une fenêtre conserve intégralement les informations saisies et ne présente que :

- **👤 Un particulier**
- **🏢 Une entreprise**

Le choix est enregistré dans `missions.provider_type` et ne peut jamais être contourné par le moteur de distribution.

Si la recherche n’aboutit pas, le client voit un message clair, peut choisir l’autre type sans perdre sa demande, puis relancer la recherche.

### 3. Admissibilité serveur particulière / entreprise

Le backend compare réellement avant une alerte puis une acceptation :

- type demandé par le client ;
- type du profil (`particulier` ou `entreprise`) ;
- service déclaré **et autorisé** ;
- compte approuvé, non suspendu et non bloqué ;
- disponibilité et absence de mission active ;
- ville/zone et distance GPS lorsqu’elles sont activées ;
- capacité de mission.

Les détails décrivant un gros travail (chantier, industriel, gros travaux, volume important, etc.) exigent une capacité renforcée. Un particulier standard ne peut donc pas recevoir cette demande. Une entreprise ou un particulier auquel la direction a explicitement accordé une capacité suffisante peut y être admissible.

Une nouvelle vérification est effectuée dans la transaction d’acceptation : une ancienne notification, un second appareil ou un profil devenu non admissible ne permettent pas de récupérer une mission.

### 4. Autorisations gérées depuis le dashboard

Dans **Utilisateurs → Fiche → Autorisations pro**, la direction peut, pour chaque professionnel validé :

- confirmer/changer le type de prestataire ;
- choisir les services effectivement autorisés parmi ceux déclarés ;
- définir une capacité `Standard`, `Renforcée / gros travaux` ou `Grande capacité`.

Ces autorisations sont enregistrées dans `pro_profiles.authorized_services` et `capacity_level`. Les offres qui ne correspondent plus sont retirées immédiatement.

### 5. Alertes et attribution

- Priorité distance GPS, puis visibilité facultative, avec repli ville/zone.
- Vagues configurables, rappels configurables, nombre maximal de rappels par offre et délai maximal de recherche.
- Aucun rappel infini : ils s’arrêtent au maximum défini, à l’expiration, à l’annulation ou à l’attribution.
- La première acceptation admissible est atomique ; les autres candidats reçoivent l’état « mission déjà attribuée ».
- Dès une acceptation, le professionnel passe à `en_mission`, ses autres offres sont retirées et il est exclu de toute nouvelle attribution.
- Une cloche visible dans l’espace professionnel affiche le nombre de demandes auxquelles le professionnel peut réellement répondre.

### 6. Sonnerie et Push

- Au premier plan, une nouvelle mission reçoit une sonnerie Klean Services à deux notes et une vibration, dans la limite des permissions du navigateur.
- Le Service Worker utilise une notification de mission persistante, une vibration et un tag par mission afin de remplacer proprement l’alerte lorsque l’état change.
- Le réglage PDG **Son d’alerte mission** est transmis côté serveur au Push et au client.
- Le clic sur la notification ouvre la mission concernée.

### 7. Paramètres des demandes et des alertes

Dans **Paramètres généraux → Paramètres des demandes et des alertes**, la direction peut régler :

- attribution automatique active/inactive ;
- priorité géographique active/inactive ;
- son des alertes ;
- activation des types particulier et entreprise ;
- délai de réponse par vague ;
- taille de la première vague et des suivantes ;
- fréquence et nombre maximal de rappels ;
- délai maximal d’une recherche.

Les paramètres sont stockés en base et une modification recalcule les recherches encore actives. Le dashboard présente aussi les recherches en cours, demandes sans réponse, professionnels disponibles et professionnels en mission.

## Migration DB additive

`db.js` ajoute sans supprimer de données :

- `missions.provider_type` ;
- `missions.capacity_required` ;
- `missions.search_started_at` et `missions.search_expires_at` ;
- `mission_candidates.reminder_count` ;
- `pro_profiles.authorized_services` et `pro_profiles.capacity_level` ;
- index de consultation `idx_missions_provider_status` ;
- nouveaux réglages de distribution.

Les profils existants reçoivent par défaut leurs services déjà déclarés comme services autorisés : aucune activité existante ne disparaît lors de la migration.

## Tests réellement exécutés

Validation sur une base neuve :

```bash
DATA_DIR=/tmp/klean-colis13 PORT=3100 node start.js
KLEAN_TEST_BASE=http://127.0.0.1:3100 npm run test:update10
```

**Résultat final : 57 / 57 réussis, 0 échec.**

Les contrôles ajoutés couvrent directement :

1. demandes indépendantes et avertissement de doublon confirmable ;
2. demande « particulier » inaccessible à une entreprise ;
3. demande « entreprise » proposée à l’entreprise autorisée ;
4. interface à deux choix vérifiée dans le client ;
5. rappel persistant de mission côté serveur ;
6. absence de prestataire et changement de type sans perte ;
7. attribution atomique ;
8. refus serveur d’un professionnel déjà en mission ;
9. refus d’une notification devenue obsolète après attribution ;
10. synchronisation des statuts client/pro/dashboard ;
11. arrêt/reprise de l’attribution automatique par le PDG et réintégration réelle dans la cloche des offres.

La suite conserve aussi les tests précédents : confidentialité des téléphones, verrou de conversation, quotas, paiement, médias, fichiers, options pro, prix, tri français et quiz synchronisé.

## Limites externes déclarées

- Le serveur et le Service Worker sont prêts pour le Web Push, mais le test a signalé que les clés `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` et `VAPID_SUBJECT` ne sont pas configurées dans cet environnement. Les Push réellement reçus avec l’application fermée ne sont donc **pas déclarés testés**.
- Une PWA ne peut pas forcer un son personnalisé en arrière-plan si Android, iOS ou le navigateur l’interdit. Le système utilise la notification, vibration et son système disponibles. La sonnerie à deux notes est vérifiable au premier plan ; le rendu arrière-plan dépend des permissions et de l’OS.
- Aucun appareil Android/iOS physique ni fournisseur Push/APNs configuré n’était disponible dans cet environnement. Un contrôle sur les appareils ciblés, après configuration VAPID/permissions, reste nécessaire avant de déclarer la réception mobile en arrière-plan validée.

## Fichiers principaux modifiés

- `db.js`
- `server.js`
- `public/app.js`
- `public/sw.js`
- `public/admin/admin.js`
- `test-update-10.js`
