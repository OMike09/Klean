# Manifest — COLIS 31

## Portée

Évolution additive de la rubrique existante **Maintenance / suspension des activités** : maintenance générale étanche, exceptions de test persistantes, page rouge personnalisable, programmation, audit et statistiques.

## Changements garantis

- Maintenance générale F qui bloque tous les comptes et toutes les API par défaut, sauf le PDG et les comptes explicitement autorisés.
- Contrôle serveur à la connexion, sur les sessions existantes, les API, les liens directs et le flux SSE.
- Les suspensions et blocages administratifs existants restent indépendants ; aucune donnée de compte n’est supprimée ou modifiée par la maintenance.
- Comptes de test recherchables et filtrables, autorisables ou retirables par lots ; autorisations persistantes.
- Page d’alerte plein écran rouge et responsive, sans accès aux écrans normaux, personnalisable par le PDG.
- Programmation de début, date de fin ou durée ; activation et fin automatiques surveillées côté serveur.
- Tables d’audit `maintenance_allowed_accounts`, `maintenance_history` et `maintenance_access_events`.
- Journal avec acteur, comptes autorisés, transitions et durée des périodes clôturées ; statistiques sur 30 jours.
- Conservation des portées partielles A à E préexistantes.

## Fichiers ajoutés

- `LIVRAISON-COLIS-31.md`
- `COLIS-31-MANIFEST.md`
- `test-colis31.js`
- `test-colis31-ui.js`

## Fichiers mis à jour

- `db.js`
- `server.js`
- `public/app.js`
- `public/admin/admin.js`
- `public/sw.js`
- `package.json`

## Validation

- COLIS 31 API : **16/16**.
- COLIS 31 UI : **10/10**.
- COLIS 30 API/UI : **25/25** et **16/16**.
- COLIS 29 API/UI : **31/31** et **18/18**.

Aucune donnée de démonstration de production ou suspension administrative artificielle n’est introduite par ce colis.
