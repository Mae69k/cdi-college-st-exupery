const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

const SESSION_COOKIE = 'cdi_sid';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 jours
const SECRET = process.env.SESSION_SECRET || 'dev-secret-a-changer-en-production';

const ROLES = {
  ELEVE: 'eleve',
  DOCUMENTALISTE: 'documentaliste',
  PRINCIPAL: 'principal',
  PRINCIPAL_ADJOINT: 'principal_adjoint'
};

const STAFF_ROLES = [ROLES.DOCUMENTALISTE, ROLES.PRINCIPAL, ROLES.PRINCIPAL_ADJOINT];

const ROLE_LABELS = {
  eleve: 'Eleve',
  documentaliste: 'Professeur documentaliste',
  principal: "Principal (chef d'etablissement)",
  principal_adjoint: 'Principal adjoint'
};

function isStaff(user) {
  return !!user && STAFF_ROLES.includes(user.role);
}

function hashPassword(plain) {
  return bcrypt.hashSync(String(plain), 10);
}

function verifyPassword(plain, hash) {
  if (!hash) return false;
  try {
    return bcrypt.compareSync(String(plain), hash);
  } catch (err) {
    return false;
  }
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payload) {
  const body = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (err) {
    return null;
  }
  if (!payload || !payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

function createSession(userId) {
  return sign({ uid: userId, exp: Date.now() + SESSION_TTL_MS });
}

function destroySession() {
  // Sessions sans etat : rien a supprimer cote serveur.
}

async function getUserById(id) {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    login: user.login,
    role: user.role,
    nom: user.nom,
    prenom: user.prenom,
    classe: user.classe || null,
    email: user.email || null,
    mustChangePassword: !!user.must_change_password,
    createdAt: user.created_at
  };
}

async function logActivity(user, action, details) {
  try {
    await db.query(
      'INSERT INTO activity (user_id, user_label, role, action, details) VALUES ($1, $2, $3, $4, $5)',
      [
        user ? user.id : null,
        user ? `${user.prenom || ''} ${user.nom || ''}`.trim() : 'Systeme',
        user ? user.role : null,
        action,
        details || ''
      ]
    );
  } catch (err) {
    console.warn('[activity] insertion impossible:', err.message);
  }
}

function getTokenFromReq(req) {
  if (req.cookies && req.cookies[SESSION_COOKIE]) return req.cookies[SESSION_COOKIE];
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

async function attachUser(req, res, next) {
  req.user = null;
  req.sessionToken = getTokenFromReq(req);
  try {
    const payload = verify(req.sessionToken);
    if (payload) {
      db.init().catch(() => {});
      req.user = await getUserById(payload.uid);
    }
  } catch (err) {
    console.warn('[auth] attachement utilisateur:', err.message);
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Connexion requise.' });
  next();
}

function requireStaff(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Connexion requise.' });
  if (!isStaff(req.user)) return res.status(403).json({ error: 'Acces reserve au personnel du CDI.' });
  next();
}

function requireRole(...roles) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Connexion requise.' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Droits insuffisants.' });
    next();
  };
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS
  });
}

module.exports = {
  SESSION_COOKIE,
  ROLES,
  STAFF_ROLES,
  ROLE_LABELS,
  isStaff,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  getUserById,
  publicUser,
  logActivity,
  attachUser,
  requireAuth,
  requireStaff,
  requireRole,
  setSessionCookie
};
