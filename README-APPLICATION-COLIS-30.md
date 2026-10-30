# Application du patch essentiel — COLIS 30

Ce dossier contient uniquement les fichiers créés ou modifiés pour COLIS 30.
Il est destiné à être recopié à la racine du projet Klean Services existant,
en conservant les mêmes chemins : `db.js`, `server.js`, `public/app.js`,
`public/admin/admin.js`, etc.

## Application

1. Sauvegardez le projet actuellement déployé.
2. Copiez le contenu de ce dossier dans la racine de votre projet Klean Services,
   en acceptant le remplacement des fichiers aux mêmes chemins.
3. Exécutez `npm ci` (ou `npm install`) afin d’installer la dépendance de test Playwright.
4. Déployez / redémarrez Render : la migration additive COLIS 30 s’exécute au démarrage.
5. Connectez-vous en PDG pour configurer la Braderie et la Recherche vocale.

## Ce qui n’est pas inclus

Les fichiers inchangés de l’application, `node_modules`, les données SQLite,
les téléversements utilisateurs et les anciens dossiers de préparation sont exclus.
Aucun historique métier n’est écrasé par ce patch.

Consultez `LIVRAISON-COLIS-30.md` pour le détail, les contrôles et les étapes Render.
