# Klean Services — Livraison COLIS 23

**Date :** 25 octobre 2026  
**Objet :** page unique de demande après ouverture d’une grande catégorie

## Résultat livré

Le clic sur une carte de **grande catégorie** ouvre désormais un unique formulaire moderne et responsive. L’ancien écran qui affichait immédiatement une longue succession de tâches a été remplacé sans supprimer le parcours réel de demande existant.

- Le nom de la grande catégorie apparaît une seule fois, dans l’en-tête vert.
- La sélection « **Je choisis mon/mes besoins** » est facultative et compacte. Elle ouvre un panneau de sélection seulement à la demande du client.
- Dans ce panneau, plusieurs tâches sont possibles **au sein d’une même prestation**. Cette limite respecte la validation serveur existante et empêche tout contournement inter-prestations.
- Le texte libre porte le libellé exact : **« Je décris mon besoin ci-dessous. »**
- Le formulaire réunit description, 3 photos maximum, note vocale jusqu’à 25 secondes, ville, quartier/repère libre, adresse, GPS facultatif et disponibilité.
- Le bouton final est exactement : **« Trouver un professionnel »**.
- Le bouton lance le flux réel déjà en place : authentification si nécessaire, contrôle des champs, choix du type de prestataire, création `POST /api/missions`, contrôle anti-doublon et mise en relation serveur.

## Prix et règles métier

- Une référence « À partir de » n’est montrée que lorsqu’une donnée fiable administrée existe pour la grande catégorie.
- L’estimation dynamique reste silencieuse lorsqu’aucun besoin n’est choisi ou lorsqu’aucune règle fiable ne permet un montant pertinent.
- Aucun « Prix à confirmer », montant inventé ou règle tarifaire côté client n’a été ajouté.
- Les plafonds réels restent contrôlés côté serveur : 3 photos, fichiers possédés par le client et note vocale vérifiée avec durée maximale configurée (max. 25 s).

## Brouillons et retour

Les saisies du formulaire de catégorie sont conservées dans `sessionStorage` : description, sélection, lieu, disponibilité, urgence, GPS, photos et note vocale. Le retour arrière conserve donc la demande ; l’authentification tardive ramène également le client vers la même catégorie avec ses données. Le brouillon est supprimé seulement après l’envoi réel réussi.

## Fichiers principaux

| Fichier | Rôle |
|---|---|
| `public/app.js` | rendu du formulaire unique, sélecteur compact, brouillon, validation et réemploi du parcours mission réel |
| `public/category-request.css` | styles isolés, responsive téléphone/tablette/ordinateur |
| `public/index.html` | chargement de la nouvelle feuille de style |
| `public/sw.js` | cache PWA renouvelé `ks-v6-public-shell` et ressource ajoutée |
| `server.js` | auto-diagnostic complété pour la feuille de style publique |
| `public/admin/admin.css` | feuille responsive du tableau de bord restaurée et servie |
| `public/admin/index.html` | liaison de la feuille administrative |
| `public/admin/admin.js` | gestion réelle des grandes catégories populaires et tâches (description/déplacement) conservée |
| `test-update-23.js` | test dédié à la page unique et au parcours mission |

## Validation effectuée sur base neuve

Serveur isolé : `PORT=3123 DATA_DIR=/tmp/klean-colis23-data`.

- COLIS 23 : **9/9**
- COLIS 22 : **11/11**
- COLIS 21 : **21/21**
- COLIS 20 : **23/23**
- COLIS 19 : **9/9**
- COLIS 18 : **10/10**
- COLIS 17 : **17/17**
- COLIS 16 : **10/10**
- COLIS 15 : **16/16**
- COLIS 14 : **16/16**
- COLIS 10 : **57/57**

La syntaxe Node de `public/app.js`, `public/admin/admin.js`, `server.js` et `public/sw.js` a aussi été validée.
