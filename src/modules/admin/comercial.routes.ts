import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../../db/pool.js';
import { R, permitir } from '../../middlewares/auth.js';
import { mensajeRecordatorio, procesarRecordatoriosEvento } from '../../services/recordatorios.js';
import { JORNADA_HOY, leerAjustes } from '../../services/sistema.js';
import { HttpError, notFound } from '../../utils/http.js';
import { ESTADOS } from '../reservas/reservas.schema.js';
import { abrirCuenta } from './ventas.routes.js';

// ====================================================================== Reservas
export const reservasAdminRouter = Router();
reservasAdminRouter.use(permitir(...R.comercial, 'mesonero'));

reservasAdminRouter.get('/', async (req, res) => {
  const f = z.object({ desde: z.iso.date().optional(), hasta: z.iso.date().optional(), estado: z.enum(ESTADOS).optional() }).parse(req.query);
  res.json(
    await query(
      `SELECT r.id, r.codigo, r.estado, r.fecha, to_char(r.hora,'HH24:MI') AS hora, r.personas, r.motivo, r.nombre_completo, r.telefono,
              r.email, r.notas, r.nota_interna, r.creado_en, r.mesa_id, r.zona_id, z.nombre AS zona, z.es_vip, z.consumo_minimo_cop,
              e.titulo AS evento, m.numero AS mesa_numero
         FROM reservas r
         JOIN zonas z ON z.id = r.zona_id
         LEFT JOIN eventos e ON e.id = r.evento_id
         LEFT JOIN mesas m ON m.id = r.mesa_id
        WHERE ($1::date IS NULL OR r.fecha >= $1) AND ($2::date IS NULL OR r.fecha <= $2)
          AND ($3::estado_reserva IS NULL OR r.estado = $3)
        ORDER BY r.fecha, r.hora LIMIT 500`,
      [f.desde ?? null, f.hasta ?? null, f.estado ?? null],
    ),
  );
});

reservasAdminRouter.patch('/:id', async (req, res) => {
  const b = z
    .object({ estado: z.enum(ESTADOS), nota_interna: z.string().max(1000).nullable(), mesa_id: z.number().int().nullable() })
    .partial()
    .parse(req.body);
  const [r] = await query(
    `UPDATE reservas
        SET estado = COALESCE($2, estado),
            nota_interna = CASE WHEN $3::boolean THEN $4 ELSE nota_interna END,
            mesa_id = CASE WHEN $5::boolean THEN $6 ELSE mesa_id END
      WHERE id = $1 RETURNING id, codigo, estado`,
    [req.params.id, b.estado ?? null, b.nota_interna !== undefined, b.nota_interna ?? null, b.mesa_id !== undefined, b.mesa_id ?? null],
  );
  if (!r) throw notFound('Reserva');
  res.json(r);
});

/** Llegó el cliente: se le abre la cuenta en su mesa y la reserva pasa a "asistió" */
reservasAdminRouter.post('/:id/sentar', async (req, res) => {
  const { mesa_id } = z.object({ mesa_id: z.number().int() }).parse(req.body);
  const [r] = await query(`SELECT id, nombre_completo, personas, estado FROM reservas WHERE id = $1`, [req.params.id]);
  if (!r) throw notFound('Reserva');
  if (['cancelada', 'rechazada', 'asistio'].includes(r.estado)) throw new HttpError(409, `La reserva está ${r.estado}`);
  const ajustes = await leerAjustes();
  const cuentaId = await abrirCuenta(
    { tipo: 'mesa', mesa_id, personas: r.personas, nombre_cliente: r.nombre_completo, reserva_id: r.id, moneda: ajustes.moneda_principal },
    req.usuario.id,
  );
  res.status(201).json({ cuenta_id: cuentaId });
});

// ====================================================================== Eventos
export const eventosAdminRouter = Router();

eventosAdminRouter.get('/', async (_req, res) => {
  res.json(
    await query(
      `SELECT e.*,
              COALESCE((SELECT json_agg(json_build_object('nombre', a.nombre, 'rol', a.rol, 'instagram', a.instagram) ORDER BY a.orden)
                          FROM artistas_evento a WHERE a.evento_id = e.id), '[]'::json) AS artistas,
              (SELECT count(*) FROM suscripciones_evento s WHERE s.evento_id = e.id) AS suscritos,
              (SELECT count(*) FROM reservas r WHERE r.evento_id = e.id AND r.estado IN ('pendiente','confirmada')) AS reservas
         FROM eventos e ORDER BY e.inicia_en DESC LIMIT 200`,
    ),
  );
});

const eventoSchema = z.object({
  titulo: z.string().trim().min(2),
  tematica: z.string().nullish(),
  descripcion: z.string().nullish(),
  flyer_url: z.string().nullish(),
  inicia_en: z.iso.datetime({ offset: true, local: true }),
  termina_en: z.iso.datetime({ offset: true, local: true }).nullish().or(z.literal('')),
  cover_cop: z.number().int().min(0).nullish(),
  nota_cover: z.string().nullish(),
  estado: z.enum(['borrador', 'publicado', 'cancelado']).default('publicado'),
  destacado: z.boolean().default(false),
  recordatorio_horas_antes: z.number().int().min(1).max(72).default(6),
  artistas: z.array(z.object({ nombre: z.string().min(1), rol: z.string().default('DJ'), instagram: z.string().nullish() })).default([]),
});

async function guardarEvento(id: number | null, e: z.infer<typeof eventoSchema>) {
  return tx(async (db) => {
    const vals = [e.titulo, e.tematica ?? null, e.descripcion ?? null, e.flyer_url || null, e.inicia_en, e.termina_en || null,
      e.cover_cop ?? null, e.nota_cover ?? null, e.estado, e.destacado, e.recordatorio_horas_antes];
    let eventoId = id;
    if (id) {
      const r = await query(
        `UPDATE eventos SET titulo=$1, tematica=$2, descripcion=$3, flyer_url=$4, inicia_en=$5, termina_en=$6, cover_cop=$7,
                nota_cover=$8, estado=$9, destacado=$10, recordatorio_horas_antes=$11 WHERE id=$12 RETURNING id`,
        [...vals, id], db,
      );
      if (!r[0]) throw notFound('Evento');
    } else {
      const slug = e.titulo.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const [n] = await query<{ id: number }>(
        `INSERT INTO eventos (titulo, tematica, descripcion, flyer_url, inicia_en, termina_en, cover_cop, nota_cover, estado, destacado,
                              recordatorio_horas_antes, slug)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [...vals, `${slug}-${Date.now().toString(36).slice(-4)}`], db,
      );
      eventoId = n.id;
    }
    await query(`DELETE FROM artistas_evento WHERE evento_id = $1`, [eventoId], db);
    for (const [i, a] of e.artistas.entries())
      await query(`INSERT INTO artistas_evento (evento_id, nombre, rol, instagram, orden) VALUES ($1,$2,$3,$4,$5)`,
        [eventoId, a.nombre, a.rol, a.instagram || null, i + 1], db);
    return eventoId;
  });
}

eventosAdminRouter.post('/', permitir(...R.comercial), async (req, res) => {
  res.status(201).json({ id: await guardarEvento(null, eventoSchema.parse(req.body)) });
});
eventosAdminRouter.put('/:id', permitir(...R.comercial), async (req, res) => {
  res.json({ id: await guardarEvento(Number(req.params.id), eventoSchema.parse(req.body)) });
});

// ====================================================================== Recordatorios
export const recordatoriosRouter = Router();

/** Campana de la barra superior: todo lo que necesita atención ahora */
recordatoriosRouter.get('/alertas', async (_req, res) => {
  const ajustes = await leerAjustes();
  const [tareas, stock, reservas, suscripciones] = await Promise.all([
    query(
      `SELECT r.id, r.titulo, r.vence_en, r.prioridad, e.titulo AS evento, (r.vence_en < now()) AS vencido
         FROM recordatorios r LEFT JOIN eventos e ON e.id = r.evento_id
        WHERE NOT r.completado AND r.vence_en <= now() + interval '24 hours' ORDER BY r.vence_en LIMIT 20`),
    query(`SELECT id, nombre, stock, stock_minimo, unidad FROM insumos WHERE activo AND stock <= stock_minimo ORDER BY (stock - stock_minimo) LIMIT 30`),
    query(
      `SELECT r.id, r.codigo, r.nombre_completo, r.telefono, r.fecha, to_char(r.hora,'HH24:MI') AS hora, r.personas, r.estado
         FROM reservas r
        WHERE r.estado = 'pendiente' AND r.fecha >= ${JORNADA_HOY} ORDER BY r.fecha, r.hora LIMIT 20`),
    query(
      `SELECT count(*) AS n FROM suscripciones_evento s JOIN eventos e ON e.id = s.evento_id
        WHERE s.estado = 'pendiente' AND e.estado = 'publicado' AND e.inicia_en > now()
          AND e.inicia_en <= now() + make_interval(hours => e.recordatorio_horas_antes)`),
  ]);
  res.json({
    tareas, stock_bajo: stock, reservas_pendientes: reservas,
    recordatorios_por_enviar: Number(suscripciones[0].n),
    aviso_reserva_horas: ajustes.recordatorio_reserva_horas,
    total: tareas.length + stock.length + reservas.length + Number(suscripciones[0].n),
  });
});

recordatoriosRouter.get('/', async (req, res) => {
  const todos = req.query.todos === '1';
  res.json(
    await query(
      `SELECT r.*, e.titulo AS evento, u.nombre AS creado_por_nombre, (NOT r.completado AND r.vence_en < now()) AS vencido
         FROM recordatorios r LEFT JOIN eventos e ON e.id = r.evento_id LEFT JOIN usuarios u ON u.id = r.creado_por
        ${todos ? '' : 'WHERE NOT r.completado'}
        ORDER BY r.completado, r.vence_en LIMIT 300`,
    ),
  );
});

const recordatorioSchema = z.object({
  titulo: z.string().trim().min(3),
  detalle: z.string().nullish(),
  vence_en: z.iso.datetime({ offset: true, local: true }),
  evento_id: z.number().int().nullish(),
  prioridad: z.enum(['baja', 'normal', 'alta']).default('normal'),
  completado: z.boolean().default(false),
});

recordatoriosRouter.post('/', async (req, res) => {
  const r = recordatorioSchema.parse(req.body);
  const [n] = await query(
    `INSERT INTO recordatorios (titulo, detalle, vence_en, evento_id, prioridad, creado_por) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [r.titulo, r.detalle ?? null, r.vence_en, r.evento_id ?? null, r.prioridad, req.usuario.id],
  );
  res.status(201).json(n);
});

recordatoriosRouter.put('/:id', async (req, res) => {
  const r = recordatorioSchema.parse(req.body);
  const [n] = await query(
    `UPDATE recordatorios SET titulo=$2, detalle=$3, vence_en=$4, evento_id=$5, prioridad=$6, completado=$7,
            completado_en = CASE WHEN $7 AND completado_en IS NULL THEN now() WHEN NOT $7 THEN NULL ELSE completado_en END
      WHERE id=$1 RETURNING id`,
    [req.params.id, r.titulo, r.detalle ?? null, r.vence_en, r.evento_id ?? null, r.prioridad, r.completado],
  );
  if (!n) throw notFound('Recordatorio');
  res.json(n);
});

recordatoriosRouter.patch('/:id/completar', async (req, res) => {
  const { completado } = z.object({ completado: z.boolean() }).parse(req.body);
  const [n] = await query(
    `UPDATE recordatorios SET completado = $2, completado_en = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1 RETURNING id`,
    [req.params.id, completado],
  );
  if (!n) throw notFound('Recordatorio');
  res.json(n);
});

recordatoriosRouter.delete('/:id', async (req, res) => {
  await query(`DELETE FROM recordatorios WHERE id = $1`, [req.params.id]);
  res.status(204).end();
});

/** Clientes que pidieron que les recuerden un evento (desde la web) */
recordatoriosRouter.get('/suscripciones', permitir(...R.comercial), async (_req, res) => {
  const [local] = await query(`SELECT nombre FROM configuracion_local WHERE id = 1`);
  const rows = await query(
    `SELECT s.*, e.titulo AS evento, e.slug, e.inicia_en, e.recordatorio_horas_antes,
            (e.inicia_en <= now() + make_interval(hours => e.recordatorio_horas_antes)) AS toca_enviar
       FROM suscripciones_evento s JOIN eventos e ON e.id = s.evento_id
      WHERE e.inicia_en > now() - interval '12 hours'
      ORDER BY e.inicia_en, s.creado_en LIMIT 1000`,
  );
  res.json(rows.map((s) => ({ ...s, mensaje: mensajeRecordatorio(s.nombre, { titulo: s.evento, inicia_en: s.inicia_en }, local?.nombre ?? 'Mamba') })));
});

recordatoriosRouter.patch('/suscripciones/:id', permitir(...R.comercial), async (req, res) => {
  const { estado } = z.object({ estado: z.enum(['pendiente', 'enviado']) }).parse(req.body);
  const [n] = await query(
    `UPDATE suscripciones_evento SET estado = $2, enviado_en = CASE WHEN $2 = 'enviado' THEN now() ELSE NULL END WHERE id = $1 RETURNING id`,
    [req.params.id, estado],
  );
  if (!n) throw notFound('Suscripción');
  res.json(n);
});

/** Fuerza el envío automático ahora (si WhatsApp Cloud API está configurado) */
recordatoriosRouter.post('/suscripciones/enviar', permitir(...R.comercial), async (_req, res) => {
  res.json(await procesarRecordatoriosEvento());
});

// ====================================================================== Clientes
export const clientesRouter = Router();
clientesRouter.use(permitir(...R.comercial, 'mesonero', 'barra'));

clientesRouter.get('/', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  res.json(
    await query(
      `SELECT c.*,
              (SELECT count(*) FROM cuentas x WHERE x.cliente_id = c.id AND x.estado IN ('pagada','fiada')) AS visitas,
              (SELECT COALESCE(SUM(total_usd),0) FROM cuentas x WHERE x.cliente_id = c.id AND x.estado IN ('pagada','fiada')) AS consumo_usd
         FROM clientes c
        WHERE ($1 = '' OR c.nombre ILIKE '%'||$1||'%' OR c.telefono ILIKE '%'||$1||'%' OR c.documento ILIKE '%'||$1||'%')
        ORDER BY c.vip DESC, c.nombre LIMIT 500`,
      [q],
    ),
  );
});

const clienteSchema = z.object({
  nombre: z.string().trim().min(2),
  telefono: z.string().nullish(),
  documento: z.string().nullish(),
  email: z.string().nullish(),
  fecha_nacimiento: z.iso.date().nullish().or(z.literal('')),
  vip: z.boolean().default(false),
  notas: z.string().nullish(),
});

clientesRouter.post('/', async (req, res) => {
  const c = clienteSchema.parse(req.body);
  const [n] = await query(
    `INSERT INTO clientes (nombre, telefono, documento, email, fecha_nacimiento, vip, notas) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [c.nombre, c.telefono || null, c.documento || null, c.email || null, c.fecha_nacimiento || null, c.vip, c.notas || null],
  );
  res.status(201).json(n);
});

clientesRouter.put('/:id', async (req, res) => {
  const c = clienteSchema.parse(req.body);
  const [n] = await query(
    `UPDATE clientes SET nombre=$2, telefono=$3, documento=$4, email=$5, fecha_nacimiento=$6, vip=$7, notas=$8 WHERE id=$1 RETURNING *`,
    [req.params.id, c.nombre, c.telefono || null, c.documento || null, c.email || null, c.fecha_nacimiento || null, c.vip, c.notas || null],
  );
  if (!n) throw notFound('Cliente');
  res.json(n);
});
