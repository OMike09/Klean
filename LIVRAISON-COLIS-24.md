# Klean Services — Livraison COLIS 24

**Date :** 25 octobre 2026  
**Objet :** suppression de la répétition du nom de catégorie dans le sélecteur de besoins

## Correction livrée

La capture signalait que le nom de la catégorie « Nettoyage & entretien » était répété dans chaque ligne du sélecteur natif de prestations. Cette répétition a été supprimée.

Après le clic sur **« Je choisis mon/mes besoins »** :

1. le panneau ouvre directement la liste des besoins/tâches correspondants ;
2. les tâches sont organisées sous leur seule **prestation** (par exemple « Ménage à domicile »), sans préfixer chaque ligne par le nom de la grande catégorie ;
3. une recherche reste disponible dans le panneau ;
4. les cases de sélection et les sélections multiples sont conservées ;
5. la contrainte réelle de l’API est conservée : plusieurs tâches sont possibles au sein d’une même prestation, jamais entre prestations différentes.

Le nom de la grande catégorie reste affiché une seule fois, dans l’en-tête vert de la page. Aucun changement n’a été fait au catalogue en base, aux tâches existantes, à l’authentification ou à la création réelle des missions.

## Expérience et compatibilité

- Les groupes de tâches ont un intertitre de prestation court et aéré.
- La liste reste scrollable dans sa fenêtre compacte afin de ne pas allonger la page de demande.
- Le rendu est adapté au téléphone, à la tablette et à l’ordinateur.
- Le cache PWA est passé à `ks-v7-public-shell`, afin que les appareils déjà installés reçoivent le nouveau JavaScript et style.

## Fichiers modifiés

| Fichier | Rôle |
|---|---|
| `public/app.js` | remplace le menu de prestations répétitif par la liste directe, groupée et recherchable des tâches |
| `public/category-request.css` | ajoute les groupes visuels de prestations |
| `public/sw.js` | renouvellement du cache PWA (`v7`) |
| `test-update-24.js` | test dédié à l’absence de répétition et au parcours réel de mission |
| `package.json` | script `test:update24` |

Les fichiers de compatibilité PWA et de modernisation existants ont été actualisés dans leurs assertions de test.

## Validation sur base neuve

Serveur isolé : `PORT=3124 DATA_DIR=/tmp/klean-colis24-data`.

- COLIS 24 : **5/5**
- COLIS 23 : **9/9**
- COLIS 22 : **11/11**
- COLIS 21 : **21/21**
- COLIS 20 : **23/23**
- COLIS 19 : **9/9**
- COLIS 18 : **10/10**
- COLIS 17 : **17/17**
- COLIS 16 : **10/10**
- COLIS 15 / 14 : **16/16**
- COLIS 10 : **57/57**
