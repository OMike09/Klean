# COLIS 21 — Manifest

## Objet
Évolution incrémentale de Klean Services autour des grandes catégories, tâches facultatives, tarification fiable et gestion PDG. Aucune fonction historique n’a été reconstruite ou supprimée.

## Fichiers principaux modifiés

- `db.js` — migration non destructive des grandes catégories populaires et descriptions de tâches.
- `server.js` — catalogue public par grandes catégories, recherche enrichie, références tarifaires fiables et API PDG sécurisées.
- `public/app.js` — accueil, recherche, liste A–Z, détail catégorie et nouveau formulaire de demande.
- `public/admin/admin.js` — Gestion des catégories et des tâches, catégories populaires, tâches enrichies.
- `public/styles.css` — repère prix rouge `#dc2626` et recherche accueil compacte.
- `test-update-21.js` — harnais COLIS 21 ajouté.
- `test-update-16.js`, `test-update-19.js`, `test-update-20.js` — assertions réalignées avec la nouvelle décision explicite de parcours et de catégories.

## Données et compatibilité

- Tables existantes préservées ; migrations `ALTER TABLE` conditionnelles.
- Les demandes historiques, services, catégories, règles tarifaires et profils professionnels sont conservés.
- La suppression d’une tâche liée à une demande historique retourne une erreur serveur et impose la désactivation.
- Une grande catégorie contenant des métiers ne peut pas être supprimée avant réaffectation.
- Les prix ne sont jamais inventés ; l’absence de référence ne produit aucun prix public sur les cartes de catégorie.

## Tests de livraison

`npm run test:update21` : **21/21** sur une base neuve isolée.

Régressions vérifiées : COLIS 10, 14, 15, 16, 17, 18, 19 et 20 — toutes réussies selon les résultats consignés dans `LIVRAISON-COLIS-21.md`.
