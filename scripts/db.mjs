/**
 * Instalador / actualizador de la base de datos de Mamba.
 *
 *   npm run db:instalar
 *
 * Usa DATABASE_URL del archivo .env (local o Neon). No necesita psql.
 *  - Si la base está vacía, crea el sitio web (mamba_completo.sql).
 *  - Siempre aplica el sistema administrativo (03 + 04), que es aditivo:
 *    no borra datos y se puede ejecutar las veces que quieras.
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'database');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('❌ Falta DATABASE_URL. Copia .env.example a .env y pon tu conexión.');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: /neon\.tech/.test(url) && !/sslmode=/.test(url) ? true : undefined,
});

const correr = async (archivo) => {
  process.stdout.write(`→ ${archivo} … `);
  await client.query(await readFile(join(DIR, archivo), 'utf8'));
  console.log('ok');
};

try {
  await client.connect();
  const { rows: [info] } = await client.query(`SELECT current_database() AS db, version() AS v`);
  console.log(`Conectado a "${info.db}" (${info.v.split(',')[0]})\n`);

  const { rows: [base] } = await client.query(`SELECT to_regclass('public.configuracion_local') IS NOT NULL AS existe`);
  if (base.existe) console.log('• El sitio web ya está instalado: se conservan sus datos.');
  else await correr('mamba_completo.sql');

  await correr('03_sistema.sql');
  await correr('04_sistema_seed.sql');

  const { rows: [r] } = await client.query(`
    SELECT (SELECT count(*) FROM productos) AS productos, (SELECT count(*) FROM insumos) AS insumos,
           (SELECT count(*) FROM mesas) AS mesas, (SELECT COALESCE(SUM(capacidad), 0) FROM mesas WHERE activo) AS puestos,
           (SELECT count(*) FROM usuarios) AS usuarios, (SELECT count(*) FROM metodos_pago) AS metodos,
           (SELECT count(*) FROM receta_items) AS recetas`);
  console.log(`\n✅ Base lista: ${r.productos} productos · ${r.recetas} líneas de receta · ${r.insumos} insumos · ${r.mesas} mesas (${r.puestos} puestos) · ${r.metodos} métodos de pago · ${r.usuarios} usuarios`);
  console.log('   Entra al panel en /admin con  admin@mamba.com  /  Mamba2026*  y cambia la contraseña.');
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  if (err.code === '28P01') console.error('   La contraseña de PostgreSQL en DATABASE_URL no es correcta.');
  if (err.code === '3D000') console.error('   La base de datos no existe: créala primero en pgAdmin (Databases → Create → Database).');
  if (err.code === 'ECONNREFUSED') console.error('   PostgreSQL no está encendido o el puerto no es el correcto.');
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
