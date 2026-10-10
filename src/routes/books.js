const express = require('express');
const db = require('../db');
const auth = require('../auth');
const util = require('../util');
const blob = require('../blob');

const router = express.Router();

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
}

function parseDate(value, fallbackNow) {
  if (!value || value === 'now' || value === 'maintenant') return new Date().toISOString();
  const d = new Date(value);
  if (isNaN(d.getTime())) return fallbackNow ? new Date().toISOString() : null;
  return d.toISOString();
}

async function fetchBook(id) {
  const { rows } = await db.query(`${util.BOOK_SELECT} WHERE b.id = $1`, [id]);
  return rows[0] ? util.mapBook(rows[0]) : null;
}

// Liste du catalogue
router.get('/', auth.requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(util.BOOK_SELECT);
    let books = rows.map(util.mapBook);

    const q = String(req.query.q || '').trim().toLowerCase();
    const genre = String(req.query.genre || '').trim().toLowerCase();
    const dispo = String(req.query.dispo || '').trim();
    const sort = String(req.query.sort || 'recent');

    if (q) {
      books = books.filter((b) =>
        [b.titre, b.auteur, b.code, b.genre, b.tome, b.description]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      );
    }
    if (genre) books = books.filter((b) => (b.genre || '').toLowerCase() === genre);
    if (dispo === 'disponible') books = books.filter((b) => b.disponible);
    if (dispo === 'emprunte') books = books.filter((b) => !b.disponible);

    if (sort === 'titre') books.sort((a, b) => String(a.titre).localeCompare(String(b.titre), 'fr', { sensitivity: 'base' }));
    else if (sort === 'auteur') books.sort((a, b) => String(a.auteur).localeCompare(String(b.auteur), 'fr', { sensitivity: 'base' }));
    else if (sort === 'note') books.sort((a, b) => (b.note || 0) - (a.note || 0));
    else if (sort === 'ancien') books.sort((a, b) => new Date(a.dateMiseEnLigne) - new Date(b.dateMiseEnLigne));
    else books.sort((a, b) => new Date(b.dateMiseEnLigne) - new Date(a.dateMiseEnLigne));

    res.json({ books, total: books.length });
  } catch (err) {
    next(err);
  }
});

// Genres disponibles
router.get('/genres', auth.requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query("SELECT DISTINCT genre FROM books WHERE genre IS NOT NULL AND genre <> '' ORDER BY genre");
    res.json({ genres: rows.map((r) => r.genre) });
  } catch (err) {
    next(err);
  }
});

// Detail d'un livre
router.get('/:id', auth.requireAuth, async (req, res, next) => {
  try {
    const book = await fetchBook(Number(req.params.id));
    if (!book) return res.status(404).json({ error: 'Livre introuvable.' });
    const { rows } = await db.query(
      `SELECT r.id, r.rating, r.text, r.at, u.prenom, u.nom
       FROM reviews r LEFT JOIN users u ON u.id = r.user_id
       WHERE r.book_id = $1 ORDER BY r.at DESC`,
      [book.id]
    );
    book.reviews = rows.map((r) => ({
      id: r.id,
      rating: r.rating,
      text: r.text,
      at: r.at,
      auteur: `${r.prenom || ''} ${String(r.nom || '').charAt(0)}.`.trim() || 'Eleve'
    }));
    res.json({ book });
  } catch (err) {
    next(err);
  }
});

// Ajouter un livre (personnel)
router.post('/', auth.requireStaff, async (req, res, next) => {
  try {
    const b = req.body || {};
    const code = normalizeCode(b.code);
    const titre = String(b.titre || '').trim();
    const auteur = String(b.auteur || '').trim();
    const coverUrl = String(b.coverUrl || '').trim();
    const pdfUrl = String(b.pdfUrl || '').trim();

    if (!code) return res.status(400).json({ error: 'Le code du livre est obligatoire.' });
    if (!titre) return res.status(400).json({ error: 'Le titre est obligatoire.' });
    if (!auteur) return res.status(400).json({ error: "L'auteur est obligatoire." });
    if (!pdfUrl) return res.status(400).json({ error: 'Le fichier PDF du livre est obligatoire.' });
    if (!coverUrl) return res.status(400).json({ error: 'La couverture est obligatoire.' });

    const { rows } = await db.query(
      `INSERT INTO books (code, titre, auteur, tome, genre, description, date_mise_en_ligne, cover_url, pdf_url, created_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) RETURNING id`,
      [
        code, titre, auteur,
        String(b.tome || '').trim() || null,
        String(b.genre || '').trim() || null,
        String(b.description || '').trim() || null,
        parseDate(b.dateMiseEnLigne, true),
        coverUrl, pdfUrl,
        req.user.id
      ]
    );
    const book = await fetchBook(rows[0].id);
    await auth.logActivity(req.user, 'livre_ajoute', `${code} - ${titre}`);
    res.status(201).json({ book });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ce code est deja utilise par un autre livre.' });
    next(err);
  }
});

// Modifier un livre
router.put('/:id', auth.requireStaff, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await fetchBook(id);
    if (!existing) return res.status(404).json({ error: 'Livre introuvable.' });
    const b = req.body || {};

    let code = existing.code;
    if (b.code !== undefined) {
      code = normalizeCode(b.code) || existing.code;
      const dup = await db.query('SELECT id FROM books WHERE code = $1 AND id <> $2', [code, id]);
      if (dup.rows.length) return res.status(409).json({ error: `Le code ${code} est deja utilise.` });
    }

    const dateValue = b.dateMiseEnLigne !== undefined ? parseDate(b.dateMiseEnLigne, false) : null;

    let coverUrl = existing.coverUrl;
    if (b.coverUrl !== undefined && String(b.coverUrl).trim()) {
      coverUrl = String(b.coverUrl).trim();
      if (existing.coverUrl && existing.coverUrl !== coverUrl) blob.removeBlob(existing.coverUrl);
    }
    let pdfUrl = existing.pdfUrl;
    if (b.pdfUrl !== undefined && String(b.pdfUrl).trim()) {
      pdfUrl = String(b.pdfUrl).trim();
      if (existing.pdfUrl && existing.pdfUrl !== pdfUrl) blob.removeBlob(existing.pdfUrl);
    }

    await db.query(
      `UPDATE books SET code=$1, titre=$2, auteur=$3, tome=$4, genre=$5, description=$6,
       date_mise_en_ligne=$7, cover_url=$8, pdf_url=$9, updated_at=NOW() WHERE id=$10`,
      [
        code,
        b.titre !== undefined ? (String(b.titre).trim() || existing.titre) : existing.titre,
        b.auteur !== undefined ? (String(b.auteur).trim() || existing.auteur) : existing.auteur,
        b.tome !== undefined ? (String(b.tome).trim() || null) : existing.tome,
        b.genre !== undefined ? (String(b.genre).trim() || null) : existing.genre,
        b.description !== undefined ? (String(b.description).trim() || null) : existing.description,
        dateValue || existing.dateMiseEnLigne,
        coverUrl, pdfUrl, id
      ]
    );
    const book = await fetchBook(id);
    await auth.logActivity(req.user, 'livre_modifie', `${book.code} - ${book.titre}`);
    res.json({ book });
  } catch (err) {
    next(err);
  }
});

// Supprimer un livre
router.delete('/:id', auth.requireStaff, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const book = await fetchBook(id);
    if (!book) return res.status(404).json({ error: 'Livre introuvable.' });
    if (!book.disponible) {
      return res.status(409).json({ error: 'Ce livre est actuellement emprunte. Enregistrez son retour avant de le supprimer.' });
    }
    await db.query('DELETE FROM reservations WHERE book_id=$1', [id]);
    await db.query('DELETE FROM reviews WHERE book_id=$1', [id]);
    await db.query('DELETE FROM favorites WHERE book_id=$1', [id]);
    await db.query('DELETE FROM books WHERE id=$1', [id]);
    await blob.removeBlobs([book.coverUrl, book.pdfUrl]);
    await auth.logActivity(req.user, 'livre_supprime', `${book.code} - ${book.titre}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
