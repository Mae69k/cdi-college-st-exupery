const db = require('./db');
const seed = require('./seed');

let promise = null;

// Initialise le schema puis cree les comptes par defaut (une seule fois par instance).
function bootstrap() {
  if (!promise) {
    promise = db.init()
      .then(() => seed())
      .catch((err) => {
        promise = null;
        throw err;
      });
  }
  return promise;
}

module.exports = bootstrap;
