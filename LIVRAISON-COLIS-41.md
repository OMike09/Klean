# Livraison COLIS 41 — Catalogue unique synchronisé

## Organisation appliquée

Les parcours publics, professionnels et d’administration utilisent la même chaîne :

`grande catégorie → métier → sous-catégorie → prestation → tâche`

Les racines actives concernées sont :

- Vidange et assainissement ;
- Beauté et coiffure femme ;
- Beauté et coiffure homme ;
- Cours à domicile ;
- Formation et coaching.

La vidange de fosse septique relève de l’assainissement. Les parcours coiffure femme et coiffure homme/barbier sont séparés. Le soutien scolaire va vers les cours à domicile ; formation et coaching sportif vont vers Formation et coaching.

## Synchronisation réelle

- Toute mutation de catalogue émet `catalogue` aux sessions SSE ; le client vide ses caches catalogue et relit la source serveur.
- Les réponses catalogue, détail et recherche portent `sub_id` et `sub_category`.
- Le formulaire professionnel lit le catalogue de compétences central, impose au moins une spécialité et conserve plusieurs sélections cohérentes.
- La direction valide les domaines et les sous-catégories autorisées ; le moteur de dispatch utilise ces droits réels.
- Les anciennes racines ne peuvent ni être recréées ni réactivées via l’API.

## Sûreté des données

La migration est idempotente et auditée. Les services sont déplacés par identifiant : les relations avec les demandes, missions, factures, avis, règles tarifaires, dictionnaires de recherche et historiques sont conservées. Les cas de profils impossibles à classer restent visibles dans la revue dédiée de la direction.

Aucun prix définitif n’a été ajouté dans le code. Les paramètres commerciaux existants restent administrables.

## Contrôles exécutés

- Base SQLite neuve : taxonomie canonique, sans racine héritée active.
- API publique, recherche texte, modification direction et événement SSE.
- Création/validation d’un professionnel barber, droits fins et matching d’une demande homme.
- Lecture catalogue par gestionnaire et agent ; écriture refusée à l’agent non autorisé.
- Parcours navigateur client mobile, professionnel et administration.
- Régression COLIS40.
