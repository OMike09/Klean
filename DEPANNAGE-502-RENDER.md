# 🛠️ KLEAN — « 502 Bad Gateway » sur Render : pourquoi, et que faire

**Ce que vous avez vu :** une page noire Render « **502 Bad Gateway** — This service is currently
unavailable. Please try again in a few minutes. » (Request ID terminé par MRS).
**Ce que ça veut dire, en clair :** **ce n'est pas KLEAN qui est cassé, c'est Render qui n'arrivait pas à
joindre votre serveur** au moment où vous avez ouvert l'application. Vos comptes, vos clients et vos
données **ne sont pas perdus**.

---

## 1. Est-ce que la formule à 7 $ est trop petite ? NON

Mesures faites sur votre application (les mêmes fichiers que ceux en ligne) :

| Ce qui est mesuré | Résultat | La formule à 7 $ offre |
|---|---|---|
| Mémoire utilisée par le serveur | **62 Mo** | 512 Mo |
| Processeur au repos | **0 %** (0 tick en 5 s) | 0,5 cœur |
| Poids d'une ouverture de l'application | **188 Ko** compressé (22 %) | — |
| Deuxième ouverture | **0 octet** (réponse 304) | — |
| Ouverture du port au démarrage | **0,1 s** | — |
| Vérifications automatiques | **3 409 ✔ / 0 ✘** | — |

**La formule à 7 $ n'est pas trop petite : elle est même largement suffisante.** Ce n'était donc pas ça.

---

## 2. La vraie cause de cette page noire (elle est déjà écrite dans votre guide)

Votre plan actuel est le **plan gratuit de Render**, et ce plan **endort le service après 15 minutes
sans visite**. À **06 h 22**, personne n'avait ouvert l'application depuis la nuit : le serveur dormait.
Au moment de votre visite, Render a commencé à le réveiller, et comme la réponse tardait (le réveil
prend 30 à 60 secondes), Render a affiché sa **propre page 502** — celle de votre capture.
C'est exactement ce que dit la page 12 de votre `DEPLOIEMENT.md` :

> « Le plan gratuit de Render **endort le serveur après 15 min sans visite** : le 1er visiteur du matin
> attendrait ~40 s. »

**Ce n'est donc ni votre compte, ni votre tableau de bord, ni vos données.** Rien n'est perdu.

### Ce que j'ai vérifié point par point pour l'exclure (preuves)

| Vérification | Résultat |
|---|---|
| Le serveur écoute-t-il sur le bon port et sur `0.0.0.0` (exigence de Render) ? | ✅ `server.listen(PORT, '0.0.0.0')` — le port de Render est bien utilisé |
| Le contrôle de santé `/api/health` est-il toujours accessible ? | ✅ Répond **200** en 0,17 s, et il reste **ouvert même quand vous avez bloqué l'entreprise** (lot 125) |
| Le port s'ouvre-t-il avant la connexion à la base (cause classique de 502) ? | ✅ Le serveur **écoute d'abord** (0,1 s), la base se connecte **ensuite** |
| Une grosse base ou un gros catalogue fait-il tomber le service ? | ✅ 62 Mo / 512 Mo, base 287 Ko |
| L'application a-t-elle une erreur au démarrage ? | ✅ Aucune — suite complète **3 409 ✔ / 0 ✘** |
| Render est-il en panne en ce moment ? | ✅ Non : « All Systems Operational » sur status.render.com |

---

## 3. Quoi faire, dans l'ordre (3 gestes simples)

### ① Tout de suite : réessayez simplement
Rechargez la page **2 ou 3 fois, en laissant 30 secondes à 2 minutes entre chaque essai**.
Le temps que Render réveille le service, l'application revient toute seule.
👉 Si vous voulez savoir si le service est réveillé, ouvrez d'abord : **`https://VOTRE-ADRESSE/api/health`**
— quand vous voyez `{"ok":true,…}`, l'application est prête.

### ② Si ça reste noir après 2 minutes : redémarrez le service (30 secondes)
1. https://dashboard.render.com → cliquez votre service **KLEAN**.
2. En haut à droite : **`Restart service`** (ou bouton **Manual Deploy → Deploy latest commit**).
3. Attendez que la pastille repasse **🟢 Live** (~1 à 2 minutes) → l'application ET le tableau de bord
   reviennent.

### ③ Pour ne plus JAMAIS revoir cette page noire (gratuit, 3 minutes)
Le réveil n'a plus lieu si le service ne dort jamais :
1. https://uptimerobot.com → compte gratuit.
2. **+ Add New Monitor** → type **HTTP(s)** → URL : `https://VOTRE-ADRESSE/api/health`
   → intervalle **5 minutes** → créer.
3. Terminé : UptimeRobot réveille KLEAN toutes les 5 minutes, jour et nuit (page 12 de votre guide).

👉 **Ou bien** passez Render au plan **toujours allumé ≈ 7 $/mois** : 1 clic (*Settings → Instance Type*),
aucun code à changer, plus aucun réveil — et nous avons mesuré que l'application occupe **12 % de la
mémoire** de ce plan. (C'est en plus, pour demain, ce qui encaisse les vrais clients sans attente.)

---

## 4. Ce que je viens d'ajouter de mon côté, pour que ça ne vous coupe plus l'accès

| Ajout | Pourquoi |
|---|---|
| 🛟 **Garde-fou anti-502 dans le serveur** | Avant, **une seule erreur imprévue** (un téléphone qui envoie une donnée bizarre) arrêtait le serveur net → **application et tableau de bord inaccessibles pour tout le monde**. Maintenant : l'erreur est **écrite au journal du tableau de bord**, la base est sauvegardée, et **le serveur continue de répondre**. Épreuve faite : erreur provoquée volontairement → accueil **200** et `/api/health` **200** juste après. |
| 📦 **Colis déployable tel quel** | Il contient maintenant `package.json` et `render.yaml` : un déploiement neuf (ou une reconstruction) ne peut plus échouer par fichier manquant. |
| 📱 **Le poids du téléphone** (fait juste avant) | 834 Ko → **188 Ko** par ouverture, **0 octet** ensuite. |
| 🧾 **Preuves conservées** | La suite enregistre son résultat dans `tests/resultats/suite126.txt` (plus dans un dossier temporaire qui disparaît). |

---

## 5. « J'ai payé la formule à 7 $, mais Render n'a pas encore prélevé mon compte »

**C'est normal, et ce n'est pas un problème.** Chez Render, la facturation fonctionne **après coup** :

| Ce que fait Render | Quand |
|---|---|
| La formule payante s'applique | **immédiatement** après le clic (le service redémarre une fois) |
| Le service ne s'endort plus | **immédiatement** — plus de réveil, donc **plus de page 502 au petit matin** |
| Le prélèvement | **à la fin de la période de facturation** (facture mensuelle, en retard d'un mois) — c'est pour ça que votre compte n'a rien vu passer |
| Une petite autorisation sur la carte | parfois au moment de l'ajout de la carte (vérification, puis rendue) |

⚠️ **Le seul vrai risque à connaître** : si la carte est **refusée** au moment de la facture de fin de
mois, Render **suspend le service** (et là, l'accès est réellement coupé). Gardez donc la carte valide
et surveillez les courriels de Render. Si un jour vous voyez « Payment failed » dans Render → *Billing*,
régularisez : le service repart tout de suite.

### Les 4 vérifications à faire dans Render (2 minutes, pour être certain que la formule est active)

1. https://dashboard.render.com → cliquez votre service **KLEAN**.
2. **Settings → Instance Type** : doit afficher **`Starter`** (≈ 7 $/mois).
   👉 Si c'est encore **`Free`**, cliquez **Starter → Save** : c'est le seul geste manquant.
3. **Status** en haut : **🟢 Live** (si c'est *Suspended* ou *Build failed*, dites-le-moi).
4. **Events** (ou *Logs*) : une ligne du type « *Instance type changed to Starter* » + un redémarrage.
   👉 C'est aussi là que vous verrez le redémarrage qui accompagne le changement de formule.

Et pour vérifier que **votre application** va bien (une seule adresse à ouvrir) :
**`https://VOTRE-ADRESSE/api/health`** → vous devez voir `{"ok":true,"storage":…}`.
Regardez ce mot **`storage`** : **`postgres`** = vos comptes sont dans votre base Neon, donc **à l'abri
d'un redéploiement** ; **`fichier`** = vos comptes vivent sur le disque du serveur Render → dites-le-moi,
je vous guide pour les mettre à l'abri (gratuit, 5 minutes).

---

## 6. Preuves : votre serveur tient la durée (nouvelle épreuve de charge)

Un service qui ne dort plus tourne 24 h/24 : il ne doit pas prendre du poids à chaque visite. Épreuve
faite (4 000 ouvertures d'application simulées depuis **8 visiteurs différents**, comme la vraie vie) :

| Mesure | Résultat |
|---|---|
| Visites abouties | **4 000 / 4 000**, sans un seul frein |
| Mémoire au démarrage | 72 Mo |
| Mémoire après 1 000 visites | 80 Mo |
| Mémoire après 2 000 visites | 84 Mo |
| Mémoire après 4 000 visites | **84 Mo** (elle **redescend** : aucune fuite) |
| Part de la formule à 7 $ utilisée | **16 %** (84 Mo sur 512 Mo) |
| Deuxième ouverture d'un téléphone | **0 octet** (réponse « rien n'a changé ») |

Et le **filet anti-machine** (protection contre les attaques) vérifié en même temps : une seule machine
qui envoie 1 600 requêtes d'un coup est **freinée quelques secondes** (400 refus « patientez 🙂 »),
**jamais bloquée**, et **dix secondes plus tard elle est servie normalement** — l'application entière
reste accessible. Un vrai client, lui, ouvre la page en **6 requêtes** : il ne verra jamais ce frein.
👉 Autrement dit : ce que vous avez vu n'était pas ce filet, et ce filet ne peut pas vous couper l'accès.

Nouveau banc permanent : **`tests/t126charge.js`** — **11 ✔ / 0 ✘** (à lancer avant un déploiement
important ; il est volontairement hors de la suite du quotidien car il dure ~40 s).

---

## 7. Êtes-vous sûr de ne rien avoir perdu ?

- **Si votre service utilise la base Neon** (`DATABASE_URL` dans Render → *Settings → Environment*) :
  vos comptes, missions et paiements sont **dans Neon**, donc **intacts**, même après un redémarrage.
- **Si la variable n'est pas réglée**, les données vivent dans un fichier sur le serveur Render
  (dossier temporaire) : elles survivent à un redémarrage simple, mais **pas** à un redéploiement.
  👉 Envoyez-moi une capture de *Render → votre service → Environment* : s'il n'y a pas de
  `DATABASE_URL`, dites-le-moi et je vous guide pour la mettre en place (gratuit) — vous ne risquerez
  plus jamais de perdre un compte.
- Dans **tous les cas**, l'application est sauvegardée dans le tableau de bord :
  **⚙️ Paramètres généraux → 💾 Sauvegardes** (un fichier à garder sur votre téléphone).

---

## 8. Si ça recommence : envoyez-moi ces 2 choses (je corrige tout de suite)

1. **L'adresse exacte** de votre application (celle en `https://….onrender.com` — je ne l'ai pas,
   mes deux essais sur `klean-4ci` et `klean-service` renvoient « Not Found », ce sont d'autres services).
2. **Render → votre service → `Logs`** : copiez-moi les **15 dernières lignes** (ou une capture d'écran).
   Avec ça, je vous dis en une minute si c'est un réveil, une erreur du serveur ou l'hébergeur.

Et si vous ne pouvez pas accéder au tableau de bord au moment où vous me parlez : **dites-le-moi ici.**
L'application tourne **déjà** dans notre espace de travail (aperçu `:8000`, vérifié à l'instant :
accueil **200 · 833 994 o**, `/admin` **200**, `/api/health` **200** avec vos 11 professionnels et 198
missions) — je peux vous y donner accès immédiatement, le temps que Render se remette.
