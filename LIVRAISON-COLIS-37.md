# Livraison COLIS 37 — Correctif définitif des photos catalogue

La correction traite la cause architecturelle des photos/logos absents ou périmés : les cartes populaires reçoivent désormais une référence versionnée issue de la base, et le PWA peut conserver une photo valide hors connexion sans réafficher une ancienne version après remplacement.

## Résultat opérationnel

- Une nouvelle photo enregistrée dans le panneau de direction est associée à la bonne grande catégorie dans une transaction unique.
- Son URL publique change de version immédiatement ; l’ancienne URL n’est plus reconnue comme la photo courante.
- Les appareils connectés reçoivent un signal temps réel et récupèrent la nouvelle version sans rechargement. Les appareils lents/hors ligne peuvent continuer à employer la version actuellement téléchargée, jamais une photo d’une autre catégorie.
- Les caches d’ancienne version sont purgés de façon ciblée ; le cache image reste borné.
- Une erreur réelle donne un fallback cohérent puis est enregistrée de façon non bloquante.

## Contrôles réalisés

`npm run test:colis37` : **21/21**

Couverture : PC/mobile PWA, premier chargement, cache, mode hors connexion, remplacement, suppression, upload permanent `uploads`/`file_records`, aperçu direction et absence d’erreur JavaScript.

Régressions précédentes validées : COLIS 34, 35 et 36 complets.

## Limite volontaire

Le catalogue actuel porte les photos de cartes sur `grand_categories.image_url`. Le registre `image_assets` accepte également le propriétaire technique `service` afin de rester compatible avec une future photo de prestation, mais aucune interface fictive de photo par prestation n’a été ajoutée tant que le modèle/catalogue ne la demande pas.
