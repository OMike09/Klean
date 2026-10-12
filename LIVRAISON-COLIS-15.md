# Klean Services — Livraison COLIS 15

**Correctif incrémental vérifié** de l’application existante, à la suite de l’audit des parcours réellement utilisables. Aucune reconstruction, suppression de fonction, donnée métier ou source centrale parallèle n’a été introduite.

## Corrections livrées et vérifiées

### 1. Ville d’intervention du professionnel
- Dans **Mon compte**, l’entrée est désormais intitulée **Ma ville d’intervention**.
- Le professionnel peut ouvrir une modale, rechercher et cliquer sa ville depuis la source centrale `villes` (`GET /api/villes`).
- Si aucune ville ne lui a été attribuée, il choisit une unique ville initiale.
- Après attribution, l’interface ne présente que les villes autorisées par l’administration : le professionnel ne peut pas s’ajouter une seconde ville par lui-même.
- Le message suivant est affiché sans ambiguïté : « Vous souhaitez intervenir dans d’autres villes ? Contactez l’administration de Klean Services. Seule l’administration peut autoriser des villes supplémentaires. »
- Côté serveur, `PUT /api/pro/service-location` reste l’autorité : une ville hors de `service_cities` renvoie un refus. La valeur `*`, les villes supplémentaires et l’autorisation toutes villes restent des actions administratives.
- Migration sûre : les profils historiques ayant une seule `service_city` reçoivent cette même ville comme autorisation explicite `service_cities`. Les données existantes restent donc protégées par la nouvelle règle.
- `GET /api/me` et le tableau de bord pro exposent les villes autorisées en tableau JSON fiable, sans parsing fragile côté navigateur.

### 2. Planning et cycle des prestations
- Le planning professionnel prend aussi en compte les états réels du cycle : demande de démarrage, prestation en cours et demande de fin, en plus des missions confirmées ou acceptées.

### 3. Jeux et partage mesurable
- Le PDG peut appliquer au Quiz, Flip Fizz et Kdo le critère **« Partage : aucun partage mesuré »**.
- Ce critère est honnête : il signifie l’absence d’ouverture mesurée d’un lien et d’inscription attribuée ; il ne prétend pas prouver qu’un utilisateur n’a jamais partagé hors de l’application.
- `GET /api/admin/shares/stats` sépare les clics sur le menu Partager, les ouvertures mesurées et les inscriptions attribuées. Le dashboard affiche ces trois indicateurs ainsi que leur limite d’interprétation.

### 4. Fréquentation et messages administratifs
- Les statistiques de fréquentation proposent maintenant : aujourd’hui, hier, cette semaine, semaine dernière, ce mois, mois dernier, 30 jours et une période personnalisée avec dates de début et de fin.
- La période personnalisée utilise les paramètres serveur `from` et `to`, sans calcul fictif seulement côté interface.
- Les messages généraux ont un bouton **Prévisualiser** avant envoi ou programmation : titre, contenu et ciblage sont contrôlables avant validation.

## Contrôles exécutés

Tous les contrôles ont été réalisés sur une instance isolée, initialisée à neuf avec `DATA_DIR=/home/user/test-colis15-final` et le port `3101`.

1. Vérification syntaxique réussie :
   - `server.js`
   - `db.js`
   - `public/app.js`
   - `public/admin/admin.js`
   - `test-update-15.js`

2. `KLEAN_TEST_BASE=http://127.0.0.1:3101 npm run test:update10`
   - **57/57, 0 échec** : régression des flux existants (missions, affectation, droits, conversations, fichiers, paiement, quiz).

3. `KLEAN_TEST_BASE=http://127.0.0.1:3101 npm run test:update15`
   - **16/16, 0 échec**.
   - Vérifie notamment la publication différée À propos, les métriques de partage distinctes, l’inscription attribuée, les périodes personnalisées de fréquentation, les messages ciblés, la conversion pro exceptionnelle, le choix de ville initiale, le refus serveur d’une ville non autorisée, l’autorisation supplémentaire donnée par l’administration et le critère de jeu basé sur le partage mesurable.

## Limites externes toujours déclarées

- Le partage natif dépend du navigateur et de l’OS. L’application ne transforme pas l’ouverture du menu de partage en confirmation d’envoi externe.
- Le Web Push système reste conditionné à la configuration Render de `VAPID_PUBLIC_KEY` et `VAPID_PRIVATE_KEY`, ainsi qu’à l’accord de l’appareil. Les limites iPhone/Android en arrière-plan restent inchangées.
