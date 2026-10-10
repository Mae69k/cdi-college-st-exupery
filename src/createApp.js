const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const auth = require('./auth');
const bootstrap = require('./bootstrap');

function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // Diagnostic accessible sans connexion, monte AVANT le bootstrap de la base.
  app.use('/api/health', require('./routes/health'));

  // Sur Vercel, seules les routes /api passent par la fonction (public/ est servi par le CDN).
  app.use('/api', async (req, res, next) => {
    try {
      await bootstrap();
      next();
    } catch (err) {
      console.error('[bootstrap]', err.message);
      res.status(503).json({ error: 'Base de donnees indisponible. Verifiez DATABASE_URL.' });
    }
  });
  app.use('/api', auth.attachUser);

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/books', require('./routes/books'));
  app.use('/api/loans', require('./routes/loans'));
  app.use('/api/users', require('./routes/users'));
  app.use('/api', require('./routes/misc'));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue.' }));

  // Servi par le CDN Vercel en production ; utile en local uniquement.
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir, { extensions: ['html'] }));
  app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[erreur]', err);
    const show = process.env.NODE_ENV !== 'production';
    res.status(err.status || 500).json({ error: show ? (err.message || 'Erreur serveur.') : 'Erreur serveur.' });
  });

  return app;
}

module.exports = createApp;
