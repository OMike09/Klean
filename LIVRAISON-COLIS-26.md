# Klean Services — Livraison COLIS 26

**Date :** 26 octobre 2026  
**Objet :** passage à 30 grandes catégories professionnelles et libellés courts adaptés aux cartes mobiles.

## Décision de classement

Les intitulés ont été séparés en deux niveaux :

- **Nom complet** : conservé pour l’administration, la recherche et la description métier.
- **Libellé court** : affiché sur les cartes, menus et en-têtes étroits afin de ne couper aucun texte sur téléphone.

Le PDG peut modifier les deux valeurs depuis l’éditeur de grande catégorie. Le champ court est enregistré en base (`grand_categories.short_label`) et n’est pas seulement une adaptation visuelle.

## Les 30 catégories actives

| # | Libellé dans l’application | Nom complet / périmètre |
|---:|---|---|
| 1 | Nettoyage | Nettoyage et entretien |
| 2 | Plomberie | Plomberie |
| 3 | Électricité | Électricité et domotique |
| 4 | Bâtiment | Bâtiment et construction |
| 5 | Menuiserie | Menuiserie et aluminium |
| 6 | Clim & froid | Climatisation et froid |
| 7 | Transport | Transport et déménagement |
| 8 | Auto & moto | Mécanique et automobile |
| 9 | Numérique | Informatique et téléphonie |
| 10 | Beauté & bien-être | Beauté, coiffure et bien-être |
| 11 | Couture & mode | Couture et mode |
| 12 | Cuisine & traiteur | Restauration et alimentation |
| 13 | Jardinage | Jardinage et espaces verts |
| 14 | Sécurité | Sécurité et surveillance |
| 15 | Aide à domicile | Aide à domicile et services familiaux |
| 16 | Événementiel | Événementiel |
| 17 | Services pro | Services professionnels et administratifs |
| 18 | Cours & formation | Cours et formation |
| 19 | Agriculture | Agriculture et élevage |
| 20 | Artisanat | Artisanat et réparations diverses |
| 21 | Ferronnerie | Ferronnerie et soudure |
| 22 | Solaire & énergie | Énergie solaire et secours électrique |
| 23 | Électroménager | Électroménager et appareils domestiques |
| 24 | Vitrerie | Vitrerie et miroiterie |
| 25 | Imprimerie | Imprimerie et signalétique |
| 26 | Photo, vidéo & son | Photo, vidéo et sonorisation |
| 27 | Toiture & étanchéité | Toiture et étanchéité |
| 28 | Eau & forage | Forage et traitement de l’eau |
| 29 | Entretien auto | Entretien automobile |
| 30 | Immobilier | Immobilier et conciergerie |

## Contenu réel, sans doublon de catalogue

- **Ferronnerie** reprend les prestations existantes de métallerie et soudure : portails, grilles, rampes, ouvrages métalliques et réparations par soudage.
- **Électroménager**, **vitrerie**, **photo/vidéo** et **entretien auto** reclassent des métiers et tâches existants sans recréer leurs identifiants.
- **Solaire & énergie** conserve les prestations solaires existantes et complète le catalogue avec l’installation/entretien des groupes électrogènes.
- **Imprimerie** isole les supports imprimés de la communication numérique et ajoute les enseignes/signalétique.
- **Toiture & étanchéité**, **eau & forage** et **immobilier** reçoivent des sous-catégories, prestations et tâches centrales réelles, administrables par le PDG.
- Une catégorie active n’est jamais laissée vide : chacune possède au moins une prestation réelle.

Les nouveaux domaines ont été retenus après vérification de leur présence chez des professionnels et annuaires ivoiriens : ferronnerie/métallerie, solaire/générateurs, électroménager, vitrerie, imprimerie-signalétique et immobilier. Les sources sont à conserver pour le choix de domaines ; elles ne servent pas à afficher des prix client.

## Migration et compatibilité

- Migration non destructive `colis26_catalogue30_structure_v1`.
- Les services, tâches, questions et missions gardent leurs identifiants ; seul leur rattachement à la grande catégorie est organisé.
- Les profils professionnels déjà autorisés dans une ancienne catégorie large reçoivent également l’autorisation de la nouvelle racine correspondante. Leurs droits de réception de missions sont préservés.
- L’ancienne racine historique `Autres services` est conservée dans la base mais désactivée après transfert vers `Artisanat et réparations diverses` lorsqu’elle coexiste avec cette nouvelle racine. Elle ne crée donc pas une 31e carte active.
- Le PDG reste le seul à pouvoir créer ou modifier les catégories et leurs libellés courts via les routes sécurisées existantes.

## Fichiers mis à jour

| Fichier | Rôle |
|---|---|
| `db.js` | migration catalogue 30, libellé court, transferts de métiers/services et conservation des autorisations pro |
| `server.js` | exposition et CRUD sécurisé de `short_label` |
| `public/app.js` | rendu compact des grandes catégories sur les cartes, menus et en-têtes |
| `public/admin/admin.js` | champ PDG « Libellé court », maintien de l’édition/téléversement d’image |
| `public/admin/index.html`, `public/admin/admin.css` | restauration et contrôle de la couche responsive du dashboard |
| `test-update-23.js`, `test-update-24.js` | assertions adaptées au libellé compact |
| `test-update-26.js` | test E2E dédié aux 30 catégories |
| `package.json` | script `test:update26` |

## Validation

Sur base neuve :

- COLIS 26 : **7/7**
- COLIS 25 : **13/13**
- COLIS 24 : **5/5**
- COLIS 23 : **9/9**
- COLIS 22 : **11/11**
- COLIS 21 : **21/21**
- COLIS 20 : **23/23**
- COLIS 19 : **9/9**
- COLIS 18 : **10/10**
- COLIS 17 : **17/17**
- COLIS 16 : **10/10**
- COLIS 14/15 : **16/16**
- COLIS 10 : **57/57**

Commande de vérification dédiée :

```bash
DATA_DIR=/tmp/klean-colis26-data PORT=3129 node server.js
KLEAN_TEST_BASE=http://127.0.0.1:3129 npm run test:update26
```

---

## Complément intégré au COLIS 26 — photos et recherche en langage courant

> Cette section complète le même COLIS 26. Aucune image générée n’a été ajoutée, sélectionnée ou associée aux catégories. Les visuels historiques déjà présents restent inchangés ; le PDG peut maintenant importer les vraies photos au moment voulu.

### 1. Photo indépendante par grande catégorie

Depuis **PDG → Tarifs et estimations intelligentes → Grandes catégories centrales → Modifier** :

- le PDG choisit une photo JPG, PNG ou WebP ; un **aperçu local** apparaît immédiatement et n’est pas publié tant que « Enregistrer et publier » n’a pas été pressé ;
- l’import prépare l’image dans le navigateur (maximum 1 400 × 1 050, JPEG optimisé) afin de limiter le poids sur téléphone et de garder un cadrage adapté aux cartes ;
- la photo est enregistrée dans `grand_categories.image_url`, donc elle persiste après actualisation et reconnexion ;
- une nouvelle importation remplace l’association de la catégorie ; le rendu accueil et les autres retours du catalogue la récupèrent automatiquement via l’API centrale ;
- « Supprimer la photo », suivi de l’enregistrement, retire uniquement l’association visuelle sans supprimer la catégorie, ses services, ses missions ou le fichier selon le cycle de conservation existant ;
- le serveur refuse une référence `/uploads/` qui ne correspond pas à une image active du registre. Seul le PDG peut modifier l’association. Une image publiée d’une catégorie active est l’unique exception publique ; les médias de missions restent privés.

Les images de carte gardent `loading="lazy"` et `object-fit: cover` dans le rendu client. Les opérations d’import, de remplacement et de retrait restent utilisables dans la modale responsive du dashboard (boutons en colonne sur téléphone).

### 2. Recherche familière, fautes et descriptions

Le moteur s’appuie désormais sur le dictionnaire central `search_dictionary_entries`. Cette table ne duplique pas le catalogue : chaque expression référence une vraie grande catégorie, un métier, une sous-catégorie, une prestation ou une tâche. Les expressions historiques de `service_search_terms` sont projetées automatiquement et sans perte dans ce dictionnaire au démarrage.

Le préchargement éditable comprend notamment :

- **plomberie** : « mon eau coule », « robinet qui goutte », « wc bouché », « canalisation bouchée » ;
- **électricité** : « plus de courant », « lumière ne s’allume pas », « disjoncteur saute », « prise ne marche plus » ;
- **climatisation** : « clim chaude », « clim souffle chaud », « ne refroidit plus », « gaz clim fini » ;
- **nettoyage** : « maison à faire briller », « nettoyer chez moi », « grand nettoyage maison » ;
- **auto/moto** : « moto ne démarre pas », « voiture en panne », « batterie morte », « panne sur la route » ;
- **bâtiment/rénovation** : « arranger ma maison », « mur abîmé », « toit fuit », « repeindre mur ».

La recherche utilise les termes officiels, descriptions, mots-clés, tâches, fautes proches et expressions du dictionnaire. Les mots communs isolés ne prennent plus le dessus sur une formulation complète. Lorsqu’une phrase reconnaît précisément un besoin, les résultats faibles sans rapport sont retirés ; lorsqu’il existe plusieurs domaines plausibles, ils restent classés et aucun besoin n’est sélectionné automatiquement. En cas de formulation trop vague, l’API fournit une question courte demandant par exemple l’appareil, la pièce ou le problème concerné.

Cette logique est disponible :

- sur la recherche d’accueil et l’écran de recherche ;
- dans le sélecteur de besoins après ouverture d’une grande catégorie (les alias sont transmis avec les tâches du catalogue) ;
- pendant la description d’une demande : des suggestions à confirmer sont proposées, sans choix imposé ;
- pour tout texte transcrit depuis un message vocal via la même fonction de traitement (`applyTranscribedNeed`) ; aucune transcription automatique fictive n’a été ajoutée.

L’API publique accepte aussi `context_category_id` dans `/api/search` pour limiter les suggestions à la grande catégorie déjà choisie.

### 3. Administration PDG du dictionnaire

Dans **PDG → Tarifs et estimations intelligentes → Dictionnaire de recherche**, le PDG peut sans code :

1. ajouter une expression, synonyme, faute ou tournure familière ;
2. choisir sa destination parmi grande catégorie, métier, sous-catégorie, prestation ou tâche ;
3. modifier à la fois le texte, la destination et l’état ;
4. activer/désactiver une expression sans effacer son historique ;
5. supprimer une expression devenue inutile.

Les validations côté serveur vérifient les clés du catalogue, l’appartenance d’une tâche à sa prestation et empêchent les doublons expression/destination. Les routes d’écriture restent exclusivement PDG.

### Validation complémentaire

Sur base neuve, le test `test-update-26-complement.js` valide **8/8** : sécurité PDG, publications/retraits d’images, persistance catalogue, sept formulations impératives, résultats ambigus, et cycle complet d’une expression (création, changement de cible, activation/désactivation, suppression).

Commande :

```bash
DATA_DIR=/tmp/klean-colis26-complement PORT=3129 node server.js
KLEAN_TEST_BASE=http://127.0.0.1:3129 npm run test:update26:complement
```

Les régressions COLIS 10, 14 à 26 restent validées sur la même base neuve (COLIS 10 : 57/57 ; COLIS 25 : 13/13 ; COLIS 26 catalogue : 7/7 ; complément : 8/8).
