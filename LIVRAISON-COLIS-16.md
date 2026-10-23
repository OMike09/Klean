# Klean Services — Livraison COLIS 16

Mise à jour incrémentale de l’application existante : **recherche intelligente**, **domaines professionnels simplifiés** et **estimations tarifaires par ville**. Les tables, services, tâches, profils, missions, historiques, prix et APIs existants sont conservés ; les nouvelles relations les complètent sans réécriture destructive.

## 1. Accueil et recherche intelligente

- L’accueil affiche désormais en grand : **« Klean Services - Tout commence par une mise en relation. »**
- La présentation est responsive (mobile, tablette et ordinateur), sans texte coupé.
- La recherche s’exécute au fur et à mesure de la saisie (délai court anti-rafale), depuis l’accueil comme depuis l’écran Rechercher.
- Le moteur normalise les accents et la ponctuation, compare les mots incomplets et les fautes proches, et classe les résultats par pertinence.
- Les résultats indiquent la grande catégorie, le métier et la tâche suggérée lorsqu’elle est identifiable.
- Le dictionnaire est stocké dans `service_search_terms`, relié à une prestation et, si nécessaire, à une tâche réelle. Il est administrable par le PDG.
- Des formulations locales initiales sont configurées en base, notamment autour des fuites d’eau, climatiseurs, coupures électriques, téléphones, nettoyage, motos et murs. Elles restent modifiables : elles ne constituent pas une API externe ni une prétendue compréhension parfaite de toutes les langues.
- Sans résultat suffisamment fiable, le client peut continuer sa description librement : aucun blocage artificiel.

## 2. Catalogue central et domaines professionnels

- Ajout de la racine `grand_categories` avec les vingt domaines demandés, dont Plomberie, Électricité, Bâtiment et construction, Informatique et téléphonie, Agriculture et élevage, etc.
- Les métiers, sous-catégories, prestations et tâches existants restent en place, reliés à leur grande catégorie grâce à `service_categories.grand_category_id`.
- Les listes client sont regroupées par grande catégorie ; le catalogue admin conserve ses identifiants existants et affiche les relations centrales.
- Dans l’inscription pro, le libellé est **« Sélectionnez votre ou vos domaines d’activité »** : le professionnel coche une ou plusieurs grandes catégories, jamais une longue liste de tâches.
- Les profils historiques sont migrés sans perte vers leurs domaines issus de leurs services déjà déclarés.
- Le matching serveur vérifie maintenant le domaine autorisé de la prestation. Une tâche ajoutée plus tard à un domaine actif devient donc automatiquement éligible pour les professionnels de ce domaine.
- Un professionnel validé peut demander une modification de domaines, mais ne peut pas s’auto-autoriser : la demande est historisée dans `pro_domain_change_requests` puis approuvée ou refusée par l’administration.
- La fiche pro d’administration permet de corriger, autoriser ou désactiver les domaines. Les anciens profils restent compatibles avec leurs autorisations service par service.

## 3. Estimations intelligentes par ville

- Ajout de `price_estimation_rules`, versionnée par les journaux d’administration existants : grande catégorie, métier, sous-catégorie, prestation, tâche, ville, zone, prix de départ/fourchette, facteurs, source, date et priorité.
- Le calcul serveur applique cet ordre réel :
  1. règle explicite du PDG ;
  2. donnée locale vérifiée et autorisée par le PDG ;
  3. historique d’interventions comparables **payées et suffisamment nombreuses** ;
  4. tarif de référence autorisé par le PDG, présenté comme provisoire ;
  5. **Prix à confirmer** s’il n’existe aucune base suffisamment fiable.
- Les règles manuelles PDG sont prioritaires et peuvent encadrer un minimum, un maximum, un ajustement fixe ou un pourcentage.
- La ville réelle d’intervention est demandée indépendamment du GPS ; elle est enregistrée dans `missions.intervention_city` et utilisée par le matching géographique.
- Abidjan peut être géré comme zone tarifaire agrégée, tout en conservant les communes détaillées de la liste centrale.
- Le client voit uniquement : **« À partir de [montant] FCFA »** avec le caractère provisoire et la source quand c’est nécessaire, ou **« Prix à confirmer après précision de votre besoin »**.
- Aucun tarif externe n’est importé ou affirmé comme « prix du marché » automatiquement. Les données locales ne sont utilisées qu’après saisie/validation explicite du PDG avec leur note et leur date.
- Nouvelle rubrique PDG : **Gestion des tarifs et estimations intelligentes**, avec règles globales, test avant publication, gestion des grandes catégories et dictionnaire de recherche.

## 4. Formulaire universel de demande

- Après une sélection issue de la recherche, le texte est repris automatiquement dans le champ libre :
  **« Décrivez ce que vous souhaitez faire. Expliquez votre problème ou le travail à réaliser. »**
- Les anciennes questions obligatoires propres à chaque service ne bloquent plus la création d’une nouvelle demande ; leurs données/API historiques sont conservées pour les demandes passées.
- Maximum serveur et client : **3 photos** et **25 secondes** de note vocale. Le serveur vérifie aussi la propriété des fichiers et la durée audio mesurée.
- La note vocale peut toujours être enregistrée, écoutée, supprimée et remplacée avant envoi.
- Une estimation indisponible ne bloque jamais la mise en relation.

## Migrations sûres

- `grand_categories` ;
- `service_search_terms` ;
- `pro_domain_change_requests` ;
- `price_estimation_rules` ;
- colonnes de rattachement des catégories, domaines pro et données d’estimation des missions.

Toutes les migrations sont idempotentes. Les profils existants reçoivent une correspondance de domaine depuis leurs services sans modifier les identifiants de services, tâches, utilisateurs ou missions.

## Vérifications réalisées

Validation sur instance isolée neuve (`DATA_DIR=/home/user/test-colis16-complete`, port `3102`) :

1. `npm run test:update10` : **57/57, 0 échec** — régression des flux existants.
2. `npm run test:update15` : **16/16, 0 échec** — correctifs précédents (villes, partage, messages, etc.).
3. `npm run test:update16` : **10/10, 0 échec** — domaines pro, ajout dynamique d’une tâche, recherche familière/fautive, règles PDG distinctes Bouaké/Abidjan, prix à confirmer sans donnée, limite 3 photos / 25 secondes et matching réel par domaine.
4. Vérifications syntaxiques réussies : `db.js`, `server.js`, `public/app.js`, `public/admin/admin.js`, `test-update-16.js`.

## Configuration externe

Aucune source tarifaire externe n’est configurée par cette livraison. Le PDG peut ajouter des données locales vérifiées avec leur origine/date dans le tableau de bord. Les limites déjà déclarées pour Web Push, GPS et partage natif restent applicables.
