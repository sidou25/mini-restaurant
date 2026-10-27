// Connexion à PostgreSQL (adresse dans la variable DATABASE_URL)
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// COUNT et SUM renvoient des bigint : on les veut en nombres JavaScript (montants en DA, petits)
types.setTypeParser(20, Number);
// Dates sans fuseau gardées en texte "AAAA-MM-JJ HH:MM:SS" (déjà à l'heure d'Alger)
types.setTypeParser(1114, v => v);
types.setTypeParser(1082, v => v);

const onVercel = Boolean(process.env.VERCEL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: onVercel ? 3 : 10,
  idleTimeoutMillis: onVercel ? 5000 : 10000,
});
// une connexion coupée (ex : Neon en veille) ne doit pas faire planter l'app
pool.on('error', err => console.error('PostgreSQL :', err.message));

// Crée les tables si besoin (une fois par démarrage, réessayé en cas d'échec)
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL manquant');
      await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    })();
    ready.catch(() => { ready = null; });
  }
  return ready;
}

const all = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

// Exécute fn(client) dans une transaction : tout passe ou rien ne passe
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, init, all, one, transaction };
