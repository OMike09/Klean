# Livraison — COLIS ESSENTIEL 35

## Résultat

Le COLIS 35 met à niveau les modules déjà existants de **publicités**, **bande défilante** et **urgences**, sans reconstruction de l’application ni remplacement de base de données.

### Ce qui est prêt

- Publicités : rendu entier et proportionné des images/affiches, vidéo non automatique, placements publics effectifs, fréquence/ordre/programmation, lien validé, aperçu avant publication et archivage logique conservant les statistiques.
- Bandeau : réglages réellement enregistrés côté serveur, huit modes de rendu, messages planifiés et catégorisés, urgence distinguée, pause/réduction d’animations, aperçu mobile/bureau et historique de configuration.
- Urgences : affichage public court de contacts vérifiés avec appel volontaire, gestion PDG des contacts dans le module existant avec source HTTPS et date de vérification obligatoires.

## Fichiers principaux

- `db.js`
- `server.js`
- `public/app.js`
- `public/admin/admin.js`
- `package.json`
- `test-colis35.js`
- `test-colis35-ui.js`
- `test-colis35-ticker-ui.js`
- `PATCH-COLIS-35.diff`

## Contrôles terminés

| Contrôle | Résultat |
|---|---:|
| Syntaxe Node des quatre sources | OK |
| API COLIS 35 | 11 / 11 |
| Interface public/administration COLIS 35 | 14 / 14 |
| Huit modes de bandeau + stabilité du scroll | 17 / 17 |
| Régression API COLIS 34 | 16 / 16 |
| Régression interface COLIS 34 | 24 / 24 |

## Déploiement

1. Effectuer une sauvegarde de la base et de l’application actuelle.
2. Appliquer `PATCH-COLIS-35.diff` à la base COLIS 34, ou déployer les fichiers du colis.
3. Installer les dépendances si nécessaire : `npm ci --no-audit --no-fund`.
4. Redémarrer le service. La migration additive s’exécute au démarrage.
5. Vérifier le tableau de gestion des publicités, `#/bandeau`, `#/urgences`, puis les API publiques.

Le package ne contient pas de base de production, de jeton, de secret, ni de dépendances installées. Aucun paiement ou opération opérateur n’est activé par ce COLIS.
