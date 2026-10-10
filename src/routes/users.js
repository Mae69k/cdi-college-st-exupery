const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();

function userToAdmin(u) {
  return {
    id: u.id,
    login: u.login,
    role: u.role,
    roleLabel: auth.ROLE_LABELS[u.role] || u.role,
    nom: u.nom,
    prenom: u.prenom,
    classe: u.classe || null,
    email: u.email || null,
    mustChangePassword: !!u.must_change_password,
    createdAt: u.created_at || null
  };
}

function generatePassword(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

async function loginExists(login, exceptId) {
  const { rows } = await db.query(
    'SELECT id FROM users WHERE lower(login) = lower($1) AND ($2::int IS NULL OR id <> $2)',
    [String(login), exceptId || null]
  );
  return rows.length > 0;
}

function validateUserPayload(body, { requireLogin = true } = {}) {
  const roles = Object.values(auth.ROLES);
  if (body.role && !roles.includes(body.role)) return 'Role invalide.';
  if (requireLogin && !String(body.login || '').trim()) return "L'identifiant (compte Pronote) est obligatoire.";
  if (!String(body.nom || '').trim()) return 'Le nom est obligatoire.';
  if (!String(body.prenom || '').trim()) return 'Le prenom est obligatoire.';
  if (body.role === auth.ROLES.ELEVE && !String(body.classe || '').trim()) return 'La classe est obligatoire pour un eleve.';
  return null;
}

const canManageStaff = auth.requireRole(auth.ROLES.PRINCIPAL, auth.ROLES.DOCUMENTALISTE);

// Liste des comptes
router.get('/', auth.requireStaff, async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (req.query.role) { params.push(String(req.query.role)); where.push(`role = $${params.length}`); }
    if (req.query.q) {
      params.push(`%${String(req.query.q).trim()}%`);
      const p = `$${params.length}`;
      where.push(`(nom ILIKE ${p} OR prenom ILIKE ${p} OR login ILIKE ${p} OR COALESCE(classe,'') ILIKE ${p})`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await db.query(`SELECT * FROM users ${clause} ORDER BY nom, prenom`, params);
    res.json({ users: rows.map(userToAdmin), total: rows.length });
  } catch (err) {
    next(err);
  }
});

// Creer un compte eleve (tout le personnel CDI)
router.post('/', auth.requireStaff, async (req, res, next) => {
  try {
    const body = req.body || {};
    const role = auth.ROLES.ELEVE;
    const error = validateUserPayload({ ...body, role });
    if (error) return res.status(400).json({ error });
    if (await loginExists(body.login)) return res.status(409).json({ error: `L'identifiant ${body.login} existe deja.` });

    const password = String(body.password || '').trim() || generatePassword();
    const { rows } = await db.query(
      `INSERT INTO users (login, role, nom, prenom, classe, email, password_hash, must_change_password, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        String(body.login).trim(), role,
        String(body.nom).trim(), String(body.prenom).trim(), String(body.classe).trim(),
        String(body.email || '').trim() || null,
        auth.hashPassword(password), !!body.mustChangePassword, req.user.id
      ]
    );
    await auth.logActivity(req.user, 'compte_eleve_cree', `${rows[0].prenom} ${rows[0].nom} (${rows[0].classe})`);
    res.status(201).json({ user: userToAdmin(rows[0]), initialPassword: password });
  } catch (err) {
    next(err);
  }
});

// Creer un compte personnel (principal / documentaliste)
router.post('/staff', canManageStaff, async (req, res, next) => {
  try {
    const body = req.body || {};
    const error = validateUserPayload(body);
    if (error) return res.status(400).json({ error });
    if (!auth.STAFF_ROLES.includes(body.role)) return res.status(400).json({ error: 'Role de personnel invalide.' });
    if (await loginExists(body.login)) return res.status(409).json({ error: `L'identifiant ${body.login} existe deja.` });

    const password = String(body.password || '').trim() || generatePassword(10);
    const { rows } = await db.query(
      `INSERT INTO users (login, role, nom, prenom, classe, email, password_hash, must_change_password, created_by)
       VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8) RETURNING *`,
      [
        String(body.login).trim(), body.role,
        String(body.nom).trim(), String(body.prenom).trim(),
        String(body.email || '').trim() || null,
        auth.hashPassword(password), !!body.mustChangePassword, req.user.id
      ]
    );
    await auth.logActivity(req.user, 'compte_personnel_cree', `${rows[0].prenom} ${rows[0].nom} (${auth.ROLE_LABELS[rows[0].role]})`);
    res.status(201).json({ user: userToAdmin(rows[0]), initialPassword: password });
  } catch (err) {
    next(err);
  }
});

// Modifier un compte
router.put('/:id', auth.requireStaff, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cur = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    const user = cur.rows[0];
    if (!user) return res.status(404).json({ error: 'Compte introuvable.' });

    const isTargetStaff = auth.isStaff(user);
    if (isTargetStaff && ![auth.ROLES.PRINCIPAL, auth.ROLES.DOCUMENTALISTE].includes(req.user.role)) {
      return res.status(403).json({ error: 'Seul le principal ou la documentaliste peut modifier un compte personnel.' });
    }
    const b = req.body || {};
    if (user.id === req.user.id && b.role && b.role !== user.role) {
      return res.status(400).json({ error: 'Vous ne pouvez pas changer votre propre role.' });
    }

    const fields = [];
    const params = [];
    const set = (col, val) => { params.push(val); fields.push(`${col} = $${params.length}`); };

    if (b.login && b.login !== user.login) {
      if (await loginExists(b.login, id)) return res.status(409).json({ error: 'Cet identifiant existe deja.' });
      set('login', String(b.login).trim());
    }
    if (b.nom) set('nom', String(b.nom).trim());
    if (b.prenom) set('prenom', String(b.prenom).trim());
    if (b.classe !== undefined && user.role === auth.ROLES.ELEVE) set('classe', String(b.classe).trim());
    if (b.email !== undefined) set('email', String(b.email).trim() || null);
    if (b.role && !isTargetStaff && Object.values(auth.ROLES).includes(b.role)) set('role', b.role);
    if (b.mustChangePassword !== undefined) set('must_change_password', !!b.mustChangePassword);
    if (b.password) set('password_hash', auth.hashPassword(String(b.password)));

    if (!fields.length) return res.json({ user: userToAdmin(user) });

    params.push(id);
    const { rows } = await db.query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    await auth.logActivity(req.user, 'compte_modifie', `${rows[0].prenom} ${rows[0].nom}`);
    res.json({ user: userToAdmin(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// Reinitialiser le mot de passe
router.post('/:id/reset-password', auth.requireStaff, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cur = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    const user = cur.rows[0];
    if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
    if (auth.isStaff(user) && ![auth.ROLES.PRINCIPAL, auth.ROLES.DOCUMENTALISTE].includes(req.user.role)) {
      return res.status(403).json({ error: 'Droits insuffisants.' });
    }
    const newPassword = String(req.body.password || '').trim() || generatePassword();
    await db.query('UPDATE users SET password_hash = $1, must_change_password = TRUE WHERE id = $2', [auth.hashPassword(newPassword), id]);
    await auth.logActivity(req.user, 'mot_de_passe_reinitialise', `${user.prenom} ${user.nom}`);
    res.json({ ok: true, password: newPassword });
  } catch (err) {
    next(err);
  }
});

// Supprimer un compte
router.delete('/:id', auth.requireStaff, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cur = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    const user = cur.rows[0];
    if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
    if (user.id === req.user.id) return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte.' });
    if (auth.isStaff(user) && ![auth.ROLES.PRINCIPAL, auth.ROLES.DOCUMENTALISTE].includes(req.user.role)) {
      return res.status(403).json({ error: 'Droits insuffisants.' });
    }
    const active = await db.query("SELECT id FROM loans WHERE user_id = $1 AND status = 'en_cours' LIMIT 1", [id]);
    if (active.rows.length) {
      return res.status(409).json({ error: 'Cet eleve a des emprunts en cours. Enregistrez les retours avant de supprimer le compte.' });
    }
    await db.query('DELETE FROM reservations WHERE user_id=$1', [id]);
    await db.query('DELETE FROM favorites WHERE user_id=$1', [id]);
    await db.query('DELETE FROM reviews WHERE user_id=$1', [id]);
    await db.query('DELETE FROM users WHERE id=$1', [id]);
    await auth.logActivity(req.user, 'compte_supprime', `${user.prenom} ${user.nom}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
