# COLIS 36 — Publicités commerciales, promotions et vues uniques

**Base :** COLIS 35  
**Date :** 1 novembre 2026  
**Principe :** amélioration directe de la rubrique existante **Gestion des publicités**. Aucun module indépendant « Promotions » n’est créé.

## Contenu

| Fichier | Évolution |
|---|---|
| `db.js` | Migration additive des données promotionnelles, vues uniques à vie, clics, interactions et demandes d’offre. |
| `server.js` | Validation stricte des prix/périodes, calcul promotionnel serveur, programmation, limite d’affichages, ciblage, statistiques et API de codes. |
| `public/app.js` | Cartes promotionnelles publiques, prix normal barré, prix réduit, économie, compteur facultatif, CTA et comptage contextualisé. |
| `public/admin/admin.js` | Formulaire commercial intégré à la publicité, aperçu multi-écran, emplacements, brouillon/duplication/réactivation et statistiques. |
| `test-colis36*.js` | Contrôles API et Playwright. |
| `PATCH-COLIS-36.diff` | Patch unifié depuis COLIS 35. |

## Fonctions livrées

### Publicité et promotion dans un seul formulaire

- Objet : produit, service, entreprise, offre ou événement.
- Types : simple, prix promotionnel, pourcentage, montant fixe, offre spéciale, code promotionnel et offre limitée dans le temps.
- Prix normal, prix promotionnel calculé, montant/pourcentage de réduction, mention, frais éventuels, quantité, avantage, conditions et bouton d’action.
- Devise technique `XOF` / affichage **FCFA**. Aucun prix commercial n’est fixé dans le code : toutes les valeurs proviennent du formulaire et sont validées côté serveur.
- Modèles : classique, prix, carte promo, badge de réduction, flash, multiple, vidéo et image+texte. Images en `contain` par défaut, sans déformation ni découpe.

### Programmation et diffusion

- Début/fin de publicité, fin de promotion, jours et créneaux horaires, durée, fréquence, priorité et plafond de vues uniques.
- Après la fin d’une promotion : continuer au prix normal ou masquer l’annonce, selon le choix enregistré.
- Compte à rebours public lorsqu’une fin de promotion est définie.
- Emplacements simultanés : accueil haut/contenu, services, recherche et bandeau. L’option visible **Afficher cette publicité sur l’écran d’accueil : OUI** pilote l’affichage accueil ; le format accueil est sélectionnable.
- Ciblage existant par ville, plus audience client/pro, catégories et services concernés. Les catégories reçoivent les publicités ciblées via l’API contextuelle.

### Codes et conditions

- Codes, nouveaux utilisateurs, liste limitée de comptes autorisés, quantité, maximum global/par compte, montant minimum, cumulabilité et avantage groupé.
- L’API vérifie toutes les conditions côté serveur avant de retourner un prix éligible.
- Une demande d’offre peut être tracée et limitée de façon atomique. Elle ne déclenche jamais de paiement, débit, transfert ni vente simulée : ces résultats restent indisponibles sans intégration officielle de commande/paiement.

### Compteurs et statistiques

- `ad_unique_views` déduplique de façon durable à vie par identifiant de compte connecté, ou par identifiant local anonyme respectueux de la confidentialité.
- Les anciens événements sont conservés et migrés comme vues uniques historiques sans les supprimer.
- Clics, contacts, intentions de commande, demandes/codes d’offre et vues restent des métriques distinctes.
- Tableau de bord : filtres période/statut/emplacement/publicité, vues uniques, vues accueil/autres espaces, clics, CTR, interactions, comparaisons, plus/moins vues, détails et historique groupé.
- Aucune information personnelle d’un visiteur n’est renvoyée dans ces statistiques. Chiffre d’affaires et ventes restent à zéro/non disponibles tant qu’un paiement officiel ne les confirme pas.

## Migration et déploiement

1. Sauvegarder la base et l’application COLIS 35.
2. Appliquer `PATCH-COLIS-36.diff` (`patch -p1`) ou remplacer les fichiers du colis.
3. Redémarrer le service. Les `ensureColumn`, tables et index sont additifs.
4. Lancer les contrôles ci-dessous.

La migration ne supprime pas les publicités, prix, médias, messages, historiques ni statistiques existantes. Les anciennes vues quotidiennes restent dans `ad_view_events`; elles sont en plus dédupliquées dans `ad_unique_views` pour la nouvelle règle « une vue par personne et publicité ».

## Validation terminée

- Syntaxe : `node --check db.js server.js public/app.js public/admin/admin.js`
- `npm run test:colis36` — **15/15**
- `npm run test:colis36:ui` — **12/12**
- Régressions COLIS 35 : API **11/11**, UI **14/14**, bandeau **17/17**
- Régressions COLIS 34 : API **16/16**, UI **24/24**
- Patch appliqué sur une copie COLIS 35 avec `patch -p1` et contrôles syntaxiques : **OK**

Les tests retirent leurs publicités, événements, codes/demandes et réglages temporaires.
