// ============================================================
// KLEAN-SERVICES CI — Récupération des données de l'ANCIENNE
// application depuis la table "klean_state" de PostgreSQL (Neon).
// S'exécute UNE SEULE FOIS au démarrage (puis se désactive).
// Importe : clients et agents (noms, téléphones, statut pro).
// Mot de passe : l'ancien fonctionne s'il était chiffré en SHA-256 ;
// sinon mot de passe temporaire "Klean" + 4 derniers chiffres du tél.
// ============================================================
const crypto = require('crypto');

function champ(obj, noms) {
  for (const n of noms) {
    if (obj && obj[n] !== undefined && obj[n] !== null && String(obj[n]).trim() !== '') return obj[n];
  }
  return null;
}
function telephone(obj) {
  const t = champ(obj, ['tel', 'telephone', 'téléphone', 'phone', 'numero', 'numéro', 'contact', 'mobile']);
  if (!t) return null;
  const p = String(t).replace(/[^\d+]/g, '');
  return p.length >= 8 ? p : null;
}
function nomComplet(obj) {
  const nom = champ(obj, ['nom', 'name', 'lastname']);
  const prenom = champ(obj, ['prenom', 'prénom', 'firstname']);
  if (nom && prenom && !String(nom).toLowerCase().includes(String(prenom).toLowerCase()))
    return (String(prenom).trim() + ' ' + String(nom).trim()).trim();
  return String(nom || prenom || '').trim() || null;
}
function ancienHash(obj) {
  const h = champ(obj, ['password', 'motdepasse', 'mdp', 'pass', 'hash', 'password_hash']);
  if (h && typeof h === 'string' && /^[0-9a-f]{64}$/i.test(h.trim())) return h.trim().toLowerCase();
  return null;
}
function texte(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

async function run(persist) {
  if (!persist.enabled()) return;
  const { db, hashPassword, getSetting, setSetting } = require('./db');
  if (getSetting('ancien_import_fait', '0') === '1') return; // déjà fait

  // Lire l'ancienne sauvegarde (table klean_state) — si elle n'existe pas, on ne fait rien
  let state = null;
  try {
    const r = await persist.query("SELECT data FROM klean_state LIMIT 1");
    if (!r || !r.rows.length) { setSetting('ancien_import_fait', '1'); return; }
    state = typeof r.rows[0].data === 'string' ? JSON.parse(r.rows[0].data) : r.rows[0].data;
  } catch (e) {
    console.log('ℹ️  Pas d\'ancienne sauvegarde à importer (' + e.message + ').');
    return;
  }
  if (!state || typeof state !== 'object') { setSetting('ancien_import_fait', '1'); return; }

  const listes = [
    { cle: 'clients', pro: false },
    { cle: 'users', pro: false },
    { cle: 'agents', pro: true },
    { cle: 'pros', pro: true },
    { cle: 'professionnels', pro: true }
  ];
  const importes = [];
  const insUser = db.prepare(`INSERT INTO users(name, phone, password_hash, salt, address, role, is_pro, pro_status, verified, rules_accepted_at)
    VALUES(?,?,?,?,?, 'user', ?, ?, 1, datetime('now'))`);
  const insLegacy = db.prepare('INSERT OR REPLACE INTO legacy_passwords(user_id, sha256) VALUES(?,?)');
  const insPro = db.prepare(`INSERT OR IGNORE INTO pro_profiles(user_id, profession, description, zone, services, available, validated_at)
    VALUES(?,?,?,?, '[]', 1, datetime('now'))`);
  const existe = db.prepare('SELECT id FROM users WHERE phone=?');

  for (const l of listes) {
    const arr = state[l.cle];
    if (!Array.isArray(arr)) continue;
    for (const fiche of arr) {
      try {
        const tel = telephone(fiche);
        const nom = nomComplet(fiche);
        if (!tel || !nom) continue;
        if (existe.get(tel)) continue; // déjà présent — on ne touche pas
        const mdpTemp = 'Klean' + tel.replace(/\D/g, '').slice(-4);
        const salt = crypto.randomBytes(16).toString('hex');
        const info = insUser.run(nom, tel, hashPassword(mdpTemp, salt), salt,
          texte(champ(fiche, ['adresse', 'address', 'quartier', 'commune', 'ville', 'zone'])),
          l.pro ? 1 : 0, l.pro ? 'approved' : null);
        const uid = info.lastInsertRowid;
        const legacy = ancienHash(fiche);
        if (legacy) insLegacy.run(uid, legacy);
        if (l.pro) {
          insPro.run(uid,
            texte(champ(fiche, ['profession', 'metier', 'métier', 'specialite', 'spécialité'])) || 'Professionnel',
            texte(champ(fiche, ['services', 'description', 'competences', 'compétences'])),
            texte(champ(fiche, ['zone', 'quartier', 'commune', 'ville', 'secteur'])));
        }
        importes.push({ nom, tel, pro: l.pro, mdpTemp, ancienMdpOk: !!legacy });
      } catch (e) { console.error('Import ancien — fiche ignorée :', e.message); }
    }
  }

  setSetting('ancien_import_fait', '1');
  if (!importes.length) { console.log('ℹ️  Ancienne sauvegarde lue : aucun nouveau compte à importer.'); return; }

  // Notification récapitulative pour les admins
  const lignes = importes.map(i =>
    `• ${i.nom} (${i.tel}) — ${i.pro ? 'Professionnel' : 'Client'} — ` +
    (i.ancienMdpOk ? `ancien mot de passe accepté, sinon mot de passe temporaire : ${i.mdpTemp}`
                   : `mot de passe temporaire : ${i.mdpTemp}`)).join('\n');
  const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all();
  const insNotif = db.prepare("INSERT INTO notifications(user_id, category, title, body, link) VALUES(?, 'systeme', ?, ?, '#/admin')");
  for (const a of admins) {
    insNotif.run(a.id, `✅ ${importes.length} ancien(s) compte(s) récupéré(s)`,
      'Comptes importés depuis l\'ancienne application :\n' + lignes +
      '\n\nChaque personne peut se connecter avec son ancien mot de passe (si accepté) ou le mot de passe temporaire indiqué, puis le changer dans Mon compte.');
  }
  console.log(`✅ Import ancien terminé : ${importes.length} compte(s) récupéré(s).`);
  importes.forEach(i => console.log('   ' + i.nom + ' (' + i.tel + ') — mot de passe temporaire : ' + i.mdpTemp));
}

module.exports = { run };
