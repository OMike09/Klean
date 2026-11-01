# COLIS 37 — Images catalogue permanentes, versionnées et PWA

## Objet
Correction intégrée du cycle complet des photos de grandes catégories utilisées par les cartes « Services populaires » et « Tous les services ». Le correctif conserve le catalogue, les comptes, les routes et les fichiers existants ; il étend le stockage actuel `uploads/` + `file_records` sans créer de stockage parallèle.

## Correctifs livrés

- Ajout de `image_assets`, registre additif des assets : ID unique, propriétaire (`grand_category` ou préparation `service`), URL source, nom du fichier existant le cas échéant, version, MIME, largeur, hauteur, taille, dates et état (`active`, `replaced`, `removed`).
- Migration automatique des photos déjà référencées par `grand_categories.image_url`, y compris les visuels historiques de `public/category-images`. Les références et données catalogue ne sont ni supprimées ni réécrites.
- Remplacement/suppression de photo dans le panneau de direction effectué dans la même transaction SQLite que la référence de catégorie : l’ancien asset est retraité, le nouveau devient le seul actif et reçoit une version cryptographiquement distincte.
- Les API publiques retournent uniquement l’URL active versionnée (`?v=…`) et ses métadonnées. Les APIs d’administration conservent l’URL source pour l’édition et ajoutent `image_public_url` et le statut du registre.
- Les photos actives publiques reçoivent `Cache-Control: public, max-age=31536000, immutable` uniquement lorsqu’une version active est validée serveur. Une ancienne URL versionnée ne peut plus être revalidée comme photo courante.
- Les fichiers `uploads/` non publiés, les APIs et les sessions restent privés et non mis en cache par le service worker.
- Nouveau worker PWA `ks-v11-public-shell` : stratégie stale-while-revalidate pour les seules images versionnées portant l’en-tête serveur `X-Klean-Public-Image: 1`, conservation hors connexion des images déjà téléchargées, purge ciblée d’anciennes versions, limite de 96 images et nettoyage des anciens caches de coque.
- Signal SSE `catalogue-image` pour les sessions ouvertes : une carte déjà visible relit la référence versionnée et remplace sa photo sans rechargement. Un contrôle public automatique reste actif toutes les 10 secondes pour les sessions non connectées.
- Cartes publiques : préchargement borné (3 requêtes simultanées, 4 cartes prioritaires), `fetchpriority`, chargement différé sous la ligne de flottaison, dimensions réelles, décodage asynchrone, second essai contrôlé puis fallback neutre. Aucun logo/visuel précédent n’est injecté en cas d’erreur.
- Panneau direction : aperçu via l’URL versionnée et affichage de l’ID, format, dimensions, version et date de modification.
- Journalisation serveur non bloquante et limitée des erreurs réelles de livraison d’image, sans identité utilisateur ni URL privée.

## Fichiers de production modifiés

- `db.js`
- `server.js`
- `public/app.js`
- `public/sw.js`
- `public/category-cards.css`
- `public/admin/admin.js`
- `package.json`

## Régression et validation

- `npm run test:colis37` — **21/21** : création/remplacement/suppression atomiques, métadonnées, ancien cache invalide, `/uploads` + `file_records`, PWA mobile, cache offline, mise à jour SSE sans rechargement et aperçu direction.
- COLIS 36 API/UI — **15/15**, **12/12**.
- COLIS 35 API/UI/ticker — **11/11**, **14/14**, **17/17**.
- COLIS 34 API/UI — **16/16**, **24/24**.
- Validation syntaxique : `db.js`, `server.js`, `public/app.js`, `public/admin/admin.js`.

## Application

1. Sauvegarder la base et déployer les fichiers du colis, ou appliquer `PATCH-COLIS-37.diff` depuis une base COLIS 36 compatible : `patch -p1 < PATCH-COLIS-37.diff`.
2. Exécuter `npm ci --no-audit --no-fund` puis redémarrer le service.
3. Au premier démarrage, la migration additive crée/remplit `image_assets` à partir des photos déjà liées aux grandes catégories.
4. Ne pas purger `uploads/`, `file_records` ou `public/category-images` : ils restent les sources binaires existantes.
5. Vérifier la publication d’une photo dans **Catalogue → Catégories & photos**. Le statut affiche l’asset/version ; la carte publique reçoit une URL `?v=` différente.

Aucun paiement, tarif, compte, rôle, route métier ou contenu catalogue n’est modifié par ce colis.
