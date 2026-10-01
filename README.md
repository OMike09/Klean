# Klean-Services CI — Version 2.0 (refonte complète)

Plateforme complète de mise en relation clients ↔ professionnels pour la Côte d'Ivoire.
**Un seul écosystème** : application utilisateur (PWA) + espace professionnel + backend + base de données + notifications temps réel + paiements + tableau de bord administrateur.

---

## 🔑 Accès

| Rôle | Adresse | Identifiants |
|---|---|---|
| Application (client & pro) | `/` | créer un compte dans l'app |
| Tableau de bord administrateur | `/admin` | identifiant : `admin` — mot de passe : `Klean@2026` |

> ⚠️ **Changez le mot de passe administrateur dès la mise en production** (Application → connectez-vous avec le compte admin → Mon compte → Sécurité).

---

## 🧭 Principes clés implémentés

1. **UN SEUL COMPTE pour tout le monde** : chaque personne s'inscrit une fois. Par défaut elle est cliente. Depuis *Mon compte → Mon espace professionnel*, elle peut déposer un dossier professionnel ; après validation par l'administration, le **même compte** devient *Client • Professionnel* (aucune duplication, aucun deuxième compte).
2. **Accueil épuré** : une grande barre de recherche « Que recherchez-vous ? » avec reconnaissance de formulations simples (« je cherche un plombier », « nettoyer mon fauteuil », « je cherche un employé »…), puis les services principaux en cartes.
3. **Formulaires adaptatifs** : chaque service affiche uniquement ses propres questions (nombre de fauteuils, type de tissu… pour le nettoyage de fauteuil ; type de problème, équipement… pour la plomberie). Les questions sont **gérées par l'administrateur** (ajout, modification, réorganisation, activation, suppression) sans casser les autres services.
4. **Mise en relation automatique** : disponibilité → compatibilité service → proximité GPS. Chaque professionnel a un **délai de réponse configurable** (60 s par défaut) ; passé ce délai, la mission passe automatiquement au suivant, puis le client est informé s'il faut relancer.
5. **Cycle de mission complet et tracé** : Demande → Acceptation pro → Confirmation client → Programmée → En cours → Terminée → Paiement (double confirmation espèces) → Avis croisés. Chaque changement d'état est horodaté et visible par les deux parties.
6. **Paiement espèces sécurisé** : une mission n'est **jamais** considérée payée automatiquement. Le client confirme avoir remis l'argent, le professionnel confirme l'avoir reçu — le paiement n'est validé que lorsque les deux ont confirmé. Commission (25 % par défaut) **configurable depuis le tableau de bord** et calculée de façon identique partout.
7. **Chat rattaché à chaque mission** : texte, photos, messages vocaux, dans les deux sens, en temps réel (SSE), sans mélange entre missions.
8. **Notifications** : centre de notifications par catégories (mission, message, paiement, compte, information, urgence, système), compteur sur la cloche 🔔, son + vibration, et chaque notification **ouvre directement** la mission ou la conversation concernée.
9. **Localisation** : GPS si autorisé (iPhone/Android/navigateur), **saisie manuelle toujours possible** — l'application n'est jamais bloquée si la localisation est refusée.
10. **Fonctions secondaires conservées et intégrées** : Avis de recherche (avec modération), Je cherche un job (publication + recherche), École & famille, bouton Urgence (avec confirmation anti-déclenchement accidentel et contacts configurables), Quiz / Flip Fizz / Kdo (isolés, activables depuis l'admin).
11. **Sécurité** : règles client et professionnel affichées et **acceptées à l'inscription** (acceptation horodatée en base), textes modifiables depuis l'admin ; signalements ; suspension de comptes ; données sensibles non exposées avant confirmation d'une mission.
12. **Gestion des fichiers** : durée de conservation configurable dans l'admin, nettoyage automatique toutes les 12 h + nettoyage manuel.
13. **Responsive & PWA** : installable sur iPhone/Android, navigation gestuelle (balayage pour revenir en arrière), bouton ← Retour partout, gros boutons, fonctionne de petit écran à ordinateur.
14. **Gestion des erreurs** : chaque action a un état de chargement, une confirmation de réussite, un message d'erreur clair en français et la possibilité de réessayer.

---

## 🖥️ Tableau de bord administrateur (`/admin`)

- **Vue d'ensemble** : utilisateurs, pros, missions, volume payé, commissions, litiges, alertes.
- **Utilisateurs** : clients / professionnels / pro en attente / suspendus / vérifiés — détails, suspension, vérification.
- **Validations pro** : dossier complet (profession, zone, expérience, documents) → valider / refuser avec motif (l'utilisateur est notifié).
- **Catégories & services** : création, modification, activation/désactivation, mots-clés de la recherche intelligente.
- **Questions dynamiques** : par service — ajouter, modifier, réordonner (↑↓), rendre obligatoire, activer/désactiver, supprimer.
- **Missions** : toutes / demandes / en attente / en cours / terminées / litiges — ouverture et résolution de litiges.
- **Paiements & commissions** : montant, commission, part pro, statut de chaque paiement.
- **Publicités & informations** : texte / image / vidéo, emplacement, durée, activation. **Message système** envoyé à tous.
- **Règles & conditions** : textes client et professionnel modifiables (appliqués immédiatement).
- **Signalements / Urgences** : traitement avec position GPS de l'alerte.
- **Gestion des fichiers** : espace utilisé, durée de conservation, nettoyage.
- **Contenu** : modération Avis de recherche, Je cherche un job, École & famille ; Quiz (questions), Flip Fizz (participants), Kdo (codes cadeaux).
- **Paramètres** : commission %, délai de réponse pro (s), conservation fichiers (jours), moyens de paiement, contacts d'urgence.

**Toute modification admin est appliquée immédiatement dans l'application** (vérifié par les tests).

---

## 🚀 Déploiement sur Render

1. Poussez le dossier `klean-services` sur un dépôt GitHub (ou téléversez-le).
2. Sur [render.com](https://render.com) : **New → Web Service** → connectez le dépôt.
3. Réglages :
   - **Runtime** : Node
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance** : au choix (fonctionne dès le plan Starter)
4. **IMPORTANT — Disque persistant** (sinon la base et les fichiers sont perdus à chaque redéploiement) :
   - Onglet **Disks** → **Add Disk** : par exemple `klean-data`, chemin `/var/data`, 1 Go ou plus.
   - Onglet **Environment** → ajoutez :
     - `DATA_DIR` = `/var/data/db`
     - `UPLOAD_DIR` = `/var/data/uploads`
5. Déployez. L'application est sur `https://votre-service.onrender.com` et l'admin sur `…/admin`.

> Render fournit `PORT` automatiquement : le serveur l'utilise déjà (`process.env.PORT`).

### Lancement local
```bash
npm install
npm start          # → http://localhost:3000
node test-e2e.js   # test complet de bout en bout (serveur démarré)
```

---

## ✅ Tests de bout en bout

`node test-e2e.js` exécute **70 vérifications**, dont les 20 tests obligatoires :
création d'utilisateur, demande avec localisation + photo + vocal, recherche de professionnel, notification reçue → ouverture directe de la demande, acceptation, confirmation client, chat (texte + photo + audio), cycle jusqu'à « terminée », paiement espèces à double confirmation, commission, évaluations croisées (anti-fraude), passage client → professionnel sur **le même compte**, retour au rôle client sans second compte, tableau de bord, et répercussion réelle des modifications admin (commission, questions, jeux, publicités, règles) dans l'application.

Dernière exécution : **70 réussis / 0 échec**.

---

## 🗂️ Structure du projet

```
klean-services/
├── server.js          # API Express : auth, missions, dispatch, chat, paiements, admin, SSE
├── db.js              # Schéma SQLite + configuration initiale (services, questions, règles)
├── test-e2e.js        # Test complet de bout en bout (20 tests du cahier des charges)
├── package.json
├── data/              # Base de données (DATA_DIR en production)
├── uploads/           # Fichiers (UPLOAD_DIR en production, rétention configurable)
└── public/
    ├── index.html / app.js / styles.css   # Application utilisateur + pro (PWA)
    ├── sw.js / manifest.json / icon.*     # PWA installable
    └── admin/                             # Tableau de bord administrateur
```
