import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/pool.js';

/**
 * Migraciones aditivas que se aplican solas al arrancar (idempotentes).
 * Sirven para que los cambios de esquema lleguen a bases ya instaladas sin correr db:instalar.
 */
const ARCHIVOS = ['10_inventario_areas.sql', '11_imagenes.sql', '12_paso_por_barra.sql', '13_cajas_metodos_base.sql'];

export async function aplicarMigraciones() {
  for (const nombre of ARCHIVOS) {
    const archivo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', nombre);
    try {
      await pool.query(await readFile(archivo, 'utf8'));
    } catch (e) {
      console.error(`[migraciones] ${nombre} no se pudo aplicar`, (e as Error).message);
    }
  }
}
