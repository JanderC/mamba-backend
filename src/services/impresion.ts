import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from '../db/pool.js';

/**
 * Impresión de comandas en papel.
 * La impresora térmica está conectada (Bluetooth/USB) al computador de la barra o de la cocina, y
 * es ese navegador el que imprime. El servidor solo reparte: «reclamar» marca los ítems como impresos
 * en la misma sentencia que los devuelve, así dos pantallas con impresora nunca sacan el mismo pedido.
 */
let lista: Promise<void> | null = null;
export function asegurarImpresion() {
  lista ??= (async () => {
    const archivo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', '09_impresion.sql');
    await pool.query(await readFile(archivo, 'utf8'));
  })().catch((e) => {
    lista = null;
    throw e;
  });
  return lista;
}

/** Columnas que necesita el ticket (las mismas que ve la pantalla de comandas) */
export const SELECT_COMANDA = `
  SELECT i.id, i.cuenta_id, i.nombre, i.presentacion, i.cantidad, i.asiento, i.notas, i.estado, i.estacion, i.ronda, i.creado_en,
         c.numero AS cuenta, c.tipo, c.nombre_cliente, c.asiento AS puesto, m.numero AS mesa_numero, m.nombre AS mesa_nombre,
         m.tipo AS mesa_tipo, z.nombre AS zona, u.nombre AS mesonero,
         COALESCE((SELECT json_agg(json_build_object('tipo', x.tipo, 'nombre', x.nombre, 'cantidad', x.cantidad) ORDER BY x.tipo, x.id)
                     FROM cuenta_item_modificadores x WHERE x.item_id = i.id), '[]'::json) AS modificadores
    FROM cuenta_items i
    JOIN cuentas c ON c.id = i.cuenta_id
    LEFT JOIN mesas m ON m.id = c.mesa_id
    LEFT JOIN zonas z ON z.id = m.zona_id
    LEFT JOIN usuarios u ON u.id = i.usuario_id`;

/** Toma (y marca como impresos) los ítems nuevos de esas estaciones que nadie ha impreso todavía */
export async function reclamarParaImprimir(estaciones: string[]) {
  await asegurarImpresion();
  const tomados = await query<{ id: number }>(
    `UPDATE cuenta_items i SET impreso_en = now()
       FROM cuentas c
      WHERE c.id = i.cuenta_id AND c.estado = 'abierta'
        AND i.impreso_en IS NULL AND i.estado IN ('pendiente', 'preparando')
        AND i.estacion = ANY($1::text[])
        AND i.creado_en > now() - interval '3 hours'
      RETURNING i.id`,
    [estaciones],
  );
  if (!tomados.length) return [];
  return query(`${SELECT_COMANDA} WHERE i.id = ANY($1::bigint[]) ORDER BY i.creado_en, i.id`, [tomados.map((t) => t.id)]);
}

/** Si la impresora falló, se devuelven a la cola para que salgan en el siguiente intento */
export async function liberarImpresion(ids: number[]) {
  await asegurarImpresion();
  await query(`UPDATE cuenta_items SET impreso_en = NULL WHERE id = ANY($1::bigint[])`, [ids]);
}
