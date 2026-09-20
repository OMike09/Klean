# 🚀 LANCER KLEAN EN LIGNE — 100 % gratuit, ~30 minutes

Objectif : une vraie adresse du type **https://klean-xxxx.onrender.com** que les clients et agents
ouvrent sur leur téléphone — inscriptions, missions, suivi en direct — dès demain matin.

**Coût total : 0 FCFA — aucune carte bancaire demandée.**
**Vous aurez besoin de 3 comptes gratuits : GitHub (le code) · Neon (les données) · Render (le serveur).**
Votre outil choisi pour le code : **GitHub Desktop** (application gratuite, aucune ligne de commande).

---

## 📦 Avant de commencer — récupérez les fichiers du projet

Dans l'espace de travail Arena (à gauche), téléchargez ces **9 fichiers** sur votre ordinateur
et placez-les **tous ensemble dans un dossier vide nommé `klean`** :

```
index.html · net.js · admin.html · admin-login.html · server.js
package.json · package-lock.json · render.yaml · .gitignore
```

⚠️ Ne copiez **ni `db.json` ni `node_modules/`** : la base se créera toute seule en ligne.

---

## Étape 1 — GitHub : créer le compte et publier le code (≈ 10 min)

1. **Créez le compte** : https://github.com → *Sign up* → email + mot de passe → validez l'email reçu.
2. **Installez GitHub Desktop** : https://desktop.github.com → *Download* → installez.
   Ouvrez l'app → **Sign in to GitHub.com** → connectez-vous (le navigateur s'ouvre, autorisez).
3. **Publiez le dossier** : dans GitHub Desktop, menu **File → Add Local Repository…**
   → *Choose* → sélectionnez votre dossier `klean` (celui avec les 9 fichiers).
   → Un message dit « ce dossier n'est pas un dépôt » : cliquez **create a repository**.
   → Nom : `klean` → **Create Repository**.
4. En bas à gauche, résumé en clair : typez `KLEAN — lancement` → **Commit to main**.
5. Cliquez le bouton bleu **Publish repository** (en haut).
   - Décochez *Keep this code private* (le Public est plus simple pour Render — votre mot de passe
     HQ n'est PAS dans les fichiers, c'est sans risque) → **Publish repository**.
6. Allez sur votre GitHub dans le navigateur : vous voyez les 9 fichiers dans le dépôt `klean` =
   **c'est bon.** ✅

> 💡 Pour les futures mises à jour : je modifie le code → vous téléchargez le fichier modifié dans
> le dossier `klean` → GitHub Desktop le détecte → **Commit** → **Push**. Terminé, Render met à jour tout seul.

---

## Étape 2 — Neon : la base de données (≈ 5 min)

*(C'est ici que vivront les comptes clients, les dossiers agents et les missions. Sans ça,
l'hébergeur gratuit effacerait tout à chaque redémarrage. Avec : rien ne se perd jamais.)*

1. https://neon.tech → **Sign up** (bouton *Google* = le plus rapide). Gratuit, sans carte.
2. **Create a project** → **Project name :** `klean` → région : choix par défaut → **Create project**.
3. La page résultat affiche une **Connection string** du genre :
   `postgresql://klean_owner:xxxxx@ep-xxxx.eu-central-1.aws.neon.tech/klean?sslmode=require`
4. **Copiez cette chaîne entière** et gardez-la ouverte dans un bloc-notes — vous allez la coller à l'étape 3.

---

## Étape 3 — Render : allumer le serveur (≈ 10 min)

1. https://render.com → **Get Started for Free** → **GitHub** (inscrivez-vous *avec* votre compte GitHub
   — ainsi Render voit directement le dépôt `klean`). Autorisez l'accès si demandé.
2. Tableau de bord → **+ New → Web Service**.
3. Sélectionnez le dépôt **`klean`** → **Connect**.
4. Render **remplit tout seul** grâce au fichier `render.yaml` (plan *Free*, Node, `npm install`,
   `node server.js`). Si on vous demande quand même : *Runtime* **Node** · *Build Command* `npm install`
   · *Start Command* `node server.js` · *Plan* **Free**.
5. Descendez à **Environment Variables** → **+ Add Environment Variable**, et ajoutez **2 lignes** :

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | *la chaîne Neon copiée à l'étape 2* |
   | `ADMIN_PIN` | `klean-2026` *(code provisoire qui crée le 1er mot de passe HQ — retiré après)* |

6. **Deploy Web Service** → le journal défile 2–3 minutes, c'est normal
   *(vous verrez « 📡 WebSocket… », « 💾 Stockage : Postgres (Neon) — données persistantes ✓ »)*.
7. Quand la pastille devient **🟢 Live**, cliquez l'URL en haut :
   **https://klean-xxxx.onrender.com** → **KLEAN EST EN LIGNE !** 🎉

---

## Étape 4 — Premier usage (2 min), ce soir

1. Ouvrez **`https://klean-xxxx.onrender.com/admin`** : on vous propose de **créer votre mot de passe HQ**
   → choisissez un mot de passe fort (lettres + chiffres + symbole) et **notez-le**.
2. Ouvrez l'app (`/`) sur votre téléphone : choisissez votre **📍 ville** (haut gauche), créez-vous un
   compte client test, lancez une mission factice pour voir le parcours.
3. Rendez-vous dans **mode agent** et remplissez un dossier de test → validez-le/rejetez-le depuis le HQ
   (boutons **✅ / ✕**) pour vérifier que le filtrage marche.
4. Supprimez le code provisoire : Render → votre service → **Environment** → supprimez `ADMIN_PIN`
   → *Save, rebuild and deploy*. Désormais, seul votre vrai mot de passe compte.
5. **Partagez le lien** aux premiers agents et clients dès demain matin 🤝.

---

## 🛠️ Bonus — garder le service « toujours chaud » (gratuit, 3 min)

Le plan gratuit de Render **endort le serveur après 15 min sans visite** : le 1er visiteur du matin
attendrait ~40 s. Pour l'éviter :

1. https://uptimerobot.com → compte gratuit.
2. **+ Add New Monitor** → type **HTTP(s)** → URL : `https://klean-xxxx.onrender.com/api/health`
   → intervalle **5 minutes** → créer.

UptimeRobot réveille KLEAN toutes les 5 minutes, jour et nuit. ✅

---

## 🔁 Mettre à jour l'app plus tard (après chaque évolution)

1. Je modifie le code ici → vous téléchargez les fichiers modifiés dans votre dossier `klean`.
2. GitHub Desktop : les changements apparaissent → résumé → **Commit to main** → **Push origin**.
3. Render **redéploie automatiquement** en ~2 min. Aucun autre geste.

---

## 💸 Et demain ?

| Besoin | Solution |
|---|---|
| Un nom propre **klean.ci** | Domaine ivoirien (~10 000–15 000 F/an chez CloudFilt/Vyte/Arikï) → Render → *Settings → Custom Domains* → l'ajouter (HTTPS gratuit automatique). Écrivez-moi, je fais la config. |
| Beaucoup de clients / lenteur | Passer Render en plan *Standard* ≈ 7 $/mois — 1 clic, aucun code à changer. |
| Paiements automatiques (OM/Wave/Moov sans intervention) | Agrégateur ivoirien **CinetPay** ou **PayDunya** — je peux brancher leur API au bouton « Payer ». |

---

## 📞 Infos en vigueur dans l'app

- Paiements : **Moov 01 00 27 75 21** · **Orange 07 09 07 61 30** · **Wave sur les deux**
- Bouton « 💬 Support WhatsApp » → **225 01 00 27 75 21**
- Commission : **25 %** plateforme · **75 %** agent — 17 services · 7 villes actives.

**En cas de blocage** : notez l'écran exact où vous êtes arrêté (ou capture) et écrivez-moi — je vous débloque. 🤝
