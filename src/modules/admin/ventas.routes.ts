import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../../db/pool.js';
import { R, permitir } from '../../middlewares/auth.js';
import { agregarItems, anularCuenta, anularItem, cerrar, detalleCuenta, itemSchema, pagar, pagoSchema, recalcular } from '../../services/cuentas.js';
import { jornada, leerAjustes, tasaVigente } from '../../services/sistema.js';
import { emitir, lugarDe } from '../../services/vivo.js';
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
  const cuenta = await detalleCuenta(id);
  emitir({ tipo: 'cuenta', accion: 'abierta', cuenta_id: id, mesonero_id: cuenta.mesonero_id });
  res.status(201).json(cuenta);
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

// ---------------------------------------------------------------------- Tablet del mesonero
const SELECT_ACTIVA = `
  SELECT c.id, c.numero, c.tipo, c.asiento, c.personas, c.nombre_cliente, c.moneda, c.total, c.pagado, c.abierta_en, c.mesonero_id,
         c.cobro_solicitado_en, c.cobro_nota, m.numero AS mesa_numero, m.nombre AS mesa_nombre, m.tipo AS mesa_tipo, z.nombre AS zona,
         u.nombre AS mesonero,
         (SELECT count(*) FROM cuenta_items i WHERE i.cuenta_id = c.id AND i.estado = 'pendiente') AS en_cola,
         (SELECT count(*) FROM cuenta_items i WHERE i.cuenta_id = c.id AND i.estado = 'preparando') AS preparando,
         (SELECT count(*) FROM cuenta_items i WHERE i.cuenta_id = c.id AND i.estado <> 'anulado') AS items,
         COALESCE((SELECT json_agg(json_build_object('id', i.id, 'nombre', i.nombre, 'presentacion', i.presentacion, 'cantidad', i.cantidad,
                                                     'estacion', i.estacion, 'asiento', i.asiento) ORDER BY i.listo_en)
                     FROM cuenta_items i WHERE i.cuenta_id = c.id AND i.estado = 'listo'), '[]'::json) AS listos
    FROM cuentas c
    LEFT JOIN mesas m ON m.id = c.mesa_id
    LEFT JOIN zonas z ON z.id = m.zona_id
    LEFT JOIN usuarios u ON u.id = c.mesonero_id
   WHERE c.estado = 'abierta'`;

/** Cuentas abiertas del mesonero que consulta (o de todo el salón con ?todas=1) */
cuentasRouter.get('/activas', permitir(...R.servicio), async (req, res) => {
  const todas = req.query.todas === '1';
  res.json(await query(`${SELECT_ACTIVA} AND ($1::int IS NULL OR c.mesonero_id = $1) ORDER BY c.abierta_en`, [todas ? null : req.usuario.id]));
});

/** Cola de cobro del cajero: las cuentas que los mesoneros han pasado a caja, en orden de llegada */
cuentasRouter.get('/cola-cobro', permitir(...R.cobro), async (_req, res) => {
  res.json(await query(`${SELECT_ACTIVA} AND c.cobro_solicitado_en IS NOT NULL ORDER BY c.cobro_solicitado_en`));
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
  const cuenta = await detalleCuenta(id);
  emitir({ tipo: 'cuenta', accion: 'editada', cuenta_id: id, mesonero_id: cuenta.mesonero_id });
  res.json(cuenta);
});

cuentasRouter.post('/:id/items', permitir(...R.servicio), async (req, res) => {
  const id = idNum(req.params.id);
  const { items, directo } = z
    .object({ items: z.array(itemSchema).min(1, 'Agrega al menos un producto'), directo: z.boolean().default(false) })
    .parse(req.body);
  await tx((db) => agregarItems(db, id, items, req.usuario, directo));
  const cuenta = await detalleCuenta(id);

  // Aviso inmediato a barra y cocina: llega con la mesa, el cliente y quién lo tomó
  const ronda = Math.max(...cuenta.items.map((i: { ronda: number }) => i.ronda));
  const nuevos = cuenta.items.filter((i: { ronda: number }) => i.ronda === ronda);
  emitir({
    tipo: 'pedido', cuenta_id: id, numero: cuenta.numero, lugar: lugarDe(cuenta), cliente: cuenta.nombre_cliente, mesonero: req.usuario.nombre,
    estaciones: [...new Set(nuevos.map((i: { estacion: string }) => i.estacion))] as string[], items: nuevos.length, directo,
  });
  res.status(201).json(cuenta);
});

cuentasRouter.delete('/:id/items/:itemId', permitir(...R.servicio), async (req, res) => {
  const id = idNum(req.params.id);
  const { motivo } = z.object({ motivo: z.string().trim().min(3, 'Indica el motivo de la anulación') }).parse(req.body ?? {});
  await tx((db) => anularItem(db, id, idNum(req.params.itemId), motivo, req.usuario));
  const cuenta = await detalleCuenta(id);
  emitir({ tipo: 'cuenta', accion: 'item_anulado', cuenta_id: id, mesonero_id: cuenta.mesonero_id });
  res.json(cuenta);
});

/** Reasignar un ítem a otro asiento (para dividir la cuenta por puesto) */
cuentasRouter.patch('/:id/items/:itemId', permitir(...R.servicio), async (req, res) => {
  const id = idNum(req.params.id);
  const { asiento } = z.object({ asiento: z.number().int().min(1).max(60).nullable() }).parse(req.body);
  const r = await query(`UPDATE cuenta_items SET asiento = $3 WHERE id = $2 AND cuenta_id = $1 RETURNING id`, [id, idNum(req.params.itemId), asiento]);
  if (!r[0]) throw notFound('Ítem');
  res.json(await detalleCuenta(id));
});

// ---------------------------------------------------------------------- Mesonero → caja
/** El mesonero pasa la cuenta a caja: aparece al instante en la cola del cajero */
cuentasRouter.post('/:id/solicitar-cobro', permitir(...R.servicio), async (req, res) => {
  const id = idNum(req.params.id);
  const { nota } = z.object({ nota: z.string().trim().max(200).nullish() }).parse(req.body ?? {});
  const [c] = await query(`SELECT estado, total FROM cuentas WHERE id = $1`, [id]);
  if (!c) throw notFound('Cuenta');
  if (c.estado !== 'abierta') throw new HttpError(409, 'La cuenta ya está cerrada');
  if (Number(c.total) <= 0) throw new HttpError(400, 'La cuenta está vacía: no hay nada que cobrar');
  await query(`UPDATE cuentas SET cobro_solicitado_en = now(), cobro_solicitado_por = $2, cobro_nota = $3 WHERE id = $1`, [id, req.usuario.id, nota || null]);
  const cuenta = await detalleCuenta(id);
  emitir({ tipo: 'cobro', accion: 'solicitado', cuenta_id: id, numero: cuenta.numero, lugar: lugarDe(cuenta), cliente: cuenta.nombre_cliente,
    mesonero: req.usuario.nombre, mesonero_id: cuenta.mesonero_id });
  res.json(cuenta);
});

cuentasRouter.delete('/:id/solicitar-cobro', permitir(...R.servicio), async (req, res) => {
  const id = idNum(req.params.id);
  await query(`UPDATE cuentas SET cobro_solicitado_en = NULL, cobro_solicitado_por = NULL, cobro_nota = NULL WHERE id = $1 AND estado = 'abierta'`, [id]);
  const cuenta = await detalleCuenta(id);
  emitir({ tipo: 'cobro', accion: 'cancelado', cuenta_id: id, numero: cuenta.numero, lugar: lugarDe(cuenta), cliente: cuenta.nombre_cliente,
    mesonero: cuenta.mesonero, mesonero_id: cuenta.mesonero_id });
  res.json(cuenta);
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
  const resultado = await tx(async (db) => {
    const r = await pagar(db, id, datos, req.usuario);
    // Atendida: sale de la cola de cobro
    await query(`UPDATE cuentas SET cobro_solicitado_en = NULL, cobro_solicitado_por = NULL, cobro_nota = NULL WHERE id = $1`, [id], db);
    return r;
  });
  const cuenta = await detalleCuenta(id);
  emitir({ tipo: 'cobro', accion: 'cobrado', cuenta_id: id, numero: cuenta.numero, lugar: lugarDe(cuenta), cliente: cuenta.nombre_cliente,
    mesonero: cuenta.mesonero, mesonero_id: cuenta.mesonero_id });
  res.status(201).json({ ...resultado, cuenta });
});

cuentasRouter.post('/:id/cerrar', permitir(...R.cobro), async (req, res) => {
  const id = idNum(req.params.id);
  await tx((db) => cerrar(db, id, req.usuario));
  const cuenta = await detalleCuenta(id);
  emitir({ tipo: 'cuenta', accion: 'cerrada', cuenta_id: id, mesonero_id: cuenta.mesonero_id });
  res.json(cuenta);
});

cuentasRouter.post('/:id/anular', permitir('gerente', 'cajero'), async (req, res) => {
  const id = idNum(req.params.id);
  const { motivo } = z.object({ motivo: z.string().trim().min(3, 'Indica el motivo') }).parse(req.body);
  await tx((db) => anularCuenta(db, id, motivo, req.usuario));
  const cuenta = await detalleCuenta(id);
  emitir({ tipo: 'cuenta', accion: 'anulada', cuenta_id: id, mesonero_id: cuenta.mesonero_id });
  res.json(cuenta);
});

// ====================================================================== Comandas (pantalla de cocina / barra)
export const comandasRouter = Router();

comandasRouter.get('/', permitir(...R.comandas), async (req, res) => {
  const { estacion } = z.object({ estacion: z.enum(['barra', 'cocina']).optional() }).parse(req.query);
  res.json(
    await query(
      `SELECT i.id, i.cuenta_id, i.nombre, i.presentacion, i.cantidad, i.asiento, i.notas, i.estado, i.estacion, i.ronda, i.creado_en,
              c.numero AS cuenta, c.tipo, c.nombre_cliente, c.asiento AS puesto, m.numero AS mesa_numero, m.nombre AS mesa_nombre,
              m.tipo AS mesa_tipo, z.nombre AS zona, u.nombre AS mesonero,
              COALESCE((SELECT json_agg(json_build_object('tipo', x.tipo, 'nombre', x.nombre, 'cantidad', x.cantidad) ORDER BY x.tipo, x.id)
                          FROM cuenta_item_modificadores x WHERE x.item_id = i.id), '[]'::json) AS modificadores
         FROM cuenta_items i
         JOIN cuentas c ON c.id = i.cuenta_id
         LEFT JOIN mesas m ON m.id = c.mesa_id
         LEFT JOIN zonas z ON z.id = m.zona_id
         LEFT JOIN usuarios u ON u.id = i.usuario_id
        WHERE i.estado IN ('pendiente','preparando','listo') AND c.estado = 'abierta'
          AND ($1::text IS NULL OR i.estacion = $1)
        ORDER BY i.creado_en, i.id`,
      [estacion ?? null],
    ),
  );
});

/** Cambia el estado y avisa en vivo (al mesonero le llega "listo para llevar a la mesa") */
async function cambiarEstado(ids: number[], estado: 'pendiente' | 'preparando' | 'listo' | 'entregado') {
  const items = await query(
    `WITH act AS (
       UPDATE cuenta_items SET estado = $2, listo_en = CASE WHEN $2 = 'listo' THEN now() ELSE listo_en END
        WHERE id = ANY($1::bigint[]) AND estado <> 'anulado' RETURNING id, cuenta_id, nombre, cantidad, estacion)
     SELECT a.id, a.nombre, a.cantidad, a.cuenta_id, a.estacion, c.tipo, c.asiento, c.nombre_cliente AS cliente, c.mesonero_id,
            m.numero AS mesa_numero, m.tipo AS mesa_tipo
       FROM act a JOIN cuentas c ON c.id = a.cuenta_id LEFT JOIN mesas m ON m.id = c.mesa_id`,
    [ids, estado],
  );
  if (items.length)
    emitir({
      tipo: 'comanda', estado,
      items: items.map((i) => ({ id: i.id, nombre: i.nombre, cantidad: i.cantidad, cuenta_id: i.cuenta_id, lugar: lugarDe(i), cliente: i.cliente,
        mesonero_id: i.mesonero_id, estacion: i.estacion })),
    });
  return items.length;
}

comandasRouter.patch('/:itemId', permitir(...R.comandas), async (req, res) => {
  const { estado } = z.object({ estado: z.enum(['pendiente', 'preparando', 'listo', 'entregado']) }).parse(req.body);
  const n = await cambiarEstado([idNum(req.params.itemId)], estado);
  if (!n) throw notFound('Ítem');
  res.json({ ok: true, estado });
});

/** Marca de una vez todos los ítems de una ronda/cuenta en una estación */
comandasRouter.post('/lote', permitir(...R.comandas), async (req, res) => {
  const { ids, estado } = z
    .object({ ids: z.array(z.number().int()).min(1), estado: z.enum(['preparando', 'listo', 'entregado']) })
    .parse(req.body);
  res.json({ ok: true, actualizados: await cambiarEstado(ids, estado) });
});

export type { Moneda };
