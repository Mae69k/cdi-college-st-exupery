const { Pool } = require('pg');
const { parse } = require('pg-connection-string');

function firstEnv(names) {
  for (const name of names) {
    const v = process.env[name];
    if (v && String(v).trim()) return String(v).trim();
  }
  return '';
}

const urlNames = [
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_URL_NON_POOLING'
];
const rawUrl = firstEnv(urlNames);

let source = null;
for (const name of urlNames) {
  if (process.env[name] && String(process.env[name]).trim()) { source = name; break; }
}

let conn = {};
if (rawUrl) {
  // On extrait explicitement host/user/password/base : cela ignore les parametres
  // d'URL (sslmode, channel_binding, ...) que la librairie pg ne comprend pas.
  const parsed = parse(rawUrl);
  conn = {
    host: parsed.host,
    port: parsed.port ? Number(parsed.port) : 5432,
    user: parsed.user,
    password: parsed.password,
    database: parsed.database || 'postgres'
  };
} else if (process.env.PGHOST) {
  source = 'PGHOST';
  conn = {
    host: process.env.PGHOST,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE || 'postgres'
  };
}

const configured = Boolean(conn.host);

if (!configured) {
  console.warn('[db] Aucune connexion Postgres configuree (DATABASE_URL / POSTGRES_URL / PGHOST).');
} else {
  console.log(`[db] connexion via ${source} -> ${conn.host}:${conn.port}/${conn.database}`);
}

const isLocal = /^(localhost|127\.0\.0\.1|::1)$/.test(conn.host || '') || !configured;

const pool = new Pool({
  ...conn,
  max: Number(process.env.PGPOOL_MAX) || 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
  ssl: isLocal || process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('[db] erreur de pool inattendue:', err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  login TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL,
  nom TEXT NOT NULL,
  prenom TEXT NOT NULL,
  classe TEXT,
  email TEXT,
  password_hash TEXT NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INTEGER
);

CREATE TABLE IF NOT EXISTS books (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  titre TEXT NOT NULL,
  auteur TEXT NOT NULL,
  tome TEXT,
  genre TEXT,
  description TEXT,
  date_mise_en_ligne TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cover_url TEXT,
  pdf_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loans (
  id SERIAL PRIMARY KEY,
  book_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  staff_id INTEGER,
  return_staff_id INTEGER,
  date_emprunt TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  date_retour_prevue TIMESTAMPTZ NOT NULL,
  date_retour TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'en_cours'
);

CREATE TABLE IF NOT EXISTS reservations (
  id SERIAL PRIMARY KEY,
  book_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (book_id, user_id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  book_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  text TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (book_id, user_id)
);

CREATE TABLE IF NOT EXISTS favorites (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  book_id INTEGER NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, book_id)
);

CREATE TABLE IF NOT EXISTS activity (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  user_label TEXT,
  role TEXT,
  action TEXT,
  details TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_loans_status ON loans (status);
CREATE INDEX IF NOT EXISTS idx_loans_user ON loans (user_id);
CREATE INDEX IF NOT EXISTS idx_loans_book ON loans (book_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_loan ON loans (book_id) WHERE status = 'en_cours';
CREATE INDEX IF NOT EXISTS idx_reservations_book ON reservations (book_id);
CREATE INDEX IF NOT EXISTS idx_reviews_book ON reviews (book_id);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites (user_id);
CREATE INDEX IF NOT EXISTS idx_activity_at ON activity (at DESC);
`;

let readyPromise = null;

function init() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    if (!configured) {
      throw new Error("Aucune base Postgres configuree. Definissez la variable DATABASE_URL (ou POSTGRES_URL) dans Vercel, puis redeployez.");
    }
    await query(SCHEMA);
    const defaults = [
      ['loanDays', '14'],
      ['maxLoansPerStudent', '3'],
      ['etablissement', 'College Saint-Exupery'],
      ['anneeScolaire', '']
    ];
    for (const [key, value] of defaults) {
      await query('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, value]);
    }
  })().catch((err) => {
    readyPromise = null;
    throw err;
  });
  return readyPromise;
}

async function getMeta() {
  const { rows } = await query('SELECT key, value FROM meta');
  const meta = {};
  rows.forEach((r) => { meta[r.key] = r.value; });
  return meta;
}

async function setMeta(key, value) {
  await query(
    'INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, String(value)]
  );
}

module.exports = { pool, query, withClient, init, getMeta, setMeta, isConfigured: () => configured, source: () => source, target: () => (configured ? `${conn.host}:${conn.port}/${conn.database}` : null) };
