# Livraison — COLIS 20

**Date :** 25 octobre 2026  
**Objet :** urgences institutionnelles, parcours de demande géolocalisé et gestion tarifaire fiable.

## Résultat livré

Cette mise à jour étend l’application existante sans retirer les missions, transactions, règles de commission, catalogue, historique ni parcours publics précédents.

### 1. Répertoire public des urgences

Le répertoire est maintenant stocké en base dans `emergency_contacts` et non dans une liste libre de paramètres. Il est consultable publiquement dans **Urgences**, en deux sections avec liens `tel:` :

- **Urgences vitales** : Police nationale `170`, `110`, `111` ; Gendarmerie `145` ; GSPM `180`, `01 01 80 13 28`, `01 03 01 90 94` ; SAMU CI `185` ; ONPC `07 89 32 32 32`, `05 74 32 32 32`, `01 50 32 32 32` ; Police secours `100`, `07 78 43 76 46`, `01 03 79 91 44`.
- **Services publics et assistance** : CIE `179`, SODECI `175`, Allô Gouvernement `101`, Centre d’appels Gouvernement `27 22 59 90 00`.

Chaque entrée publique comporte son organisme source, URL, date de source lorsqu’elle est publiée, date de vérification (25/10/2026) et dernière modification. Aucun contact Klean fictif n’est affiché.

**Sources enregistrées :**

- ONPC, communiqué du 29/06/2026 : Police, Gendarmerie, GSPM, ONPC, Police secours et Centre d’appels Gouvernement.
- Ministère des Affaires étrangères, « Numéros utiles » : `180`, `185`, `100`.
- CIE, Centre de relation client : `179`.
- SODECI, Centre de relation client : `175`.
- Gouvernement / Ministère de la Communication : Allô `101`.

> Transparence : l’attribution ONPC récente de `170`, `110`, `111` à la Police nationale est affichée avec une note de divergence. La page diplomatique consultée le 25/10/2026 classe `110`, `1111`, `170` sous la gendarmerie. L’application ne prétend donc pas lever cette contradiction.

Le PDG gère les contacts dans **Sécurité → Urgences** : ajout avec source HTTPS/date obligatoire, modification, désactivation/restauration et historique par contact. Les routes sont protégées côté serveur par rôle PDG.

### 2. Nouveau parcours de demande

Le parcours client est maintenant dans cet ordre :

1. service puis tâche ;
2. champ obligatoire exact : **« Décrivez votre tache ou ce que vous voulez. »** ;
3. ville d’intervention ;
4. commune obligatoire uniquement si la ville est Abidjan ;
5. estimation concise.

La position GPS reste un complément de repérage : elle ne sélectionne ni ne remplace jamais la ville. Les limites existantes sont conservées : **3 photos maximum** et **25 secondes maximum** pour la note vocale.

La liste centrale sépare désormais Abidjan de ses 13 communes : Abobo, Adjamé, Anyama, Attécoubé, Bingerville, Cocody, Koumassi, Marcory, Plateau, Port-Bouët, Songon, Treichville et Yopougon. Les anciennes valeurs historiques `Abidjan / …` restent interprétables pour les anciens profils/demandes ; elles ne sont plus proposées à la saisie.

### 3. Politique tarifaire

- Les cartes accueil, populaires, catégories, prestations, résultats de recherche et listes ordinaires ne reçoivent plus de prix ni de réglage tarifaire par API.
- Le bloc client reste vide jusqu’à tâche + description + lieu complet. Il n’affiche alors strictement que :
  - `À partir de X FCFA`, ou
  - `Prix à confirmer`.
- Aucun intervalle, source, mention « provisoire », justification, commentaire ou texte autour du prix n’est affiché au client.
- Les anciens montants des missions/paiements engagés sont conservés dans leurs écrans financiers dédiés.
- Les valeurs historiques `services.price_from` sont conservées en base mais ne sont plus utilisées comme une pseudo-référence de marché.

Le moteur partagé par l’aperçu et la création de mission utilise, dans cet ordre :

1. règles tarifaires PDG documentées ;
2. références locales vérifiées ;
3. médiane d’historiques réellement payés, suffisamment nombreux et comparables ;
4. sinon `Prix à confirmer`.

Une commune ne crée aucune majoration/minoration automatique. Elle ne peut modifier un résultat que lorsqu’une règle PDG/référence validée la vise explicitement, ou lorsqu’un historique comparable de cette commune existe. Une règle peut viser plusieurs villes avec une liste séparée par des virgules.

### 4. Gestion PDG des tarifs

La rubrique PDG est renommée **Gestion des tarifs**. Elle centralise règles, références, ville(s), commune facultative d’Abidjan, provenance, URL éventuelle, date source, date de vérification, aperçu et historique.

- les règles doivent avoir une cible, un montant, une provenance vérifiable et une date de vérification ;
- ajout, modification, désactivation et restauration sont historisés dans `price_estimation_rule_history` ;
- la suppression API d’une règle réalise une désactivation ;
- une règle modifiée n’altère jamais une mission existante : la mission conserve son estimation/snapshot au moment de sa création.

Les villes et communes sont administrées depuis la même source centrale dans **Services & catégories → Villes**. Les routes de gestion tarifaire restent contrôlées serveur PDG ; les routes villes/communes sont contrôlées par la permission catalogue.

## Migrations non destructives

Ajouts :

- tables `communes`, `emergency_contacts`, `emergency_contact_history`, `price_estimation_rule_history` ;
- colonne `missions.intervention_commune` ;
- réactivation de la ville centrale Abidjan et conversion des anciennes localités `Abidjan / Commune` en compatibilité lecture ;
- conservation des données historiques de prix et des missions.

## Validation

Nouvelle commande :

```bash
KLEAN_TEST_BASE=http://127.0.0.1:3110 npm run test:update20
```

Résultat frais : **23/23, 0 échec**.

Régressions validées après adaptation des attentes désormais remplacées par COLIS 20 :

- `test:update10` : **57/57** ;
- `test:update15` : **16/16** ;
- `test:update16` : **10/10** ;
- `test:update17` : **17/17** ;
- `test:update18` : **10/10** ;
- `test:update19` : **9/9** ;
- `test:update20` : **23/23**.

Les tests couvrent notamment les coordonnées officielles et leur divergence documentée, l’absence de fuite de prix via API, la commune Abidjan obligatoire, la confirmation sans montant inventé, les permissions PDG, l’historique et le format client strict.
