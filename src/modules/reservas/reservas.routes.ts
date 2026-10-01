import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query } from '../../db/pool.js';
import { mensajeReserva, notificarReserva, type ReservaNotificable } from '../../services/notificaciones.js';
import { HttpError } from '../../utils/http.js';
import { crearReservaSchema } from './reservas.schema.js';

export const reservasRouter = Router();

/** Zonas, políticas, eventos y horarios para armar el formulario */
reservasRouter.get('/opciones', async (_req, res) => {
  const [zonas, politicas, eventos, horarios] = await Promise.all([
    query(`SELECT slug, nombre, descripcion, capacidad_mesa, max_personas, consumo_minimo_cop, es_vip, beneficios
             FROM zonas WHERE activo AND reservable ORDER BY orden`),
    query(`SELECT titulo, cuerpo, icono FROM politicas_reserva WHERE activo ORDER BY orden`),
    query(`SELECT slug, titulo, inicia_en FROM eventos
            WHERE estado = 'publicado' AND inicia_en >= now() - interval '6 hours'
            ORDER BY inicia_en LIMIT 10`),
    query(`SELECT dia_semana, abierto, to_char(hora_apertura,'HH24:MI') AS hora_apertura,
                  to_char(hora_cierre,'HH24:MI') AS hora_cierre FROM horarios ORDER BY dia_semana`),
  ]);
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ zonas, politicas, eventos, horarios });
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos o escríbenos por WhatsApp.' },
});

reservasRouter.post('/', limiter, async (req, res) => {
  const data = crearReservaSchema.parse(req.body);
  if (data.sitio_web) throw new HttpError(400, 'Solicitud inválida');

  // Fecha no pasada (hora Colombia)
  const [{ hoy }] = await query<{ hoy: string }>(`SELECT (now() AT TIME ZONE 'America/Bogota')::date::text AS hoy`);
  if (data.fecha < hoy) throw new HttpError(400, 'La fecha de la reserva ya pasó');

  // Zona válida y capacidad
  const [zona] = await query(
    `SELECT id, nombre, max_personas, es_vip, consumo_minimo_cop FROM zonas WHERE slug = $1 AND activo AND reservable`,
    [data.zona],
  );
  if (!zona) throw new HttpError(400, 'Zona no disponible');
  if (data.personas > zona.max_personas)
    throw new HttpError(
      400,
      `La zona ${zona.nombre} admite máximo ${zona.max_personas} personas. Escríbenos por WhatsApp para grupos grandes.`,
    );

  // Día abierto y hora dentro del horario (el cierre puede pasar de medianoche)
  const [h] = await query(
    `SELECT abierto, to_char(hora_apertura,'HH24:MI') AS ap, to_char(hora_cierre,'HH24:MI') AS ci
       FROM horarios WHERE dia_semana = extract(dow FROM $1::date)`,
    [data.fecha],
  );
  if (h && !h.abierto) throw new HttpError(400, 'Ese día no abrimos. Revisa nuestros horarios.');
  if (h?.ap && h?.ci) {
    const dentro = h.ci > h.ap ? data.hora >= h.ap && data.hora < h.ci : data.hora >= h.ap || data.hora < h.ci;
    if (!dentro) throw new HttpError(400, `Ese día atendemos de ${h.ap} a ${h.ci}.`);
  }

  const evento = data.evento
    ? (await query(`SELECT id, titulo FROM eventos WHERE slug = $1 AND estado = 'publicado'`, [data.evento]))[0]
    : null;

  const [nueva] = await query<{ id: string; codigo: string }>(
    `INSERT INTO reservas (nombre_completo, telefono, email, fecha, hora, personas, zona_id, motivo, evento_id,
                           notas, acepta_politicas, ip_origen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11)
     RETURNING id, codigo`,
    [
      data.nombre_completo, data.telefono, data.email, data.fecha, data.hora, data.personas, zona.id,
      data.motivo, evento?.id ?? null, data.notas || null, req.ip ?? null,
    ],
  );

  const [local] = await query<{ whatsapp: string; email_reservas: string | null }>(
    `SELECT whatsapp, email_reservas FROM configuracion_local WHERE id = 1`,
  );

  const reserva: ReservaNotificable = {
    ...nueva,
    nombre_completo: data.nombre_completo,
    telefono: data.telefono,
    email: data.email ?? null,
    fecha: data.fecha,
    hora: data.hora,
    personas: data.personas,
    motivo: data.motivo,
    notas: data.notas ?? null,
    zona: zona.nombre,
    es_vip: zona.es_vip,
    consumo_minimo_cop: zona.consumo_minimo_cop,
    evento: evento?.titulo ?? null,
  };

  // Notificación en segundo plano: el cliente no espera
  void notificarReserva(reserva, local.whatsapp, local.email_reservas);

  res.status(201).json({
    codigo: nueva.codigo,
    estado: 'pendiente',
    // El cliente también puede enviar la solicitud desde su WhatsApp para confirmación inmediata con el RRPP
    whatsapp_url: `https://wa.me/${local.whatsapp}?text=${encodeURIComponent(mensajeReserva(reserva))}`,
  });
});

/** Consulta pública del estado de una reserva (código + teléfono) */
reservasRouter.get('/estado/:codigo', async (req, res) => {
  const tel = String(req.query.telefono ?? '').replace(/\D/g, '');
  const [r] = await query(
    `SELECT r.codigo, r.estado, r.fecha, to_char(r.hora,'HH24:MI') AS hora, r.personas, z.nombre AS zona
       FROM reservas r JOIN zonas z ON z.id = r.zona_id
      WHERE r.codigo = $1 AND r.telefono = $2`,
    [req.params.codigo.toUpperCase(), tel],
  );
  if (!r) throw new HttpError(404, 'No encontramos una reserva con esos datos');
  res.json(r);
});
