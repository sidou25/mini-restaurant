// PostgreSQL local pour le développement uniquement (en ligne, c'est Neon)
// Lancer : npm run db   (laisser ce terminal ouvert, Ctrl + C pour arrêter)
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(import.meta.dirname, '..', '.pgdata');
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'resto', password: 'resto', port: 5434, persistent: true });

const firstTime = !fs.existsSync(dir);
if (firstTime) await pg.initialise();
await pg.start();
if (firstTime) await pg.createDatabase('mini_restaurant');
console.log('PostgreSQL local prêt : postgres://resto:resto@localhost:5434/mini_restaurant');

process.on('SIGINT', async () => {
  await pg.stop();
  process.exit(0);
});
