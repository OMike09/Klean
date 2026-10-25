# Livraison — COLIS 22

**Date :** 25 octobre 2026  
**Objet :** modernisation visuelle et responsive de Klean Services, sans supprimer de fonction ni modifier les règles métier.

## Modernisation livrée

### Application client

- Nouvelle couche `public/modern-ui.css`, ajoutée au-dessus des styles existants : elle conserve les couleurs Klean Services (`#0b7a6b`, vert profond et rouge prix) tout en uniformisant les surfaces, ombres, rayons, contrastes et espacements.
- En-tête, navigation basse, cartes, listes, catégories, recherche, formulaires, boutons, statuts, messages, fenêtres et notifications harmonisés.
- Boutons avec zones tactiles robustes, état focus visible, retour visuel au survol sur ordinateur et états désactivés lisibles.
- Protection des textes longs et des débordements horizontaux dans les cartes, listes et résultats de recherche.
- Ajustements explicites pour petits écrans (dont iPhone SE/Android compacts), tablettes et ordinateurs : grilles adaptatives, espacement progressif, largeur utile accrue sur grand écran et formulaires gardés lisibles.
- Respect des encoches/safe areas iPhone, de la taille minimale de police sur mobile et du paramètre système `prefers-reduced-motion`.
- Navigation principale améliorée avec boutons `type="button"`, libellés ARIA pour notifications et navigation basse.

### Administration

- Nouvelle feuille `public/admin/admin.css` pour un tableau de bord plus professionnel : menu latéral, entêtes, cartes KPI, panneaux, tableaux, contrôles, modales et alertes modernisés.
- Menu mobile coulissant, recherche globale adaptable, tableaux conservés dans des conteneurs défilables, formulaires et modales ajustés pour téléphone/tablette.
- Le menu reprend l’intitulé **Gestion des catégories et des tâches**.

### Chargement et stabilité

- Les styles modernes client et administration sont déclarés dans leurs pages HTML respectives.
- Le cache PWA est passé à `ks-v5-public-shell` et inclut `modern-ui.css`, afin que les appareils installés récupèrent la nouvelle présentation sans mettre en cache les API ou données privées.
- Les nouveaux fichiers UI font partie du contrôle de structure serveur (`REQUIRED_FILES`).
- Aucun appel navigateur vers `localhost` n’a été ajouté : les API restent relatives et compatibles avec Render.

## Préservation des fonctions

Les routes, API, formulaires, contrôles serveur, comptes, professions, demandes, tarif fiable, catégories et tâches du COLIS 21 sont conservés. Les modifications sont exclusivement de présentation, d’accessibilité et de robustesse de navigation.

## Vérifications exécutées

| Vérification | Résultat |
|---|---:|
| Syntaxe `server.js`, client, admin, service worker | OK |
| `test:update22` — UI responsive, PWA, ressources, navigation, APIs | **11/11** |
| `test:update21` — catégories, tâches et demande | **21/21** |
| `test:update20` — tarifs/urgence/lieux/formulaire | **23/23** |
| `test:update19` — accès public et PWA | **9/9** |
| `test:update18` — historique et protection des brouillons | **10/10** |

Les tests COLIS 20 et 21 ont été rejoués sur une base neuve isolée (port 3122). Le serveur principal est actif sur le port 3000.
