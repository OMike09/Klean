# Livraison — COLIS 21

**Date :** 25 octobre 2026  
**Évolution :** organisation par grandes catégories, tâches facultatives et parcours de demande modernisé.

## Réalisé

- L’accueil utilise désormais exclusivement `grand_categories` pour **Services populaires**. Les cartes sont uniques, actives, ordonnées par la sélection PDG et ouvrent le détail de la grande catégorie.
- Le bouton **Voir tous les services** ouvre une liste A–Z de seules grandes catégories actives.
- Nouvelle route publique de détail : catégories, métiers/prestations associés et tâches rattachées, avec :
  - **Je choisis mon/mes besoins (facultatif)** ;
  - chemin **Je décris mon besoin** ;
  - choix possible de plusieurs tâches dans la demande, sans obligation de tâche.
- La recherche progressive renvoie séparément les **Grandes catégories** et les **Prestations et tâches**. En l’absence de correspondance, elle propose de décrire le besoin librement.
- Nouveau formulaire client :
  1. `Je décris mon besoin ci-dessous.` ;
  2. photos facultatives, maximum 3 ;
  3. note vocale facultative, maximum 25 secondes ;
  4. ville ;
  5. commune lorsqu’Abidjan est choisi ;
  6. adresse/quartier ;
  7. GPS facultatif ;
  8. disponibilité ;
  9. estimation seulement lorsqu’elle est disponible ;
  10. CTA **Trouver un professionnel**.

  Le brouillon conserve la description, la localisation, les tâches facultatives, les pièces déjà jointes et la disponibilité avant authentification.

- Les cartes de grandes catégories montrent `À partir de X FCFA` seulement lorsqu’une règle active est documentée (`source_note` et `verified_at`), comparable au contexte de la carte et rattachée à au moins une tâche active. Sinon, aucun prix et aucun message `Prix à confirmer` ne sont rendus dans ce parcours.
- Migration SQLite non destructive :
  - `grand_categories.popular` et `popular_sort` ;
  - `taches.description` et `updated_at` ;
  - migration initiale de la sélection historique des prestations populaires vers leurs grandes catégories, exécutée une seule fois.
- Espace PDG renommé **Gestion des catégories et des tâches** : publication/désactivation, création, modification, ordre et suppression protégée des grandes catégories ; sélection/ordre des catégories populaires ; recherche de tâches ; descriptions ; déplacement d’une tâche vers une prestation ; activation/désactivation ; suppression confirmée et bloquée lorsqu’un historique de demande existe.
- Les opérations de catégories, tâches, sélection populaire et suppression sont contrôlées côté serveur et réservées au PDG.
- Le modèle professionnel à grands domaines est conservé : le matching utilise les domaines autorisés et inclut les nouvelles tâches rattachées à ces domaines sans sélection manuelle exhaustive.

## API ajoutées ou adaptées

- `GET /api/grand-categories` — grandes catégories actives A–Z, détail condensé et référence tarifaire fiable éventuelle.
- `GET /api/grand-categories/populaires` — seulement les catégories actives sélectionnées et ordonnées par PDG.
- `GET /api/grand-categories/:id/catalogue` — détail public d’une grande catégorie.
- `GET /api/search` — réponse enrichie avec `categories` et résultats prestations/tâches.
- `PUT /api/admin/grand-categories/populaires/ordre` — ordre persistant PDG.
- `POST|PUT|DELETE /api/admin/taches` — descriptions, déplacement, désactivation et protection d’historique.

## Vérifications exécutées

Sur une base SQLite neuve isolée, serveur port 3121 :

| Harnais | Résultat |
|---|---:|
| `test:update21` | 21/21 |
| `test:update20` | 23/23 |
| `test:update19` | 9/9 |
| `test:update18` | 10/10 |
| `test:update17` | 17/17 |
| `test:update16` | 10/10 |
| `test:update15` | 16/16 |
| `test:update14` | 16/16 |
| `test:update10` | 57/57 |

Les contrôles couvrent notamment : accueil/clic/A–Z/recherche, prix fiable puis absent, sélection et ordre persistants, CRUD PDG et permissions, tâche facultative, protection de l’historique, demande sans tâche et non-régressions principales.

## Service local

Le serveur principal est actif avec le code COLIS 21 sur le port 3000. La sélection populaire locale de démonstration a été rétablie à partir de la configuration historique des prestations, sans créer de liste UI statique.
