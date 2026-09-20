# ✨ KLEAN — Le Yango du ménage à Bouaké 🇨🇮

Plateforme qui met en relation un client qui demande un nettoyage avec un agent
de nettoyage disponible à proximité — comme Yango le fait avec les chauffeurs.

**Phase 1 : Bouaké** → Abidjan → Yamoussoukro → Korhogo → San Pedro → Daloa → Man…

## 🧩 Contenu du projet

| Fichier | Rôle |
|---|---|
| `index.html` | L'application (client + agent), interface mobile style Yango |
| `server.js` | **Serveur central** : API + temps réel (WebSocket) + stockage (`db.json`) |
| `net.js` | Connecte l'appli au serveur central (appelé automatiquement) |
| `db.json` | Données (agents, missions) — remplacer par PostgreSQL en production |

## ▶️ Lancer

```bash
cd klean
node server.js
```

Puis ouvrir `http://localhost:8000` (ou l'adresse du serveur) sur **2 appareils** :

- **Appareil 1** : mode *🙋 Je cherche un nettoyage* → réservez une mission
- **Appareil 2** : mode *🧹 Je suis agent* → créez un profil, passez **En ligne**

La demande de l'appareil 1 arrive **en temps réel** sur l'appareil 2 (compte à
rebours 20 s, comme chez Yango). L'agent accepte : le client voit son nom, sa
note, sa distance, puis suit les statuts *en route → arrivé → nettoyage →
terminée* en direct.

Si le serveur est absent (fichier ouvert directement), l'appli fonctionne en
**mode démo** avec des agents simulés.

## 💰 Modèle économique

- Commission plateforme : **25%** (`PLATFORM_FEE` dans `server.js` — à tester sur le terrain)
- L'agent reçoit **75%** de chaque mission
- Ex. mission à 10 000 F → agent 7 500 F / plateforme 2 500 F

## 🔧 Configuration

| Réglage | Fichier | Ligne |
|---|---|---|
| Numéro WhatsApp plateforme | `index.html` | `OWNER_PHONE` |
| Commission | `server.js` | `PLATFORM_FEE = 0.25` |
| Services & prix | `index.html` | `SERVICES` |
| Quartiers de Bouaké | `index.html` | `QUARTIERS` |
| Port du serveur | env | `PORT=8000 node server.js` |

## 🌐 API du serveur central

- `POST /api/missions` — créer une demande (diffusée aux agents en ligne)
- `POST /api/missions/:id/accept` — un agent accepte (premier arrivé gagne)
- `POST /api/missions/:id/status` — `enroute / arrive / encours / terminee`
- `POST /api/missions/:id/cancel` — annulation client
- `GET  /api/agents/:id/summary` — gains (75%), commission (25%), historique
- `GET  /api/stats`, `GET /api/health`
- `WS   /ws` — temps réel : `mission_request`, `mission_update`, `mission_taken`

## 🚀 Pour la production (prochaine étape)

1. **Hébergement** : Render / Railway (gratuit pour tester) ou VPS (~5 000 F/mois)
2. **Base de données** : PostgreSQL + Redis (au lieu de `db.json`)
3. **Paiements réels** : CinetPay ou PayDunya (Wave, Orange Money, MTN, Moov en une API)
4. **Géolocalisation réelle** : GPS des agents (au lieu de la distance simulée)
5. **Auth** : OTP SMS (ex. Africa's Talking — API SMS africaine)
6. **Apps stores** : empaquetage PWA ou Flutter/React Native
7. **Vérification agents** : identité + casier, puis notes clients
