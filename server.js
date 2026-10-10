require('dotenv').config();

const createApp = require('./src/createApp');
const bootstrap = require('./src/bootstrap');

const app = createApp();

// Export pour la detection automatique par Vercel (serverless).
module.exports = app;

// En local (node server.js) : on demarre un vrai serveur HTTP.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  bootstrap()
    .catch((err) => console.error('[init] Base de donnees:', err.message))
    .finally(() => {
      app.listen(PORT, () => {
        console.log(`\n  CDI en ligne - College Saint-Exupery`);
        console.log(`  Serveur demarre : http://localhost:${PORT}\n`);
      });
    });
}
