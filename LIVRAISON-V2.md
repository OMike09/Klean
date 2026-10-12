# Klean Services — Refonte v2 : notice de déploiement

## Ce que contient cette version (Étapes 1 à 5, toutes testées)

1. **Catalogue complet** : 39 métiers → 61 sous-catégories → 125 services → 452 tâches, gérés
   à 100 % depuis le tableau de bord (créer, modifier, désactiver, supprimer, réordonner,
   rechercher, ⭐ populaires de l'accueil, 📅 saisonniers, 📍 disponibilité par ville).
2. **Grande barre de recherche admin** sur toutes les pages : nom, téléphone, e-mail, code KP,
   métiers, services, tâches, missions, paiements, équipe, journal — ouverture directe.
3. **Fiche compte** avec gestion rapide : modifier, suspendre, bloquer, désactiver temporairement,
   réinitialiser l'accès, forcer un nouveau mot de passe, supprimer (si autorisé), historique admin.
4. **＋ Créer rapidement un compte** (mot de passe temporaire, profil complété par l'utilisateur).
5. **Taille du texte** : 14–26 px côté utilisateur (Compte → Paramètres) ; taille par défaut du
   tableau de bord définie par le PDG uniquement.
6. Exemple de nom partout : **John Sery Michael**.
7. Inscription : **Ville** (liste complète de Côte d'Ivoire, avec recherche, évolutive depuis le
   dashboard) + **Quartier** libre.
8. **Un téléphone = un compte** (interface + serveur + base) avec options
   « Se connecter » / « Réinitialiser mon accès ».
9. **Œil 👁** sur tous les champs mot de passe (masqué par défaut).
10. **Récupération sécurisée** : code à 6 chiffres haché (15 min, 5 essais, usage unique),
    identité vérifiée par l'équipe ; aucun mot de passe jamais affiché ni stocké en clair.
11. **Mode maintenance PDG** : 6 portées (A–F), durée avec fin automatique, justification
    obligatoire, message personnalisé ; le compte PDG reste toujours accessible.
12. **Hiérarchie** PDG → Administrateurs → Gestionnaires → Agents → Utilisateurs, avec
    12 permissions réglables compte par compte par le PDG.
13. **Journal des actions sensibles** : automatique, consultable, recherchable.
14. Côté utilisateur inchangé dans son esprit : simple (chercher → demander → être mis en relation).

## Fichiers à envoyer sur GitHub (dépôt OMike09/Klean, branche main)

Ouvrez : https://github.com/OMike09/Klean/upload/main puis envoyez ces fichiers **à la racine** :

- `db.js`              (modifié — migrations douces, aucune donnée existante touchée)
- `server.js`          (modifié)
- `seed-metiers.js`    (NOUVEAU — taxonomie + villes)
- `test-e2e.js`        (modifié)

Puis ouvrez : https://github.com/OMike09/Klean/upload/main/public et envoyez :

- `app.js`             (modifié)

Puis ouvrez : https://github.com/OMike09/Klean/upload/main/public/admin et envoyez :

- `admin.js`           (modifié)

(`index.html`, `styles.css`, `sw.js`, `manifest.json`, `start.js`, `persist.js`,
`import-ancien.js`, `package.json` sont inchangés.)

Render redéploie automatiquement après le commit.

## Ce qui se passe au premier démarrage en production (automatique, une seule fois)

- Ajout des nouvelles tables/colonnes **sans toucher aux données existantes**
  (comptes, missions, paiements, réglages et les 7 comptes importés sont conservés).
- Installation de la taxonomie : les services actuels sont **fusionnés en conservant leurs
  identifiants** (les missions et questions existantes restent liées).
- Le compte administrateur le plus ancien (admin) devient **PDG**.
- Les professionnels déjà validés reçoivent leur **code KP**.

## Après le déploiement — à vérifier (2 minutes)

1. `/admin` → connexion admin / Klean@2026 → le menu affiche DIRECTION
   (👑 Équipe, 🛠 Maintenance, 🧾 Journal) → votre compte est bien PDG.
2. Barre de recherche : tapez le nom d'un des comptes importés → sa fiche s'ouvre.
3. 📚 Métiers & catalogue : 39 métiers présents, services existants conservés.
4. Application : créer un compte de test (ville + quartier, œil 👁), puis le supprimer
   depuis sa fiche admin.

## Vérifications effectuées avant livraison

- 70/70 tests de bout en bout (comptes, demandes, missions, paiements, GPS, notifications,
  chat, jeux, modération…) sur base vierge.
- Audit complet des permissions : matrice PDG / Admin / Gestionnaire / Agent / Utilisateur
  sur les 14 sections + protection absolue du compte PDG + fonctions réservées PDG.
- Intégrité des données : chaque service a un métier, une sous-catégorie et des tâches ;
  pas de doublon de téléphone ; codes KP uniques ; aucun mot de passe en clair.
