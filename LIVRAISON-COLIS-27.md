# Klean Services — Livraison COLIS 27

**Date :** 26 octobre 2026  
**Objet :** gestion PDG réellement persistante des photos de catégories, compétences professionnelles fines, dédoublonnage contrôlé, vues publicitaires et regroupement des paramètres.

## 1. Photos des grandes catégories — parcours PDG visible

Dans **PDG → Paramètres → Catégories & photos**, chaque grande catégorie active est affichée dans une carte avec :

- sa photo actuelle ou son icône de secours ;
- **Ajouter une photo**, **Modifier la photo**, **Supprimer la photo** et **Détails** ;
- le nom court mobile, le nom complet et le nombre de métiers rattachés.

Le formulaire accepte un fichier depuis un ordinateur ou un téléphone (JPG, PNG, WebP), affiche un aperçu local, optimise l’image lorsque le navigateur le permet, l’importe, puis demande une confirmation explicite avant le remplacement. La suppression demande aussi confirmation.

L’association est sauvegardée dans `grand_categories.image_url`, donc par **identifiant de catégorie** — jamais par nom. Le serveur refuse les chemins d’upload qui ne sont pas des images actives du registre, et seul le PDG peut écrire cette association. L’API centrale redistribue ensuite la photo sur les cartes sans créer de liste parallèle. Retirer la photo ne supprime ni catégorie, ni prestation, ni mission, ni historique. Aucune image pilote ou image IA n’a été ajoutée à cette livraison.

## 2. Dédoublonnage prudent et traçable

La migration COLIS 27 ajoute `catalogue_merge_audit` et ne fusionne que des entrées **strictement identiques après normalisation** (accents, casse, espaces et ponctuation), dans le même parent lorsque cela est nécessaire.

- Les catégories, sous-catégories et prestations proches mais différentes restent distinctes.
- Lors d’une égalité certaine, les prestations, tâches, règles de prix, dictionnaire, missions et associations de profil sont réalignés avant suppression du doublon.
- Les options de compte professionnel conservent aussi leurs références de catégories.
- Le PDG voit les fusions effectives et leur snapshot dans **Paramètres → Catégories & photos**.

La migration est idempotente (`colis27_catalogue_exact_dedup_v1`) et a été testée avec une prestation reliée au doublon : la référence est déplacée vers la catégorie canonique et l’audit est conservé.

## 3. Compétences des professionnels : catégorie puis sous-catégorie

Les professionnels disposent désormais d’un sélecteur hiérarchique dans l’inscription et la modification de profil :

1. ils ouvrent une grande catégorie ;
2. ils cochent une ou plusieurs sous-catégories réellement maîtrisées ;
3. ils peuvent recommencer dans plusieurs grandes catégories.

Les identifiants sont enregistrés dans `pro_profiles.selected_subcategories` et, après validation, dans `authorized_subcategories`. Les domaines parents sont déduits côté serveur ; le formulaire API refuse désormais une inscription ou une demande de modification dépourvue de sous-catégorie.

Les profils existants sont migrés seulement lorsqu’un ancien service correspond avec certitude à une sous-catégorie active. Les services introuvables ou non classables sont enregistrés dans `pro_profile_catalogue_reviews` ; aucun métier n’est inventé. Le PDG peut, dans **Paramètres → Catégories & photos**, choisir une sous-catégorie certaine ou « Ne pas attribuer ». Cette décision est journalisée et les compétences autorisées restent contrôlées côté serveur pour le matching.

## 4. Statistiques de vues publicitaires

La table persistante `ad_view_events` mémorise les consultations des publicités internes et des campagnes annonceurs.

- Une même personne connectée ou un même navigateur anonyme est compté au plus une fois **par publicité et par jour**.
- Le navigateur anonyme utilise uniquement une clé locale aléatoire ; aucune adresse IP, téléphone ou empreinte technique n’est exposée.
- Dans **PDG → Paramètres → Publicités**, le tableau affiche annonceur, titre, date, statut, vues totales et visiteurs uniques.
- **Voir les vues** affiche les comptes identifiables uniquement lorsqu’ils étaient connectés, avec première/dernière consultation et nombre de consultations. Les visiteurs anonymes restent agrégés.
- Les données survivent à la reconnexion et les routes de lecture détaillée sont réservées au PDG.

## 5. Une entrée « Paramètres »

La barre latérale ne contient plus trois entrées concurrentes de configuration. Une entrée principale **⚙️ Paramètres** ouvre des sous-sections organisées :

- Application & comptes ;
- Catégories & photos ;
- Notifications & messages ;
- Publicités ;
- Commercial ;
- Prix & estimations ;
- Sécurité & règles.

Les écrans et permissions précédents restent en place : aucun réglage n’a été supprimé, et les API gardent leurs contrôles serveur existants.

## Fichiers concernés

| Fichier | Rôle |
|---|---|
| `db.js` | migration COLIS 27, audit de fusion exacte, file PDG des profils, événements de vues, migration contrôlée des profils anciens |
| `server.js` | catalogue de compétences, matching par sous-catégorie, décisions PDG, photos sécurisées, collecte/lecture d’analytique publicitaire |
| `public/app.js` / `public/styles.css` | sélecteur professionnel hiérarchique et envoi de vues publicitaires dédupliquées |
| `public/admin/admin.js` / `public/admin/index.html` / `public/admin/admin.css` | cartes de photos, file de correction, audit, vues détaillées de pubs, hub Paramètres responsive |
| `test-update-27.js` | test API/DB COLIS 27 — 10 assertions |
| `test-ui-27.js` | parcours navigateur desktop, Pixel 7 et iPhone 13 — 33 assertions |
| `package.json` | script `npm run test:update27` |

## Validation réellement exécutée

Sur base SQLite isolée, avec serveur lancé :

- `npm run test:update27` : **10/10** — migration, photos, sélection/migration de compétences, file PDG, vues publicitaires et dédoublonnage exact ;
- `npm run test:update26` : **7/7** ;
- `npm run test:update26:complement` : **8/8** ;
- `test-ui-27.js` sous Chromium Playwright : **33/33** sur desktop 1440 px, émulation Android Pixel 7 et iPhone 13. Les parcours vérifient le dashboard, la section photo, l’analytique, le hub Paramètres, l’application publique, l’absence de débordement horizontal et les erreurs JavaScript.

Commandes :

```bash
npm ci --no-audit --no-fund
DATA_DIR=/tmp/klean-colis27 PORT=3017 npm start
KLEAN_TEST_BASE=http://127.0.0.1:3017 npm run test:update27
KLEAN_TEST_BASE=http://127.0.0.1:3017 npm run test:update26
# test-ui-27.js nécessite Playwright/Chromium dans l'environnement de test
node test-ui-27.js http://127.0.0.1:3017
```

## Déploiement Render

Aucune commande de migration séparée n’est nécessaire : `db.js` applique les migrations idempotentes au démarrage avec le volume persistant Render. Avant déploiement, sauvegarder la base de production ; après démarrage, vérifier le journal, les lignes de revue PDG et les catégories actives. Les nouvelles tables conservent les données entre les redémarrages seulement si le disque Render persistant reste configuré.
