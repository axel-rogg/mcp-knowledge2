// Apply all SQL migrations from drizzle/migrations/ in lexical order.
// Tracks applied files in `_migrations` table.

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'drizzle', 'migrations');

async function ensureMigrationsTable(client: pg.Client) {
  // Existenz-Check ueber pg_catalog (read-only, kein schema-CREATE-priv noetig)
  // — Neon's connection-role kann CREATE-on-public hin und wieder verlieren
  // (Mig 0019 entfernt es indirekt?), wodurch CREATE TABLE IF NOT EXISTS
  // schon im if-check failen wuerde. Read-Pfad zuerst, CREATE nur wenn
  // wirklich noetig.
  const exists = await client.query<{ reg: string | null }>(
    `SELECT to_regclass('public._migrations')::text AS reg`,
  );
  if (exists.rows[0]?.reg) return; // schon da
  await client.query(`
    CREATE TABLE _migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedSet(client: pg.Client): Promise<Set<string>> {
  const r = await client.query<{ name: string }>(`SELECT name FROM _migrations`);
  return new Set(r.rows.map((row) => row.name));
}

async function main() {
  // DATABASE_URL preferred (knowledge_app role, db owner, has CREATE on
  // public). DATABASE_ADMIN_URL kann fehlende USAGE-on-public haben (Neon-
  // Default fuer non-owner-roles). Wenn eine Migration REFERENCES auf
  // shared-tabellen wie `users` braucht (e.g. 0020, 0025), muss der
  // Operator zuerst die Grants pre-deploy fahren — siehe
  // docs/runbooks/runbook-neon-role-grants.md.
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_ADMIN_URL;
  if (!url) {
    console.error('DATABASE_URL or DATABASE_ADMIN_URL must be set');
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await appliedSet(client);
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      console.warn(`▸ applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO _migrations(name) VALUES($1)`, [file]);
        await client.query('COMMIT');
        ran += 1;
      } catch (e) {
        await client.query('ROLLBACK');
        console.error(`✗ ${file} failed:`, (e as Error).message);
        process.exit(2);
      }
    }
    console.warn(`✓ migrations: ${ran} applied, ${applied.size + ran} total`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
