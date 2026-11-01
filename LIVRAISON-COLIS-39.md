# Livraison COLIS 39 — COLIS 38 inclus + correctif de publication

## Livraison cumulative

Ce ZIP contient **simultanément** :

1. le **COLIS 38**, soit le centre de contrôle universel de 57 fonctionnalités persistantes (interface PDG, états, permissions, protections API, masquage, historique, suppressions sécurisées et synchronisation) ;
2. le **COLIS 39**, soit le correctif empêchant l’erreur JavaScript `busy is not defined` lors de la publication d’une publicité depuis l’administration.

Un seul patch, `PATCH-COLIS-37-A-39-CUMULATIF.diff`, permet de passer directement du COLIS 37 aux deux livraisons combinées.

## Correctif publication

La fonction `busy()` était utilisée dans le tableau d’administration pour désactiver le bouton pendant l’enregistrement, mais n’était pas déclarée dans ce script. Elle est désormais définie localement : le bouton **Publier** envoie la demande, affiche « Enregistrement… » durant l’opération et retrouve son libellé si une erreur serveur survient.

## Contrôles validés

- COLIS 38 API/sécurité : **20/20**.
- COLIS 38 interface bureau/Android/iPhone : **15/15**.
- COLIS 39 publication publicitaire : **4/4**.
  - le flux Publier est atteint ;
  - le formulaire se ferme après réponse ;
  - l’erreur `busy is not defined` est absente ;
  - la requête de test est interceptée : aucune publicité de contrôle n’est créée.

Aucune donnée métier, publicité, statistique, compte, prix, rôle ou permission existante n’est effacée par cette livraison.
