# Klean Services — LIVRAISON COLIS 29

**Date :** 30 octobre 2026  
**Objet :** Braderie d’articles réelle + bande défilante d’accueil fluide et pilotable par le PDG.

## Contenu livré

### 1. Braderie d’articles

- Nouvelle entrée **« 🏷️ Braderie d’articles »** sur l’accueil, strictement placée entre **« Trouver ou proposer un job »** et **« Avis de recherche »**.
- Réglage PDG de visibilité de cette entrée : elle est masquée de l’accueil lorsque le PDG le demande.
- État initial sans données de démonstration : la Braderie est **désactivée**, mais l’entrée demeure visible par défaut. Son clic affiche exactement :
  > « La braderie d’articles n’est pas encore opérationnelle. Elle pourra être activée à tout moment. Merci de votre compréhension. »
- Publication réelle par un compte connecté : image obligatoire, titre, description, prix FCFA, ville d’inscription, quartier libre, téléphone, lien facultatif, état et diffusion locale/nationale.
- Téléversements vérifiés côté serveur : une image doit appartenir au compte déposant et être reconnue comme image dans le registre de fichiers.
- Validation PDG obligatoire avant toute visibilité publique.
- Consultation moderne : recherche textuelle, ville, quartier, prix min/max, état, tri récent/prix et articles disponibles uniquement.
- Gestion vendeur : consultation de ses articles, correction d’un brouillon/refusé, marquage « vendu » confirmé, fermeture des offres et conservation de l’historique.
- Gestion PDG : validation, refus motivé, modification contrôlée, suspension, retrait logique non destructif, expiration, réactivation, signalements/fraudes, demandes de contact et statistiques.

### 2. Confidentialité et négociation

- Le mode par défaut est **« Contact via Klean Services »**.
  - `contact_phone` et `external_link` ne figurent alors dans **aucune réponse publique** de liste ou détail ; ils ne sont pas seulement masqués par CSS.
  - Les demandes de contact sont enregistrées, visibles et traitables dans le dashboard PDG ; elles sont transmises par notification sans divulgation automatique du numéro.
- Le mode PDG **« Contact direct vendeur »** autorise explicitement l’exposition du téléphone ; le lien reste contrôlé par son réglage dédié.
- Offres FCFA persistées : offre acheteur, contre-proposition vendeur, dernier prix vendeur, unique dernière proposition acheteur, acceptation/refus et historique accessible aux seules parties concernées et au PDG.
- Notifications enregistrées à chaque étape importante.

### 3. Quotas et règles réellement appliqués

Toutes les limites ci-dessous sont contrôlées par l’API et SQLite, jamais seulement dans l’interface :

- activation et visibilité accueil ;
- conditions de publication ;
- quota de publications par client et plateforme, selon jour/semaine/mois/année ;
- nombre maximal de photos ;
- quota de propositions selon période ;
- durée avant expiration ;
- ville de publication imposée à la ville inscrite du vendeur ;
- disponibilité, vente, suspension, suppression logique, expiration et blocage d’offres.

### 4. Bande défilante

- Remplacement du mécanisme de répétition interrompu par un ruban mesuré après rendu : le premier segment est allongé jusqu’à couvrir l’écran, dupliqué une seule fois, puis translaté exactement de 50 %. La boucle revient donc sur un contenu identique, sans blanc ni saut.
- Aucune reconstruction du DOM tant que la configuration reçue de l’API n’a pas changé ; l’animation ne redémarre plus toutes les 12 secondes.
- Synchronisation accueil toutes les 5 secondes, sans cache API.
- Responsive mobile et ordinateur, pause tactile/survol, espace réservé afin de ne pas masquer le contenu.
- Le dashboard PDG **« 📺 Gestion bande défilante »** configure réellement :
  - activation, vitesse, hauteur, bordure ;
  - fond, couleur, taille et graisse du texte ;
  - présentations classique, colorée, icônes, image, moderne ;
  - animations continu, glissement et fondu ;
  - aperçu direct ;
  - messages multiples, ordre, icône, image, couleur, durée individuelle, lien et activation.
- En fondu, la durée individuelle de chaque message est réellement utilisée ; le réglage global constitue la valeur de repli.

## Données et sécurité

Nouvelles tables SQLite :

- `braderie_items`
- `braderie_negotiations`
- `braderie_negotiation_events`
- `braderie_contact_requests`
- `braderie_reports`

Les états sont historisés. Une suppression d’article est logique, donc ne détruit pas les offres, notifications ou éléments d’audit existants.

Les 30 JPEG de catégories COLIS 28 ont aussi été restaurés dans `public/category-images/` depuis l’archive validée, afin de préserver les cartes illustrées existantes.

## Fichiers principaux modifiés

- `db.js` — migration et réglages COLIS 29.
- `server.js` — API publique, API authentifiée, API PDG, sérialiseurs confidentiels, quotas, offres, médias publics publiés et bandeau.
- `public/app.js` — accueil, Braderie, publication, consultation, vente, offres, contact, signalement et ruban fluide.
- `public/admin/admin.js` — rubriques PDG de gestion du bandeau et de la Braderie.
- `package.json` — commandes de test COLIS 29.
- `test-colis29.js` — contrôle API réel.
- `test-colis29-ui.js` — contrôle Playwright réel.

## Vérifications exécutées

Sur le serveur local `http://127.0.0.1:3132` :

1. `npm run test:update29` : **31/31, failed=0**
   - activation/règles, publication, validation, modification PDG ;
   - confidentialité API Klean ;
   - photo publiée ; quotas ; négociation complète ; demande de contact ; signalement ; vente ; réactivation ; permissions PDG ; bandeau configuré et exposé publiquement.
2. `npm run test:update29:ui` : **18/18, failed=0**
   - bureau, Pixel 7 et iPhone 13 ; ordre des raccourcis ; animation effective ; aucun débordement ; aucune erreur JavaScript ; Braderie active et état désactivé exact ; deux dashboards PDG.
3. `KLEAN_TEST_BASE=http://127.0.0.1:3132 npm run test:update28` : **8/8, failed=0**.
4. `node test-category-images-ui.js http://127.0.0.1:3132` : **33/33, failed=0**.
5. Syntaxe vérifiée : `db.js`, `server.js`, `public/app.js`, `public/admin/admin.js`, tests COLIS 29.

Les tests créent des comptes, fichiers et articles de contrôle puis les suppriment. État final contrôlé : **0 article Braderie de test, 0 négociation de test, 0 demande de contact de test, 0 signalement de test, 0 compte de test COLIS 29**.

## Mise en service

Après déploiement Render, le PDG active la fonctionnalité depuis :

`Dashboard PDG → Contenu → 🏷️ Braderie d’articles`

Puis, si souhaité, règle le ruban depuis :

`Dashboard PDG → Communication → 📺 Gestion bande défilante`
