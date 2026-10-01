// ============================================================
// KLEAN-SERVICES CI — Persistance PostgreSQL (Render)
// Sauvegarde la base SQLite et les fichiers (photos/audio) dans
// PostgreSQL pour que RIEN ne soit perdu lors des redéploiements.
// Activée automatiquement si la variable DATABASE_URL est définie.
// ============================================================
const fs = require('fs');
const path = require('path');

let pool = null;
const DB_URL = process.env.DATABASE_URL || '';

function enabled() { return !!pool; }

async function tryConnect(ssl) {
  const { Pool } = require('pg');
  const p = new Pool({ connectionString: DB_URL, max: 3, ssl });
  await p.query('SELECT 1');
  return p;
}

async function init() {
  if (!DB_URL) return false;
  const local = /localhost|127\.0\.0\.1/.test(DB_URL);
  // On essaie d'abord avec SSL (Neon, Supabase, Render externe...), puis sans (local, interne)
  const attempts = local
    ? [false, { rejectUnauthorized: false }]
    : [{ rejectUnauthorized: false }, false];
  let lastErr = null;
  for (const ssl of attempts) {
    try { pool = await tryConnect(ssl); lastErr = null; break; }
    catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  await pool.query(`CREATE TABLE IF NOT EXISTS ks_storage(
    key TEXT PRIMARY KEY, data BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ks_files(
    name TEXT PRIMARY KEY, data BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  console.log('🐘 PostgreSQL connecté : sauvegarde automatique activée.');
  return true;
}

// ---- Base de données SQLite (fichier complet) ----
async function restoreDb(dbPath) {
  const r = await pool.query("SELECT data, updated_at FROM ks_storage WHERE key='sqlite'");
  if (!r.rows.length) return false;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, r.rows[0].data);
  console.log('🐘 Base de données restaurée depuis PostgreSQL (sauvegarde du ' + r.rows[0].updated_at.toISOString() + ').');
  return true;
}
async function backupDb(buf) {
  await pool.query(`INSERT INTO ks_storage(key, data, updated_at) VALUES('sqlite', $1, now())
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = now()`, [buf]);
}

// ---- Fichiers téléversés (photos, audio, documents) ----
async function saveFile(name, buf) {
  await pool.query(`INSERT INTO ks_files(name, data) VALUES($1, $2)
    ON CONFLICT(name) DO UPDATE SET data = excluded.data`, [name, buf]);
}
async function loadFile(name) {
  const r = await pool.query('SELECT data FROM ks_files WHERE name=$1', [name]);
  return r.rows.length ? r.rows[0].data : null;
}
async function deleteFilesOlderThan(days) {
  const r = await pool.query("DELETE FROM ks_files WHERE created_at < now() - ($1 || ' days')::interval", [String(days)]);
  return r.rowCount;
}

module.exports = { init, enabled, restoreDb, backupDb, saveFile, loadFile, deleteFilesOlderThan };
