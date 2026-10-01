import cron from 'node-cron';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { TZ, actualizarTasaBCV } from './sistema.js';

export function mensajeRecordatorio(nombre: string, evento: { titulo: string; inicia_en: string | Date }, local: string) {
  const d = new Date(evento.inicia_en);
  const cuando = d.toLocaleString('es-CO', { timeZone: TZ, weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true });
  return `🐍 ¡Hola ${nombre.split(' ')[0]}! Te recordamos que *${evento.titulo}* es ${cuando} en ${local}. ¿Te guardamos mesa? Responde este mensaje y te reservamos.`;
}

async function enviarWhatsApp(destino: string, texto: string) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: destino, type: 'text', text: { body: texto } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`WhatsApp API ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

/**
 * Envía los recordatorios de eventos que ya entraron en su ventana ("N horas antes").
 * Con WhatsApp Cloud API configurado se envían solos; sin él quedan en "pendiente" y el RRPP
 * los despacha con un clic desde Recordatorios (enlace wa.me con el mensaje armado).
 */
export async function procesarRecordatoriosEvento() {
  const automatico = Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
  const pendientes = await query(
    `SELECT s.id, s.nombre, s.telefono, e.titulo, e.inicia_en
       FROM suscripciones_evento s JOIN eventos e ON e.id = s.evento_id
      WHERE s.estado = 'pendiente' AND e.estado = 'publicado' AND e.inicia_en > now()
        AND e.inicia_en <= now() + make_interval(hours => e.recordatorio_horas_antes)
      LIMIT 200`,
  );
  if (!automatico) return { automatico, pendientes: pendientes.length, enviados: 0, fallidos: 0 };

  const [local] = await query(`SELECT nombre FROM configuracion_local WHERE id = 1`);
  let enviados = 0, fallidos = 0;
  for (const s of pendientes) {
    try {
      await enviarWhatsApp(s.telefono, mensajeRecordatorio(s.nombre, s, local?.nombre ?? 'Mamba'));
      await query(`UPDATE suscripciones_evento SET estado = 'enviado', enviado_en = now() WHERE id = $1`, [s.id]);
      enviados++;
    } catch (err) {
      await query(`UPDATE suscripciones_evento SET estado = 'fallido', detalle = $2 WHERE id = $1`, [s.id, (err as Error).message]);
      fallidos++;
    }
  }
  return { automatico, pendientes: pendientes.length, enviados, fallidos };
}

export function iniciarTareasProgramadas() {
  // Recordatorios de eventos: cada 10 minutos
  cron.schedule('*/10 * * * *', () => {
    procesarRecordatoriosEvento()
      .then((r) => r.enviados + r.fallidos > 0 && console.log('[cron] recordatorios de evento', r))
      .catch((e) => console.error('[cron] recordatorios', e.message));
  });

  // Tasa oficial (BCV + TRM): todos los días a las 8:00 a.m. hora del negocio
  cron.schedule(
    '0 8 * * *',
    () => {
      actualizarTasaBCV()
        .then((t) => console.log(`[cron] tasa actualizada: USD/VES=${t.usd_ves} USD/COP=${t.usd_cop}`))
        .catch((e) => console.error('[cron] tasa', e.message));
    },
    { timezone: TZ },
  );

  // Si la base solo tiene la tasa referencial del seed, intenta traer la real al arrancar
  query(`SELECT fuente FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1`)
    .then(async ([t]) => {
      if (t && t.fuente !== 'inicial') return;
      await actualizarTasaBCV();
      console.log('[tasas] tasa oficial cargada al iniciar');
    })
    .catch((e) => console.warn('[tasas] no se pudo cargar la tasa oficial al iniciar:', e.message));
}
