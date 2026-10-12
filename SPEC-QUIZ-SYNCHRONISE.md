# Spécification technique — Quiz synchronisé sur l'écran d'accueil

## 1. Principe
Une session de quiz devient une **série synchronisée** : toutes les personnes connectées voient
LA MÊME question AU MÊME MOMENT, directement sur l'écran d'accueil, sans aucun clic.
Le déroulé est **déterministe** : il se calcule à partir de l'heure de lancement (`started_ms`),
du temps par question (`time_per_q`) et de l'intervalle entre les quiz (`interval_s`).

```
Cycle C = time_per_q + interval_s   (en secondes)
écoulé  = maintenant - started_ms
index   = écoulé / C                (question en cours)
phase   = « question »  si (écoulé % C) <  time_per_q
          « pause »     si (écoulé % C) >= time_per_q   (décompte avant le prochain quiz)
fin     = quand la dernière question est fermée (pas de pause après la dernière)
```
Aucune tâche de fond n'est nécessaire : serveur et clients recalculent la phase à chaque
requête → synchronisation garantie, rafraîchissement/reconnexion sans triche possible.

## 2. Règles côté serveur (toutes re-vérifiées serveur)
- **Réponse unique** : index UNIQUE `(session_id, user_id, question_id)` + contrôle applicatif.
  Toute seconde tentative → 400 « réponse verrouillée ».
- **Fenêtre de réponse** : une réponse n'est acceptée que si la phase calculée est « question »
  et que l'index envoyé correspond à la question réellement ouverte.
- **Progression conditionnelle** (option ☑ de la session) : pour répondre à la question N,
  il faut avoir répondu CORRECTEMENT à la question N-1. Sinon → **spectateur**
  (il voit tout, ne peut plus répondre ; contrôles désactivés interface ET serveur).
  Option décochée → tout le monde répond à chaque question (score cumulé).
- **Résultats** : la bonne réponse n'est révélée que pendant la pause (jamais pendant la question).
- **Fin de série** : finalisation automatique (au premier appel qui constate la fin) —
  finalistes = sans faute (mode progression) ou tous les participants (mode score) ;
  gagnants automatiques (meilleur score puis plus rapide) ou désignés par l'admin.

## 3. États affichés au participant (écran d'accueil)
`⏳ en attente` → `🟢 quiz actif (décompte)` → `✅ réponse envoyée, verrouillée`
→ `⏳ prochain quiz dans Xs (décompte)` → … → `🏁 série terminée`
Spectateur : `👁️ mode spectateur` (questions et résultats visibles, boutons désactivés).

## 4. Rôles
- **Admin** : crée la série (titre, nb questions, temps/question, intervalle, progression,
  nb gagnants, mode de désignation), lance, arrête, **rejoue** (réinitialise réponses + statuts),
  consulte les statistiques, communique avec les gagnants, demande la photo.
- **Participant** : répond une seule fois par quiz, avance s'il a bon (mode progression).
- **Spectateur** : voit sans répondre.

## 5. Schéma (ajouts, rien de supprimé)
- `quiz_sessions.interval_s INTEGER DEFAULT 30` — délai entre deux quiz.
- `quiz_sessions.started_ms INTEGER` — top départ en millisecondes.
- Index unique `idx_quiz_answers_once(session_id, user_id, question_id)`.

## 6. API
- `GET  /api/games/concours` → état complet : session + `live { phase, index, total,
  remaining_ms, next_in_ms, question{...}, can_answer, answered, my_answer, spectator,
  reveal{bonne réponse + ma réponse} en pause }`.
- `POST /api/games/concours/:id/repondre { index, answer }` — validations ci-dessus.
- `POST /api/admin/quiz-sessions/:id/rejouer` — remet les réponses/statuts à zéro et relance
  immédiatement la même série (nouveau `started_ms`).
- Synchronisation : décompte local à la seconde + re-synchronisation serveur toutes les 5 s
  et à chaque changement de phase.

## 7. Bandeau d'annonces défilantes (bas de l'accueil)
- Table `annonces` (titre, contenu, icône, couleur, lien optionnel, ordre, actif).
- Réglages : `bandeau_enabled` (0/1), `bandeau_speed` (pixels/seconde, 10-400 ; lente=30, normale=60, rapide=120, personnalisée).
- `GET /api/annonces` (public) → { enabled, speed, items } ; CRUD admin `/api/admin/annonces` (permission « communication »).
- Rendu : piste dupliquée ×4 + animation CSS `translateX(-50%)` linéaire infinie → boucle sans temps mort,
  fluide (GPU), pause au survol/toucher (`animation-play-state: paused`), durée = largeur/vitesse.
- Fixé au-dessus de la barre de navigation (jamais par-dessus le contenu : un espace réservé est ajouté en bas de page).

## 8. Fichiers modifiés & comment tester
- `db.js` : tables annonces/view_seen/quiz (migrations auto) — démarrer le serveur suffit.
- `server.js` : moteur quiz synchronisé + /api/annonces + CRUD + suppression de session.
- `public/app.js` : panneau quiz en direct + bandeau sur l'accueil.
- `public/admin/admin.js` : panneaux Jeux (sessions) et Communication (bandeau).
Tests : créer 2 annonces → elles défilent en boucle sur l'accueil ; changer la vitesse → rechargement accueil plus rapide/lent ;
désactiver le bandeau → disparaît ; lancer un quiz → la question apparaît seule sur l'accueil de chaque compte connecté ;
répondre 2 fois → refus « verrouillée » ; mauvaise réponse → spectateur à la question suivante (serveur ET interface) ;
supprimer un quiz terminé → disparaît avec ses réponses.

## 9. Bandeau fixe v2 : publicités, informations et urgences typées
- Table `annonces` : + colonnes `type` ('pub'|'info'|'urgence', défaut 'info') et `theme` (texte libre affiché entre parenthèses). Migration additive `ensureColumn`, aucune donnée perdue.
- Icône posée automatiquement par le serveur selon le type : 📢 / ℹ️ / 🚨. L'admin n'écrit jamais « Pub », « Info » ou « Urgence » : l'accueil affiche automatiquement `📢 Pub (Thème) : message`, `ℹ️ Info (Thème) : message`, `🚨 Urgence (Thème) : message` (libellé Urgence en rouge).
- Dashboard → 📣 Publicités & informations → panneau 📺 : trois options 📢 PUBLICITÉS / ℹ️ INFORMATIONS / 🚨 URGENCES (filtres + compteurs « actives : N »), formulaire Type + Thème + Message + Couleur + Lien, vitesses Très lente 15 / Lente 30 / Normale 60 / Rapide 120 / Très rapide 200 px/s + personnalisée (10-400), ordre ↑↓, Activer/Désactiver par publication et global.
- Accueil : le bandeau reste `position:fixed` au-dessus de la barre de navigation pendant le défilement de la page ; seul son contenu défile horizontalement (animation CSS linéaire infinie, pause au survol). Re-synchronisation automatique toutes les 12 s : tout changement du dashboard (type, thème, message, état, ordre, vitesse, activation globale) apparaît sans recharger.
- Tester : créer une pub avec thème « Sport » → l'accueil affiche « 📢 Pub (Sport) : … » ; idem info et urgence ; inverser l'ordre ↑↓ ; changer la vitesse ; désactiver une publication (disparaît du bandeau) ; vérifier sur mobile que le bandeau ne bouge pas quand on fait défiler les services.

## 10. Modèle économique (commission, visibilité, publicités, avis, emploi)
**Principe : tout est calculé côté serveur, tout est réglable dans le tableau de bord, rien n'est codé en dur.**
- **Commission obligatoire** : `commission_enabled` + taux général `commission_rate` + table `commission_rules` (règles par type de pro, catégorie, ville/zone, période-campagne, priorité). Calcul à la fin de mission (`missionFinance`), affichage transparent avant validation (prix total / commission / part pro) côté pro ET client. Verrou anti-contournement : montant re-modifiable uniquement via la demande d'accord client.
- **Modification du prix sur le terrain** : table `mission_price_changes` (ancien, nouveau, motif, statuts, dates). Le pro propose + motif obligatoire → notification client (ancien/nouveau/différence/commission) → acceptation ou refus → commission recalculée automatiquement. Impossible de terminer la mission avec une demande en attente. Historique visible dans 📈 Finances & revenus.
- **Visibilité pro FACULTATIVE** : tables `visibility_plans` (nom, prix, durée, niveau 1-3, avantages, cible, active) + `visibility_subs`. Souscription → transaction en attente → confirmation du paiement par l'admin → activation auto (badge ⭐ « Mis en avant », bonus de classement dans le dispatch, jamais bloquant pour les non-payants). Bouton global `visibilite_enabled` : OFF = plus rien proposé, profils intacts, historique conservé.
- **Campagnes publicitaires** : table `ad_campaigns` (budget, durée, format texte/image/vidéo, zone, priorité standard/prioritaire/premium auto selon budget, 9 statuts). File d'attente automatique quand `pub_max_actives` est atteint, promotion auto à l'expiration/suspension (`pubTick`). Rotation pondérée par priorité (poids max ×3, pas de monopole). Budgets proposés + niveaux (`pub_budgets`, `pub_niveaux`) modifiables.
- **Avis de recherche** : formules normal (gratuit/payant selon `avis_prix_normal`) / mis en avant / urgent, prix et activation par formule, expiration auto `avis_duree_jours`, tri urgent > mis en avant > normal (payé seulement).
- **« Je cherche un travail »** : GRATUIT ; mise en avant facultative (avant/prioritaire), prix et durée configurables, désactivable (`emploi_boost_enabled`).
- **Transactions & finances** : table `transactions` (commission, publicité, visibilité, avis, emploi ; en_attente/confirme/echoue/rembourse). « Paiement reçu » applique automatiquement l'effet associé. Vue 📈 Finances : résumé (commissions jour/semaine/mois, revenus par source, revenu total), filtres (date, type, statut, recherche ville/catégorie/nom).
- **Tableau de bord** : 💰 Paramètres commerciaux (sections A-E + international pays/devise) ; 📈 Finances & revenus. Chaque modification de paramètre est journalisée (admin, ancienne → nouvelle valeur, date/heure).
- **Tests : 44/44 (modèle économique) + 70/70 (non-régression).**
