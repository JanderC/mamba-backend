import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../../db/pool.js';
import { R, permitir } from '../../middlewares/auth.js';
import { actualizarTasaBCV, leerAjustes, tasaVigente } from '../../services/sistema.js';
import { HttpError, notFound } from '../../utils/http.js';
import { MONEDAS } from '../../utils/moneda.js';

// ====================================================================== Ajustes y datos del local
export const configRouter = Router();

configRouter.get('/ajustes', async (_req, res) => {
  res.json(await leerAjustes());
});

const ajustesSchema = z
  .object({
    moneda_principal: z.enum(MONEDAS),
    servicio_pct: z.number().min(0).max(100),
    servicio_auto_mesas: z.boolean(),
    capacidad_maxima: z.number().int().min(1).max(5000),
    permitir_venta_sin_stock: z.boolean(),
    recordatorio_reserva_horas: z.number().min(0).max(72),
    ticket_pie: z.string().max(300),
  })
  .partial();

configRouter.put('/ajustes', permitir(), async (req, res) => {
  const cambios = ajustesSchema.parse(req.body);
  for (const [clave, valor] of Object.entries(cambios)) {
    await query(
      `INSERT INTO ajustes (clave, valor) VALUES ($1, $2::jsonb)
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = now()`,
      [clave, JSON.stringify(valor)],
    );
  }
  res.json(await leerAjustes());
});

const localSchema = z.object({
  nombre: z.string().min(2),
  eslogan: z.string().nullish(),
  descripcion: z.string().nullish(),
  direccion: z.string().min(2),
  ciudad: z.string().min(2),
  departamento: z.string().nullish(),
  latitud: z.number().min(-90).max(90).nullish(),
  longitud: z.number().min(-180).max(180).nullish(),
  whatsapp: z.string().regex(/^\d{10,15}$/, 'Solo números, con código de país (ej. 573001234567)'),
  telefono: z.string().nullish(),
  email_reservas: z.string().nullish(),
  instagram: z.string().nullish(),
  tiktok: z.string().nullish(),
  dress_code: z.string().nullish(),
  edad_minima: z.number().int().min(0).max(30),
});

configRouter.put('/local', permitir(), async (req, res) => {
  const l = localSchema.parse(req.body);
  await query(
    `UPDATE configuracion_local SET nombre=$1, eslogan=$2, descripcion=$3, direccion=$4, ciudad=$5, departamento=$6,
            latitud=$7, longitud=$8, whatsapp=$9, telefono=$10, email_reservas=$11, instagram=$12, tiktok=$13,
            dress_code=$14, edad_minima=$15 WHERE id = 1`,
    [l.nombre, l.eslogan ?? null, l.descripcion ?? null, l.direccion, l.ciudad, l.departamento ?? null, l.latitud ?? null,
     l.longitud ?? null, l.whatsapp, l.telefono ?? null, l.email_reservas ?? null, l.instagram ?? null, l.tiktok ?? null,
     l.dress_code ?? null, l.edad_minima],
  );
  res.json({ ok: true });
});

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullish().or(z.literal(''));
const horariosSchema = z.array(
  z.object({
    dia_semana: z.number().int().min(0).max(6),
    abierto: z.boolean(),
    hora_apertura: hora, hora_cierre: hora, cierre_cocina: hora, cierre_barra: hora,
    nota: z.string().nullish(),
  }),
);

configRouter.put('/horarios', permitir(), async (req, res) => {
  const dias = horariosSchema.parse(req.body);
  for (const d of dias) {
    if (d.abierto && (!d.hora_apertura || !d.hora_cierre)) throw new HttpError(400, 'Los días abiertos necesitan hora de apertura y cierre');
    await query(
      `INSERT INTO horarios (dia_semana, abierto, hora_apertura, hora_cierre, cierre_cocina, cierre_barra, nota)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (dia_semana) DO UPDATE SET abierto=EXCLUDED.abierto, hora_apertura=EXCLUDED.hora_apertura,
         hora_cierre=EXCLUDED.hora_cierre, cierre_cocina=EXCLUDED.cierre_cocina, cierre_barra=EXCLUDED.cierre_barra, nota=EXCLUDED.nota`,
      [d.dia_semana, d.abierto, d.hora_apertura || null, d.hora_cierre || null, d.cierre_cocina || null, d.cierre_barra || null, d.nota || null],
    );
  }
  res.json({ ok: true });
});

// ====================================================================== Tasas de cambio
export const tasasRouter = Router();

tasasRouter.get('/actual', async (_req, res) => {
  res.json(await tasaVigente());
});

tasasRouter.get('/historial', async (_req, res) => {
  res.json(
    await query(
      `SELECT t.*, u.nombre AS usuario FROM tasas_cambio t LEFT JOIN usuarios u ON u.id = t.usuario_id
        ORDER BY t.fecha DESC, t.created_at DESC LIMIT 60`,
    ),
  );
});

tasasRouter.post('/manual', permitir(...R.gestion), async (req, res) => {
  const { usd_ves, usd_cop, ves_cop } = z
    .object({ usd_ves: z.number().positive(), usd_cop: z.number().positive(), ves_cop: z.number().positive().nullish() })
    .parse(req.body);
  const [t] = await query(
    `INSERT INTO tasas_cambio (usd_ves, usd_cop, ves_cop, ves_cop_manual, fuente, usuario_id)
     VALUES ($1,$2,$3,$4,'manual',$5) RETURNING *`,
    [usd_ves, usd_cop, ves_cop ?? usd_cop / usd_ves, ves_cop != null, req.usuario.id],
  );
  res.status(201).json(t);
});

/** Botón "Actualizar ahora" (BCV + TRM) */
tasasRouter.post('/actualizar', permitir(...R.gestion), async (req, res) => {
  res.status(201).json(await actualizarTasaBCV(req.usuario.id));
});

/** Fija a mano solo el cruce VES/COP (tasa de frontera), sin tocar las oficiales */
tasasRouter.patch('/actual/ves-cop', permitir(...R.gestion), async (req, res) => {
  const { ves_cop } = z.object({ ves_cop: z.number().positive().nullable() }).parse(req.body);
  const [t] = await query(
    `UPDATE tasas_cambio
        SET ves_cop = COALESCE($1, usd_cop / usd_ves), ves_cop_manual = ($1::numeric IS NOT NULL)
      WHERE id = (SELECT id FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1)
      RETURNING *`,
    [ves_cop],
  );
  if (!t) throw notFound('Tasa');
  res.json(t);
});

// ====================================================================== Métodos de pago
export const metodosRouter = Router();

metodosRouter.get('/', async (req, res) => {
  const todos = req.query.todos === '1';
  res.json(await query(`SELECT * FROM metodos_pago ${todos ? '' : 'WHERE activo'} ORDER BY activo DESC, orden, nombre`));
});

const metodoSchema = z.object({
  nombre: z.string().trim().min(2),
  es_efectivo: z.boolean().default(false),
  monedas: z.array(z.enum(MONEDAS)).min(1, 'Elige al menos una moneda'),
  requiere_referencia: z.boolean().default(false),
  orden: z.number().int().default(0),
  activo: z.boolean().default(true),
});

metodosRouter.post('/', permitir(...R.gestion), async (req, res) => {
  const m = metodoSchema.parse(req.body);
  const [dup] = await query(`SELECT 1 FROM metodos_pago WHERE lower(nombre) = lower($1)`, [m.nombre]);
  if (dup) throw new HttpError(409, 'Ya existe un método de pago con ese nombre');
  const [n] = await query(
    `INSERT INTO metodos_pago (nombre, es_efectivo, monedas, requiere_referencia, orden, activo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [m.nombre, m.es_efectivo, m.monedas, m.requiere_referencia, m.orden, m.activo],
  );
  res.status(201).json(n);
});

metodosRouter.put('/:id', permitir(...R.gestion), async (req, res) => {
  const m = metodoSchema.parse(req.body);
  const [n] = await query(
    `UPDATE metodos_pago SET nombre=$2, es_efectivo=$3, monedas=$4, requiere_referencia=$5, orden=$6, activo=$7 WHERE id=$1 RETURNING *`,
    [req.params.id, m.nombre, m.es_efectivo, m.monedas, m.requiere_referencia, m.orden, m.activo],
  );
  if (!n) throw notFound('Método de pago');
  res.json(n);
});

// ====================================================================== Cajas (puntos de cobro)
export const cajasCrud = Router();
cajasCrud.post('/', permitir(...R.gestion), async (req, res) => {
  const c = z.object({ nombre: z.string().trim().min(2), descripcion: z.string().nullish() }).parse(req.body);
  const [n] = await tx(async (db) =>
    query(`INSERT INTO cajas (nombre, descripcion) VALUES ($1,$2) ON CONFLICT (nombre) DO UPDATE SET activo = true RETURNING *`, [c.nombre, c.descripcion ?? null], db),
  );
  res.status(201).json(n);
});
