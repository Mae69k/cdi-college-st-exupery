const express = require('express');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();

const attempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

function keyFor(req, login) {
  return `${req.ip}|${String(login || '').toLowerCase()}`;
}

function tooMany(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function registerFail(key) {
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(key, { first: Date.now(), count: 1 });
  } else {
    rec.count += 1;
  }
}

router.post('/login', async (req, res, next) => {
  try {
    const { login, password } = req.body || {};
    if (!login || !password) {
      return res.status(400).json({ error: 'Identifiant et mot de passe requis.' });
    }
    const key = keyFor(req, login);
    if (tooMany(key)) {
      return res.status(429).json({ error: 'Trop de tentatives. Reessayez dans quelques minutes.' });
    }

    const { rows } = await db.query('SELECT * FROM users WHERE lower(login) = lower($1)', [String(login).trim()]);
    const user = rows[0];
    if (!user || !auth.verifyPassword(password, user.password_hash)) {
      registerFail(key);
      auth.logActivity(user || null, 'connexion_echouee', `identifiant ${login}`);
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
    }

    attempts.delete(key);
    const token = auth.createSession(user.id);
    auth.setSessionCookie(res, token);
    auth.logActivity(user, 'connexion', '');
    res.json({ user: auth.publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    if (req.user) await auth.logActivity(req.user, 'deconnexion', '');
    auth.destroySession(req.sessionToken);
    res.clearCookie(auth.SESSION_COOKIE);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Non connecte.' });
  res.json({ user: auth.publicUser(req.user) });
});

router.post('/me/password', auth.requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 6 caracteres.' });
    }
    if (!auth.verifyPassword(currentPassword, req.user.password_hash)) {
      return res.status(400).json({ error: 'Mot de passe actuel incorrect.' });
    }
    await db.query('UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2', [
      auth.hashPassword(newPassword),
      req.user.id
    ]);
    await auth.logActivity(req.user, 'changement_mot_de_passe', '');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
