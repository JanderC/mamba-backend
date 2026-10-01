import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import rateLimit from 'express-rate-limit';
import { HttpError, notFound } from '../../utils/http.js';

export const eventosRouter = Router();

const SELECT_EVENTO = `
  SELECT e.id, e.slug, e.titulo, e.tematica, e.descripcion, e.flyer_url, e.inicia_en, e.termina_en,
         e.cover_cop, e.nota_cover, e.destacado,
         COALESCE((SELECT json_agg(json_build_object('nombre', a.nombre, 'rol', a.rol, 'instagram', a.instagram)
                                   ORDER BY a.orden)
                     FROM artistas_evento a WHERE a.evento_id = e.id), '[]') AS artistas
    FROM eventos e`;

const listQuery = z.object({
  cuando: z.enum(['proximos', 'pasados', 'todos']).default('proximos'),
  limite: z.coerce.number().int().min(1).max(50).default(20),
});

eventosRouter.get('/', async (req, res) => {
  const { cuando, limite } = listQuery.parse(req.query);
  const fin = `COALESCE(e.termina_en, e.inicia_en + interval '8 hours')`;
  const where =
    cuando === 'proximos' ? `AND ${fin} >= now()` : cuando === 'pasados' ? `AND ${fin} < now()` : '';
  const order = cuando === 'pasados' ? 'DESC' : 'ASC';
  const rows = await query(
    `${SELECT_EVENTO} WHERE e.estado = 'publicado' ${where} ORDER BY e.inicia_en ${order} LIMIT $1`,
    [limite],
  );
  res.set('Cache-Control', 'public, max-age=60');
  res.json(rows);
});

eventosRouter.get('/:slug', async (req, res) => {
  const [evento] = await query(`${SELECT_EVENTO} WHERE e.slug = $1 AND e.estado = 'publicado'`, [req.params.slug]);
  if (!evento) throw notFound('Evento');
  res.json(evento);
});

/** "Recuérdame este evento": el cliente deja su WhatsApp y se le avisa unas horas antes */
const recordatorioLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta más tarde.' } });

eventosRouter.post('/:slug/recordatorio', recordatorioLimiter, async (req, res) => {
  const b = z
    .object({
      nombre: z.string().trim().min(2, 'Escribe tu nombre').max(80),
      telefono: z.string().transform((v) => v.replace(/\D/g, '')).pipe(z.string().min(10, 'WhatsApp inválido').max(15, 'WhatsApp inválido')),
    })
    .parse(req.body);
  const [evento] = await query(`SELECT id, titulo, inicia_en FROM eventos WHERE slug = $1 AND estado = 'publicado'`, [req.params.slug]);
  if (!evento) throw notFound('Evento');
  if (new Date(evento.inicia_en).getTime() < Date.now()) throw new HttpError(409, 'Este evento ya comenzó');
  const telefono = b.telefono.length === 10 ? `57${b.telefono}` : b.telefono;
  await query(
    `INSERT INTO suscripciones_evento (evento_id, nombre, telefono) VALUES ($1,$2,$3)
     ON CONFLICT (evento_id, telefono) DO UPDATE SET nombre = EXCLUDED.nombre`,
    [evento.id, b.nombre, telefono],
  );
  res.status(201).json({ ok: true, evento: evento.titulo });
});
