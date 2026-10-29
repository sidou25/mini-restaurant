// Copie toute la base Neon (DATABASE_URL) vers Supabase (SUPA_POSTGRES_URL).
// Supabase est vidé d'abord : à lancer quand le restaurant ne prend pas de commandes.
// Lancement : node --env-file=.env.local scripts/copy-db.mjs
import fs from 'node:fs';
import pg from 'pg';
// db.js garde aussi les dates en texte telles quelles (déjà à l'heure d'Alger)
import { poolConfig } from '../db.js';

// Ordre important : une table vient après celles qu'elle référence
const TABLES = ['settings', 'livreurs', 'users', 'products', 'orders', 'order_items', 'versements', 'session'];
const SANS_ID = ['settings', 'session'];

if (!process.env.DATABASE_URL || !process.env.SUPA_POSTGRES_URL) {
  console.error('Il faut DATABASE_URL (Neon) et SUPA_POSTGRES_URL (Supabase) dans .env.local');
  process.exit(1);
}

const source = new pg.Client({ connectionString: process.env.DATABASE_URL });
const target = new pg.Client(poolConfig(process.env.SUPA_POSTGRES_URL));
await source.connect();
await target.connect();

// Les tables existent sur Supabase avant la copie
await target.query(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));

await target.query('BEGIN');
try {
  await target.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY`);
  for (const table of TABLES) {
    const { rows } = await source.query(`SELECT * FROM ${table}`);
    for (const row of rows) {
      const cols = Object.keys(row);
      const params = cols.map((_, i) => `$${i + 1}`).join(', ');
      await target.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${params})`, cols.map(c => row[c]));
    }
    // Les nouveaux numéros (SERIAL) repartent après le plus grand id copié
    if (!SANS_ID.includes(table)) {
      await target.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM ${table}`);
    }
    console.log(`${table} : ${rows.length} ligne(s)`);
  }
  await target.query('COMMIT');
  console.log('✅ Copie terminée');
} catch (e) {
  await target.query('ROLLBACK');
  console.error('❌ Copie annulée, rien n\'a changé sur Supabase :', e.message);
  process.exitCode = 1;
} finally {
  await source.end();
  await target.end();
}
