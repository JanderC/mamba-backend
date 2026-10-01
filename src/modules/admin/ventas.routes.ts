import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../../db/pool.js';
import { R, permitir } from '../../middlewares/auth.js';
import { agregarItems, anularCuenta, anularItem, cerrar, detalleCuenta, itemSchema, pagar, pagoSchema, recalcular } from '../../services/cuentas.js';
import { jornada, leerAjustes, tasaVigente } from '../../services/sistema.js';
import { HttpError, notFound } from '../../utils/http.js';
import { MONEDAS, type Moneda, convertir, preciosEnTodas, redondearMoneda } from '../../utils/moneda.js';

// ====================================================================== Catálogo para el POS
export const posRouter = Router();

/**
 * Todo lo que la pantalla de pedido necesita en una sola llamada: categorías → productos → presentaciones
 * con precio en las 3 monedas, ingredientes que se pueden quitar, adicionales, y las cervezas en
 * inventario para armar tobos surtidos.
 */
posRouter.get('/catalogo', async (_req, res) => {
  const tasa = await tasaVigente();
  const [categorias, productos, variantes, receta, adicionales, seleccionables] = await Promise.all([
    query(`SELECT id, nombre, icono, tipo, estacion FROM categorias_menu WHERE activo ORDER BY orden`),
    query(`SELECT id, categoria_id, nombre, descripcion, moneda_base, disponible, destacado
             FROM productos WHERE visible_pos ORDER BY orden, nombre`),
    query(`SELECT * FROM precios_producto WHERE activo ORDER BY orden, precio`),
    query(`SELECT r.id, r.precio_producto_id, r.insumo_id, r.cantidad, r.removible, COALESCE(r.etiqueta, i.nombre) AS etiqueta, i.stock
             FROM receta_items r JOIN insumos i ON i.id = r.insumo_id ORDER BY r.orden`),
    query(`SELECT a.*, COALESCE((SELECT array_agg(categoria_id) FROM adicional_categorias WHERE adicional_id = a.id), '{}') AS categorias
             FROM adicionales a WHERE a.activo ORDER BY a.orden, a.nombre`),
    query(`SELECT id, nombre, categoria_insumo_id, stock, recargo_seleccion FROM insumos WHERE activo ORDER BY nombre`),
  ]);

  const out = categorias.map((c) => ({
    ...c,
    adicionales: adicionales
      .filter((a) => a.categorias.includes(c.id))
      .map((a) => ({ id: a.id, nombre: a.nombre, precios: preciosEnTodas(a, tasa) })),
    productos: productos
      .filter((p) => p.categoria_id === c.id)
      .map((p) => ({
        id: p.id, nombre: p.nombre, descripcion: p.descripcion, disponible: p.disponible, destacado: p.destacado,
        variantes: variantes
          .filter((v) => v.producto_id === p.id)
          .map((v) => {
            const rec = receta.filter((r) => r.precio_producto_id === v.id);
            // Cuántas unidades se pueden vender con el stock actual (limitado por el ingrediente fijo más escaso)
            const fijos = rec.filter((r) => !r.removible);
            const disponibles = fijos.length ? Math.floor(Math.min(...fijos.map((r) => r.stock / r.cantidad))) : null;
            return {
              id: v.id,
              presentacion: v.presentacion,
              precios: preciosEnTodas({ ...v, moneda_base: p.moneda_base }, tasa),
              disponibles,
              removibles: rec.filter((r) => r.removible).map((r) => ({ id: r.id, etiqueta: r.etiqueta })),
              seleccion: v.seleccion_cantidad
                ? {
                    cantidad: v.seleccion_cantidad,
                    opciones: seleccionables
                      .filter((s) => s.categoria_insumo_id === v.seleccion_categoria_insumo_id)
                      .map((s) => ({
                        insumo_id: s.id, nombre: s.nombre, stock: Math.floor(s.stock),
                        recargo: Object.fromEntries(
                          MONEDAS.map((m) => [m, redondearMoneda(convertir(s.recargo_seleccion, p.moneda_base, m, tasa), m)]),
                        ),
                      })),
                  }
                : null,
            };
          }),
      }))
      .filter((p) => p.variantes.length),
  }));
  res.json({ tasa, categorias: out.filter((c) => c.productos.length) });
});

// ====================================================================== Cuentas
export const cuentasRouter = Router();

const idNum = (v: string | string[]) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, 'Identificador inválido');
  return n;
};

const abrirSchema = z.object({
  tipo: z.enum(['mesa', 'barra', 'llevar']),
  mesa_id: z.number().int().nullish(),
  asiento: z.number().int().min(1).max(60).nullish(),
  personas: z.number().int().min(1).max(60).default(1),
  nombre_cliente: z.string().trim().max(80).nullish(),
  cliente_id: z.number().int().nullish(),
  mesonero_id: z.number().int().nullish(),
  moneda: z.enum(MONEDAS).optional(),
  reserva_id: z.uuid().nullish(),
  notas: z.string().max(300).nullish(),
});

export async function abrirCuenta(datos: z.infer<typeof abrirSchema>, usuarioId: number) {
  const ajustes = await leerAjustes();
  return tx(async (db) => {
    let servicio = 0;
    if (datos.tipo === 'mesa') {
      if (!datos.mesa_id) throw new HttpError(400, 'Selecciona la mesa');
      servicio = ajustes.servicio_auto_mesas ? ajustes.servicio_pct : 0;
    }
    if (datos.mesa_id) {
      const [mesa] = await query(`SELECT id, capacidad FROM mesas WHERE id = $1 AND activo`, [datos.mesa_id], db);
      if (!mesa) throw notFound('Mesa');
    }
    const [c] = await query<{ id: number }>(
      `INSERT INTO cuentas (tipo, mesa_id, personas, nombre_cliente, cliente_id, mesonero_id, moneda, servicio_pct, reserva_id, notas, asiento, numero)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'') RETURNING id`,
      [datos.tipo, datos.mesa_id ?? null, datos.personas, datos.nombre_cliente || null, datos.cliente_id ?? null,
       datos.mesonero_id ?? usuarioId, datos.moneda ?? ajustes.moneda_principal, servicio, datos.reserva_id ?? null, datos.notas || null, datos.asiento ?? null],
      db,
    );
    if (datos.reserva_id)
      await query(`UPDATE reservas SET estado = 'asistio', mesa_id = COALESCE($2, mesa_id) WHERE id = $1`, [datos.reserva_id, datos.mesa_id ?? null], db);
    return c.id;
  });
}

cuentasRouter.post('/', permitir(...R.servicio), async (req, res) => {
  const id = await abrirCuenta(abrirSchema.parse(req.body), req.usuario.id);
  res.status(201).json(await detalleCuenta(id));
});

const listaSchema = z.object({
  estado: z.enum(['abierta', 'pagada', 'anulada']).optional(),
  tipo: z.enum(['mesa', 'barra', 'llevar']).optional(),
  desde: z.iso.date().optional(),
  hasta: z.iso.date().optional(),
  q: z.string().optional(),
});

cuentasRouter.get('/', permitir(...R.servicio), async (req, res) => {
  const f = listaSchema.parse(req.query);
  const fecha = jornada('COALESCE(c.cerrada_en, c.abierta_en)');
  res.json(
    await query(
      `SELECT c.id, c.numero, c.tipo, c.estado, c.moneda, c.personas, c.nombre_cliente, c.subtotal, c.servicio, c.descuento, c.total,
              c.pagado, c.total_usd, c.abierta_en, c.cerrada_en, m.numero AS mesa_numero, m.nombre AS mesa_nombre, z.nombre AS zona,
              u.nombre AS mesonero,
              (SELECT count(*) FROM cuenta_items i WHERE i.cuenta_id = c.id AND i.estado <> 'anulado') AS items
         FROM cuentas c
         LEFT JOIN mesas m ON m.id = c.mesa_id
         LEFT JOIN zonas z ON z.id = m.zona_id
         LEFT JOIN usuarios u ON u.id = c.mesonero_id
        WHERE ($1::text IS NULL OR c.estado = $1)
          AND ($2::text IS NULL OR c.tipo = $2)
          AND ($3::date IS NULL OR ${fecha} >= $3)
          AND ($4::date IS NULL OR ${fecha} <= $4)
          AND ($5::text IS NULL OR c.numero ILIKE '%'||$5||'%' OR c.nombre_cliente ILIKE '%'||$5||'%')
        ORDER BY c.abierta_en DESC LIMIT 500`,
      [f.estado ?? null, f.tipo ?? null, f.desde ?? null, f.hasta ?? null, f.q?.trim() || null],
    ),
  );
});

cuentasRouter.get('/:id', permitir(...R.servicio), async (req, res) => {
  res.json(await detalleCuenta(idNum(req.params.id)));
});

const editarSchema = z
  .object({
    mesa_id: z.number().int().nullable(),
    asiento: z.number().int().min(1).max(60).nullable(),
    personas: z.number().int().min(1).max(60),
    nombre_cliente: z.string().trim().max(80).nullable(),
    cliente_id: z.number().int().nullable(),
    mesonero_id: z.number().int().nullable(),
    servicio_pct: z.number().min(0).max(100),
    descuento: z.number().min(0),
    descuento_motivo: z.string().max(200).nullable(),
    notas: z.string().max(300).nullable(),
  })
  .partial();

cuentasRouter.patch('/:id', permitir(...R.servicio), async (req, res) => {
  const id = idNum(req.params.id);
  const b = editarSchema.parse(req.body);
  if ((b.descuento !== undefined || b.servicio_pct !== undefined) && !['admin', 'gerente', 'cajero'].includes(req.usuario.rol))
    throw new HttpError(403, 'Solo caja o gerencia pueden cambiar descuentos y servicio');
  await tx(async (db) => {
    const [c] = await query(`SELECT estado, subtotal, tipo FROM cuentas WHERE id = $1 FOR UPDATE`, [id], db);
    if (!c) throw notFound('Cuenta');
    if (c.estado !== 'abierta') throw new HttpError(409, 'La cuenta ya está cerrada');
    if (b.descuento != null && b.descuento > c.subtotal) throw new HttpError(400, 'El descuento no puede superar el subtotal');
    const sets: string[] = [];
    const vals: unknown[] = [id];
    for (const [k, v] of Object.entries(b)) {
      vals.push(v);
      sets.push(`${k} = $${vals.length}`);
    }
    if (b.mesa_id !== undefined) sets.push(`tipo = CASE WHEN $${Object.keys(b).indexOf('mesa_id') + 2}::int IS NULL THEN tipo ELSE 'mesa' END`);
    if (sets.length) await query(`UPDATE cuentas SET ${sets.join(', ')} WHERE id = $1`, vals, db);
    await recalcular(db, id);
  });
  res.json(await detalleCuenta(id));
});

cuentasRouter.post('/:id/items', permitir(...R.servicio), async (req, res) => {
  const id = idNum(req.params.id);
  const { items, directo } = z
    .object({ items: z.array(itemSchema).min(1, 'Agrega al menos un producto'), directo: z.boolean().default(false) })
    .parse(req.body);
  await tx((db) => agregarItems(db, id, items, req.usuario, directo));
  res.status(201).json(await detalleCuenta(id));
});

cuentasRouter.delete('/:id/items/:itemId', permitir(...R.servicio), async (req, res) => {
  const id = idNum(req.params.id);
  const { motivo } = z.object({ motivo: z.string().trim().min(3, 'Indica el motivo de la anulación') }).parse(req.body ?? {});
  await tx((db) => anularItem(db, id, idNum(req.params.itemId), motivo, req.usuario));
  res.json(await detalleCuenta(id));
});

/** Reasignar un ítem a otro asiento (para dividir la cuenta por puesto) */
cuentasRouter.patch('/:id/items/:itemId', permitir(...R.servicio), async (req, res) => {
  const id = idNum(req.params.id);
  const { asiento } = z.object({ asiento: z.number().int().min(1).max(60).nullable() }).parse(req.body);
  const r = await query(`UPDATE cuenta_items SET asiento = $3 WHERE id = $2 AND cuenta_id = $1 RETURNING id`, [id, idNum(req.params.itemId), asiento]);
  if (!r[0]) throw notFound('Ítem');
  res.json(await detalleCuenta(id));
});

cuentasRouter.post('/:id/pagos', permitir(...R.cobro), async (req, res) => {
  const id = idNum(req.params.id);
  const datos = z
    .object({
      pagos: z.array(pagoSchema).min(1, 'Agrega al menos un pago'),
      sesion_caja_id: z.number().int(),
      asiento: z.number().int().nullish(),
      vuelto_moneda: z.enum(MONEDAS).nullish(),
      cerrar: z.boolean().default(false),
    })
    .parse(req.body);
  const resultado = await tx((db) => pagar(db, id, datos, req.usuario));
  res.status(201).json({ ...resultado, cuenta: await detalleCuenta(id) });
});

cuentasRouter.post('/:id/cerrar', permitir(...R.cobro), async (req, res) => {
  const id = idNum(req.params.id);
  await tx((db) => cerrar(db, id, req.usuario));
  res.json(await detalleCuenta(id));
});

cuentasRouter.post('/:id/anular', permitir('gerente', 'cajero'), async (req, res) => {
  const id = idNum(req.params.id);
  const { motivo } = z.object({ motivo: z.string().trim().min(3, 'Indica el motivo') }).parse(req.body);
  await tx((db) => anularCuenta(db, id, motivo, req.usuario));
  res.json(await detalleCuenta(id));
});

// ====================================================================== Comandas (pantalla de cocina / barra)
export const comandasRouter = Router();

comandasRouter.get('/', permitir(...R.comandas), async (req, res) => {
  const { estacion } = z.object({ estacion: z.enum(['barra', 'cocina']).optional() }).parse(req.query);
  res.json(
    await query(
      `SELECT i.id, i.cuenta_id, i.nombre, i.presentacion, i.cantidad, i.asiento, i.notas, i.estado, i.estacion, i.ronda, i.creado_en,
              c.numero AS cuenta, c.tipo, c.nombre_cliente, m.numero AS mesa_numero, m.nombre AS mesa_nombre, u.nombre AS mesonero,
              COALESCE((SELECT json_agg(json_build_object('tipo', x.tipo, 'nombre', x.nombre, 'cantidad', x.cantidad) ORDER BY x.tipo, x.id)
                          FROM cuenta_item_modificadores x WHERE x.item_id = i.id), '[]'::json) AS modificadores
         FROM cuenta_items i
         JOIN cuentas c ON c.id = i.cuenta_id
         LEFT JOIN mesas m ON m.id = c.mesa_id
         LEFT JOIN usuarios u ON u.id = i.usuario_id
        WHERE i.estado IN ('pendiente','preparando','listo') AND c.estado = 'abierta'
          AND ($1::text IS NULL OR i.estacion = $1)
        ORDER BY i.creado_en, i.id`,
      [estacion ?? null],
    ),
  );
});

comandasRouter.patch('/:itemId', permitir(...R.comandas), async (req, res) => {
  const { estado } = z.object({ estado: z.enum(['pendiente', 'preparando', 'listo', 'entregado']) }).parse(req.body);
  const [i] = await query(
    `UPDATE cuenta_items SET estado = $2, listo_en = CASE WHEN $2 = 'listo' THEN now() ELSE listo_en END
      WHERE id = $1 AND estado <> 'anulado' RETURNING id, estado`,
    [idNum(req.params.itemId), estado],
  );
  if (!i) throw notFound('Ítem');
  res.json(i);
});

/** Marca de una vez todos los ítems de una ronda/cuenta en una estación */
comandasRouter.post('/lote', permitir(...R.comandas), async (req, res) => {
  const { ids, estado } = z
    .object({ ids: z.array(z.number().int()).min(1), estado: z.enum(['preparando', 'listo', 'entregado']) })
    .parse(req.body);
  await query(
    `UPDATE cuenta_items SET estado = $2, listo_en = CASE WHEN $2 = 'listo' THEN now() ELSE listo_en END
      WHERE id = ANY($1::bigint[]) AND estado <> 'anulado'`,
    [ids, estado],
  );
  res.json({ ok: true });
});

export type { Moneda };
