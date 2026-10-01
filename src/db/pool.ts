import pg from 'pg';
import { env } from '../config/env.js';

// Si la URL trae sslmode (Neon: sslmode=verify-full) el driver negocia SSL y verifica el certificado.
// Solo se fuerza SSL cuando es un host de Neon sin sslmode en la URL. El Postgres local va sin SSL.
const forzarSsl = /neon\.tech/.test(env.DATABASE_URL) && !/sslmode=/.test(env.DATABASE_URL);

// Postgres devuelve DATE como string 'YYYY-MM-DD' (evita corrimientos de zona horaria)
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: forzarSsl ? true : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => console.error('[pg] error inesperado en el pool', err));

/** Cualquier cosa que pueda ejecutar consultas: el pool o un cliente dentro de una transacción */
export type Db = Pick<pg.PoolClient, 'query'>;

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool) {
  const res = await db.query<T>(text, params);
  return res.rows;
}

/** Ejecuta `fn` dentro de una transacción (COMMIT si termina bien, ROLLBACK si lanza) */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
