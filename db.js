// ============================================================
// KLEAN-SERVICES CI — Base de données (SQLite)
// ============================================================
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'klean.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- RÉPARATION DES TABLES HÉRITÉES ----------
// Les très anciennes versions ont pu créer des tables sous_categories / taches
// avec des clés étrangères vers des tables obsolètes (metiers, services2).
// Ces tables sont inutilisables (tout INSERT échoue) : on les reconstruit
// proprement avant la création du schéma. Si par précaution elles contenaient
// des données, elles sont conservées sous le nom *_ancien.
(function repareTablesHeritees() {
  const A_REPARER = [
    { table: 'sous_categories', mauvaiseRef: /REFERENCES\s+metiers\s*\(/i },
    { table: 'taches',          mauvaiseRef: /REFERENCES\s+services2\s*\(/i },
  ];
  A_REPARER.forEach(({ table, mauvaiseRef }) => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!row || !mauvaiseRef.test(row.sql || '')) return;
    const n = db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
    if (n > 0) {
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}_ancien`);
      console.log(`🔧 Table héritée ${table} (clé étrangère obsolète) renommée en ${table}_ancien (${n} lignes conservées).`);
    } else {
      db.exec(`DROP TABLE ${table}`);
      console.log(`🔧 Table héritée ${table} (clé étrangère obsolète, vide) supprimée : elle sera recréée correctement.`);
    }
  });
})();

// ---------- SCHÉMA ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  photo TEXT,
  address TEXT,
  lat REAL, lng REAL,
  role TEXT NOT NULL DEFAULT 'user',          -- user | admin
  is_pro INTEGER NOT NULL DEFAULT 0,          -- compte unique : devient aussi pro après validation
  pro_status TEXT,                            -- NULL | pending | approved | rejected
  suspended INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  rules_accepted_at TEXT,
  pro_rules_accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT, address TEXT NOT NULL, lat REAL, lng REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pro_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  profession TEXT, description TEXT, experience TEXT, zone TEXT,
  services TEXT NOT NULL DEFAULT '[]',        -- JSON ids services
  documents TEXT NOT NULL DEFAULT '[]',       -- JSON fichiers
  available INTEGER NOT NULL DEFAULT 1,
  validated_at TEXT, rejected_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS service_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, icon TEXT, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);

-- Niveau 2 : sous-catégories (entre MÉTIER et SERVICE)
CREATE TABLE IF NOT EXISTS sous_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metier_id INTEGER NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);

-- Niveau 4 : tâches / prestations proposées pour un service
CREATE TABLE IF NOT EXISTS taches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);

-- Villes et localités de Côte d'Ivoire (gérées depuis le tableau de bord)
CREATE TABLE IF NOT EXISTS villes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS service_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',          -- text | number | select | bool | date
  options TEXT NOT NULL DEFAULT '[]',
  required INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS missions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES users(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  pro_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'recherche',
  -- recherche | sans_pro | acceptee | confirmee | en_cours | terminee | payee | annulee | litige
  answers TEXT NOT NULL DEFAULT '{}',
  description TEXT, address TEXT, lat REAL, lng REAL,
  urgence INTEGER NOT NULL DEFAULT 0,
  date_souhaitee TEXT,
  photos TEXT NOT NULL DEFAULT '[]',
  audio TEXT,
  amount INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  status TEXT NOT NULL, actor_id INTEGER, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  pro_id INTEGER NOT NULL REFERENCES users(id),
  rank INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | offered | refused | expired | accepted
  offered_at TEXT, responded_at TEXT,
  UNIQUE(mission_id, pro_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL DEFAULT 'text',          -- text | photo | audio
  content TEXT, file TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS legacy_passwords (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL                        -- ancien mot de passe (ancienne application)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'systeme',   -- mission|message|paiement|compte|information|urgence|systeme
  title TEXT NOT NULL, body TEXT, link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id INTEGER NOT NULL UNIQUE REFERENCES missions(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'especes',
  status TEXT NOT NULL DEFAULT 'en_attente',  -- en_attente | confirme_client | confirme_pro | valide
  commission_rate REAL NOT NULL,
  commission_amount INTEGER NOT NULL,
  pro_amount INTEGER NOT NULL,
  client_confirmed_at TEXT, pro_confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  target_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(mission_id, author_id)
);

CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT );

CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'texte',         -- texte | image | video
  title TEXT, content TEXT, file TEXT,
  placement TEXT NOT NULL DEFAULT 'accueil',  -- accueil | services
  duration INTEGER NOT NULL DEFAULT 6,
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS avis_recherche (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  nom TEXT NOT NULL, photo TEXT, description TEXT,
  date_disparition TEXT, heure_disparition TEXT,
  dernier_lieu TEXT, derniere_vue TEXT,
  description_physique TEXT, vetements TEXT,
  contact TEXT NOT NULL, infos TEXT,
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | approved | rejected | resolved
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  metier TEXT NOT NULL, competences TEXT, experience TEXT,
  localisation TEXT, disponibilite TEXT, contact TEXT NOT NULL,
  cv TEXT, photo TEXT, description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ecole_famille (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL, details TEXT, contact TEXT,
  status TEXT NOT NULL DEFAULT 'nouveau',     -- nouveau | en_traitement | traite
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS urgences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT, lat REAL, lng REAL,
  handled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS signalements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  target_id INTEGER REFERENCES users(id),
  mission_id INTEGER REFERENCES missions(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'nouveau',     -- nouveau | traite
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quiz_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL, options TEXT NOT NULL, answer INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS game_plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  game TEXT NOT NULL,                         -- quiz | flipfizz
  score INTEGER, result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kdo_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE, reward TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  used_by INTEGER REFERENCES users(id), used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_missions_client ON missions(client_id);
CREATE INDEX IF NOT EXISTS idx_missions_pro ON missions(pro_id);
CREATE INDEX IF NOT EXISTS idx_messages_mission ON messages(mission_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);
`);

// ---------- HELPERS ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}
function getSetting(key, def = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : def;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

// ---------- SEED (configuration initiale uniquement) ----------
function seed() {
  if (getSetting('seeded')) return;

  // Paramètres par défaut
  const defaults = {
    commission_rate: '25',
    dispatch_wait_seconds: '60',
    file_retention_days: '90',
    payment_especes: '1',
    payment_mobile_money: '0',
    quiz_enabled: '0',
    flipfizz_enabled: '0',
    kdo_enabled: '0',
    urgence_info: "En cas d'urgence grave, appelez directement les services compétents. Klean-Services CI transmettra votre alerte à son équipe.",
    urgence_contacts: JSON.stringify([
      { nom: 'Police secours', tel: '110' },
      { nom: 'Pompiers', tel: '180' },
      { nom: 'SAMU', tel: '185' },
      { nom: 'Klean-Services CI', tel: '+225 07 00 00 00 00' }
    ]),
    rules_client: `RÈGLES D'UTILISATION — CLIENT

1. PAIEMENT : le paiement s'effectue selon les moyens activés (espèces notamment). Le client confirme le paiement dans l'application après l'avoir effectué.
2. ESPÈCES : en cas de paiement en espèces, remettez le montant exact au professionnel puis confirmez dans l'application.
3. COMPORTEMENT & RESPECT : tout manque de respect, menace ou violence entraîne la suspension du compte.
4. RESPONSABILITÉ : décrivez fidèlement votre besoin (photos, détails). Les fausses demandes sont interdites.
5. FRAUDE : toute tentative de contournement de la plateforme ou de fraude entraîne l'exclusion.
6. ANNULATION : annulez au plus tôt si vous n'avez plus besoin du service. Les annulations répétées de missions confirmées peuvent être sanctionnées.
7. SÉCURITÉ : ne partagez jamais votre mot de passe. Signalez tout comportement suspect.
8. PLATEFORME : la mise en relation doit se faire via Klean-Services CI.`,
    rules_pro: `RÈGLES D'UTILISATION — PROFESSIONNEL

1. PAIEMENT & COMMISSION : une commission est prélevée sur chaque mission (taux affiché dans vos revenus). Confirmez la réception du paiement dans l'application.
2. ESPÈCES : après réception du paiement en espèces, confirmez-le immédiatement dans l'application.
3. COMPORTEMENT & RESPECT : soyez ponctuel, courtois et professionnel. Tout abus entraîne la suspension.
4. RESPONSABILITÉ : vous êtes responsable de la qualité de vos prestations et de votre matériel.
5. FRAUDE : il est interdit de traiter hors plateforme une mission reçue via Klean-Services CI.
6. ANNULATION : n'acceptez une mission que si vous pouvez l'honorer. Les abandons répétés sont sanctionnés.
7. SÉCURITÉ : présentez-vous avec votre profil vérifié. Ne demandez jamais d'informations sensibles au client.
8. PLATEFORME : maintenez votre disponibilité et votre zone d'intervention à jour.`,
  };
  for (const [k, v] of Object.entries(defaults)) setSetting(k, v);

  // Compte administrateur
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare(`INSERT INTO users(name, phone, password_hash, salt, role, verified, rules_accepted_at)
              VALUES('Administrateur', 'admin', ?, ?, 'admin', 1, datetime('now'))`)
    .run(hashPassword('Klean@2026', salt), salt);

  // Catégories + services + mots-clés (recherche intelligente)
  const cat = db.prepare('INSERT INTO service_categories(name, icon, sort) VALUES(?,?,?)');
  const svc = db.prepare('INSERT INTO services(category_id, name, keywords, sort) VALUES(?,?,?,?)');
  const q = db.prepare('INSERT INTO service_questions(service_id, label, type, options, required, sort) VALUES(?,?,?,?,?,?)');

  const C = {};
  [['Nettoyage', '🧽'], ['Plomberie', '🔧'], ['Électricité', '💡'], ['Menuiserie', '🪚'],
   ['Réparation', '🛠️'], ['Transport', '🚚'], ['Cours à domicile', '📚'], ['Canal placement', '🤝']]
    .forEach(([n, i], idx) => { C[n] = cat.run(n, i, idx).lastInsertRowid; });

  const S = {};
  const services = [
    ['Nettoyage', 'Nettoyage de fauteuil', 'fauteuil,canape,canapé,salon,sofa,divan,tissu,nettoyer'],
    ['Nettoyage', 'Nettoyage de maison', 'maison,menage,ménage,appartement,domicile,nettoyer,entretien,femme de menage'],
    ['Nettoyage', 'Nettoyage de bureau', 'bureau,entreprise,locaux,societe,société,nettoyer'],
    ['Nettoyage', 'Nettoyage de tapis & moquette', 'tapis,moquette,nettoyer'],
    ['Plomberie', 'Plomberie — dépannage', 'plombier,plomberie,fuite,robinet,tuyau,wc,toilette,douche,evier,évier,lavabo,canalisation,eau'],
    ['Plomberie', 'Installation sanitaire', 'installation,sanitaire,chauffe-eau,chauffe eau,lavabo,wc,douche,plombier'],
    ['Électricité', 'Électricité — dépannage', 'electricien,électricien,electricite,électricité,panne,courant,disjoncteur,prise,interrupteur,lumiere,lumière,cable,câble'],
    ['Électricité', 'Installation électrique', 'installation,electrique,électrique,compteur,climatiseur,ventilateur,electricien,brassage'],
    ['Menuiserie', 'Menuiserie bois', 'menuisier,menuiserie,bois,porte,meuble,armoire,lit,table,chaise,etagere,étagère'],
    ['Menuiserie', 'Menuiserie aluminium & vitrerie', 'aluminium,alu,vitre,vitrerie,fenetre,fenêtre,baie'],
    ['Réparation', 'Réparation TV & électronique', 'television,télévision,tv,tele,télé,ecran,écran,decodeur,décodeur,electronique,électronique,reparer,réparer'],
    ['Réparation', 'Réparation électroménager', 'frigo,refrigerateur,réfrigérateur,congelateur,congélateur,machine a laver,climatiseur,micro-ondes,cuisiniere,cuisinière,electromenager,électroménager,reparer'],
    ['Réparation', 'Réparation téléphone & ordinateur', 'telephone,téléphone,portable,smartphone,ordinateur,pc,laptop,tablette,reparer,réparer,ecran casse'],
    ['Transport', 'Transport & livraison', 'transport,livraison,livrer,colis,course,taxi,moto,tricycle,camion'],
    ['Transport', 'Déménagement', 'demenagement,déménagement,demenager,déménager,cartons,meubles'],
    ['Cours à domicile', 'Cours à domicile', 'cours,domicile,soutien,scolaire,maths,mathematiques,francais,français,anglais,physique,repetiteur,répétiteur,professeur,ecole,école'],
    ['Canal placement', 'Canal placement — personnel', 'employe,employé,placement,recrutement,personnel,embauche,nounou,gardien,chauffeur,cuisinier,menagere,ménagère,aide'],
  ];
  services.forEach(([c, n, kw], idx) => { S[n] = svc.run(C[c], n, kw, idx).lastInsertRowid; });

  // Questions dynamiques par service (modifiables dans le tableau de bord)
  const QQ = {
    'Nettoyage de fauteuil': [
      ['Nombre de fauteuils', 'number', [], 1],
      ['Nombre de places (total)', 'number', [], 1],
      ['Dimensions approximatives', 'text', [], 0],
      ['Type de tissu', 'select', ['Tissu simple', 'Velours', 'Cuir', 'Simili-cuir', 'Je ne sais pas'], 1],
      ['État du fauteuil', 'select', ['Bon état', 'Usé', 'Très usé'], 0],
      ['Niveau de saleté', 'select', ['Léger', 'Moyen', 'Très sale'], 1],
      ['Taches particulières ?', 'text', [], 0],
      ['Accessibilité du lieu', 'select', ['Rez-de-chaussée', 'Étage avec ascenseur', 'Étage sans ascenseur'], 0],
    ],
    'Nettoyage de maison': [
      ['Type de logement', 'select', ['Studio', 'Appartement 2-3 pièces', 'Appartement 4+ pièces', 'Villa'], 1],
      ['Surface approximative (m²)', 'number', [], 0],
      ['Type de nettoyage', 'select', ['Entretien courant', 'Grand nettoyage', 'Après travaux', 'Avant/après déménagement'], 1],
      ['Fréquence souhaitée', 'select', ['Une seule fois', 'Hebdomadaire', 'Mensuelle'], 0],
    ],
    'Nettoyage de bureau': [
      ['Surface approximative (m²)', 'number', [], 0],
      ['Nombre de bureaux/pièces', 'number', [], 1],
      ['Fréquence souhaitée', 'select', ['Une seule fois', 'Quotidienne', 'Hebdomadaire'], 1],
    ],
    'Nettoyage de tapis & moquette': [
      ['Nombre de tapis', 'number', [], 1],
      ['Dimensions approximatives', 'text', [], 0],
      ['Niveau de saleté', 'select', ['Léger', 'Moyen', 'Très sale'], 1],
    ],
    'Plomberie — dépannage': [
      ['Type de problème', 'select', ['Fuite d\u2019eau', 'Canalisation bouchée', 'Panne d\u2019équipement', 'Autre'], 1],
      ['Équipement concerné', 'select', ['Robinet', 'WC', 'Douche', 'Évier/Lavabo', 'Chauffe-eau', 'Tuyauterie', 'Autre'], 1],
      ['Fuite ou panne ?', 'select', ['Fuite', 'Panne', 'Les deux'], 0],
      ['Accès au lieu', 'select', ['Facile', 'Difficile'], 0],
    ],
    'Installation sanitaire': [
      ['Équipement à installer', 'select', ['Chauffe-eau', 'WC', 'Lavabo', 'Douche', 'Autre'], 1],
      ['Équipement déjà acheté ?', 'bool', [], 1],
    ],
    'Électricité — dépannage': [
      ['Type de problème', 'select', ['Coupure totale', 'Coupure partielle', 'Prise/interrupteur', 'Disjoncteur saute', 'Autre'], 1],
      ['Équipement concerné', 'text', [], 0],
      ['Accès au lieu', 'select', ['Facile', 'Difficile'], 0],
    ],
    'Installation électrique': [
      ['Type d\u2019installation', 'select', ['Climatiseur', 'Ventilateur', 'Luminaires', 'Câblage complet', 'Autre'], 1],
      ['Équipement déjà acheté ?', 'bool', [], 1],
    ],
    'Menuiserie bois': [
      ['Type de travail', 'select', ['Fabrication', 'Réparation', 'Pose/Installation'], 1],
      ['Objet concerné', 'text', [], 1],
    ],
    'Menuiserie aluminium & vitrerie': [
      ['Type de travail', 'select', ['Fabrication', 'Réparation', 'Remplacement vitre'], 1],
      ['Dimensions approximatives', 'text', [], 0],
    ],
    'Réparation TV & électronique': [
      ['Appareil concerné', 'select', ['Télévision', 'Décodeur', 'Home cinéma', 'Autre'], 1],
      ['Marque et modèle', 'text', [], 0],
      ['Description de la panne', 'text', [], 1],
    ],
    'Réparation électroménager': [
      ['Appareil concerné', 'select', ['Réfrigérateur', 'Congélateur', 'Machine à laver', 'Climatiseur', 'Cuisinière', 'Autre'], 1],
      ['Description de la panne', 'text', [], 1],
    ],
    'Réparation téléphone & ordinateur': [
      ['Appareil concerné', 'select', ['Téléphone', 'Ordinateur', 'Tablette'], 1],
      ['Marque et modèle', 'text', [], 0],
      ['Description de la panne', 'text', [], 1],
    ],
    'Transport & livraison': [
      ['Que faut-il transporter ?', 'text', [], 1],
      ['Lieu de départ', 'text', [], 1],
      ['Lieu d\u2019arrivée', 'text', [], 1],
      ['Véhicule souhaité', 'select', ['Moto', 'Tricycle', 'Voiture', 'Camionnette', 'Camion'], 0],
    ],
    'Déménagement': [
      ['Type de logement', 'select', ['Studio', 'Appartement', 'Villa', 'Bureau'], 1],
      ['Adresse de départ', 'text', [], 1],
      ['Adresse d\u2019arrivée', 'text', [], 1],
      ['Étage (départ/arrivée)', 'text', [], 0],
    ],
    'Cours à domicile': [
      ['Matière(s)', 'text', [], 1],
      ['Niveau de l\u2019élève', 'select', ['Primaire', 'Collège', 'Lycée', 'Supérieur', 'Adulte'], 1],
      ['Nombre d\u2019élèves', 'number', [], 0],
      ['Fréquence souhaitée', 'select', ['1 fois/semaine', '2 fois/semaine', '3+ fois/semaine'], 0],
    ],
    'Canal placement — personnel': [
      ['Type de personnel recherché', 'select', ['Ménagère', 'Nounou', 'Gardien', 'Chauffeur', 'Cuisinier(ère)', 'Autre'], 1],
      ['Temps plein ou partiel ?', 'select', ['Temps plein', 'Temps partiel'], 1],
      ['Logé(e) ou non ?', 'select', ['Logé(e)', 'Non logé(e)', 'Indifférent'], 0],
      ['Détails du poste', 'text', [], 0],
    ],
  };
  for (const [sname, questions] of Object.entries(QQ)) {
    questions.forEach(([label, type, options, required], idx) => {
      q.run(S[sname], label, type, JSON.stringify(options), required, idx);
    });
  }

  // Quiz : quelques questions configurables par l'admin
  const qq = db.prepare('INSERT INTO quiz_questions(question, options, answer) VALUES(?,?,?)');
  qq.run('Quelle est la capitale politique de la Côte d\u2019Ivoire ?', JSON.stringify(['Abidjan', 'Yamoussoukro', 'Bouaké', 'Korhogo']), 1);
  qq.run('Combien de régions compte la Côte d\u2019Ivoire ?', JSON.stringify(['14', '31', '33', '19']), 2);
  qq.run('Quel fleuve traverse Bouaké ?', JSON.stringify(['Le Bandama', 'La Comoé', 'Le Sassandra', 'Le Cavally']), 0);

  setSetting('seeded', '1');
  console.log('Base de données initialisée (admin : téléphone "admin" / mot de passe "Klean@2026")');
}
seed();

// ============================================================
// MIGRATIONS DOUCES (s'appliquent aussi aux bases déjà en production,
// sans jamais toucher aux données existantes)
// ============================================================
function ensureColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
function migrate() {
  ensureColumn('services', 'sub_id', 'INTEGER');                   // lien vers sous_categories
  ensureColumn('services', 'popular', 'INTEGER NOT NULL DEFAULT 0'); // mis en avant sur l'accueil
  ensureColumn('services', 'seasonal', 'INTEGER NOT NULL DEFAULT 0');// service saisonnier
  ensureColumn('services', 'cities', "TEXT NOT NULL DEFAULT '[]'");  // villes où le service est proposé ([]=partout)
  ensureColumn('missions', 'tache', 'TEXT');                        // tâche précise choisie par le client
  ensureColumn('users', 'ville', 'TEXT');
  ensureColumn('users', 'quartier', 'TEXT');
  // --- Hiérarchie & gestion des comptes (v2 étape 2) ---
  ensureColumn('users', 'email', 'TEXT');
  ensureColumn('users', 'kp_code', 'TEXT');                          // code professionnel unique (KP######)
  ensureColumn('users', 'blocked', 'INTEGER NOT NULL DEFAULT 0');    // blocage total (connexion refusée)
  ensureColumn('users', 'disabled_until', 'TEXT');                   // désactivation temporaire jusqu'à cette date
  ensureColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0'); // changement de mot de passe obligatoire
  ensureColumn('users', 'perms', 'TEXT');                            // permissions JSON (équipe) — NULL = valeurs par défaut du rôle
  ensureColumn('users', 'profile_incomplete', 'INTEGER NOT NULL DEFAULT 0');   // compte créé rapidement par un admin
  ensureColumn('users', 'created_by', 'INTEGER');                    // admin qui a créé le compte (création rapide)
  ensureColumn('users', 'font_size', 'INTEGER');                     // taille de texte choisie (14–26 px)

  db.exec(`CREATE TABLE IF NOT EXISTS reset_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_reset_user ON reset_codes(user_id, used);`);

  db.exec(`CREATE TABLE IF NOT EXISTS admin_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    admin_name TEXT NOT NULL,
    admin_role TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    target_name TEXT,
    details TEXT,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_log_target ON admin_log(target_type, target_id);
  CREATE INDEX IF NOT EXISTS idx_log_date ON admin_log(created_at);`);

  // Migration hiérarchie : le plus ancien compte administrateur devient PDG (une seule fois)
  if (!getSetting('hierarchie_v1')) {
    const first = db.prepare("SELECT id FROM users WHERE role IN ('admin','pdg') ORDER BY id LIMIT 1").get();
    if (first) db.prepare("UPDATE users SET role='pdg' WHERE id=?").run(first.id);
    setSetting('hierarchie_v1', '1');
  }

  // Codes professionnels KP : attribués aux pros validés qui n'en ont pas encore
  const sansCode = db.prepare("SELECT id FROM users WHERE pro_status='approved' AND (kp_code IS NULL OR kp_code='')").all();
  for (const u of sansCode) {
    let code;
    do { code = 'KP' + String(Math.floor(100000 + Math.random() * 900000)); }
    while (db.prepare('SELECT 1 FROM users WHERE kp_code=?').get(code));
    db.prepare('UPDATE users SET kp_code=? WHERE id=?').run(code, u.id);
  }
}
migrate();

// ============================================================
// FUSION DE LA GRANDE BASE DES MÉTIERS DE CÔTE D'IVOIRE
// (ne crée que ce qui n'existe pas déjà ; tout reste modifiable
//  ensuite depuis le tableau de bord — jamais de doublon)
// ============================================================
function normName(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function seedTaxonomie() {
  if (getSetting('taxonomie_v1')) return;
  const { METIERS, VILLES } = require('./seed-metiers');

  // Correspondance entre les anciennes catégories et les nouveaux métiers (fusion, pas de doublon)
  const ALIAS = {
    'nettoyage': 'Nettoyage & entretien',
    'menuiserie': 'Menuiserie bois',
    'reparation': 'Électroménager',
    'transport': 'Transport & livraison',
    'cours a domicile': 'Cours & formation',
  };

  const catByNorm = {};
  db.prepare('SELECT * FROM service_categories').all().forEach(c => { catByNorm[normName(c.name)] = c; });
  // Applique les alias : renomme les anciennes catégories vers les nouveaux noms de métiers
  for (const [oldNorm, newName] of Object.entries(ALIAS)) {
    const c = catByNorm[oldNorm];
    if (c && !catByNorm[normName(newName)]) {
      db.prepare('UPDATE service_categories SET name=? WHERE id=?').run(newName, c.id);
      delete catByNorm[oldNorm];
      c.name = newName; catByNorm[normName(newName)] = c;
    }
  }

  const insCat = db.prepare('INSERT INTO service_categories(name, icon, sort) VALUES(?,?,?)');
  const insSub = db.prepare('INSERT INTO sous_categories(metier_id, name, sort) VALUES(?,?,?)');
  const insSvc = db.prepare('INSERT INTO services(category_id, sub_id, name, keywords, sort) VALUES(?,?,?,?,?)');
  const insTac = db.prepare('INSERT INTO taches(service_id, name, sort) VALUES(?,?,?)');

  // Fusion des anciens services de production vers la nouvelle structure
  // (même identifiant conservé → missions, questions et profils pros intacts)
  const SERVICE_MOVES = {
    'nettoyage de fauteuil':            { metier: 'Nettoyage & entretien', sous: 'Maison', rename: 'Nettoyage de fauteuils et canapés' },
    'nettoyage de maison':              { metier: 'Nettoyage & entretien', sous: 'Maison', rename: 'Ménage à domicile' },
    'nettoyage de bureau':              { metier: 'Nettoyage & entretien', sous: 'Bureaux & commerces', rename: 'Nettoyage de bureaux' },
    'nettoyage de tapis moquette':      { metier: 'Nettoyage & entretien', sous: 'Maison' },
    'electricite depannage':            { metier: 'Électricité', sous: 'Dépannage', rename: 'Dépannage électrique' },
    'menuiserie aluminium vitrerie':    { metier: 'Menuiserie aluminium & vitrerie', sous: 'Aluminium' },
    'reparation tv electronique':       { metier: 'Téléphones & électronique', sous: 'Réparation' },
    'reparation telephone ordinateur':  { metier: 'Téléphones & électronique', sous: 'Réparation' },
    'reparation electromenager':        { metier: 'Électroménager', sous: 'Réparation', rename: 'Réparation d\u2019électroménager' },
    'cours a domicile':                 { metier: 'Cours & formation', sous: 'Cours à domicile', rename: 'Soutien scolaire' },
    'transport livraison':              { metier: 'Transport & livraison', sous: 'Transport' },
    'demenagement':                     { metier: 'Transport & livraison', sous: 'Déménagement' },
  };

  const tx = db.transaction(() => {
    let catSort = db.prepare('SELECT COALESCE(MAX(sort),0) m FROM service_categories').get().m;

    // --- Pré-passage : déplacement/renommage des anciens services ---
    const findOrCreateCat = (name, icon) => {
      let c = catByNorm[normName(name)];
      if (!c) { const id = insCat.run(name, icon || '🔹', ++catSort).lastInsertRowid; c = { id, name }; catByNorm[normName(name)] = c; }
      return c;
    };
    const findOrCreateSub = (catId, name) => {
      let s = db.prepare('SELECT * FROM sous_categories WHERE metier_id=? AND name=?').get(catId, name);
      if (!s) s = { id: insSub.run(catId, name, 50).lastInsertRowid };
      return s;
    };
    db.prepare('SELECT * FROM services').all().forEach(sv => {
      const mv = SERVICE_MOVES[normName(sv.name)];
      if (!mv) return;
      const cat = findOrCreateCat(mv.metier, null);
      const sub = findOrCreateSub(cat.id, mv.sous);
      db.prepare('UPDATE services SET name=?, category_id=?, sub_id=? WHERE id=?')
        .run(mv.rename || sv.name, cat.id, sub.id, sv.id);
    });
    METIERS.forEach(M => {
      let cat = catByNorm[normName(M.m)];
      if (!cat) {
        const id = insCat.run(M.m, M.i, ++catSort).lastInsertRowid;
        cat = { id, name: M.m };
        catByNorm[normName(M.m)] = cat;
      } else if (M.i) {
        db.prepare('UPDATE service_categories SET icon=COALESCE(icon,?) WHERE id=?').run(M.i, cat.id);
      }
      const subByNorm = {};
      db.prepare('SELECT * FROM sous_categories WHERE metier_id=?').all(cat.id).forEach(s => { subByNorm[normName(s.name)] = s; });
      const svcByNorm = {};
      db.prepare('SELECT * FROM services WHERE category_id=?').all(cat.id).forEach(s => { svcByNorm[normName(s.name)] = s; });

      M.sc.forEach((SC, scIdx) => {
        let sub = subByNorm[normName(SC.n)];
        if (!sub) { sub = { id: insSub.run(cat.id, SC.n, scIdx).lastInsertRowid }; subByNorm[normName(SC.n)] = sub; }
        SC.sv.forEach((SV, svIdx) => {
          let svc = svcByNorm[normName(SV.n)];
          if (!svc) {
            svc = { id: insSvc.run(cat.id, sub.id, SV.n, SV.k || '', svIdx).lastInsertRowid };
            svcByNorm[normName(SV.n)] = svc;
          } else {
            // service existant : on le rattache à sa sous-catégorie et on enrichit ses mots-clés
            db.prepare('UPDATE services SET sub_id=COALESCE(sub_id,?), keywords=CASE WHEN keywords=\'\' THEN ? ELSE keywords END WHERE id=?')
              .run(sub.id, SV.k || '', svc.id);
          }
          const nbT = db.prepare('SELECT COUNT(*) n FROM taches WHERE service_id=?').get(svc.id).n;
          if (!nbT && SV.t) SV.t.forEach((t, ti) => insTac.run(svc.id, t, ti));
        });
      });
      // Les anciens services du métier sans sous-catégorie → sous-catégorie "Général"
      const orphelins = db.prepare('SELECT id FROM services WHERE category_id=? AND sub_id IS NULL').all(cat.id);
      if (orphelins.length) {
        let gen = subByNorm[normName('Général')];
        if (!gen) { gen = { id: insSub.run(cat.id, 'Général', 99).lastInsertRowid }; subByNorm[normName('Général')] = gen; }
        orphelins.forEach(o => db.prepare('UPDATE services SET sub_id=? WHERE id=?').run(gen.id, o.id));
      }
    });

    // Toute catégorie restante (hors METIERS, ex. "Canal placement") : sous-catégorie "Général" pour ses services
    db.prepare('SELECT DISTINCT category_id FROM services WHERE sub_id IS NULL').all().forEach(r => {
      const gen = db.prepare('SELECT id FROM sous_categories WHERE metier_id=? AND name=?').get(r.category_id, 'Général');
      const gid = gen ? gen.id : insSub.run(r.category_id, 'Général', 99).lastInsertRowid;
      db.prepare('UPDATE services SET sub_id=? WHERE category_id=? AND sub_id IS NULL').run(gid, r.category_id);
    });

    // Villes de Côte d'Ivoire
    const insVille = db.prepare('INSERT OR IGNORE INTO villes(name, sort) VALUES(?,?)');
    VILLES.forEach((v, i) => insVille.run(v, i));

    // Quelques services populaires par défaut (modifiable dans le tableau de bord)
    ['Ménage à domicile', 'Nettoyage de fauteuils et canapés', 'Réparation de fuite', 'Dépannage électrique',
     'Installation de climatiseur', 'Coiffure femme', 'Soutien scolaire', 'Livraison express']
      .forEach(n => db.prepare('UPDATE services SET popular=1 WHERE name=?').run(n));

  });
  tx();
  setSetting('taxonomie_v1', '1');
  const st = {
    metiers: db.prepare('SELECT COUNT(*) n FROM service_categories').get().n,
    sous: db.prepare('SELECT COUNT(*) n FROM sous_categories').get().n,
    services: db.prepare('SELECT COUNT(*) n FROM services').get().n,
    taches: db.prepare('SELECT COUNT(*) n FROM taches').get().n,
    villes: db.prepare('SELECT COUNT(*) n FROM villes').get().n
  };
  console.log(`📚 Catalogue des métiers installé : ${st.metiers} métiers, ${st.sous} sous-catégories, ${st.services} services, ${st.taches} tâches, ${st.villes} villes.`);
}
seedTaxonomie();

// Tâches pour les services hérités de l'ancienne base (conservés avec leur id d'origine).
// Idempotent : ne touche qu'aux services listés qui n'ont encore AUCUNE tâche.
(function seedLegacyTaches() {
  const LEGACY_TACHES = {
    'Nettoyage de tapis & moquette': ['Nettoyage de tapis', 'Nettoyage de moquette', 'Détachage en profondeur', 'Désodorisation'],
    'Plomberie — dépannage': ['Réparation de fuite d\u2019eau', 'Débouchage de canalisation', 'Réparation WC / chasse d\u2019eau', 'Remplacement de robinet', 'Autre dépannage plomberie'],
    'Menuiserie bois': ['Fabrication de meuble', 'Réparation de meuble', 'Pose de porte en bois', 'Pose d\u2019étagères', 'Ponçage et vernissage'],
    'Menuiserie aluminium & vitrerie': ['Fabrication de fenêtre alu', 'Pose de porte alu', 'Remplacement de vitre', 'Pose de miroir', 'Moustiquaires'],
    'Réparation téléphone & ordinateur': ['Remplacement d\u2019écran', 'Remplacement de batterie', 'Problème de charge', 'Dépannage logiciel', 'Récupération de données'],
    'Transport & livraison': ['Livraison de colis', 'Transport de personnes', 'Transport de marchandises', 'Course express'],
    'Canal placement — personnel': ['Ménagère / femme de ménage', 'Nounou / garde d\u2019enfants', 'Gardien', 'Cuisinier(ère)', 'Chauffeur', 'Autre personnel'],
  };
  const insTac = db.prepare('INSERT INTO taches(service_id, name, sort) VALUES(?,?,?)');
  Object.entries(LEGACY_TACHES).forEach(([n, ts]) => {
    const svc = db.prepare('SELECT id FROM services WHERE name=?').get(n);
    if (svc && !db.prepare('SELECT COUNT(*) n FROM taches WHERE service_id=?').get(svc.id).n)
      ts.forEach((t, ti) => insTac.run(svc.id, t, ti));
  });
})();

// ============================================================
// RÉORGANISATION DES SERVICES (v3) — one-shot
// 1. Un même service ne doit exister qu'une seule fois (dédoublonnage par
//    nom, en conservant le service le plus utilisé ; missions, questions,
//    tâches et profils professionnels sont re-rattachés, rien n'est perdu).
// 2. Ordre d'affichage des services populaires (popular_sort), géré depuis
//    le tableau de bord.
// ============================================================
ensureColumn('services', 'popular_sort', 'INTEGER');
(function reorganisationServicesV3() {
  if (getSetting('services_v3')) return;
  const tx = db.transaction(() => {
    // --- 1. Dédoublonnage par nom normalisé ---
    const groups = {};
    db.prepare('SELECT id, name FROM services ORDER BY id').all()
      .forEach(s => { const k = normName(s.name); (groups[k] = groups[k] || []).push(s); });
    let fusions = 0;
    Object.values(groups).filter(g => g.length > 1).forEach(g => {
      // On garde le service le plus utilisé (missions), sinon le plus ancien
      const nMiss = id => db.prepare('SELECT COUNT(*) n FROM missions WHERE service_id=?').get(id).n;
      g.sort((a, b) => nMiss(b.id) - nMiss(a.id) || a.id - b.id);
      const keep = g[0];
      g.slice(1).forEach(dup => {
        db.prepare('UPDATE missions SET service_id=? WHERE service_id=?').run(keep.id, dup.id);
        db.prepare('UPDATE service_questions SET service_id=? WHERE service_id=?').run(keep.id, dup.id);
        // Tâches : on déplace celles qui n'existent pas déjà sous le service conservé
        const keptTaches = new Set(db.prepare('SELECT name FROM taches WHERE service_id=?').all(keep.id).map(t => normName(t.name)));
        db.prepare('SELECT id, name FROM taches WHERE service_id=?').all(dup.id).forEach(t => {
          if (keptTaches.has(normName(t.name))) db.prepare('DELETE FROM taches WHERE id=?').run(t.id);
          else { db.prepare('UPDATE taches SET service_id=? WHERE id=?').run(keep.id, t.id); keptTaches.add(normName(t.name)); }
        });
        // Profils professionnels : remplacement de l'id du doublon par celui conservé
        db.prepare('SELECT user_id, services FROM pro_profiles').all().forEach(p => {
          let ids; try { ids = JSON.parse(p.services || '[]'); } catch { ids = []; }
          if (ids.includes(dup.id)) {
            ids = [...new Set(ids.map(x => x === dup.id ? keep.id : x))];
            db.prepare('UPDATE pro_profiles SET services=? WHERE user_id=?').run(JSON.stringify(ids), p.user_id);
          }
        });
        // Le doublon hérite du statut populaire s'il l'avait
        const d = db.prepare('SELECT popular FROM services WHERE id=?').get(dup.id);
        if (d && d.popular) db.prepare('UPDATE services SET popular=1 WHERE id=?').run(keep.id);
        db.prepare('DELETE FROM services WHERE id=?').run(dup.id);
        fusions++;
      });
    });
    // --- 2. Ordre initial des services populaires ---
    db.prepare('SELECT id FROM services WHERE popular=1 ORDER BY sort, id').all()
      .forEach((s, i) => db.prepare('UPDATE services SET popular_sort=? WHERE id=?').run(i + 1, s.id));
    if (fusions) console.log(`🧹 Réorganisation des services : ${fusions} doublon(s) fusionné(s) sans perte de données.`);
  });
  tx();
  setSetting('services_v3', '1');
})();

module.exports = { db, hashPassword, getSetting, setSetting, DB_PATH };
