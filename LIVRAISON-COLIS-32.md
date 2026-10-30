# Klean Services — COLIS 32
## Espaces vendeurs Braderie, abonnements contrôlés et simplification maintenance

**Date :** 30 octobre 2026  
**Nature :** évolution additive appliquée directement au projet existant, sans reconstruction ni suppression des routes/fonctionnalités COLIS 29 à 31.

## 1. Maintenance / Suspension des activités

La rubrique privée est simplifiée en trois parties opérationnelles :

1. **État de la plateforme** : interrupteur unique, indicateur clair et statistiques compactes.
2. **Gestion des comptes** : liste unique recherchable et filtrable par rôle, sélection/désélection globale, autorisation ou retrait d’exception pour la sélection, et commande **« Débloquer tous les comptes »**.
3. **Message de maintenance** : titre, message, précision, logo téléversable, couleur, icône et aperçu.

Les confirmations sont demandées avant les changements à effet immédiat. « Débloquer tous les comptes » désactive la maintenance générale : il ne modifie jamais `blocked`, `suspended` ou `disabled_until`. Les sanctions individuelles restent donc actives.

Les contrats et le journal COLIS 31 sont conservés : contrôle serveur 503, exceptions persistantes, audit et historique restent intacts.

## 2. Appellations visibles

- Dans l’application utilisateur, les libellés concernés passent de **Client** à **Utilisateur**.
- Les libellés publics **PDG** de la Braderie/validation sont remplacés par **Klean Services** ou une formulation équivalente.
- Le rôle technique `pdg`, les permissions, données et le tableau privé restent inchangés.

## 3. Espace vendeur Braderie

Dans **Mon compte**, l’entrée **« Mon espace braderie »** est placée directement après l’espace professionnel.

Le parcours connecté est réel :

- création d’un espace lié de manière unique à son propriétaire ;
- consultation des formules publiées ;
- souscription trimestrielle (3 mois) ou annuelle (12 mois) ;
- transaction Braderie en attente ;
- activation uniquement au moment où Klean Services confirme la transaction côté serveur ;
- consultation de l’historique des abonnements et paiements.

Statuts persistants pris en charge : `pending_payment`, `payment_confirmed`, `active`, `expired`, `suspended`, `cancelled` (affichés en français dans l’interface).

À l’expiration, l’espace et les historiques restent accessibles ; la publication est refusée par le serveur jusqu’à renouvellement/attribution valide. Les anciennes annonces ne sont jamais supprimées automatiquement.

## 4. Formules et limites réellement serveur

Nouvelles tables additives :

- `braderie_plans`, `braderie_plan_history` ;
- `braderie_spaces`, `braderie_subscriptions`, `braderie_space_events` ;
- colonnes additives `videos` et `subscription_id` sur `braderie_items`.

Trois formules de départ sont créées sans prix commercial codé en dur : **Simple**, **Premium**, **Professionnelle / Business**. Elles restent inactives jusqu’à leur paramétrage par Klean Services.

Chaque formule administre :

- prix FCFA trimestriel et annuel ;
- promotion datée et prix promotionnels ;
- économie annuelle calculée ;
- quotas de publications et d’articles actifs ;
- photos par article ;
- autorisation vidéo, nombre, durée, taille et formats MIME ;
- avantages, restrictions, visibilité et activation.

Chaque souscription enregistre un **instantané immuable** de ces conditions. Les modifications ultérieures de formule ne réécrivent donc pas l’historique.

La publication exige côté serveur :

- une souscription active non expirée ;
- le respect des quotas de la souscription ;
- le respect du nombre de photos ;
- le contrôle des vidéos (propriétaire, MIME, taille, format et durée analysée) ;
- la modération Braderie historique existante.

## 5. Administration Braderie

Le tableau privé Braderie ajoute :

- KPI jour/semaine/mois/année : espaces, abonnements, renouvellements, recettes confirmées, articles publiés/vendus ;
- création/modification et historique des formules ;
- espaces vendeurs, suspension, réactivation, annulation ;
- attribution gratuite ou promotionnelle traçable ;
- paiements en attente, confirmation via le flux transactionnel existant, prolongations ;
- distribution par formule et historique des abonnements.

La confirmation « Paiement reçu » utilise `POST /api/admin/transactions/:id/statut` avec statut `confirme`; le serveur active ou programme ensuite la souscription. Il ne s’agit pas d’un bouton décoratif.

## 6. Endpoints ajoutés

### Utilisateur

- `GET /api/braderie/plans`
- `GET|POST /api/braderie/space`
- `POST /api/braderie/space/subscriptions`

### Klean Services (route `/api/admin`)

- `GET|POST /braderie/plans`
- `PUT /braderie/plans/:id`
- `GET /braderie/plans/:id/history`
- `GET /braderie/spaces`
- `GET /braderie/subscriptions`
- `PUT /braderie/spaces/:id/status`
- `POST /braderie/spaces/:id/grant`
- `POST /braderie/subscriptions/:id/extend`
- `GET /braderie/subscription-stats?period=day|week|month|year`

## 7. Vérifications exécutées

- `npm run test:colis32` : **22/22**
- `npm run test:colis32:ui` : **9/9**
- `npm run test:update29` : **31/31**
- `npm run test:update29:ui` : **18/18**
- `npm run test:update30` : **25/25**
- `npm run test:update30:ui` : **16/16**
- `npm run test:update31` : **16/16**
- `npm run test:update31:ui` : **10/10**

Les tests COLIS 29/30 ont été adaptés pour créer un espace vendeur et faire confirmer son paiement avant leurs publications historiques, conformément à la nouvelle règle serveur.

Après les tests : maintenance vide, Braderie désactivée comme avant les tests, et aucun compte/formule/espace/abonnement/transaction de test COLIS 29–32 conservé.
