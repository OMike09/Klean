# Livraison — COLIS 34

## Objet
Mise à jour additive de l’application Klean Services : comptes rapides à code provisoire, stabilité du défilement de l’accueil et préparation sûre de **Klean Kbine à distance**.

## Inclus

### 1. Comptes rapides et codes provisoires
- Création de comptes rapides par les membres autorisés à gérer les comptes.
- Code provisoire aléatoire de 10 caractères, sans caractères ambigus, protégé par hachage salé en base ; le code en clair n’est pas conservé ni inscrit dans le journal d’audit.
- Durée de validité et nombre maximal d’essais configurables exclusivement par le rôle technique PDG dans Administration → Utilisateurs.
- Statuts sûrs consultables : actif, remplacé, expiré, verrouillé ou révoqué. Aucun code n’est renvoyé dans les listes ou fiches.
- Connexion immédiate avec téléphone + code provisoire, sans étape imposée de création de mot de passe.
- Régénération/réinitialisation invalide immédiatement le code précédent. Les changements ou réinitialisations de mot de passe invalident aussi les codes actifs.
- Le titulaire peut remplacer le code par un mot de passe depuis Compte → Paramètres du compte → Modifier mon mot de passe, après confirmation du nouveau mot de passe.
- Aucun second compte n’est créé si le téléphone existe : l’administration reçoit une orientation vers la récupération/régénération d’accès.

### 2. Accueil sans remontée de page involontaire
- Le cycle de rendu distingue désormais une navigation demandée par l’utilisateur d’un rafraîchissement de données de l’accueil.
- La position de défilement est préservée pour les rendus automatiques, y compris le rafraîchissement périodique du catalogue.
- Les tests couvrent Bureau, Android et iPhone après plus de 25 secondes de rafraîchissement automatique.

### 3. Klean Kbine à distance — préparation contrôlée
- Nouveau libellé public : **Klean Kbine à distance** ; les routes/API techniques `cabine` restent conservées pour compatibilité.
- L’écran d’entrée présente seulement : **Transfert de crédit** et **Souscription Appel/Internet**.
- Le formulaire utilise le libellé **« Numéro à débiter (Numéro qui paye) »**, pré-remplit le numéro connu du compte quand disponible, rend le numéro bénéficiaire modifiable et oblige sa confirmation.
- Les transferts calculent côté serveur les frais centralisés : 2 % par défaut, activables/désactivables, taux et arrondi FCFA administrables. Aucun prix n’est figé côté interface et les frais ne sont appliqués qu’une fois.
- Les souscriptions proposent Appel/Internet, les seules offres réellement administrées, ainsi qu’une demande libre avec recherche indicative dans le catalogue. Cette recherche ne crée aucune opération.
- Les récapitulatifs restent entièrement non engageants : aucun débit, paiement, transfert, forfait, historique fictif ou succès simulé n’est produit.
- L’administration centralisée possède les réglages frais, arrondi, libellé et texte d’aide de la demande libre. Les offres, opérateurs et prix existants restent administrables.

## Limite volontaire de cette livraison
Aucune intégration officielle de paiement ou d’opérateur n’est fournie dans ce colis. Le serveur conserve `payment_enabled:false`, `checkout_available:false` et bloque toute soumission par `503 PROVIDER_NOT_CONNECTED`. La confirmation réelle, le dispatch fournisseur, les remboursements et les succès opérationnels seront traités uniquement après intégrations officielles vérifiées.

## Validation effectuée
- `npm run test:colis34` : **16/16**
- `npm run test:colis34:ui` : **24/24** (Bureau, Android, iPhone)
- Régressions API : COLIS 33 **22/22**, COLIS 32 **22/22**, COLIS 29 **31/31**, COLIS 30 **25/25**, COLIS 31 **16/16**
- Régressions UI : COLIS 33 **9/9**, COLIS 29 **18/18**, COLIS 30 **16/16**, COLIS 31 **10/10**
- Vérifications syntaxiques de `db.js`, `server.js`, `public/app.js`, `public/admin/admin.js` et des nouveaux tests.

## Mise en service
1. Sauvegarder la base SQLite active avant déploiement.
2. Déployer les fichiers du colis en conservant la base, les comptes, les rôles, les routes et les téléversements existants.
3. Installer les dépendances si nécessaire : `npm ci --no-audit --no-fund`.
4. Redémarrer l’application : `npm start` ou le processus de production habituel.
5. Le démarrage applique automatiquement les migrations additives de `db.js` pour `quick_access_codes` et les nouveaux réglages Kbine.

Aucune donnée métier existante n’est supprimée par cette mise à jour.
