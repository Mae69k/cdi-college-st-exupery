// Postgres local persistant pour le developpement.
// Les binaires sont copies vers un chemin ASCII car initdb d'UTF8 echoue
// sous Windows si le chemin des binaires contient des caracteres non-ASCII.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOME = process.env.LOCALAPPDATA || os.tmpdir();
const BASE = path.join(HOME, 'cdi-dev');
const PG_BIN = path.join(BASE, 'pgbin');
const DATA_DIR = path.join(BASE, 'pgdata');
const PORT = 55433;
const DB_NAME = 'cdi';

const binPostgres = path.join(PG_BIN, 'bin', 'postgres.exe');
const binInitdb = path.join(PG_BIN, 'bin', 'initdb.exe');
const binPgCtl = path.join(PG_BIN, 'bin', 'pg_ctl.exe');

function ensureBinaries() {
  if (fs.existsSync(binPostgres)) return;
  const srcNative = path.join(ROOT, 'node_modules', '@embedded-postgres', 'windows-x64', 'native');
  fs.mkdirSync(PG_BIN, { recursive: true });
  fs.cpSync(srcNative, PG_BIN, { recursive: true });
}

function initialise() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'))) return;
  execFileSync(binInitdb, [
    '-D', DATA_DIR, '--encoding=UTF8', '--locale=C', '--username=postgres', '--auth=trust'
  ], { stdio: 'pipe' });
}

(async () => {
  const srcInitdb = path.join(ROOT, 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin', 'initdb.exe');
  if (!fs.existsSync(srcInitdb)) {
    console.error('[localpg] Binaires Postgres absents. Installez la devDependency embedded-postgres (npm install).');
    process.exit(1);
  }
  console.log('[localpg] copie des binaires (chemin ASCII)...');
  ensureBinaries();
  console.log('[localpg] initialisation du cluster le cas echeant...');
  initialise();

  console.log('[localpg] demarrage du serveur postgres sur le port ' + PORT + '...');
  const postgres = spawn(binPostgres, ['-D', DATA_DIR, '-p', String(PORT), '-k', DATA_DIR], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  postgres.stdout.on('data', (d) => process.stdout.write(d));
  postgres.stderr.on('data', (d) => process.stderr.write(d));
  postgres.on('exit', (code) => {
    console.log('[localpg] serveur arrete (code ' + code + ').');
  });

  // Attente du serveur puis creation de la base si absente.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const { Client } = require('pg');
  let admin = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      admin = new Client({ host: '127.0.0.1', port: PORT, user: 'postgres', database: 'postgres' });
      await admin.connect();
      break;
    } catch (e) { admin = null; }
  }
  if (!admin) {
    console.error('[localpg] postgres pas pret. Verifier le port ' + PORT + '.');
    postgres.kill();
    process.exit(1);
  }
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
  if (!exists.rows.length) {
    await admin.query('CREATE DATABASE ' + DB_NAME);
    console.log('[localpg] base "' + DB_NAME + '" creee.');
  }
  await admin.end();
  console.log('[localpg] postgres pret.');
  console.log('[localpg]   binaire : ' + binPostgres);
  console.log('[localpg]   donnees : ' + DATA_DIR);
  console.log('[localpg]   URL     : postgres://postgres@127.0.0.1:' + PORT + '/' + DB_NAME);
  console.log('[localpg]   (Ctrl+C pour arreter, ou: npx pg-ctl)');

  process.on('SIGINT', async () => {
    await postgres.kill();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await postgres.kill();
    process.exit(0);
  });
  setInterval(() => {}, 1 << 30).unref();
})().catch((e) => {
  console.error('[localpg] erreur', e);
  process.exit(1);
});