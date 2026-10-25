# Spécification — COLIS N°9

## Objectif

Rendre les services professionnels immédiatement lisibles dans l'administration et remplacer le listing de fichiers techniques par une consultation sécurisée des échanges, organisée par client et adaptée à un grand volume de comptes.

## Contrat des données

### Professionnels

`GET /api/admin/users` joint `pro_profiles` à `users` et expose :

- `pro_profession` : profession libre enregistrée ;
- `services` : tableau de libellés de services résolus depuis les identifiants JSON de `pro_profiles.services` ;
- `service_city` : lieu de service, lorsqu'il est renseigné.

Il n'y a pas de colonne répliquée : les valeurs sont recalculées lors de chaque lecture de la table d'administration.

### Échanges classés

Les éléments associés à un client sont reconstruits uniquement à partir de relations métier existantes :

| Source | Rattachement client | Éléments exposés |
|---|---|---|
| `missions` | `missions.client_id` | description, photos, audio |
| `messages` | `messages.mission_id → missions.client_id` | texte, photo, audio |
| `support_messages` | `support_messages.conversation_id → support_conversations.user_id` | texte, audio |

Un fichier découvert seulement sur le disque n'est jamais attribué arbitrairement à un client.

## Routes d'administration

Toutes les routes suivantes passent par la permission existante `securite` :

- `GET /api/admin/files/clients?q=&type=&from=&to=&page=` : liste paginée de clients qui possèdent du contenu ; recherche côté serveur.
- `GET /api/admin/files/clients/:id` : détails d'un seul client à la demande.
- `GET /api/admin/files/clients/:id/media/:name/download` : média individuel, après vérification du rattachement.
- `GET /api/admin/files/clients/:id/text/:source/:itemId/download` : texte individuel au format `.txt`.
- `GET /api/admin/files/clients/:id/download` : archive ZIP du client (export texte et médias), maximum 200 Mo.
- `GET /api/admin/files` et `POST /api/admin/files/cleanup` : inventaire/rétention historique maintenus.

Chaque téléchargement utilise `Content-Disposition: attachment`. Le dashboard fait une requête authentifiée, transforme la réponse en Blob et déclenche le téléchargement local : l'authentification Bearer n'est donc pas perdue comme elle le serait avec un simple lien HTML.

## Performance

- La page affiche 25 clients par défaut (plafond API : 50).
- Les contenus détaillés ne sont demandés qu'à l'ouverture d'un client.
- Les filtres sont effectués côté SQLite/PostgreSQL restauré, en s'appuyant sur les index existants de client/mission et de conversations support.
- Le regroupement est limité à 3 000 éléments par client pour protéger une réponse administrative anormale ; le ZIP applique en plus une limite de 200 Mo.

## Sécurité

- Le nom de fichier reçu dans une URL est normalisé et ne peut pas traverser les dossiers.
- Le serveur retrouve d'abord l'élément depuis les relations en base avant de lire un fichier local ou persistant.
- Un client non administrateur reçoit une erreur 403 sur ces routes.
- Aucun nom physique Multer aléatoire n'est exposé comme une attribution de propriétaire.
