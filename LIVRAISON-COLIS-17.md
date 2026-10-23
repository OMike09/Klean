# Klean Services — Livraison COLIS 17

Mise à jour **incrémentale** de l’application existante : aucun compte, identifiant, profil candidat, avis, mission, API historique ou règle métier n’a été remplacé. Les nouvelles tables et colonnes sont ajoutées par migrations SQLite idempotentes.

## 1. Splash officiel plein écran

- Le splash utilise exclusivement le logo officiel existant (`/logo.png`).
- Il couvre réellement toute la fenêtre (`position: fixed`, largeur/hauteur viewport dynamique), y compris sur tablette et ordinateur : aucune bande blanche liée au conteneur de l’application.
- Les safe areas iPhone sont prises en compte.
- Le logo, le nom et le message **« Exprimez votre besoin, un professionnel arrive. »** ont été agrandis avec des tailles responsives.
- L’ouverture automatique reste planifiée à **3 secondes**, indépendamment de la vitesse réseau.

## 2. Accueil et catalogue unique A–Z

- Le slogan « Klean Services - Tout commence par une mise en relation. » a été retiré de l’accueil uniquement.
- Les huit services populaires et leur source centrale sont conservés.
- La grille longue « Tous les services » a été supprimée de l’accueil.
- Un accès discret **« Voir tous les services »** mène à la page active du catalogue central.
- Juste après, les trois accès demandés sont visibles au défilement, dans l’ordre :
  1. **Trouver ou proposer un job** ;
  2. **Avis de recherche** ;
  3. **Urgences**.
- Le catalogue rassemble chaque service actif une seule fois et le trie côté interface avec le collateur français (`localeCompare`, insensible aux accents et à la casse). La sélection continue directement vers le parcours de demande existant.
- La page continue de demander `/api/catalogue` : les changements PDG sont donc reflétés automatiquement, sans liste parallèle.

## 3. Trouver ou proposer un job

- Le texte utilisateur « Je cherche un job » a été remplacé par **« Trouver ou proposer un job »**. La route technique `#/jobs`, les endpoints `/api/jobs`, les profils de candidats historiques et leurs identifiants restent compatibles.
- Une nouvelle table non destructive `job_offers` gère les vraies offres : intitulé, description, compétences, ville, lieu/quartier, durée/période, rémunération, contact et modalités de candidature.
- Deux parcours concrets sont disponibles :
  - **Trouver un job** : recherche d’offres publiées par métier, compétence ou ville ;
  - **Proposer un job** : publication d’une offre soumise à modération.
- Les anciens profils de candidats restent affichés dans une section dédiée et continuent à utiliser leur modération/mise en avant historique.
- Le tableau de bord Contenu distingue désormais les nouvelles offres des profils historiques ; publier, refuser et clôturer sont des actions serveur réelles.

## 4. Avis de recherche configurables

- Ajout de `search_notice_categories` avec catégories initiales configurables : personne recherchée/disparue, objet perdu/retrouvé, autre recherche autorisée.
- Les avis conservent les anciennes données et gagnent la catégorie et la ville sans suppression de colonnes historiques.
- La publication exige côté serveur : catégorie active, intitulé, description, ville présente dans la source centrale et contact.
- Consultation, recherche texte, filtre par catégorie/ville, photo, contact autorisé et signalement sont accessibles côté client.
- Le tableau de bord permet d’ajouter, modifier, ordonner, activer ou désactiver des catégories. Désactiver une catégorie ne supprime jamais les avis existants.
- Les avis et les offres restent soumis à la modération existante.

## 5. Urgences sans faux contact

- L’écran **Urgences** différencie explicitement l’assistance Klean Services d’un appel aux secours publics.
- Il indique que Klean Services ne remplace pas les secours publics et ne fournit aucun numéro public inventé.
- Par défaut, sans disponibilité configurée, l’écran affiche une indisponibilité claire et aucun bouton d’alerte trompeur.
- L’administration configure réellement : disponibilité de l’assistance, message, catégories/services, contacts. Seuls les contacts explicitement marqués **vérifiés** dans le dashboard sont exposés à l’utilisateur.
- Lorsque l’assistance est ouverte, une demande choisit une catégorie disponible et est stockée/notifiée aux administrateurs via l’API existante `/api/urgence` ; elle n’est jamais présentée comme un contact automatique avec des secours publics.

## Migrations et sécurité serveur

- Nouvelles migrations : `search_notice_categories`, `job_offers`, `avis_recherche.category_id`, `avis_recherche.city`.
- Les validations (offre, avis, statut, catégorie, disponibilité urgence) sont réalisées côté serveur.
- Les routes d’administration ajoutées restent derrière le middleware et les permissions de contenu existants.
- Les réglages d’urgence sont validés côté serveur : les contacts nécessitent nom, numéro et état `verified` ; les catégories doivent être structurées.

## Vérifications réalisées

Validation complète sur une instance neuve isolée (`DATA_DIR=/home/user/test-colis17-full-data`, port `3103`) :

1. `npm run test:update10` — **57/57, 0 échec** : parcours existants, permissions, missions, médias, messagerie, quiz et dashboard.
2. `npm run test:update15` — **16/16, 0 échec** : paramètres, partage mesuré, villes pro, activité et contrôles existants.
3. `npm run test:update16` — **10/10, 0 échec** : catalogue/domaine pro, recherche, estimation, limites et matching dynamique.
4. `npm run test:update17` — **17/17, 0 échec** : catalogue A–Z, validations/modération d’offres, avis et catégories, indisponibilité urgence, contacts vérifiés, splash et accueil.
5. Vérification sur le serveur principal port 3000 : authentification PDG, catalogue, catégories d’avis, configuration urgence et liste d’offres répondent correctement.

## Configuration externe restante

Aucun fournisseur de secours public, SMS ou Push n’a été ajouté. Les contacts d’urgence ne sont visibles que lorsqu’un administrateur les saisit et les marque vérifiés. Les coordonnées locales officielles, si souhaitées, doivent être vérifiées et renseignées par l’équipe avant activation. Web Push reste inactif tant que les clés VAPID ne sont pas configurées dans Render.
