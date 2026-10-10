const express = require('express');
const { handleUploadPresigned } = require('@vercel/blob/client');
const { issueSignedToken } = require('@vercel/blob');
const db = require('../db');
const auth = require('../auth');
const util = require('../util');
const blob = require('../blob');

const router = express.Router();

/* ------------------------------------------------------------- upload Blob */

const BLOB_ALLOWED_TYPES = [
  'application/pdf',
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'
];
const BLOB_MAX_SIZE = 80 * 1024 * 1024;

// Le callback "blob.upload-completed" est appele par Vercel (sans cookie) :
// on le laisse passer, sa signature est verifiee par handleUploadPresigned.
function requireStaffUnlessCallback(req, res, next) {
  if (req.body && req.body.type === 'blob.upload-completed') return next();
  return auth.requireStaff(req, res, next);
}

router.post('/blob/upload', requireStaffUnlessCallback, async (req, res) => {
  if (!blob.hasToken()) {
    return res.status(500).json({ error: 'Stockage Blob non configure.' });
  }
  try {
    const jsonResponse = await handleUploadPresigned({
      body: req.body,
      request: req,
      getSignedToken: async (pathname) => ({
        token: await issueSignedToken({
          pathname,
          operations: ['put'],
          allowedContentTypes: BLOB_ALLOWED_TYPES,
          maximumSizeInBytes: BLOB_MAX_SIZE,
          validUntil: Date.now() + 60 * 60 * 1000
        }),
        urlOptions: {
          allowedContentTypes: BLOB_ALLOWED_TYPES,
          maximumSizeInBytes: BLOB_MAX_SIZE,
          validUntil: Date.now() + 10 * 60 * 1000,
          addRandomSuffix: true,
          allowOverwrite: false
        }
      })
    });
    res.json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* -------------------------------------------------------------- statistiques */

router.get('/stats', auth.requireStaff, async (req, res, next) => {
  try {
    const one = async (sql, params) => (await db.query(sql, params)).rows[0].n;
    const books = await one('SELECT COUNT(*)::int AS n FROM books');
    const students = await one("SELECT COUNT(*)::int AS n FROM users WHERE role = 'eleve'");
    const activeLoans = await one("SELECT COUNT(*)::int AS n FROM loans WHERE status = 'en_cours'");
    const overdue = await one("SELECT COUNT(*)::int AS n FROM loans WHERE status = 'en_cours' AND date_retour_prevue < NOW()");
    const reservations = await one('SELECT COUNT(*)::int AS n FROM reservations');
    const reviews = await one('SELECT COUNT(*)::int AS n FROM reviews');
    const loansTotal = await one('SELECT COUNT(*)::int AS n FROM loans');

    const top = await db.query(
      `SELECT b.titre, b.code, COUNT(*)::int AS emprunts
       FROM loans l JOIN books b ON b.id = l.book_id
       GROUP BY b.id, b.titre, b.code ORDER BY emprunts DESC, b.titre LIMIT 5`
    );
    const recent = await db.query(`${util.LOAN_SELECT} ORDER BY l.date_emprunt DESC LIMIT 8`);

    res.json({
      books, students, activeLoans, overdue, reservations, reviews, loansTotal,
      topBooks: top.rows.map((r) => ({ titre: r.titre, code: r.code, emprunts: r.emprunts })),
      recentLoans: recent.rows.map(util.mapLoan)
    });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------- parametres */

router.get('/settings', auth.requireAuth, async (req, res, next) => {
  try {
    const m = await db.getMeta();
    res.json({
      etablissement: m.etablissement || 'College Saint-Exupery',
      anneeScolaire: m.anneeScolaire || '',
      loanDays: Number(m.loanDays) || 14,
      maxLoansPerStudent: Number(m.maxLoansPerStudent) || 3
    });
  } catch (err) {
    next(err);
  }
});

router.put('/settings', auth.requireRole(auth.ROLES.PRINCIPAL, auth.ROLES.DOCUMENTALISTE), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (b.etablissement !== undefined) await db.setMeta('etablissement', String(b.etablissement).trim() || 'College Saint-Exupery');
    if (b.anneeScolaire !== undefined) await db.setMeta('anneeScolaire', String(b.anneeScolaire).trim());
    if (b.loanDays !== undefined) {
      const v = Number(b.loanDays);
      if (Number.isFinite(v) && v > 0 && v <= 365) await db.setMeta('loanDays', v);
    }
    if (b.maxLoansPerStudent !== undefined) {
      const v = Number(b.maxLoansPerStudent);
      if (Number.isFinite(v) && v >= 0 && v <= 50) await db.setMeta('maxLoansPerStudent', v);
    }
    await auth.logActivity(req.user, 'parametres_modifies', '');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ favoris */

router.get('/favorites', auth.requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `${util.BOOK_SELECT} WHERE b.id IN (SELECT book_id FROM favorites WHERE user_id = $1)`,
      [req.user.id]
    );
    res.json({ books: rows.map(util.mapBook) });
  } catch (err) {
    next(err);
  }
});

router.post('/favorites', auth.requireAuth, async (req, res, next) => {
  try {
    const bookId = Number(req.body.bookId);
    const exists = await db.query('SELECT id FROM books WHERE id = $1', [bookId]);
    if (!exists.rows.length) return res.status(404).json({ error: 'Livre introuvable.' });
    await db.query('INSERT INTO favorites (user_id, book_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, bookId]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/favorites/:bookId', auth.requireAuth, async (req, res, next) => {
  try {
    await db.query('DELETE FROM favorites WHERE user_id = $1 AND book_id = $2', [req.user.id, Number(req.params.bookId)]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------ reservations */

router.get('/reservations', auth.requireAuth, async (req, res, next) => {
  try {
    const params = [];
    let clause = '';
    if (!auth.isStaff(req.user)) { params.push(req.user.id); clause = 'WHERE r.user_id = $1'; }
    const { rows } = await db.query(
      `SELECT r.id, r.book_id, r.at, b.titre, b.code, b.cover_url,
              u.prenom, u.nom, u.classe,
              (SELECT COUNT(*) FROM loans l WHERE l.book_id = r.book_id AND l.status = 'en_cours') AS active
       FROM reservations r
       LEFT JOIN books b ON b.id = r.book_id
       LEFT JOIN users u ON u.id = r.user_id
       ${clause}
       ORDER BY r.at DESC`,
      params
    );
    const reservations = rows.map((r) => ({
      id: r.id,
      bookId: r.book_id,
      titre: r.titre || 'Livre supprime',
      code: r.code || null,
      coverUrl: r.cover_url || null,
      eleve: `${r.prenom || ''} ${r.nom || ''}`.trim() || 'Inconnu',
      classe: r.classe || null,
      disponible: Number(r.active) === 0,
      at: r.at
    }));
    res.json({ reservations, total: reservations.length });
  } catch (err) {
    next(err);
  }
});

router.post('/reservations', auth.requireAuth, async (req, res, next) => {
  try {
    const bookId = Number(req.body.bookId);
    const exists = await db.query('SELECT id FROM books WHERE id = $1', [bookId]);
    if (!exists.rows.length) return res.status(404).json({ error: 'Livre introuvable.' });
    const dup = await db.query('SELECT id FROM reservations WHERE book_id=$1 AND user_id=$2', [bookId, req.user.id]);
    if (dup.rows.length) return res.status(409).json({ error: 'Vous avez deja une demande pour ce livre.' });
    await db.query('INSERT INTO reservations (book_id, user_id) VALUES ($1,$2)', [bookId, req.user.id]);
    await auth.logActivity(req.user, 'demande_emprunt', `livre #${bookId}`);
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/reservations/:id', auth.requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.query('SELECT * FROM reservations WHERE id = $1', [id]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'Reservation introuvable.' });
    if (!auth.isStaff(req.user) && r.user_id !== req.user.id) return res.status(403).json({ error: 'Droits insuffisants.' });
    await db.query('DELETE FROM reservations WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------------- avis */

router.post('/reviews', auth.requireAuth, async (req, res, next) => {
  try {
    const bookId = Number(req.body.bookId);
    const rating = Math.max(1, Math.min(5, Number(req.body.rating) || 0));
    const text = String(req.body.text || '').trim().slice(0, 800);
    const exists = await db.query('SELECT id FROM books WHERE id = $1', [bookId]);
    if (!exists.rows.length) return res.status(404).json({ error: 'Livre introuvable.' });
    if (!rating) return res.status(400).json({ error: 'Donnez une note de 1 a 5.' });
    await db.query(
      `INSERT INTO reviews (book_id, user_id, rating, text, at) VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (book_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, text = EXCLUDED.text, at = NOW()`,
      [bookId, req.user.id, rating, text]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/reviews/:id', auth.requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await db.query('SELECT * FROM reviews WHERE id = $1', [id]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: 'Avis introuvable.' });
    if (!auth.isStaff(req.user) && r.user_id !== req.user.id) return res.status(403).json({ error: 'Droits insuffisants.' });
    await db.query('DELETE FROM reviews WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* --------------------------------------------------------- journal d'activite */

router.get('/activity', auth.requireStaff, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM activity ORDER BY at DESC LIMIT 100');
    res.json({
      activity: rows.map((a) => ({
        id: a.id, userId: a.user_id, userLabel: a.user_label, role: a.role,
        action: a.action, details: a.details, at: a.at
      }))
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
