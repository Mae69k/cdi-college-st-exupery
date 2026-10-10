const express = require('express');
const db = require('../db');
const auth = require('../auth');
const util = require('../util');

const router = express.Router();

async function metaNumbers() {
  const m = await db.getMeta();
  const loanDays = Number(m.loanDays) > 0 ? Number(m.loanDays) : 14;
  const maxLoans = Number.isFinite(Number(m.maxLoansPerStudent)) ? Number(m.maxLoansPerStudent) : 3;
  return { loanDays, maxLoans };
}

// Recherche d'eleves (nom de famille)
router.get('/students/search', auth.requireStaff, async (req, res, next) => {
  try {
    const raw = String(req.query.q || '').trim();
    const like = `%${raw}%`;
    const { rows } = await db.query(
      `SELECT u.id, u.login, u.nom, u.prenom, u.classe,
        (SELECT COUNT(*) FROM loans l WHERE l.user_id = u.id AND l.status = 'en_cours') AS emprunts
       FROM users u
       WHERE u.role = 'eleve'
         AND ($1 = '' OR u.nom ILIKE $2 OR u.prenom ILIKE $2 OR u.login ILIKE $2
              OR COALESCE(u.classe,'') ILIKE $2 OR (u.prenom || ' ' || u.nom) ILIKE $2 OR (u.nom || ' ' || u.prenom) ILIKE $2)
       ORDER BY u.nom, u.prenom
       LIMIT 30`,
      [raw, like]
    );
    const students = rows.map((r) => ({
      id: r.id,
      login: r.login,
      nom: r.nom,
      prenom: r.prenom,
      classe: r.classe || null,
      empruntsEnCours: Number(r.emprunts || 0)
    }));
    res.json({ students, total: students.length });
  } catch (err) {
    next(err);
  }
});

// Liste des emprunts
router.get('/', auth.requireAuth, async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (auth.isStaff(req.user)) {
      if (req.query.userId) { params.push(Number(req.query.userId)); where.push(`l.user_id = $${params.length}`); }
    } else {
      params.push(req.user.id); where.push(`l.user_id = $${params.length}`);
    }
    if (req.query.status) { params.push(String(req.query.status)); where.push(`l.status = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await db.query(`${util.LOAN_SELECT} ${clause} ORDER BY l.date_emprunt DESC`, params);
    res.json({ loans: rows.map(util.mapLoan), total: rows.length });
  } catch (err) {
    next(err);
  }
});

// Enregistrer un emprunt (personnel)
router.post('/', auth.requireStaff, async (req, res, next) => {
  try {
    const { loanDays, maxLoans } = await metaNumbers();
    const userId = Number(req.body.userId);
    const code = String(req.body.bookCode || '').trim().toUpperCase().replace(/\s+/g, '');
    const duration = Number(req.body.days) > 0 ? Number(req.body.days) : loanDays;

    const studentRes = await db.query('SELECT * FROM users WHERE id = $1 AND role = $2', [userId, auth.ROLES.ELEVE]);
    const student = studentRes.rows[0];
    if (!student) return res.status(404).json({ error: 'Eleve introuvable.' });

    const bookRes = await db.query('SELECT * FROM books WHERE code = $1', [code]);
    const book = bookRes.rows[0];
    if (!book) return res.status(404).json({ error: `Aucun livre ne porte le code ${code || '(vide)'}.` });

    const activeRes = await db.query("SELECT id FROM loans WHERE book_id = $1 AND status = 'en_cours'", [book.id]);
    if (activeRes.rows.length) return res.status(409).json({ error: `Le livre ${book.code} est deja emprunte.` });

    const countRes = await db.query("SELECT COUNT(*)::int AS n FROM loans WHERE user_id = $1 AND status = 'en_cours'", [userId]);
    if (maxLoans > 0 && countRes.rows[0].n >= maxLoans) {
      return res.status(409).json({ error: `${student.prenom} ${student.nom} a deja ${countRes.rows[0].n} livres empruntes (limite : ${maxLoans}).` });
    }

    let loanId;
    try {
      const ins = await db.query(
        `INSERT INTO loans (book_id, user_id, staff_id, date_retour_prevue, status)
         VALUES ($1, $2, $3, $4, 'en_cours') RETURNING id`,
        [book.id, student.id, req.user.id, util.addDays(new Date(), duration).toISOString()]
      );
      loanId = ins.rows[0].id;
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: `Le livre ${book.code} est deja emprunte.` });
      throw err;
    }

    await db.query('DELETE FROM reservations WHERE book_id = $1 AND user_id = $2', [book.id, student.id]);

    const { rows } = await db.query(`${util.LOAN_SELECT} WHERE l.id = $1`, [loanId]);
    await auth.logActivity(req.user, 'emprunt', `${book.code} -> ${student.prenom} ${student.nom}`);
    res.status(201).json({ loan: util.mapLoan(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// Enregistrer un retour
router.post('/:id/return', auth.requireStaff, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cur = await db.query('SELECT * FROM loans WHERE id = $1', [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Emprunt introuvable.' });
    if (cur.rows[0].status !== 'en_cours') return res.status(409).json({ error: 'Ce livre est deja rendu.' });
    await db.query("UPDATE loans SET status='rendu', date_retour=NOW(), return_staff_id=$1 WHERE id=$2", [req.user.id, id]);
    const { rows } = await db.query(`${util.LOAN_SELECT} WHERE l.id = $1`, [id]);
    await auth.logActivity(req.user, 'retour', `emprunt #${id}`);
    res.json({ loan: util.mapLoan(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// Prolonger un emprunt
router.post('/:id/renew', auth.requireStaff, async (req, res, next) => {
  try {
    const { loanDays } = await metaNumbers();
    const id = Number(req.params.id);
    const cur = await db.query('SELECT * FROM loans WHERE id = $1', [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Emprunt introuvable.' });
    if (cur.rows[0].status !== 'en_cours') return res.status(409).json({ error: 'Impossible de prolonger un emprunt termine.' });
    const days = Number(req.body.days) > 0 ? Number(req.body.days) : loanDays;
    const base = new Date(cur.rows[0].date_retour_prevue) > new Date() ? new Date(cur.rows[0].date_retour_prevue) : new Date();
    await db.query('UPDATE loans SET date_retour_prevue = $1 WHERE id = $2', [util.addDays(base, days).toISOString(), id]);
    const { rows } = await db.query(`${util.LOAN_SELECT} WHERE l.id = $1`, [id]);
    await auth.logActivity(req.user, 'prolongation', `emprunt #${id} (+${days}j)`);
    res.json({ loan: util.mapLoan(rows[0]) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
