# Livraison — COLIS ESSENTIEL 36

## Résultat

Le COLIS 36 complète la rubrique existante **Gestion des publicités** de Klean Services avec une gestion commerciale des promotions et un compteur de vues uniques durable.

## Principaux apports

- Le même formulaire permet de créer une publicité simple ou promotionnelle, de choisir les prix, la réduction, les conditions, le code, le CTA, la présentation et les emplacements.
- Le calcul prix réduit / économie / pourcentage est contrôlé côté serveur. Les prix incohérents, négatifs ou expirés sont refusés ou désactivés selon le comportement choisi.
- La publicité peut continuer au prix normal après la promotion ou être retirée automatiquement.
- L’accueil est un emplacement explicite OUI/NON, sans superposer la barre de recherche ou la navigation. Services, recherche, bandeau, villes, audiences et catégories sont également pris en charge.
- Une vue unique est comptée une seule fois à vie par utilisateur et par publicité. Les clics, contacts, intentions de commande et demandes d’offre ne sont pas confondus avec les vues.
- Les demandes d’offre/code sont vérifiées et limitées, mais ne simulent aucun paiement ni vente. Les revenus/ventes nécessitent toujours un connecteur officiel.
- Le tableau de bord fournit des filtres, comparaisons, détails par publicité et historiques de vues.

## Contrôles validés

| Test | Résultat |
|---|---:|
| API promotions et vues uniques | 15 / 15 |
| Interface promotionnelle responsive | 12 / 12 |
| Régression COLIS 35 | 42 / 42 |
| Régression COLIS 34 | 40 / 40 |

## Déploiement

1. Sauvegarder l’application et la base avant mise à jour.
2. Appliquer `PATCH-COLIS-36.diff` depuis une base COLIS 35, ou déployer les fichiers du colis.
3. Installer les dépendances existantes si nécessaire : `npm ci --no-audit --no-fund`.
4. Redémarrer le service pour lancer les migrations additives.
5. Vérifier les publicités, les statistiques et les emplacements d’affichage.

Le colis ne contient ni base de production, ni identifiant, ni secret, ni dépendance installée.
