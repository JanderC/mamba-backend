// Crea los usuarios del equipo (lista en scripts/equipo.local.json) con una contraseña inicial distinta para cada uno.
//   node scripts/crear_usuarios.mjs               → base de .env (desarrollo)
//   node scripts/crear_usuarios.mjs --produccion  → base de .env.railway
// Si el correo ya existe, no lo toca (no cambia su rol ni su contraseña).
// Al final muestra la tabla con las contraseñas: entrégaselas a cada uno y que la cambien al entrar.
import { randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import pg from 'pg';

// La lista del equipo vive en scripts/equipo.local.json (no se sube a git: tiene nombres y correos).
// Formato: [{ "nombre": "…", "email": "…", "rol": "admin|gerente|cajero|mesonero|barra|cocina|rrpp", "cargo": "…" }]
const archivoEquipo = join(dirname(fileURLToPath(import.meta.url)), 'equipo.local.json');
if (!existsSync(archivoEquipo)) {
  console.error(`Falta ${archivoEquipo} con la lista del equipo.`);
  process.exit(1);
}
const EQUIPO = JSON.parse(readFileSync(archivoEquipo, 'utf8'));

// Sin letras que se confunden (0/O, 1/l/I)
const LETRAS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const clave = (nombre) => `${nombre.split(' ')[0]}-${Array.from({ length: 6 }, () => LETRAS[randomInt(LETRAS.length)]).join('')}`;

const produccion = process.argv.includes('--produccion');
const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(raiz, produccion ? '.env.railway' : '.env'), quiet: true, override: true });
const url = process.env.DATABASE_URL;
const c = new pg.Client({ connectionString: url, ssl: /neon/.test(url) ? { rejectUnauthorized: false } : undefined });
await c.connect();

console.log(`\nBase: ${produccion ? 'PRODUCCIÓN' : 'desarrollo'}\n`);
const filas = [];
await c.query('BEGIN');
try {
  for (const u of EQUIPO) {
    const { rows: [existe] } = await c.query(`SELECT id, rol FROM usuarios WHERE lower(email) = lower($1)`, [u.email]);
    if (existe) { filas.push({ nombre: u.nombre, correo: u.email, rol: existe.rol, 'contraseña': '(ya existía: no se cambió)' }); continue; }
    const pass = clave(u.nombre);
    await c.query(`INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES ($1, $2, $3, $4)`, [u.nombre, u.email, await bcrypt.hash(pass, 10), u.rol]);
    filas.push({ nombre: u.nombre, correo: u.email, rol: `${u.rol} (${u.cargo})`, 'contraseña': pass });
  }
  await c.query('COMMIT');
  console.table(filas);
  console.log('Cada uno entra con su correo y esa contraseña, y la cambia desde su nombre (abajo a la izquierda) → «Cambiar contraseña».');
} catch (e) {
  await c.query('ROLLBACK');
  console.error('No se creó ninguno:', e.message);
  process.exitCode = 1;
}
await c.end();
