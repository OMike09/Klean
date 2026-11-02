# Livraison COLIS 40 — Contacts publicitaires, logo progressif et recherche simplifiée

## Livraison cumulative

Le ZIP contient les COLIS **38, 39 et 40**. Le patch `PATCH-COLIS-37-A-40-CUMULATIF.diff` permet de les appliquer directement sur une base COLIS 37.

## Contacts de publicité sous contrôle PDG

- Ajout par publicité : désignation du contact, numéro d’appel et numéro WhatsApp distinct ou réutilisé.
- Normalisation serveur en format international ; un numéro ivoirien à 10 chiffres reçoit l’indicatif `+225`.
- Bouton **Appeler** avec lien `tel:` ; bouton **WhatsApp** vers `wa.me`, compatible application WhatsApp et WhatsApp Web.
- Cinq politiques par publicité : appel + numéro, WhatsApp sans numéro, deux boutons sans numéro, numéro + deux boutons, ou masquage total.
- Politique par défaut PDG pour les nouvelles publicités conservant le choix « règle générale ».
- Sécurité : les champs bruts restent privés dans la base/administration. Quand le mode est masqué, aucun numéro, lien d’appel ou lien WhatsApp n’est présent dans l’API publique.
- Une interaction contact est comptée sans conserver le numéro dans la statistique.

## Logo et PWA

- Écran de démarrage officiel avec préchargement du logo, fondu et zoom doux, durée minimale de 900 ms au lieu de 3 secondes imposées.
- Respect de `prefers-reduced-motion` : apparition immédiate sans mouvement si le système le demande.
- Le PDG peut publier uniquement le logo officiel via le stockage permanent existant. Chaque publication reçoit une URL versionnée, invalide l’ancienne référence PWA et signale les sessions connectées.
- Le service worker passe en cache `ks-v12-public-shell` afin de distribuer le nouveau comportement sans conserver une ancienne coque.

## Recherche accueil

- Le cercle vert de la seconde loupe a été retiré **uniquement sur l’accueil**.
- La loupe simple au début du texte « Décrivez votre besoin… » est conservée.
- Le microphone reste le seul bouton circulaire ; recherche écrite, vocale, photos et parcours existants ne sont pas remplacés.

## Contrôles réalisés

- `npm run test:colis40` : **27/27**.
  - appel/WhatsApp, numéros distincts, masquage de l’API publique ;
  - carte sur ordinateur, Android et iPhone ;
  - gestion PDG, interface éditeur, logo, animation et recherche.
- `npm run test:colis39` : **4/4**.
- `npm run test:colis38` : **20/20** et interface : **15/15**.
- `npm run test:colis37` : **21/21**.

Les publicités existantes, statistiques, comptes, rôles, prix, logo officiel actuel et fonctions de recherche sont conservés. Les publicités créées pendant les tests sont supprimées à la fin des contrôles.
