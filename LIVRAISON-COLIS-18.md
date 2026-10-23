# Klean Services — Livraison COLIS 18

Mise à jour incrémentale de navigation de l’application existante : aucun compte, rôle, API, donnée, dashboard, règle métier ou parcours antérieur n’a été supprimé.

## Navigation Retour centralisée

- Le client dispose désormais d’un gestionnaire centralisé pour les changements de route, la flèche **← Retour**, le bouton Retour Android et l’historique navigateur.
- Le retour revient à l’écran effectivement visité : par exemple accueil → catalogue → catégorie → prestation revient catégorie → catalogue → accueil.
- Les boutons Retour déjà présents sur les sous-pages sont raccordés au gestionnaire centralisé ; ils ne font jamais un simple rechargement.
- Les écrans racines (Accueil, Demandes, Messages, Compte) conservent une interface non dupliquée au premier écran, mais affichent la flèche Retour lorsqu’ils ont été ouverts depuis un autre écran de l’historique.
- Un lien profond sans historique revient vers son parent logique (catalogue, demandes, messages ou compte) quand ce parent existe, sans boucle ni erreur. Au premier écran, l’application reste en place et informe l’utilisateur.
- Les changements d’URL initiés par le navigateur, le bouton matériel Android ou le geste système compatible sont synchronisés avec ce même historique.

## Balayage arrière

- Sur iPhone/iPad, le geste système du navigateur est laissé prioritaire et est pris en compte par la navigation par hash.
- Sur Android et interfaces tactiles non iOS, un balayage horizontal **depuis le bord gauche** vers la droite revient à l’écran précédent.
- Le geste ne se déclenche pas sur les champs, boutons, liens, onglets, tableaux, galeries/photos, médias ou zones de recherche ; il ne gêne donc pas le défilement vertical ni les interactions horizontales existantes.
- Les gestes verticaux restent des gestes de défilement.

## Protection des modifications non enregistrées

- Les formulaires de création/inscription, demande de service, informations, adresses, sécurité, paramètres, profil professionnel et fenêtres de publication sont surveillés après une modification réelle.
- Avant de quitter un formulaire modifié, l’application affiche exactement :
  **« Vous avez des modifications non enregistrées. Voulez-vous quitter cette page ? »**
- Les actions proposées sont : **« Continuer la modification »** et **« Quitter sans enregistrer »**.
- Cette protection est appliquée à la flèche, au geste, à la navigation interne et au retour navigateur/hardware.
- Les écritures serveur (`POST`, `PUT`, `PATCH`, `DELETE`) sont suivies : pendant un envoi, la navigation arrière indique d’attendre afin d’éviter une perte ou une double opération.
- Les fenêtres de formulaire sont refermées avant de quitter la page ; elles demandent confirmation uniquement si leur contenu a été modifié.

## Tableau de bord PDG / administration

- Le dashboard dispose lui aussi d’un historique de vues, d’un bouton **← Retour** dans sa barre supérieure dès qu’une vue précédente existe, du retour navigateur et du balayage tactile compatible.
- Les formulaires d’administration et fenêtres de modification sont protégés par la même confirmation de brouillon.
- Les autorisations serveur existantes ne sont pas modifiées.

## Vérifications effectuées

Instance isolée neuve (`DATA_DIR=/home/user/test-colis18-data`, port `3104`) :

1. `npm run test:update10` : **57/57, 0 échec**.
2. `npm run test:update15` : **16/16, 0 échec**.
3. `npm run test:update16` : **10/10, 0 échec**.
4. `npm run test:update17` : **17/17, 0 échec**.
5. `npm run test:update18` : **10/10, 0 échec** — exécution de la logique réelle de navigation dans un environnement navigateur simulé : pile d’écrans, flèche, navigateur/Android, premier écran, texte de confirmation, conditions du balayage et dashboard.
6. Vérifications de syntaxe réussies : `public/app.js`, `public/admin/admin.js`, `test-update-18.js`.
7. Vérification HTTP sur le serveur principal : `/` et `/admin/` répondent toutes deux avec succès.

## Limites réelles des plateformes

Les gestes système iOS/Android restent contrôlés par le navigateur et les réglages de l’appareil. L’application ne tente pas de les bloquer ; lorsqu’ils modifient l’historique interne, ils sont pris en charge. Sur un premier écran sans page Klean Services précédente, le navigateur peut conserver son comportement système de sortie/retour hors site, ce qui ne peut pas être remplacé de manière fiable par une page web.
