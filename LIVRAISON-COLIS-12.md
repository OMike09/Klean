# Klean Services — COLIS N°12

**Date :** 10 octobre 2026  
**Objet :** audit global demandé, compléments fonctionnels et vérification sur environnement propre.

## Causes constatées et corrections appliquées

| Sujet | Cause / risque traité | Correction réellement appliquée |
|---|---|---|
| Prix accueil | Valeurs potentiellement conservées par cache et absence de trace de mise à jour | `price_updated_at`, API `/api` en `no-store`, lecture DB actualisée, prix rouge « Dès … FCFA », visibilité `price_show` appliquée au client. |
| Coordonnées | Le masquage interface seul aurait laissé les données récupérables | `missionFull()` ne sérialise jamais le téléphone pro vers le client. Le téléphone client n’est renvoyé qu’au pro effectivement attribué ou aux administrateurs autorisés. |
| Attribution | Risque de choix direct, double acceptation et disponibilité seulement visuelle | Choix direct désactivé, vagues d’offres, transaction atomique, états pro persistants et libération à la fin/annulation. |
| Alerte mission | Une seule alerte pouvait être manquée | Rappels serveur configurables. Ils alimentent badge/SSE/son et Web Push lorsque VAPID est configuré ; arrêt automatique dès retrait, refus, annulation ou acceptation. |
| Conversations | Quotas ou fermeture limités au front-end | Quotas et durée audio vérifiés côté serveur, verrou automatique après paiement réellement validé, plus verrou manuel dashboard par mission. |
| Tri | `sort/id` ou SQLite NOCASE ne garantissait pas le classement français | Collateur `Intl.Collator('fr', { sensitivity: 'base' })` sur catégories, services, sous-catégories, tâches et villes pour les listes où aucun ordre prioritaire n’est requis. Les listes prioritaires (missions, populaires, urgences) gardent leur ordre métier. |
| Quiz | Statut d’un mauvais répondant pas assez explicite dans le suivi | QCM unique synchronisé, élimination écrite immédiatement en DB, spectateur sans droit de réponse, compteurs inscrits/en lice/spectateurs distincts. |
| Fichiers | Suppression d’affichage et destruction réelle devaient être distinguées | États `active/hidden/archived/recovery/purged`, récupération, purge binaire locale/PostgreSQL, confirmation explicite, refus si fichier nécessaire à une mission active ou en litige, ZIP autorisé avec progression. |
| Splash | Le chargement réseau pouvait dépasser l’animation | Sortie programmée à 3 000 ms indépendamment du réseau, puis rafraîchissement si la session finit de s’hydrater après. |

## Fonctions disponibles

### Prix, client et professionnel
- Prix enregistrés en DB et synchronisés vers l’accueil sans ancien cache API.
- Affichage conditionnel de `Dès [prix] FCFA`, rouge, seulement si le service est visible.
- Dispatch automatique par service, ville/zone, disponibilité, distance GPS disponible et priorité de visibilité facultative.
- Première vague, vagues suivantes, délai d’offre et délai de rappel configurables au dashboard.
- Acceptation concurrente protégée atomiquement.
- États pro : `disponible`, `alerte`, `en_mission`, `indisponible`, `suspendu`.

### Messagerie et paiement
- Textes, images et vocaux limités séparément par partie et par mission.
- Durée réelle des audios lue côté serveur ; défaut : 20 secondes.
- Suspension PDG des vocaux/images ; verrou manuel d’une conversation depuis Missions.
- Verrou définitif du chat normal dès paiement validé côté serveur ; support séparé conservé.

### Quiz
- Questions QCM à quatre réponses, réponse correcte administrée, chronologie serveur, pause/reprise, fin et réinitialisation confirmée.
- Un mauvais répondant devient immédiatement `elimine`, voit la suite en spectateur et ne peut pas envoyer de réponse ultérieure.
- Classement auto : score décroissant, puis temps cumulé croissant ; désignation manuelle des finalistes/gagnants disponible.
- Réinitialisation : archive avant effacement des participants/réponses/vues de la nouvelle session.
- Quiz actif affiché directement sur l’accueil avec chronomètre synchronisé et compteurs.

### Options et fichiers
- Options pro dynamiques avec cible, catégories, ordre, état actif/suspendu et contrôle serveur.
- Gestion PDG de fichiers, recherche, états, restauration, récupération, ZIP de sélection/tout, progression de réception et purge effective protégée.

## Base de données et migrations additives

Les migrations non destructives sont exécutées au démarrage dans `db.js`. Elles ajoutent notamment :
- états de disponibilité et verrou de conversation ;
- colonnes de chronologie Quiz ;
- prix mis à jour ;
- `pro_account_options`, `pro_option_usage` ;
- `file_records`, `push_subscriptions`, `quiz_views`, `quiz_archives` ;
- réglages de dispatch, rappels, chat et récupération fichiers.

Aucune suppression de table ou remise à zéro des données de production n’est exécutée par ces migrations.

## Tests réellement exécutés

Exécution sur une base SQLite totalement neuve, hors données de production :

```bash
DATA_DIR=/tmp/klean-colis12 PORT=3100 node start.js
KLEAN_TEST_BASE=http://127.0.0.1:3100 npm run test:update10
```

**Résultat : 41 / 41 réussis, 0 échec.**

Le test couvre :
- splash 3 s, tri français de catégories, prix, visibilité prix et no-cache ;
- demande, offre, rappel persistant, acceptation atomique, disponibilité ;
- confidentialité API des téléphones ;
- verrou admin et verrou paiement du chat, quota texte, WAV de 21 s refusé ;
- médias privés, média publicitaire public, récupération, ZIP et purge réelle ;
- option pro inactive refusée côté serveur ;
- quiz synchronisé, élimination immédiate, spectateur bloqué à la question suivante, pause/reprise/archive.

Contrôles de syntaxe exécutés : `server.js`, `db.js`, `persist.js`, `public/app.js`, `public/admin/admin.js`, `public/sw.js`, `test-update-10.js`.

## Limites et configuration externe à connaître

- **Web Push hors premier plan :** le code, les souscriptions et le service worker sont prêts, mais l’envoi réel requiert `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` et `VAPID_SUBJECT` sur Render, ainsi que l’autorisation navigateur de l’utilisateur. Le comportement sonore dépend ensuite des règles iOS/Android/navigateur ; il n’est pas possible de le forcer lorsque le système l’interdit.
- **Paiement externe :** le cycle espèces/double confirmation serveur est testé. Aucun fournisseur Mobile Money/SMS réel n’est configuré dans cet environnement ; il ne serait pas honnête de le déclarer validé.
- **Départage Quiz :** l’automatique score + temps et le choix manuel existent. Une question supplémentaire de départage dédiée n’est pas encore implémentée comme flux distinct ; elle doit être ajoutée avant de déclarer cette variante précise testée.
- **Tests visuels multi-appareils :** les règles responsive/safe areas et la temporisation splash sont vérifiées par code ; un contrôle manuel sur plusieurs appareils physiques reste recommandé avant production.

## Fichiers principaux modifiés

- `db.js`
- `server.js`
- `persist.js`
- `public/app.js`
- `public/styles.css`
- `public/sw.js`
- `public/admin/admin.js`
- `public/admin/index.html`
- `package.json`, `package-lock.json`
- `test-update-10.js`
