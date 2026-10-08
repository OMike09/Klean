# Klean Services — Mise à jour COLIS N°7

Ce colis **complète l’application existante** : il ne reconstruit pas les fonctions déjà livrées (missions, paiement/commission, quiz, bandeau, publicité, dashboard, etc.).

## 1. Marque, lancement et iPhone

- Nom harmonisé dans l’application, le dashboard, les messages et le manifeste : **Klean Services** (sans « CI »).
- Logo : remplacé ensuite par le symbole goutte vert fourni par le client ; voir le complément cumulatif `LIVRAISON-COLIS-8.md`. Il est installé dans `public/logo.png` et décliné pour les icônes PWA 192/512 px.
- Écran de lancement vert : logo, nom, texte « Exprimez votre besoin, un professionnel arrive. » ; délai minimum d’environ 1 seconde au démarrage.
- `viewport-fit=cover`, zones sûres haut/bas/gauche/droite, `100dvh`, barre basse et modales adaptées aux encoches / Dynamic Island.
- Taille minimale des champs à 16 px pour éviter le zoom iOS ; dispositions compactes pour petits écrans.
- Le bouton Retour est celui déjà unifié dans les en-têtes de tous les écrans secondaires ; les cinq écrans racines de la barre basse n’ont volontairement pas un deuxième bouton Retour.

## 2. Catalogue et prix

- L’accueil recharge les services et prix depuis l’API à chaque ouverture, avec la ville du compte.
- Un contrôle toutes les 25 secondes actualise l’accueil déjà ouvert lorsqu’un prix est modifié au dashboard.
- Catalogue, recherche et demande reçoivent également les prix de l’API ; aucun prix d’accueil n’est dupliqué dans le code client.
- Prix conservés en rouge (`#dc2626`).

## 3. Contact Klean Services

- Dans **Compte** : `📩 Contacter Klean Services`.
- Choix initial : `💡 Suggestion` ou `⚠️ Préoccupation`.
- Tables dédiées : `support_conversations` et `support_messages`, indépendantes des conversations de missions.
- À la création, le client voit son message et une réponse automatique :
  - suggestion : « Merci pour votre suggestion. Nous l’avons bien reçue et nous en tiendrons compte. »
  - préoccupation : « Nous avons bien reçu votre préoccupation. Un agent Klean Services vous contactera dans peu de temps. »
- Conversation privée, statut ouverte/fermée, réponse client et réponse d’équipe synchronisée par SSE chez le client.
- Dashboard : nouvelle entrée **📩 Messages Klean Services** ; liste, filtres Suggestion/Préoccupation, lecture, réponse, fermeture/réouverture. Une conversation ouverte est rafraîchie toutes les 5 secondes pour faire apparaître un nouveau message client sans rechargement manuel.

## 4. Demandes et professionnels

- Une demande accepte maintenant plusieurs tâches du même service. Chaque tâche peut comporter une précision facultative.
- Le serveur vérifie que chaque identifiant de tâche appartient au service demandé, enregistre les tâches dans `missions.taches` et conserve `missions.tache` pour la compatibilité historique.
- Les tâches apparaissent clairement dans la demande client et chez le professionnel.
- Sélection des services pro réorganisée en catégories repliables, identiques au catalogue client ; sélection multiple conservée.
- Nouveau réglage pro : `📍 Changer mon lieu de service`. Il est distinct de la ville d’inscription.
- Le dispatch compare le lieu de service actuel avec la ville du client ; quand les deux GPS sont présents, une proximité de 50 km garde le professionnel éligible.
- Les notifications d’opportunité professionnelle existantes sont conservées.

## 5. Notes vocales

- Enregistrement via `getUserMedia` et `MediaRecorder` avec formats négociés : `audio/mp4` prioritaire sur iPhone, puis WebM/Opus.
- Message clair si l’autorisation microphone est refusée ou si le navigateur ne prend pas en charge l’enregistrement.
- Dans une demande : arrêt, téléversement, écoute avant envoi de la demande.
- Dans la conversation de mission : arrêt, écoute dans une fenêtre de prévisualisation, puis envoi explicite ou suppression.
- Lecture via élément audio natif côté destinataire ; téléversement M4A accepté et testé par API.

## 6. Villes et ciblage des publicités

- Ajout des 13 communes sous le format `Abidjan / Commune` : Abobo, Adjamé, Anyama, Attécoubé, Bingerville, Cocody, Koumassi, Marcory, Plateau, Port-Bouët, Songon, Treichville, Yopougon.
- L’ancienne valeur générique « Abidjan » est conservée dans les profils historiques mais retirée des listes actives.
- Le dashboard Publicités propose : `🌍 Toute la Côte d’Ivoire` ou `📍 Une ou plusieurs villes`, puis une liste multi-sélection.
- Les zones sont validées au serveur et enregistrées dans `ads.zones` (et `ad_campaigns.zones`).
- `/api/ads` filtre réellement les publicités par ville du compte ; une commune d’Abidjan est distincte d’une autre commune. Une zone historique générique « Abidjan » couvre toutefois les communes pour ne pas perdre les anciennes campagnes.

## Migration additive

Les migrations sont non destructives : ajout de `missions.taches`, `pro_profiles.service_city`, `ads.zones`, `ad_campaigns.zones`, tables de support et communes actives. Les données, missions, messages et campagnes existantes sont conservées.

## Vérifications effectuées

- Syntaxe : `node --check db.js`, `server.js`, `public/app.js`, `public/admin/admin.js`.
- Régression complète existante : **70 / 70 tests réussis** sur base fraîche.
- Nouveau parcours API COLIS 7 : **18 / 18 réussis** sur base fraîche : communes, ciblage ville/pays, refus zone invalide, prix dashboard → API client, conversation suggestion/préoccupation et réponse équipe, confidentialité, lieu de service pro, deux tâches par demande, dispatch localisé et note vocale M4A.
- Les adaptations iPhone ont été vérifiées au niveau code responsive/safe-area et des flux API. Une validation sur un **iPhone physique** reste à faire après déploiement (autorisation microphone Safari et installation PWA ne peuvent pas être simulées par les tests serveur).
