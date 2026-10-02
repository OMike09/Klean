====================================================================
KLEAN-SERVICES CI — MIGRATION DES COMPTES DE L'APP V1 VERS LA V2
Continuité totale : mêmes numéros, mêmes mots de passe (clients),
même historique. Généré le 02/10/2026.
====================================================================

CE QUE FAIT CE COLIS
--------------------
Il transfère dans la nouvelle app (la simple) :
  • 4 comptes clients        (même numéro + MÊME mot de passe)
  • 5 comptes professionnels (validés, profil + services,
                              mot de passe temporaire : Klean!2026)
  • 2 missions historiques   (1 expirée, 1 annulée — aucune mission bloquée)
  • 2 services du catalogue v1 ré-ajoutés :
      🌬️ Climatisation — dépannage & installation  (pro Alex Zoan Bi + mission clim)
      🛠️ Bricolage & petits travaux                (pro Ballack Yao)
  → Retirez ces 2 services depuis le tableau de bord si vous ne les voulez pas.

FILET DE SÉCURITÉ — les 4 nouveaux inscrits déjà dans la nouvelle app :
  • OUATT Mike, Fatim Yeo, Bagnon Élisee, OUATTARA Alama Azaria
    (+ leur mission « fabrication d'une table » à Kounahiri)
  Ils sont DÉJÀ dans la nouvelle app → le colis ne les touche PAS :
  si leur compte existe au moment du déploiement, aucun changement
  (leur mot de passe d'origine est conservé). S'ils n'existent plus
  (ex. disque Render vidé, sauvegarde absente), ils sont RECRÉÉS
  automatiquement avec le mot de passe temporaire Klean!2026
  (à changer à la 1re connexion).

La migration s'exécute AUTOMATIQUEMENT une seule fois au démarrage de l'app
après le déploiement, puis elle s'éteint d'elle-même (drapeau en base).
Elle est idempotente : si un compte existe déjà, il est ignoré.

BUG IMPORTANT CORRIGÉ DANS CE COLIS
-----------------------------------
Dans la nouvelle app, la sauvegarde automatique vers PostgreSQL était
CASSÉE (variable DB_PATH non exportée par db.js) : la base n'était pas
réellement sauvegardée. Corrigé ici (db.js).

LES 5 FICHIERS À MISE EN PLACE SUR GITHUB
------------------------------------------
Le dépôt OMike09/Klean (branche main) :

  1. REMPLACER  server.js   (par le server.js de ce colis)
  2. REMPLACER  start.js    (par le start.js de ce colis)
  3. REMPLACER  db.js       (par le db.js de ce colis)
  4. NOUVEAU    migration/legacy-data.json
  5. NOUVEAU    migration/run-legacy-migration.js

⚠️ Si entre-temps d'autres modifications ont été faites sur ces 3 fichiers,
ne remplacez PAS tout le fichier : appliquez seulement les 3 blocs ci-dessous.

BLOC A — db.js (2 lignes)
-------------------------
Remplacer :
    const db = new Database(path.join(DATA_DIR, 'klean.db'));
par :
    const DB_PATH = path.join(DATA_DIR, 'klean.db');
    const db = new Database(DB_PATH);

Et remplacer la toute dernière ligne :
    module.exports = { db, hashPassword, getSetting, setSetting };
par :
    module.exports = { db, hashPassword, getSetting, setSetting, DB_PATH };

BLOC B — server.js (la route de login)
---------------------------------------
Remplacer TOUT le bloc :
    app.post('/api/auth/login', (req, res) => {
      const { phone, password } = req.body || {};
      const p = (phone || '').trim().replace(/\s+/g, '');
      const user = db.prepare('SELECT * FROM users WHERE phone=?').get(p);
      if (!user || user.password_hash !== hashPassword(password || '', user.salt))
        return res.status(401).json({ error: 'Téléphone ou mot de passe incorrect.' });
      if (user.suspended) return res.status(403).json({ error: 'Votre compte est suspendu. Contactez Klean-Services CI.' });
      res.json({ token: sign({ id: user.id, exp: Date.now() + 90 * 86400000 }), user: me(user) });
    });
par :
    app.post('/api/auth/login', (req, res) => {
      const { phone, password } = req.body || {};
      const p = (phone || '').trim().replace(/\s+/g, '');
      const user = db.prepare('SELECT * FROM users WHERE phone=?').get(p);
      let ok = user && user.password_hash === hashPassword(password || '', user.salt);
      if (!ok && user && user.pw_legacy) {
        // Migration (app Klean v1) : ancien format sha256(salt + '::' + mot de passe)
        ok = user.password_hash === crypto.createHash('sha256').update(user.salt + '::' + (password || '')).digest('hex');
      }
      if (!user || !ok) return res.status(401).json({ error: 'Téléphone ou mot de passe incorrect.' });
      if (user.pw_legacy) {
        // 1er login réussi : conversion automatique vers le format moderne (scrypt)
        const ns = crypto.randomBytes(16).toString('hex');
        db.prepare('UPDATE users SET password_hash=?, salt=?, pw_legacy=0 WHERE id=?').run(hashPassword(password || '', ns), ns, user.id);
      }
      if (user.suspended) return res.status(403).json({ error: 'Votre compte est suspendu. Contactez Klean-Services CI.' });
      res.json({ token: sign({ id: user.id, exp: Date.now() + 90 * 86400000 }), user: me(user) });
    });

BLOC C — start.js (2 lignes, juste avant la dernière ligne })();)
------------------------------------------------------------------
Après la ligne :
    require('./server');
ajouter :
    // Migration une fois des données de l'app Klean v1 (comptes, pros, missions)
    try { require('./migration/run-legacy-migration'); } catch (e) { console.error('⚠️  Migration legacy :', e.message); }

APRÈS LE DÉPLOIEMENT (GitHub → Render redéploye tout seul)
-----------------------------------------------------------
1. Ouvrir les logs Render → on doit voir :
     📦 Migration legacy terminée en 0.3 s :
        clients migrés   : 4
        pros migrés      : 5
        missions migrées : 2
        filet de sécurité: 4 utilisateur(s) recréé(s) | 1 mission(s) recréée(s)
                      (ou « X déjà présent(s) » si leur compte est encore sur le disque)
        services ajoutés : Climatisation — dépannage & installation, Bricolage & petits travaux
   (au 2ᵉ redémarrage : « Migration legacy déjà effectuée : rien à faire. »)

2. ⚠️ VÉRIFIER QUE LE SERVICE A SA BASE : Render → service klean →
   Environment → DATABASE_URL doit être définie (sinon les comptes ne
   survivront pas à un redéploiement). S'il est vide, coller l'URL
   PostgreSQL/Neon de votre base (celle qui contient l'ancienne app).

3. Ce que vous dites aux gens :
   • CLIENTS (4) : « Ouvrez la nouvelle app, connectez-vous avec votre
     numéro et votre mot de passe d'avant. Tout est au même endroit. »
     (rien à faire d'autre — le mot de passe se convertit tout seul au 1er login)
   • PROS (5) : « Connectez-vous avec votre numéro. Mot de passe : Klean!2026.
     Changez-le ensuite depuis Votre compte → Mot de passe. »
     (Sory BAMBA, Marie Oulaï, Ballack Yao, Malan Amon, Alex Zoan Bi —
     ils sont déjà validés professionnels, pas besoin de redemander)

4. Ce qui est conservé côté clients :
   • historique de missions (la mission « Decodeur à installer » de
     Siagbé apparaît comme « expirée », la mission clim de Kone comme
     « annulée ») — pour repartir, ils refont simplement une demande
     dans la nouvelle app.

SÉCURITÉ
--------
• legacy-data.json contient les mots de passe des comptes (hashés,
  non déchiffrables) — ne pas le publier hors dépôt privé.
• Le mot de passe temporaire des pros (Klean!2026) est dans le colis
  — changez-le de mémoire, il ne sert qu'une fois.

PREUVE
------
Testé en local sur une copie exacte de la nouvelle app (tous les
scénarios au vert) :
• base vierge (pire cas, disque vidé) : 9 comptes + 4 inscrits +
  3 missions + 2 services créés, rien de manquant ;
• login legacy (ancien format) + conversion automatique au 1er login ;
• missions des clients migrés visibles (expirée/annulée), pas de
  redispatch des missions expirées aux pros ;
• inscrit déjà présent (disque persistant) : ignoré, mot de passe
  d'origine conservé, zéro doublon, connectable ;
• login pro + dashboard, catalogue 10 catégories, idempotence au
  redémarrage, mission « table » conservée avec ses réponses.
====================================================================
