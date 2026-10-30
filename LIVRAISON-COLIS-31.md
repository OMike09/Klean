# Klean Services — LIVRAISON COLIS 31

**Date :** 30 octobre 2026  
**Objet :** Gestion avancée de la maintenance générale et des accès temporaires de test.

## 1. Rubrique PDG complétée, sans doublon

La rubrique existante **« 🛠 Maintenance / suspension des activités »** est enrichie. Les maintenances partielles historiques A à E sont conservées ; la portée F devient une **maintenance générale réellement étanche**.

L’état est affiché clairement :

- maintenance désactivée ;
- maintenance activée ;
- maintenance programmée.

Les actions sensibles d’activation, désactivation, autorisation, retrait d’autorisation et blocage global demandent une confirmation dans le tableau de bord.

## 2. Maintenance générale avec exceptions persistantes

Pendant une maintenance générale :

- tous les comptes sont bloqués par défaut ;
- le PDG conserve toujours son accès total ;
- seuls les comptes explicitement enregistrés dans **« Comptes autorisés pendant la maintenance »** restent fonctionnels ;
- les autorisations sont persistantes après déconnexion et redémarrage ;
- elles ne modifient jamais les suspensions, blocages ou désactivations administratives habituelles d’un compte.

Le PDG peut rechercher les comptes par nom, identifiant, téléphone ou e-mail, les filtrer par client, professionnel, administrateur, gestionnaire, agent ou PDG, puis les autoriser ou les retirer par lots.

La section affiche pour chaque compte son identité, son identifiant, son rôle, ses coordonnées disponibles, son statut administratif et son statut d’autorisation de maintenance.

Les commandes opérationnelles incluent :

1. Activer la maintenance générale ;
2. Désactiver la maintenance ;
3. Sélectionner les comptes autorisés ;
4. Bloquer tous les comptes de test ;
5. Autoriser les comptes sélectionnés ;
6. Bloquer les comptes sélectionnés ;
7. Personnaliser et prévisualiser l’alerte ;
8. Programmer la maintenance ;
9. Consulter l’historique.

## 3. Contrôle serveur et sessions ouvertes

La maintenance générale est contrôlée côté serveur, pas seulement dans l’interface :

- connexion refusée pour un compte non autorisé ;
- ancienne session refusée ;
- API, liens directs et opérations métier refusés avec HTTP 503 ;
- accès aux routes administratives réservé au PDG pendant la maintenance ;
- flux SSE déjà ouverts notifiés immédiatement lors de l’activation, de la désactivation ou du retrait d’une autorisation ;
- un utilisateur non autorisé bascule vers la page d’alerte sans pouvoir contourner la mesure avec une URL directe ou une requête API.

Les comptes autorisés continuent d’utiliser les fonctionnalités prévues par leurs permissions normales. Le PDG n’est jamais bloqué.

## 4. Page publique rouge de maintenance

Les personnes bloquées voient une page plein écran qui remplace l’application :

- fond rouge professionnel personnalisable ;
- logo Klean Services ;
- icône d’alerte ;
- titre et texte lisibles sur mobile et ordinateur ;
- précision complémentaire ;
- date de retour lorsqu’elle est connue ;
- aucune navigation vers les pages habituelles.

Le PDG peut modifier depuis la rubrique existante : titre, message, précision, couleur, icône, URL du logo et visualiser un aperçu avant activation.

Le message par défaut est conforme à la demande : **« MAINTENANCE EN COURS »**, explication de l’opération, suspension temporaire, remerciement et mention **« Nous serons de retour très bientôt. »**

## 5. Programmation, fin automatique et audit

Une maintenance peut être :

- immédiate ;
- programmée à une date et heure ;
- terminée à une date et heure ;
- définie avec une durée de 1 minute à 30 jours ;
- arrêtée manuellement à tout moment.

Le serveur vérifie l’horloge toutes les 15 secondes afin d’activer une maintenance programmée et de terminer automatiquement une maintenance arrivée à échéance, même sans visiteur actif.

Les nouvelles tables persistantes sont :

- `maintenance_allowed_accounts` ;
- `maintenance_history` ;
- `maintenance_access_events`.

L’historique PDG conserve l’activation, programmation, démarrage automatique, désactivation, fin automatique, modifications d’autorisations, l’identité du PDG, les comptes autorisés au moment de l’action et les durées calculables des périodes terminées.

Les statistiques sur 30 jours affichent : comptes bloqués par défaut, comptes autorisés, accès de comptes de test et tentatives d’accès refusées.

## 6. Fichiers principaux modifiés

- `db.js` — migration additive COLIS 31 : listes autorisées, historique et événements d’accès.
- `server.js` — barrière générale d’API, contrôle connexion/session/SSE, programmation, statistiques, recherches de comptes et API PDG.
- `public/app.js` — page rouge plein écran, respect des comptes autorisés, bascule immédiate SSE et restauration de session après maintenance.
- `public/admin/admin.js` — extension de la rubrique maintenance existante.
- `public/sw.js` — cache public `ks-v10-public-shell`.
- `package.json` — scripts de tests COLIS 31.
- `test-colis31.js` / `test-colis31-ui.js` — contrôles API et navigateur.

## 7. Vérifications exécutées

Sur `http://127.0.0.1:3000` :

1. `npm run test:update31` : **16/16**.
   - blocage global, ancienne session, connexion, accès direct/API ;
   - trois exceptions persistantes ; retrait immédiat ; PDG ; historique ; programmation ; rétablissement.
2. `npm run test:update31:ui` : **10/10**.
   - page rouge responsive bureau/mobile ; lien direct masqué ; compte autorisé fonctionnel ; dashboard PDG enrichi.
3. Régressions COLIS 30 : API **25/25**, UI **16/16**.
4. Régressions COLIS 29 : API **31/31**, UI **18/18**.
5. Syntaxe vérifiée : `db.js`, `server.js`, `public/app.js`, `public/admin/admin.js`, tests COLIS 31.

Les comptes et événements de test sont supprimés à la fin des tests. Les données métier, missions, paiements, historiques et paramètres existants sont conservés.

## 8. Mise en service Render

Après le déploiement, laissez l’application démarrer une fois afin d’exécuter la migration additive. Ensuite, ouvrez :

`Dashboard PDG → Direction → 🛠 Maintenance / suspension`

La maintenance est désactivée par défaut. Avant une activation générale, configurez les comptes autorisés nécessaires aux tests et prévisualisez l’alerte.
