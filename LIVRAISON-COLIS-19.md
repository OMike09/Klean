# Klean Services — Livraison COLIS 19

Mise à jour incrémentale de l’application existante : Klean Services peut maintenant être découverte sans compte et propose une installation PWA réelle lorsque le navigateur le permet. Les données, comptes, rôles, règles métier, routes d’écriture et contrôles serveur existants sont conservés.

## 1. Accès public sans compte

Un visiteur arrive désormais sur **l’accueil**, sans redirection automatique vers l’inscription ou la connexion.

Les contenus suivants sont consultables sans session :

- accueil et services populaires ;
- recherche, catalogue complet A–Z, catégories et prestations ;
- offres et profils de job publiés ;
- avis de recherche publiés et catégories ;
- urgences, catégories et contacts explicitement configurés/vérifiés ;
- page À propos et informations publiques.

Les coordonnées des publications ne sont pas exposées aux visiteurs anonymes : l’API masque les numéros et modalités de contact des offres, profils et avis jusqu’à l’authentification. Les contenus privés, conversations, missions, notifications, comptes, tableaux de bord et actions d’administration restent protégés.

## 2. Inscription seulement au moment d’une action

- Une action protégée affiche : **« Pour effectuer cette action, veuillez créer un compte ou vous connecter. »**
- Les deux choix sont proposés : **Créer un compte** et **Se connecter**.
- Les écritures restent protégées côté serveur : les essais anonymes sur missions, offres, avis et urgences renvoient `401`.
- Les boutons de publication d’avis/profils/offres et de demande d’assistance ouvrent cette étape seulement lorsque nécessaire.
- Dans une demande de prestation, le texte, la ville, l’adresse, la date, l’urgence et la position GPS déjà saisie sont conservés dans la session du navigateur avant l’authentification. Après inscription ou connexion, le visiteur revient au même formulaire pour terminer l’envoi. Les fichiers privés ne sont pas envoyés avant l’authentification, afin de ne pas contourner les règles de stockage.

## 3. Rubrique Compte pour les visiteurs

La rubrique **Compte** n’ouvre plus automatiquement une page de connexion pour les nouveaux visiteurs. Elle affiche une présentation claire avec :

- **Créer un compte** ;
- **Se connecter**.

Après authentification, l’espace personnel existant est affiché normalement, sans création de second compte.

## 4. Installation PWA réelle

- Ajout du bouton fixe discret **« ⇩ Installer l’application »** en bas à droite de l’accueil, au-dessus de la navigation mobile et des Safe Areas.
- Lorsqu’un navigateur Android/desktop expose `beforeinstallprompt`, le bouton déclenche sa fenêtre native d’installation.
- L’application ne prétend pas être installée à l’acceptation du clic : le bouton disparaît uniquement avec l’événement système `appinstalled` ou en mode standalone déjà détecté.
- En cas d’annulation, le bouton reste disponible.
- Sur iPhone/iPad, où l’installation directe est généralement indisponible, une instruction réelle explique Safari → **Partager** → **Sur l’écran d’accueil**.
- Le manifeste a été complété (`id`, `scope`, `display`, `display_override`, langue, couleurs, icônes officielles 192/512).
- Le service worker passe à `ks-v4-public-shell` et ne met en cache que la coque publique. Il exclut explicitement APIs, uploads, sessions et données privées. Hors connexion, aucune fausse disponibilité de contenu privé n’est annoncée.

## 5. Vérifications réalisées

Validation complète sur instance isolée neuve (`DATA_DIR=/home/user/test-colis19-full-data`, port `3106`) :

1. `npm run test:update10` : **57/57, 0 échec**.
2. `npm run test:update15` : **16/16, 0 échec**.
3. `npm run test:update16` : **10/10, 0 échec**.
4. `npm run test:update17` : **17/17, 0 échec**.
5. `npm run test:update18` : **10/10, 0 échec** — historique, retour et protection de brouillon.
6. `npm run test:update19` : **9/9, 0 échec** — API de lecture anonyme, interdiction serveur des écritures anonymes, masquage des coordonnées, route d’accueil publique, mécanisme PWA, conservation de demande, rubrique Compte et cache sûr.
7. Vérification sur le serveur principal port 3000 : accueil, manifeste, service worker, catalogue, avis, jobs, offres et urgences publiques répondent correctement.

## Limites réelles à connaître

L’installation native dépend du navigateur, du HTTPS de production et du système. En environnement Render avec HTTPS, Chrome/Edge/Android peuvent proposer leur fenêtre native quand les critères PWA sont remplis. Safari iOS requiert une action manuelle via son menu Partager ; l’interface ne déclare jamais l’installation terminée tant que le système ne l’a pas confirmée.
