# Klean Services — COLIS N°11

**Date :** 9 octobre 2026  
**Objet :** consolidation du quiz unique QCM / concours et validation de l’élimination automatique.

## Modification apportée

Le quiz est un système unique : le QCM autonome ne peut plus lancer de partie parallèle. Les questions QCM sont utilisées exclusivement dans les sessions synchronisées administrées depuis le tableau de bord.

### Déroulé désormais garanti côté serveur

1. L’administrateur crée les questions QCM à quatre réponses A/B/C/D et définit la bonne réponse.
2. Il crée une session avec le nombre de questions, la durée, le mode élimination et le nombre de gagnants.
3. Au lancement, toutes les questions de la session et la référence temporelle serveur sont figées.
4. Tous les utilisateurs voient la même question et le même chronomètre serveur.
5. En mode élimination, toute mauvaise réponse inscrit immédiatement le participant au statut `elimine` en base.
6. Un éliminé est empêché côté API de répondre aux questions suivantes (`403`) ; il n’est plus compté parmi les concurrents `en_lice`.
7. Il continue néanmoins de voir les questions, le chrono, les corrections et la suite du direct en mode spectateur.
8. Les compteurs affichent séparément : inscrits, concurrents encore en lice et spectateurs actifs.
9. À la fin, les finalistes et gagnants sont déterminés par score, temps cumulé et règles de session ; le dashboard peut aussi désigner les gagnants lorsque ce mode est choisi.

## Interface dashboard

- Une seule rubrique de questions QCM et de sessions synchronisées.
- Création / lancement / pause / reprise / arrêt de sessions.
- Compteur « en lice / inscrits » et compteur de spectateurs.
- Détail des statuts de chaque participant.
- Archives conservées lors d’une réinitialisation confirmée.

## Test réellement exécuté

Sur une base SQLite neuve temporaire :

```bash
DATA_DIR=/tmp/klean-quiz-final PORT=3100 node start.js
KLEAN_TEST_BASE=http://127.0.0.1:3100 npm run test:update10
```

**Résultat : 36 / 36 tests réussis.**

Les tests Quiz ajoutés/vérifiés dans cette livraison :
- lancement d’une session synchronisée de deux questions ;
- réponse volontairement fausse à la première question ;
- statut `elimine` immédiat persistant côté serveur ;
- compteur `in_competition` à zéro pour ce joueur ;
- maintien en spectateur ;
- tentative de réponse sur la question suivante refusée serveur (`403`) ;
- pause, reprise et archivage lors de la réinitialisation confirmée.

Les contrôles de syntaxe `node --check` ont aussi réussi pour `server.js`, `public/app.js`, `public/admin/admin.js` et `test-update-10.js`.

## Fichiers concernés

- `server.js` — statut d’élimination immédiat, droits de réponse, compteurs séparés.
- `public/app.js` — affichage explicite « éliminé, mode spectateur », concurrents en lice.
- `public/admin/admin.js` — compteur `en lice / inscrits` dans les sessions.
- `test-update-10.js` — scénario E2E d’élimination et de blocage sur question suivante.
