// Postgres connection pool + transaction helpers.
//
// Every request handler MUST run inside `withUserTx` to enable RLS. The
// transaction sets `app.current_user` (UUID, via `SET LOCAL`) which all RLS
// policies depend on. `SET LOCAL` is transaction-scoped — the setting cannot
// leak to the next caller using the same pooled connection.

import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { schema } from './schema.ts';
import { loadEnv } from '../types/env.ts';
import { logger } from '../lib/logger.ts';

const { Pool } = pg;

export type Db = NodePgDatabase<typeof schema>;

let appPool: pg.Pool | null = null;
let adminPool: pg.Pool | null = null;

function buildPool(connectionString: string, max: number): pg.Pool {
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  });
  pool.on('error', (err) => {
    logger.error({ err }, 'pg pool error');
  });
  return pool;
}

export function appDbPool(): pg.Pool {
  if (!appPool) {
    const env = loadEnv();
    appPool = buildPool(env.DATABASE_URL, env.DATABASE_POOL_MAX);
  }
  return appPool;
}

export function adminDbPool(): pg.Pool {
  if (!adminPool) {
    const env = loadEnv();
    // Admin pool stays small — used for /v1/internal/erase-user only.
    adminPool = buildPool(env.DATABASE_ADMIN_URL, 4);
  }
  return adminPool;
}

/**
 * Run `fn` inside a transaction with `SET LOCAL app.current_user` and
 * `SET LOCAL app.request_id` configured. RLS policies depend on these.
 *
 * Use this for every request that touches RLS-protected tables.
 */
export async function withUserTx<T>(
  userId: string,
  requestId: string,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const client = await appDbPool().connect();
  try {
    await client.query('BEGIN');
    // set_config(setting, value, is_local) — is_local=true means transaction-scoped
    await client.query(`SELECT set_config('app.current_user', $1, true)`, [userId]);
    await client.query(`SELECT set_config('app.request_id', $1, true)`, [requestId]);

    const db = drizzle(client, { schema });
    const result = await fn(db as Db);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Admin-tx — bypasses RLS (uses BYPASSRLS role). Only for
 * /v1/internal/erase-user and admin reporting.
 */
export async function withAdminTx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await adminDbPool().connect();
  try {
    await client.query('BEGIN');
    const db = drizzle(client, { schema });
    const result = await fn(db as Db);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function closeDbPools(): Promise<void> {
  await Promise.all([appPool?.end(), adminPool?.end()].filter(Boolean));
  appPool = null;
  adminPool = null;
}
