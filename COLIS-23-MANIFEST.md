# Manifest — COLIS 23

## Portée

Évolution ciblée du parcours **grande catégorie → demande client**. Aucun schéma de base de données ni endpoint de création de mission n’est remplacé.

## Fonctionnalités

- Formulaire unique après ouverture d’une grande catégorie.
- Tâches facultatives dans une sélection différée, recherchable et multiple.
- Verrouillage client cohérent avec la contrainte API : toutes les tâches choisies restent dans une seule prestation.
- Description libre obligatoire ; photos (3), note vocale (25 s), localisation, GPS, disponibilité et urgence.
- Prix uniquement s’il est fiable et administré ; absence de prix silencieuse autrement.
- Brouillon persistant lors du retour et pendant une connexion demandée tardivement.
- CTA final exact : `Trouver un professionnel`.
- Réemploi de la demande et de la mise en relation réelles, sans maquette.

## Ressources ajoutées

- `public/category-request.css`
- `test-update-23.js`
- `LIVRAISON-COLIS-23.md`
- `COLIS-23-MANIFEST.md`

## Ressources mises à jour

- `public/app.js`
- `public/index.html`
- `public/sw.js`
- `server.js`
- `public/admin/index.html`
- `public/admin/admin.css`
- `public/admin/admin.js`
- `package.json`
- `test-update-19.js`
- `test-update-22.js`

## Invariants conservés

- Les grandes catégories et tâches viennent du catalogue central en base.
- Les prix, médias, audio, ville/commune, tâches et attribution sont contrôlés côté serveur.
- Une demande sans tâche prédéfinie reste acceptée.
- La validation API interdit les tâches de prestations différentes dans une même demande.
- Aucune autre fonction existante n’a été reconstruite ni supprimée.
