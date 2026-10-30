# Patch essentiel — COLIS 31

Ce dossier contient les fichiers créés ou modifiés pour la livraison COLIS 31.
Il doit être appliqué sur le projet Klean Services existant en conservant les
mêmes chemins (`db.js`, `server.js`, `public/app.js`, etc.).

## Application sur Render

1. Sauvegardez le projet déjà déployé.
2. Copiez le contenu de ce dossier dans la racine du projet Klean Services,
   en acceptant le remplacement des fichiers de mêmes noms.
3. Exécutez `npm ci` puis redéployez / redémarrez Render.
4. La migration additive COLIS 31 est exécutée au démarrage.
5. Configurez la fonctionnalité dans :
   `Dashboard PDG → Direction → Maintenance / suspension`.

## Inclus

Maintenance générale étanche, liste persistante des comptes de test, page rouge
personnalisable, planification, audit, statistiques, tests et documentation.

## Exclu volontairement

Les fichiers inchangés, `node_modules`, la base SQLite locale, les téléversements
et les données métier ne sont pas inclus ni supprimés.
