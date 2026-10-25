# COLIS 20 — Manifest

## Fichiers modifiés

- `db.js` — migrations non destructives : communes, répertoire officiel/historique urgences, historique règles tarifaires, compatibilité Abidjan et politique de confirmation.
- `server.js` — API publiques urgences/villes/communes sans prix, moteur d’estimation fiable, persistance commune, permissions et routes PDG administratives.
- `public/app.js` — urgence publique documentée, demande réordonnée, commune Abidjan, estimation à deux formulations strictes, suppression affichage prix catalogue.
- `public/styles.css` — bloc estimation rouge masqué lorsqu’il est vide.
- `public/admin/admin.js` — gestion PDG contacts/historique, tarifs/historique, villes et communes ; retrait des prix du catalogue administratif ordinaire.
- `test-update-10.js` — scénarios historiques adaptés au tarif masqué et à Abidjan/commune.
- `test-update-16.js` — scénarios estimation adaptés à la description, commune et vérification.
- `test-update-17.js` — scénarios urgences adaptés au répertoire institutionnel public.
- `test-update-20.js` — 23 contrôles E2E COLIS 20.
- `package.json` — commande `test:update20`.
- `LIVRAISON-COLIS-20.md` — rapport complet.

## Nouvelles tables / colonne

| Élément | Rôle |
|---|---|
| `communes` | Communes par ville depuis la source centrale |
| `emergency_contacts` | Contacts institutionnels, source, date, état et ordre |
| `emergency_contact_history` | Historique création/import/modification/désactivation |
| `price_estimation_rule_history` | Historique de la gestion PDG des règles |
| `missions.intervention_commune` | Commune réellement choisie pour une nouvelle demande |

## Routes notables

Public :

- `GET /api/urgence/config`
- `GET /api/villes`
- `GET /api/communes?city=Abidjan`
- `GET /api/estimates`

PDG :

- `GET|POST /api/admin/emergency-contacts`
- `PUT /api/admin/emergency-contacts/:id`
- `GET /api/admin/emergency-contacts/:id/history`
- `GET|POST /api/admin/estimation-rules`
- `PUT /api/admin/estimation-rules/:id`
- `GET /api/admin/estimation-rules/:id/history`

Catalogue administré :

- `GET|POST /api/admin/communes`
- `PUT /api/admin/communes/:id`

## Règles de sécurité

- Aucun contact d’urgence libre/non vérifié n’est publié.
- Les coordonnées officielles ont une provenance, date de vérification et date de dernière modification.
- Les tarifs de catalogue ne sont pas inclus dans les réponses publiques ni administratives ordinaires.
- Les écritures de règles tarifaires et contacts institutionnels sont vérifiées côté serveur, PDG uniquement.
- L’estimation sans donnée fiable ne renvoie aucun montant.
- Une mission garde ses montants/estimations historiques ; une règle nouvelle s’applique aux nouvelles demandes uniquement.
