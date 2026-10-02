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

module.exports = { db, hashPassword, getSetting, setSetting, DB_PATH };
