// Deja el salón con «Mesa 1» … «Mesa N» en una sola zona, listas para imprimir sus QR.
//   node scripts/mesas_salon.mjs                 → muestra lo que haría en la base de .env (no cambia nada)
//   node scripts/mesas_salon.mjs --aplicar       → lo hace
//   node scripts/mesas_salon.mjs --produccion …  → usa .env.railway (producción)
//   --mesas 25  --zona "Salón"  --puestos 4      → opcionales
// Borra las mesas y zonas que había. Las cuentas viejas se conservan en los reportes (quedan sin mesa).
// No toca nada si alguna mesa tiene una cuenta abierta o un pedido del QR pendiente.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const args = process.argv.slice(2);
const opcion = (n, def) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : def; };
const aplicar = args.includes('--aplicar');
const produccion = args.includes('--produccion');
const N = Number(opcion('mesas', 25));
const ZONA = opcion('zona', 'Salón');
const PUESTOS = Number(opcion('puestos', 4));

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(raiz, produccion ? '.env.railway' : '.env'), quiet: true, override: true });
const url = process.env.DATABASE_URL;
const c = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) || !/sslmode|neon/.test(url) ? undefined : { rejectUnauthorized: false } });
await c.connect();
const q = async (s, p) => (await c.query(s, p)).rows;

console.log(`\nBase: ${produccion ? 'PRODUCCIÓN' : 'desarrollo'} · ${aplicar ? 'APLICANDO' : 'solo muestra (agrega --aplicar para hacerlo)'}\n`);
const zonas = await q(`SELECT z.id, z.nombre, (SELECT count(*)::int FROM reservas r WHERE r.zona_id = z.id) AS reservas FROM zonas z ORDER BY id`);
const mesas = await q(`SELECT m.id, m.numero, m.nombre, z.nombre AS zona,
    (SELECT count(*)::int FROM cuentas c WHERE c.mesa_id = m.id AND c.estado = 'abierta') AS abiertas,
    (SELECT count(*)::int FROM pedidos_qr p WHERE p.mesa_id = m.id AND p.estado = 'pendiente') AS pendientes
  FROM mesas m JOIN zonas z ON z.id = m.zona_id ORDER BY m.numero`);
console.log(`Hoy hay ${mesas.length} mesa(s): ${mesas.map((m) => `${m.nombre ?? 'Mesa ' + m.numero} (${m.zona})`).join(', ') || '—'}`);
console.log(`y ${zonas.length} zona(s): ${zonas.map((z) => z.nombre).join(', ') || '—'}`);

const ocupadas = mesas.filter((m) => m.abiertas || m.pendientes);
if (ocupadas.length) {
  console.error(`\n✋ No se hizo nada: ${ocupadas.map((m) => `mesa ${m.numero}`).join(', ')} tiene una cuenta abierta o un pedido QR pendiente. Ciérrala primero.`);
  process.exit(1);
}

console.log(`\nVa a: borrar esas mesas y zonas, crear la zona «${ZONA}» y «Mesa 1» … «Mesa ${N}» (${PUESTOS} puestos c/u).`);
const conReservas = zonas.filter((z) => z.reservas);
if (conReservas.length) console.log(`(Las zonas con reservas guardadas no se pueden borrar: ${conReservas.map((z) => z.nombre).join(', ')} → se desactivan)`);

await c.query('BEGIN');
try {
  await q(`UPDATE cuentas SET mesa_id = NULL WHERE mesa_id IS NOT NULL`);
  await q(`UPDATE reservas SET mesa_id = NULL WHERE mesa_id IS NOT NULL`);
  await q(`DELETE FROM pedidos_qr`);
  await q(`DELETE FROM mesas`);
  await q(`DELETE FROM zonas WHERE id NOT IN (SELECT zona_id FROM reservas)`);
  await q(`UPDATE zonas SET activo = false`);
  const slug = ZONA.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const [z] = await q(
    `INSERT INTO zonas (slug, nombre, capacidad_mesa, max_personas, reservable, orden, activo) VALUES ($1, $2, $3, 20, true, 1, true)
     ON CONFLICT (slug) DO UPDATE SET nombre = EXCLUDED.nombre, activo = true RETURNING id`,
    [slug, ZONA, PUESTOS],
  );
  const cols = Math.ceil(Math.sqrt(N * 1.6)), filas = Math.ceil(N / cols);
  const paso = (t, i) => (t === 1 ? 50 : 10 + (80 * i) / (t - 1));
  for (let i = 0; i < N; i++) {
    await q(`INSERT INTO mesas (zona_id, numero, nombre, tipo, forma, capacidad, pos_x, pos_y) VALUES ($1, $2, $3, 'mesa', 'cuadrada', $4, $5, $6)`,
      [z.id, i + 1, `Mesa ${i + 1}`, PUESTOS, paso(cols, i % cols).toFixed(2), paso(filas, Math.floor(i / cols)).toFixed(2)]);
  }
  const [r] = await q(`SELECT count(*)::int AS mesas, count(qr_token)::int AS con_qr FROM mesas`);
  console.log(`\nResultado: ${r.mesas} mesas, ${r.con_qr} con su código QR, en la zona «${ZONA}».`);
  await c.query(aplicar ? 'COMMIT' : 'ROLLBACK');
  console.log(aplicar ? '✅ Guardado. Imprime los QR en Mesas y zonas → Códigos QR.' : '↩️  Era una prueba: no se guardó nada.');
} catch (e) {
  await c.query('ROLLBACK');
  console.error('\n❌ No se pudo, no se cambió nada:', e.message);
  process.exitCode = 1;
}
await c.end();
