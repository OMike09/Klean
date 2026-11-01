# COLIS 35 — Publicités, bandeau et urgences

**Base d’application :** COLIS 34  
**Date :** 1 novembre 2026  
**Nature :** mise à jour additive et compatible ; aucune donnée métier n’est réinitialisée.

## Contenu livré

| Élément | Rôle |
|---|---|
| `db.js` | Migration additive des cycles de diffusion, réglages/historique du bandeau et icône de contact d’urgence. |
| `server.js` | Validation/autorisation serveur, planification, filtrage public, archivage logique, statistiques conservées, API de configuration et de contacts vérifiés. |
| `public/app.js` | Rendu public proportionné des publicités, vidéo non automatique, placements effectifs, bandeau fluide et page Urgences compacte avec liens `tel:` volontaires. |
| `public/admin/admin.js` | Gestion enrichie des publicités, aperçu téléphone/tablette/bureau, module bandeau, et gestion PDG des contacts d’urgence. |
| `package.json` | Commandes de test COLIS 35. |
| `test-colis35*.js` | Tests API, interface responsive et huit modes réels de bandeau. |
| `PATCH-COLIS-35.diff` | Patch unifié appliquable sur la base COLIS 34. |

## Éléments fonctionnels

### Publicités

- Images/affiches conservent par défaut leurs proportions en `contain`; le recadrage `cover` reste un choix explicite.
- Le rendu mobile, tablette et bureau est responsive; les publicités ne sont pas des fenêtres bloquantes et ne sont plus incluses dans le bloc de recherche fixe.
- Les vidéos sont servies avec contrôles, en sourdine, sans `autoplay`, et avec lecture en ligne.
- Les emplacements actifs sont `home_top`, `home_mid`, `services_top` et `search_top`; les anciennes valeurs restent compatibles.
- Sont administrables : média, texte, lien `https://` ou `#/…`, emplacement, zones, priorité, fréquence, durée, activation, début/fin et restauration.
- Les publicités expirées, suspendues, programmées ou archivées restent administrativement consultables; seules les actives sont envoyées au public. L’archivage préserve ligne, historique et statistiques.

### Bande défilante

- Paramètres persistants : couleurs, bordure, police/graisse/taille, hauteur, vitesse, sens, espacement, coins, position, pause et préférence de réduction des animations.
- Modes testés : défilement horizontal, vertical, fixe, rotation, fondu, cartes, actualité et promotion.
- Messages : catégorie, priorité, ordre, lien validé, icône/image, état, programmation et mode individuel. Les urgences obtiennent le libellé visuel **URGENT** et la priorité est respectée sans empêcher l’usage de l’écran.
- Les changements de mode ne pilotent jamais le scroll de page. Le bandeau s’actualise depuis l’API et respecte `prefers-reduced-motion` lorsqu’il est activé.

### Urgences

- La page publique est volontairement réduite à des rangées service/numéro/bouton d’appel `tel:`.
- Aucun numéro n’est inventé. Les contacts créés/modifiés exigent côté serveur un service, un numéro, une source institutionnelle HTTPS et une date de vérification.
- L’administration permet ajout, modification, icône, ordre, activation/retrait et historique; les demandes d’assistance déjà présentes restent gérées dans le même écran.

## Déploiement sûr

1. Sauvegarder la base de données et le répertoire d’application existant.
2. Appliquer `PATCH-COLIS-35.diff` sur une base **COLIS 34** ou remplacer les fichiers listés ci-dessus.
3. Exécuter `npm ci --no-audit --no-fund` si les dépendances ne sont pas déjà installées.
4. Redémarrer l’application : `db.js` applique automatiquement les seules migrations additives (`ensureColumn` et `CREATE … IF NOT EXISTS`).
5. Vérifier les routes publiques `/api/ads`, `/api/annonces` et `/api/urgence/config`, puis le tableau d’administration.

Aucune table existante, publicité, message, statistique, numéro d’urgence, rôle, route ou réglage n’est supprimé par la migration.

## Validation exécutée

- `node --check db.js server.js public/app.js public/admin/admin.js`
- `npm run test:colis35` — **11/11**
- `npm run test:colis35:ui` — **14/14**
- `npm run test:colis35:ticker` — **17/17**
- Régressions : `npm run test:colis34` — **16/16** ; `npm run test:colis34:ui` — **24/24**
- Application du patch sur une copie COLIS 34 avec `patch -p1` puis contrôles de syntaxe — **OK**

Les tests temporaires créent puis retirent leurs données de contrôle et restaurent la configuration du bandeau.
