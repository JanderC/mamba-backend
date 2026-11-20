import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { R, permitir } from '../../middlewares/auth.js';
import { TZ } from '../../services/sistema.js';
import { HttpError } from '../../utils/http.js';

/**
 * Control de entrada y salida del personal — /api/admin/asistencia
 * Cada quien marca su entrada al empezar y su salida al irse; la gerencia ve el reporte con las horas.
 */
export const asistenciaRouter = Router();

/** Mi estado: si tengo una entrada sin salida (estoy trabajando) */
asistenciaRouter.get('/mia', async (req, res) => {
  const [abierta] = await query(`SELECT id, entrada FROM asistencias WHERE usuario_id = $1 AND salida IS NULL ORDER BY entrada DESC LIMIT 1`, [req.usuario.id]);
  res.json({ abierta: abierta ?? null });
});

asistenciaRouter.post('/entrada', async (req, res) => {
  const [abierta] = await query(`SELECT id FROM asistencias WHERE usuario_id = $1 AND salida IS NULL`, [req.usuario.id]);
  if (abierta) throw new HttpError(409, 'Ya marcaste tu entrada');
  const [a] = await query(`INSERT INTO asistencias (usuario_id) VALUES ($1) RETURNING id, entrada`, [req.usuario.id]);
  res.status(201).json(a);
});

asistenciaRouter.post('/salida', async (req, res) => {
  const [a] = await query(
    `UPDATE asistencias SET salida = now() WHERE id = (SELECT id FROM asistencias WHERE usuario_id = $1 AND salida IS NULL ORDER BY entrada DESC LIMIT 1)
     RETURNING id, entrada, salida`, [req.usuario.id]);
  if (!a) throw new HttpError(409, 'No tienes una entrada abierta');
  res.json(a);
});

/** Reporte: entradas y salidas de todos en un rango, con horas trabajadas */
asistenciaRouter.get('/', permitir(...R.gestion), async (req, res) => {
  const { desde, hasta } = z.object({ desde: z.iso.date(), hasta: z.iso.date() }).parse(req.query);
  res.json(await query(
    `SELECT a.id, a.entrada, a.salida, u.nombre, u.rol,
            round(extract(epoch FROM (COALESCE(a.salida, now()) - a.entrada)) / 3600, 2)::float AS horas
       FROM asistencias a JOIN usuarios u ON u.id = a.usuario_id
      WHERE (a.entrada AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
      ORDER BY a.entrada DESC`, [desde, hasta, TZ]));
});

/** Gerencia corrige una salida olvidada */
asistenciaRouter.patch('/:id', permitir(...R.gestion), async (req, res) => {
  const b = z.object({ salida: z.iso.datetime({ offset: true }).nullable(), nota: z.string().max(200).nullish() }).parse(req.body);
  const [a] = await query(`UPDATE asistencias SET salida = $2, nota = COALESCE($3, nota) WHERE id = $1 RETURNING id`, [Number(req.params.id), b.salida, b.nota ?? null]);
  if (!a) throw new HttpError(404, 'Registro no encontrado');
  res.json(a);
});
