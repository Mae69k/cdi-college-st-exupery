const db = require('./db');
const auth = require('./auth');

const DEFAULTS = [
  {
    login: 'leboursin.maeron',
    password: 'Maeron.StExupery#26',
    role: auth.ROLES.PRINCIPAL,
    nom: 'LEBOURSIN',
    prenom: 'Maeron',
    mustChangePassword: false
  },
  { login: 'principal', password: 'Principal2026!', role: auth.ROLES.PRINCIPAL, nom: 'Dupont', prenom: 'Marie' },
  { login: 'documentaliste', password: 'CDI2026!', role: auth.ROLES.DOCUMENTALISTE, nom: 'Bernard', prenom: 'Sophie' },
  { login: 'adjoint', password: 'Adjoint2026!', role: auth.ROLES.PRINCIPAL_ADJOINT, nom: 'Martin', prenom: 'Paul' }
];

async function seed() {
  const created = [];
  for (const d of DEFAULTS) {
    const exists = await db.query('SELECT id FROM users WHERE lower(login) = lower($1)', [d.login]);
    if (exists.rows.length) continue;
    await db.query(
      `INSERT INTO users (login, role, nom, prenom, password_hash, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [d.login, d.role, d.nom, d.prenom, auth.hashPassword(d.password), d.mustChangePassword !== false]
    );
    created.push(d);
  }

  if (!created.length) return;

  console.log('\n  ============================================================');
  console.log('   Comptes crees automatiquement (pensez a changer les mots de passe)');
  console.log('  ------------------------------------------------------------');
  created.forEach((d) => {
    console.log(`   ${String(auth.ROLE_LABELS[d.role]).padEnd(34)} ${d.login.padEnd(18)} ${d.password}`);
  });
  console.log('  ============================================================\n');
}

module.exports = seed;
