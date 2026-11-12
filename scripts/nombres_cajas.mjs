// Quita el nombre «Caja Barra»: las cajas se llaman «Caja Principal», «Caja Secundaria», «Caja 3»…
// La caja que tiene el turno abierto (la que se está usando) queda como «Caja Principal».
//   node scripts/nombres_cajas.mjs                → base de .env (desarrollo)
//   node scripts/nombres_cajas.mjs --produccion   → base de .env.railway
// No toca turnos, cobros ni montos: solo los nombres.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const produccion = process.argv.includes('--produccion');
const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(raiz, produccion ? '.env.railway' : '.env'), quiet: true, override: true });
const url = process.env.DATABASE_URL;
const c = new pg.Client({ connectionString: url, ssl: /neon/.test(url) ? { rejectUnauthorized: false } : undefined });
await c.connect();
const q = async (s, p) => (await c.query(s, p)).rows;
const ver = () => q(`SELECT c.id, c.nombre, c.activo, (SELECT count(*)::int FROM sesiones_caja s WHERE s.caja_id = c.id AND s.estado = 'abierta') AS abierta
                       FROM cajas c ORDER BY c.id`);

console.log(`\nBase: ${produccion ? 'PRODUCCIÓN' : 'desarrollo'}\nAntes:`);
console.table(await ver());
await c.query('BEGIN');
try {
  const cajas = await q(`SELECT c.id, c.nombre, EXISTS (SELECT 1 FROM sesiones_caja s WHERE s.caja_id = c.id AND s.estado = 'abierta') AS abierta
                           FROM cajas c WHERE c.activo ORDER BY c.id FOR UPDATE`);
  // Orden: primero la que está abierta (será la Principal), después las demás por antigüedad
  const orden = [...cajas].sort((a, b) => Number(b.abierta) - Number(a.abierta) || a.id - b.id);
  const nombres = ['Caja Principal', 'Caja Secundaria', ...Array.from({ length: 20 }, (_, i) => `Caja ${i + 3}`)];
  // Nombres temporales primero para no chocar con el índice único al intercambiar
  for (const x of orden) await q(`UPDATE cajas SET nombre = $2 WHERE id = $1`, [x.id, `tmp-${x.id}-${Date.now()}`]);
  for (const [i, x] of orden.entries()) await q(`UPDATE cajas SET nombre = $2 WHERE id = $1`, [x.id, nombres[i]]);
  await c.query('COMMIT');
  console.log('Después:');
  console.table(await ver());
} catch (e) {
  await c.query('ROLLBACK');
  console.error('No se cambió nada:', e.message);
  process.exitCode = 1;
}
await c.end();
