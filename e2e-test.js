const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

const ROOT = __dirname;
const PORT = 55432;
const tmp = path.join(os.tmpdir(), 'cdi-pg-' + Date.now());
const pgBin = path.join(tmp, 'pgbin-native');
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(tmp, { recursive: true });

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.log('  FAIL  ' + name + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : '')); }
}

const pgClient = () => new (require('pg').Client)({ host: '127.0.0.1', port: PORT, user: 'postgres', database: 'postgres' });

(async () => {
  console.log('[setup] copie des binaires PostgreSQL vers un chemin ASCII...');
  const srcNative = path.join(ROOT, 'node_modules', '@embedded-postgres', 'windows-x64', 'native');
  fs.cpSync(srcNative, pgBin, { recursive: true });

  const binDir = path.join(pgBin, 'bin');
  console.log('[setup] initdb (UTF8, locale C, trust)...');
  execFileSync(path.join(binDir, 'initdb.exe'), [
    '-D', dataDir, '--encoding=UTF8', '--locale=C', '--username=postgres', '--auth=trust'
  ], { stdio: 'pipe' });

  console.log('[setup] demarrage du serveur postgres...');
  const postgres = spawn(path.join(binDir, 'postgres.exe'), ['-D', dataDir, '-p', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  postgres.stdout.on('data', (d) => { logs += d; });
  postgres.stderr.on('data', (d) => { logs += d; });
  postgres.on('exit', (code) => { logs += `\n[postgres exited code=${code}]`; });

  // Attente de la disponibilite du port
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const probe = pgClient();
      await probe.connect();
      await probe.end();
      ready = true;
      break;
    } catch (e) { /* pas encore prêt */ }
  }
  if (!ready) {
    console.error('[setup] postgres pas pret. Logs:\n' + logs);
    process.exit(1);
  }
  console.log('[setup] creation de la base cdi...');
  {
    const c = pgClient();
    await c.connect();
    await c.query('CREATE DATABASE cdi');
    await c.end();
  }

  process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${PORT}/cdi`;
  process.env.POSTGRES_URL = process.env.DATABASE_URL;
  process.env.SESSION_SECRET = 'e2e-secret';
  process.env.NODE_ENV = 'test';

  const createApp = require('./src/createApp');
  const app = createApp();
  const server = app.listen(0);
  await new Promise((res) => server.once('listening', res));
  const base = 'http://localhost:' + server.address().port;

  let cookie = '';
  async function req(method, url, body) {
    const opts = { method, headers: {} };
    if (cookie) opts.headers.Cookie = cookie;
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(base + url, opts);
    const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }

  console.log('\n== Authentification ==');
  let r = await req('POST', '/api/auth/login', { login: 'principal', password: 'Principal2026!' });
  check('login principal (defaut)', r.status === 200 && r.data.user && r.data.user.role === 'principal', r);
  check('cookie de session recu', cookie.includes('cdi_sid='), cookie);

  let me = await req('GET', '/api/auth/me');
  check('GET /me', me.status === 200 && me.data.user.login === 'principal', me);

  r = await req('POST', '/api/auth/login', { login: 'leboursin.maeron', password: 'Maeron.StExupery#26' });
  check('login leboursin.maeron', r.status === 200 && r.data.user.nom === 'LEBOURSIN' && r.data.user.prenom === 'Maeron', r);
  check('leboursin role principal + pas de changement mdp', r.data.user.role === 'principal' && r.data.user.mustChangePassword === false, r.data.user);

  r = await req('POST', '/api/auth/login', { login: 'principal', password: 'MauvaisMotDePasse' });
  check('mauvais mot de passe => 401', r.status === 401, r);

  // Retour sur principal
  await req('POST', '/api/auth/login', { login: 'principal', password: 'Principal2026!' });

  console.log('\n== Catalogue (livres) ==');
  r = await req('POST', '/api/books', {
    code: 'fr-001', titre: 'Le Petit Prince', auteur: 'Antoine de Saint-Exupery',
    tome: '', genre: 'Conte', description: 'Un classique.',
    dateMiseEnLigne: 'now',
    coverUrl: 'https://blob.example/covers/petit-prince.png',
    pdfUrl: 'https://blob.example/pdfs/petit-prince.pdf'
  });
  check('creer un livre (JSON + urls)', r.status === 201 && r.data.book.code === 'FR-001', r);
  const bookId = r.data.book && r.data.book.id;

  check('code normalise en majuscules', r.data.book && r.data.book.code === 'FR-001', r.data.book && r.data.book.code);
  check('livre disponible par defaut', r.data.book && r.data.book.disponible === true, r.data.book);
  check('coverUrl conserve', r.data.book && r.data.book.coverUrl === 'https://blob.example/covers/petit-prince.png', r.data.book);

  r = await req('POST', '/api/books', { code: 'FR-001', titre: 'Doublon', auteur: 'X', coverUrl: 'a', pdfUrl: 'b' });
  check('code duplique => 409', r.status === 409, r);

  r = await req('POST', '/api/books', { code: 'FR-002', titre: 'Sans PDF', auteur: 'X', coverUrl: 'a' });
  check('PDF manquant => 400', r.status === 400, r);

  r = await req('POST', '/api/books', { code: 'fr-002', titre: 'Sans couverture', auteur: 'X', pdfUrl: 'b' });
  check('couverture manquante => 400', r.status === 400, r);

  r = await req('POST', '/api/books', {
    code: 'fr-002', titre: 'Harry Potter', auteur: 'J.K. Rowling', genre: 'Fantastique',
    coverUrl: 'https://blob.example/covers/hp.png', pdfUrl: 'https://blob.example/pdfs/hp.pdf',
    dateMiseEnLigne: '2024-09-01T08:30'
  });
  check('creer 2e livre avec date explicite', r.status === 201, r);

  r = await req('GET', '/api/books');
  check('liste catalogue = 2', r.status === 200 && r.data.total === 2, r.data && r.data.total);
  check('tri par defaut = recent', r.data.books[0].code === 'FR-001', r.data.books.map((b) => b.code));

  r = await req('GET', '/api/books?q=harry');
  check('recherche plein texte', r.data.total === 1 && r.data.books[0].code === 'FR-002', r.data);

  r = await req('GET', '/api/books/genres');
  check('liste des genres', r.data.genres.includes('Fantastique') && r.data.genres.includes('Conte'), r.data);

  r = await req('PUT', '/api/books/' + bookId, { titre: 'Le Petit Prince (edition illustree)', genre: 'Jeunesse' });
  check('modifier un livre', r.status === 200 && r.data.book.titre === 'Le Petit Prince (edition illustree)' && r.data.book.genre === 'Jeunesse', r);

  console.log('\n== Comptes eleves ==');
  r = await req('POST', '/api/users', { login: 'dupont.marie', nom: 'DUPONT', prenom: 'Marie', classe: '6A', password: 'EleveTest1' });
  check('creer un eleve', r.status === 201 && r.data.user.role === 'eleve', r);
  const eleveId = r.data.user && r.data.user.id;

  r = await req('POST', '/api/users', { login: 'martin.luc', nom: 'Martin', prenom: 'Luc', classe: '5B' });
  check('creer eleve avec mdp genere', r.status === 201 && typeof r.data.initialPassword === 'string' && r.data.initialPassword.length >= 6, r);

  r = await req('POST', '/api/users', { login: 'dupont.marie', nom: 'DUPONT', prenom: 'Marie', classe: '6A' });
  check('login eleve duplique => 409', r.status === 409, r);

  r = await req('POST', '/api/users', { login: 'sansclasse', nom: 'X', prenom: 'Y' });
  check('eleve sans classe => 400', r.status === 400, r);

  r = await req('GET', '/api/loans/students/search?q=dup');
  check('recherche eleve par nom partiel', r.status === 200 && r.data.students.length === 1 && r.data.students[0].nom === 'DUPONT', r.data);
  check('recherche eleve insensible casse', (await req('GET', '/api/loans/students/search?q=DUPONT')).data.total === 1);

  console.log('\n== Emprunts (staff) ==');
  r = await req('POST', '/api/loans', { userId: eleveId, bookCode: 'fr-001' });
  check('enregistrer un emprunt', r.status === 201 && r.data.loan.status === 'en_cours', r);
  const loanId = r.data.loan && r.data.loan.id;
  check('emprunt lie au bon eleve et livre', r.data.loan.userId === eleveId && r.data.loan.code === 'FR-001', r.data.loan);

  r = await req('POST', '/api/loans', { userId: eleveId, bookCode: 'FR-001' });
  check('livre deja emprunte => 409', r.status === 409, r);

  r = await req('POST', '/api/loans', { userId: eleveId, bookCode: 'INEXISTANT' });
  check('code livre inconnu => 404', r.status === 404, r);

  r = await req('GET', '/api/books');
  const b1 = r.data.books.find((b) => b.code === 'FR-001');
  check('livre emprunte marque indisponible', b1 && b1.disponible === false, b1);

  r = await req('GET', '/api/loans?status=en_cours');
  check('liste emprunts en cours', r.data.total === 1, r.data);

  console.log('\n== Statistiques / parametres ==');
  r = await req('GET', '/api/stats');
  check('stats coherentes', r.data.books === 2 && r.data.students === 2 && r.data.activeLoans === 1, r.data);

  r = await req('PUT', '/api/settings', { etablissement: 'College Saint-Exupery', anneeScolaire: '2026-2027', loanDays: 21, maxLoansPerStudent: 2 });
  check('modifier parametres', r.status === 200, r);
  r = await req('GET', '/api/settings');
  check('parametres enregistres', r.data.loanDays === 21 && r.data.maxLoansPerStudent === 2, r.data);

  r = await req('POST', '/api/loans', { userId: eleveId, bookCode: 'FR-002', days: 7 });
  check('2e emprunt (limite = 2)', r.status === 201, r);
  const loan2 = r.data.loan && r.data.loan.id;
  r = await req('POST', '/api/loans', { userId: eleveId, bookCode: 'FR-002' });
  check('limite emprunts atteinte => 409', r.status === 409, r);

  console.log('\n== Retour / prolongation ==');
  r = await req('POST', '/api/loans/' + loan2 + '/return');
  check('enregistrer un retour', r.status === 200 && r.data.loan.status === 'rendu', r);
  r = await req('POST', '/api/loans/' + loan2 + '/return');
  check('retour double => 409', r.status === 409, r);
  r = await req('POST', '/api/loans/' + loanId + '/renew', { days: 5 });
  check('prolonger un emprunt', r.status === 200 && r.data.loan.id === loanId, r);

  console.log('\n== Favoris / reservations / avis (eleve) ==');
  cookie = '';
  r = await req('POST', '/api/auth/login', { login: 'dupont.marie', password: 'EleveTest1' });
  check('login eleve', r.status === 200 && r.data.user.role === 'eleve', r);

  r = await req('POST', '/api/books', { code: 'X-1', titre: 'T', auteur: 'A', coverUrl: 'c', pdfUrl: 'p' });
  check('eleve ne peut pas ajouter de livre => 403', r.status === 403, r);

  r = await req('GET', '/api/stats');
  check('eleve ne peut pas voir stats => 403', r.status === 403, r);

  r = await req('POST', '/api/favorites', { bookId: bookId });
  check('ajouter un favori', r.status === 200, r);
  r = await req('GET', '/api/favorites');
  check('lister favoris', r.data.books.length === 1 && r.data.books[0].id === bookId, r.data);
  r = await req('DELETE', '/api/favorites/' + bookId);
  check('retirer favori', r.status === 200 && (await req('GET', '/api/favorites')).data.books.length === 0);

  r = await req('POST', '/api/reservations', { bookId: bookId });
  check('creer une reservation', r.status === 201, r);
  r = await req('POST', '/api/reservations', { bookId: bookId });
  check('reservation double => 409', r.status === 409, r);
  r = await req('GET', '/api/reservations');
  check('eleve voit ses reservations', r.data.total === 1, r.data);

  r = await req('POST', '/api/reviews', { bookId: bookId, rating: 5, text: 'Genial !' });
  check('creer un avis', r.status === 201, r);
  r = await req('POST', '/api/reviews', { bookId: bookId, rating: 4, text: 'Tres bien' });
  check('modifier son avis (upsert)', r.status === 201, r);
  r = await req('GET', '/api/books/' + bookId);
  check('avis attache au livre', r.data.book.reviews.length === 1 && r.data.book.reviews[0].rating === 4, r.data.book.reviews);

  console.log('\n== Journal / suppression ==');
  await req('POST', '/api/auth/login', { login: 'principal', password: 'Principal2026!' });
  r = await req('GET', '/api/activity');
  check('journal activite rempli', r.data.activity.length > 0, r.data.activity && r.data.activity.length);

  r = await req('DELETE', '/api/books/' + bookId);
  check('impossible de supprimer un livre emprunte => 409', r.status === 409, r);

  // rendre d'abord
  await req('POST', '/api/loans/' + loanId + '/return');
  r = await req('DELETE', '/api/books/' + bookId);
  check('supprimer un livre disponible', r.status === 200, r);

  r = await req('GET', '/api/reservations');
  check('reservations du livre supprime nettoyees', r.data.total === 0, r.data);

  r = await req('DELETE', '/api/users/' + eleveId);
  check('supprimer un eleve sans emprunt en cours', r.status === 200, r);

  console.log('\n== Deconnexion ==');
  r = await req('POST', '/api/auth/logout');
  check('logout', r.status === 200, r);
  r = await req('GET', '/api/auth/me');
  check('session invalidee apres logout => 401', r.status === 401, r);

  server.close();
  try { execFileSync(path.join(binDir, 'pg_ctl.exe'), ['-D', dataDir, '-m', 'fast', 'stop', '-w'], { stdio: 'pipe' }); } catch (e) { postgres.kill(); }
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\n' + (failures === 0 ? 'TOUS LES TESTS PASSENT' : failures + ' TEST(S) EN ECHEC'));
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('ERREUR FATALE', e);
  process.exit(1);
});