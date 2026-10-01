import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../../db/pool.js';
import { R, permitir } from '../../middlewares/auth.js';
import { JORNADA_HOY, TZ, jornada, leerAjustes } from '../../services/sistema.js';
import { HttpError, notFound } from '../../utils/http.js';

export const salonRouter = Router();

async function aforo() {
  const [ajustes, [puerta], [sentados]] = await Promise.all([
    leerAjustes(),
    query<{ n: number }>(`SELECT COALESCE(SUM(delta), 0) AS n FROM aforo_registros WHERE ${jornada('fecha')} = ${JORNADA_HOY}`),
    query<{ n: number }>(`SELECT COALESCE(SUM(personas), 0) AS n FROM cuentas WHERE estado = 'abierta'`),
  ]);
  const enPuerta = Math.max(0, Number(puerta.n));
  // Si el portero no está contando, el mejor dato disponible es la gente sentada con cuenta abierta
  const actual = Math.max(enPuerta, Number(sentados.n));
  return { actual, en_puerta: enPuerta, con_cuenta: Number(sentados.n), maximo: ajustes.capacidad_maxima };
}

/** Plano del salón en vivo: zonas → mesas → cuentas abiertas y reservas de hoy */
salonRouter.get('/', permitir(...R.comandas, 'rrpp'), async (_req, res) => {
  const [zonas, mesas, cuentas, reservas] = await Promise.all([
    query(`SELECT id, slug, nombre, color, es_vip, consumo_minimo_cop, orden FROM zonas WHERE activo ORDER BY orden`),
    query(`SELECT * FROM mesas WHERE activo ORDER BY numero`),
    query(
      `SELECT c.id, c.numero, c.mesa_id, c.asiento, c.tipo, c.personas, c.cobro_solicitado_en, c.nombre_cliente, c.total, c.pagado, c.moneda, c.abierta_en, u.nombre AS mesonero,
              (SELECT count(*) FROM cuenta_items i WHERE i.cuenta_id = c.id AND i.estado IN ('pendiente','preparando')) AS pendientes,
              (SELECT count(*) FROM cuenta_items i WHERE i.cuenta_id = c.id AND i.estado = 'listo') AS listos
         FROM cuentas c LEFT JOIN usuarios u ON u.id = c.mesonero_id
        WHERE c.estado = 'abierta' ORDER BY c.abierta_en`,
    ),
    query(
      `SELECT r.id, r.codigo, r.nombre_completo, r.telefono, to_char(r.hora,'HH24:MI') AS hora, r.personas, r.estado, r.mesa_id, r.zona_id, r.motivo
         FROM reservas r
        WHERE r.fecha = (now() AT TIME ZONE '${TZ}' - interval '6 hours')::date AND r.estado IN ('pendiente','confirmada')
        ORDER BY r.hora`,
    ),
  ]);
  res.json({
    aforo: await aforo(),
    zonas: zonas.map((z) => ({
      ...z,
      mesas: mesas
        .filter((m) => m.zona_id === z.id)
        .map((m) => ({
          ...m,
          cuentas: cuentas.filter((c) => c.mesa_id === m.id),
          reservas: reservas.filter((r) => r.mesa_id === m.id),
        })),
    })),
    sin_mesa: cuentas.filter((c) => !c.mesa_id),
    reservas_sin_mesa: reservas.filter((r) => !r.mesa_id),
  });
});

// ====================================================================== Aforo (puerta)
salonRouter.get('/aforo', async (_req, res) => {
  res.json(await aforo());
});

salonRouter.post('/aforo', permitir(...R.comandas, 'rrpp'), async (req, res) => {
  const { delta, nota } = z.object({ delta: z.number().int().min(-50).max(50), nota: z.string().nullish() }).parse(req.body);
  if (delta === 0) throw new HttpError(400, 'Indica cuántas personas entran o salen');
  await query(`INSERT INTO aforo_registros (delta, nota, usuario_id) VALUES ($1,$2,$3)`, [delta, nota ?? null, req.usuario.id]);
  res.status(201).json(await aforo());
});

// ====================================================================== Zonas
const zonaSchema = z.object({
  nombre: z.string().trim().min(2),
  descripcion: z.string().nullish(),
  capacidad_mesa: z.number().int().min(1).default(6),
  max_personas: z.number().int().min(1).default(20),
  consumo_minimo_cop: z.number().int().min(0).default(0),
  es_vip: z.boolean().default(false),
  reservable: z.boolean().default(true),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#12805a'),
  beneficios: z.array(z.string()).default([]),
  orden: z.number().int().default(0),
  activo: z.boolean().default(true),
});

salonRouter.get('/zonas', async (_req, res) => {
  res.json(
    await query(
      `SELECT z.*, (SELECT count(*) FROM mesas m WHERE m.zona_id = z.id AND m.activo) AS mesas,
              (SELECT COALESCE(SUM(capacidad),0) FROM mesas m WHERE m.zona_id = z.id AND m.activo) AS puestos
         FROM zonas z ORDER BY z.activo DESC, z.orden`,
    ),
  );
});

salonRouter.post('/zonas', permitir(...R.gestion), async (req, res) => {
  const z_ = zonaSchema.parse(req.body);
  const slug = z_.nombre.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const [n] = await query(
    `INSERT INTO zonas (slug, nombre, descripcion, capacidad_mesa, max_personas, consumo_minimo_cop, es_vip, reservable, color, beneficios, orden, activo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [`${slug}-${Date.now().toString(36).slice(-4)}`, z_.nombre, z_.descripcion ?? null, z_.capacidad_mesa, z_.max_personas, z_.consumo_minimo_cop,
     z_.es_vip, z_.reservable, z_.color, z_.beneficios, z_.orden, z_.activo],
  );
  res.status(201).json(n);
});

salonRouter.put('/zonas/:id', permitir(...R.gestion), async (req, res) => {
  const z_ = zonaSchema.parse(req.body);
  const [n] = await query(
    `UPDATE zonas SET nombre=$2, descripcion=$3, capacidad_mesa=$4, max_personas=$5, consumo_minimo_cop=$6, es_vip=$7, reservable=$8,
            color=$9, beneficios=$10, orden=$11, activo=$12 WHERE id=$1 RETURNING id`,
    [req.params.id, z_.nombre, z_.descripcion ?? null, z_.capacidad_mesa, z_.max_personas, z_.consumo_minimo_cop, z_.es_vip, z_.reservable,
     z_.color, z_.beneficios, z_.orden, z_.activo],
  );
  if (!n) throw notFound('Zona');
  res.json(n);
});

// ====================================================================== Mesas
const mesaSchema = z.object({
  zona_id: z.number().int(),
  numero: z.number().int().min(1).max(9999),
  nombre: z.string().trim().nullish(),
  tipo: z.enum(['mesa', 'barra', 'vip']),
  forma: z.enum(['redonda', 'cuadrada', 'rectangular', 'barra']),
  capacidad: z.number().int().min(1).max(60),
  pos_x: z.number().min(0).max(100).default(50),
  pos_y: z.number().min(0).max(100).default(50),
  activo: z.boolean().default(true),
});

salonRouter.get('/mesas', async (_req, res) => {
  res.json(
    await query(
      `SELECT m.*, z.nombre AS zona,
              COALESCE((SELECT json_agg(json_build_object('numero', a.numero, 'etiqueta', a.etiqueta) ORDER BY a.numero)
                          FROM asientos a WHERE a.mesa_id = m.id), '[]'::json) AS asientos
         FROM mesas m JOIN zonas z ON z.id = m.zona_id ORDER BY m.activo DESC, m.numero`,
    ),
  );
});

salonRouter.post('/mesas', permitir(...R.gestion), async (req, res) => {
  const m = mesaSchema.parse(req.body);
  const [dup] = await query(`SELECT 1 FROM mesas WHERE numero = $1`, [m.numero]);
  if (dup) throw new HttpError(409, `Ya existe la mesa número ${m.numero}`);
  const [n] = await query(
    `INSERT INTO mesas (zona_id, numero, nombre, tipo, forma, capacidad, pos_x, pos_y, activo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [m.zona_id, m.numero, m.nombre || null, m.tipo, m.forma, m.capacidad, m.pos_x, m.pos_y, m.activo],
  );
  res.status(201).json(n);
});

salonRouter.put('/mesas/:id', permitir(...R.gestion), async (req, res) => {
  const m = mesaSchema.parse(req.body);
  const [dup] = await query(`SELECT 1 FROM mesas WHERE numero = $1 AND id <> $2`, [m.numero, req.params.id]);
  if (dup) throw new HttpError(409, `Ya existe la mesa número ${m.numero}`);
  const [n] = await query(
    `UPDATE mesas SET zona_id=$2, numero=$3, nombre=$4, tipo=$5, forma=$6, capacidad=$7, pos_x=$8, pos_y=$9, activo=$10 WHERE id=$1 RETURNING id`,
    [req.params.id, m.zona_id, m.numero, m.nombre || null, m.tipo, m.forma, m.capacidad, m.pos_x, m.pos_y, m.activo],
  );
  if (!n) throw notFound('Mesa');
  res.json(n);
});

/** Guarda el plano después de arrastrar las mesas */
salonRouter.put('/plano', permitir(...R.gestion), async (req, res) => {
  const mesas = z.array(z.object({ id: z.number().int(), pos_x: z.number().min(0).max(100), pos_y: z.number().min(0).max(100) })).parse(req.body);
  await tx(async (db) => {
    for (const m of mesas) await query(`UPDATE mesas SET pos_x = $2, pos_y = $3 WHERE id = $1`, [m.id, m.pos_x, m.pos_y], db);
  });
  res.json({ ok: true });
});
