# COLIS N°9 — Professionnels : services visibles & échanges classés par client

Ce **COLIS N°9 est cumulatif** : il reprend toutes les améliorations des COLIS 7 et 8 (dont le logo fourni) et ajoute la gestion opérationnelle des échanges/fichiers demandée.

## Ce qui est livré

### 1. Tableau `Utilisateurs > Professionnels`

- Nouvelle colonne **« Service »** dans le tableau Utilisateurs.
- Elle affiche directement le ou les services sélectionnés par le professionnel, sans ouvrir sa fiche.
- Si aucun service n'est encore défini, sa profession reste visible.
- Les données viennent directement de `pro_profiles.services` et `pro_profiles.profession` à chaque lecture : une modification de profil est donc reflétée automatiquement, sans copie de données.

### 2. `Gestion des fichiers` remplacée par `Échanges & fichiers par client`

- Les noms techniques de fichiers ne sont plus présentés comme une liste plate.
- Chaque ligne correspond à un client, avec compteurs de **textes**, **vocaux/audios** et **photos/images**.
- Le bouton **Voir** ouvre les éléments associés à ce client :
  - demande initiale (texte, photos, note vocale),
  - discussion liée à chaque mission,
  - messages de Contact Klean Services.
- Une image peut être ouverte, un audio écouté et chaque élément est téléchargeable individuellement.

### 3. Recherche rapide et pagination

- Recherche côté serveur par **nom client**, **téléphone** ou **contenu d'un texte**.
- Filtres côté serveur : tous les contenus, textes, audios/vocaux, images/photos, période « Du / Au ».
- Pagination à 25 clients (maximum serveur 50 par page) : le dashboard ne charge pas tous les échanges de plusieurs milliers de clients d'un seul coup.
- Les détails d'un client ne sont chargés qu'au clic sur **Voir**.

### 4. Téléchargements réels et sécurisés

- **Télécharger** sur une ligne client télécharge une vraie archive ZIP dans le navigateur administrateur.
- L'archive contient l'export `messages-et-textes.txt` et les médias accessibles du client, avec des noms explicites client + type + date.
- Les boutons de chaque média/texte utilisent un vrai téléchargement (`Content-Disposition: attachment`), et non un simple onglet ou lien visuel.
- Les routes de téléchargement restent réservées aux administrateurs disposant de la permission **Sécurité**. Un fichier n'est remis que s'il est effectivement rattaché au client demandé ; aucun nom de fichier isolé ne suffit.
- Le ZIP est plafonné à 200 Mo pour protéger le serveur Render ; au-delà, les éléments restent téléchargeables individuellement.

### 5. Conservation et compatibilité

- Le nettoyage/rétention existant est conservé, tout comme la carte de durée de conservation et le bouton de nettoyage manuel.
- Aucune suppression de table, de fonction ou de donnée existante. Aucune migration SQL manuelle n'est requise.
- La lecture utilise les fichiers locaux lorsqu'ils existent et la restauration PostgreSQL (`persist`) lorsque Render a restauré un fichier après redéploiement.

## Fichiers du colis à téléverser sur GitHub

| N° | Fichier | Dossier GitHub cible |
|---:|---|---|
| 1 | `db.js` | racine |
| 2 | `server.js` | racine |
| 3 | `public/app.js` | `public/` |
| 4 | `public/styles.css` | `public/` |
| 5 | `public/index.html` | `public/` |
| 6 | `public/manifest.json` | `public/` |
| 7 | `public/sw.js` | `public/` |
| 8 | `public/logo.png` | `public/` |
| 9 | `public/icon-192.png` | `public/` |
| 10 | `public/icon-512.png` | `public/` |
| 11 | `public/icon.svg` | `public/` |
| 12 | `public/admin/admin.js` | `public/admin/` |

Les fichiers `test-e2e.js`, `test-update-7.js`, `test-fichiers-e2e.js`, les spécifications et ce guide constituent les preuves de test/documentation : ils ne sont pas nécessaires au déploiement, mais sont inclus dans l'archive.

## Déploiement Render

1. Remplacer les 12 fichiers ci-dessus en conservant exactement leur dossier cible.
2. Committer puis pousser sur la branche liée à Render.
3. Attendre le redéploiement ; le démarrage exécute les migrations additives déjà existantes.
4. Ouvrir `Administration > Gestion des fichiers` : le titre devient **Échanges & fichiers par client**.
5. Vérifier au minimum : un professionnel à plusieurs services, une recherche client, l'ouverture d'un audio/photo, le téléchargement d'un texte puis du ZIP client.

## Vérifications fraîches effectuées avant livraison

- `node --check db.js server.js public/app.js public/admin/admin.js` : **OK**.
- `node test-e2e.js` sur base neuve : **70/70 réussis**.
- `node test-update-7.js` sur base neuve distincte : **18/18 réussis**.
- `node test-fichiers-e2e.js` sur base neuve distincte : **12/12 réussis**.
  - inventaire technique historique conservé,
  - colonne/API Service professionnelle,
  - recherche client et dans texte,
  - filtres audio, image et date,
  - détail client texte/audio/image,
  - téléchargements individuels média/texte,
  - ZIP client réellement lisible,
  - refus de l'espace admin à un compte client.
