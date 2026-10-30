# Manifest — Klean Services COLIS 32

## Fichiers applicatifs modifiés

| Fichier | Rôle |
|---|---|
| `db.js` | migrations additives espaces/formules/abonnements, historiques et médias vidéo Braderie ; semis de formules inactives sans prix imposé |
| `server.js` | APIs espaces et formules, souscription/transaction/activation, quotas serveur, vidéos, administration et statistiques ; harmonisation des messages publics concernés |
| `public/app.js` | entrée Mon espace braderie, souscription utilisateur, tableau d’espace, publication avec médias vidéo et libellés harmonisés |
| `public/admin/admin.js` | maintenance en 3 parties et gestion administrative complète des formules/espaces/abonnements |
| `package.json` | scripts des tests COLIS 32 |

## Tests ajoutés

| Fichier | Couverture |
|---|---|
| `test-colis32.js` | formule, espace, paiement serveur, activation, quotas, vidéo/durée, expiration, renouvellement trimestriel/annuel, statistiques, vocabulaire visible |
| `test-colis32-ui.js` | compte, création d’espace, maintenance simplifiée, dashboard Braderie |

## Tests de régression adaptés

| Fichier | Adaptation additive |
|---|---|
| `test-colis29.js` | espace vendeur et transaction confirmée avant la publication de contrôle |
| `test-colis29-ui.js` | même préparation réelle pour le vendeur UI |
| `test-colis30.js` | espace vendeur et transaction confirmée avant la publication géolocalisée |
| `test-colis30-ui.js` | même préparation réelle pour le vendeur UI |
| `test-colis31-ui.js` | assertion de la nouvelle maintenance simplifiée |

## Propriétés de compatibilité

- aucune table historique Braderie n’est remplacée ni supprimée ;
- les annonces historiques restent accessibles ;
- les tables/colonnes ajoutées utilisent `CREATE TABLE IF NOT EXISTS` et `ensureColumn` ;
- la transaction de souscription réutilise le registre financier existant ;
- le rôle technique `pdg` et les permissions existantes sont préservés ;
- les règles maintenance COLIS 31 restent contrôlées par le serveur.
