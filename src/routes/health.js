const express = require('express');
const db = require('../db');
const bootstrap = require('../bootstrap');

const router = express.Router();

function sanitize(msg) {
  return String(msg || '')
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgres://***')
    .slice(0, 400);
}

// Diagnostic de la base de donnees : accessible sans etre connecte.
router.get('/', async (req, res) => {
  try {
    await bootstrap();
    await db.query('SELECT 1 AS ok');
    res.json({ ok: true, database: 'ok', via: db.source(), cible: db.target() });
  } catch (err) {
    res.status(503).json({
      ok: false,
      database: 'erreur',
      detail: sanitize(err.message),
      variable_detectee: db.source() || null,
      cible: db.target()
    });
  }
});

module.exports = router;
