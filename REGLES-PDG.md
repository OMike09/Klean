# 📜 RÈGLES DU PDG — à respecter dans TOUTES les modifications

> Ces consignes viennent du PDG. Elles **survivent aux sessions** : toute modification de
> l'application doit les respecter, et un banc d'essai les vérifie quand c'est automatique.

---

## 🚫 1. LE TOUT PREMIER LOGO NE SE TOUCHE PAS (29/09/2026)

**Consigne du PDG :** « Laisse le tout premier logo à ne pas toucher. »

* **Ce que c'est :** le **logo KLEAN**, la toute première image de l'application —
  l'**écran d'ouverture**, puis l'**en-tête**, le **favicon**, l'**icône d'installation** sur le
  téléphone, et les icônes du tableau de bord.
* **Fichiers concernés (figés par empreinte) :** `klean-icon-512.png`, `klean-icon-192.png`,
  `klean-icon-m512.png`, `hq-icon-192.png`, `hq-icon-512.png`, `hq-icon-180.png`.
* **Règle :** on **ne remplace, ne redimensionne, ne recompresse, ne renomme ni ne supprime** jamais
  ces fichiers — pas même « pour améliorer ». Un changement de logo ne peut être qu'une **décision
  explicite du PDG**.
* **Comment c'est protégé automatiquement :** `tests/logo-fige.json` contient les empreintes
  (sha256), et **`tests/t126logo.js`** refuse toute modification non déclarée (il explique quoi
  faire). Le banc vérifie aussi que le logo est **toujours en place** : écran d'ouverture, en-tête,
  favicon, installation téléphone, slogan juste en dessous, et qu'il **voyage intact** dans le colis
  « A ENVOYER ».

---

## ✍️ 2. LE SLOGAN IMPOSÉ

« **Klean-Services — Tout commence par une mise en relation.** » — partout où le slogan principal
de la plateforme est affiché (application, tableau de bord, pages de connexion, installation sur le
téléphone).

## 👤 3. UN SEUL COMPTE PAR PERSONNE

Tout le monde commence **utilisateur/client** ; « **DEVENIR PROFESSIONNEL** » se demande **sur le
même compte** (jamais un deuxième) ; le même compte peut être **utilisateur + professionnel** et
passer d'un espace à l'autre.

## 🎛️ 4. LE PDG CONTRÔLE TOUT DEPUIS SON TABLEAU DE BORD

Chaque fonctionnalité a **son réglage** (activer / désactiver / configurer / actualiser /
afficher-masquer / mettre en avant / statistiques / utilisateurs / permissions) — **sans modifier le
code**. Le PDG est l'autorité principale ; « le PDG **et** les gestionnaires autorisés » se règle
depuis le HQ (par défaut : PDG seul).

## 💰 5. AUCUN PAIEMENT « RÉUSSI » SANS CONFIRMATION RÉELLE

Un clic sur « J'ai payé » ne rend **jamais** un paiement réussi. 1 paiement = 1 transaction tracée.
Pour les espèces : **prévu → déclaré → confirmé**, et la plateforme n'affirme **jamais** avoir reçu
l'argent qu'elle n'a pas encaissé.

## 🛡️ 6. NE PLUS BLOQUER AUTOMATIQUEMENT (29/09/2026)

La sécurité **observe, compte, prévient** — mais ne coupe **jamais** l'accès d'elle-même : sur un
réseau mobile partagé, cela couperait des milliers de clients innocents. Seul le PDG bloque (motif +
durée), et le blocage global reste le **dernier panneau** du tableau de bord.

## 🔐 7. CONFIDENTIALITÉ ÉCOLE-FAMILLE

Un parent ne voit **que ses enfants** et **que ce qui le concerne** — jamais un autre enfant, jamais
une autre famille. Une école **non validée** n'a **aucun** accès aux fonctions professionnelles.

## 🧰 8. UNE SEULE SOURCE DE SERVICES, SANS DOUBLON

Aucun service du tableau de bord ne doit être invisibles côté utilisateur s'il est activé et destiné à
l'affichage ; aucun service désactivé ne doit continuer d'apparaître ; jamais de doublon.

---

**Rappel d'usage :** après **chaque** modification, lancer `bash tests/lancer-tout.sh` (suite
complète) — elle vérifie ces règles et prévient si quelque chose de l'existant s'est cassé.
