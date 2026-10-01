import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { MOTIVOS, formatCOP, formatFecha, formatHora } from '../utils/format.js';

export type ReservaNotificable = {
  id: string;
  codigo: string;
  nombre_completo: string;
  telefono: string;
  email: string | null;
  fecha: string;
  hora: string;
  personas: number;
  motivo: string;
  notas: string | null;
  zona: string;
  es_vip: boolean;
  consumo_minimo_cop: number;
  evento: string | null;
};

export function mensajeReserva(r: ReservaNotificable) {
  return [
    `🐍 *NUEVA RESERVA — MAMBA BISTRO BAR*`,
    ``,
    `*Código:* ${r.codigo}`,
    `*Nombre:* ${r.nombre_completo}`,
    `*Teléfono:* ${r.telefono}`,
    `*Fecha:* ${formatFecha(r.fecha)}`,
    `*Hora:* ${formatHora(r.hora)}`,
    `*Personas:* ${r.personas}`,
    `*Zona:* ${r.zona}${r.es_vip ? ' ⭐ VIP' : ''}`,
    r.consumo_minimo_cop > 0 ? `*Consumo mínimo:* ${formatCOP(r.consumo_minimo_cop)}` : null,
    `*Motivo:* ${MOTIVOS[r.motivo] ?? r.motivo}`,
    r.evento ? `*Evento:* ${r.evento}` : null,
    r.notas ? `*Notas:* ${r.notas}` : null,
    ``,
    `Quedo atento(a) a la confirmación 🙌`,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/** WhatsApp Cloud API (Meta). Solo se ejecuta si hay token configurado. */
async function enviarWhatsApp(destino: string, texto: string) {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) return false;
  const r = await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: destino, type: 'text', text: { body: texto } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`WhatsApp API ${r.status}: ${await r.text()}`);
  return true;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Email vía Resend. Solo se ejecuta si hay API key configurada. */
async function enviarEmail(to: string, subject: string, texto: string) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return false;
  const html = `<div style="font-family:system-ui,sans-serif;background:#04140f;color:#f3e9c6;padding:24px;border-radius:12px">
    <h2 style="color:#d4af37;margin:0 0 12px">Mamba Bistro Bar 2.0</h2>
    <pre style="font-family:inherit;white-space:pre-wrap;margin:0">${escapeHtml(texto.replace(/\*/g, ''))}</pre></div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, html }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  return true;
}

/** Notifica al local por WhatsApp y email. Nunca lanza: la reserva ya quedó guardada. */
export async function notificarReserva(r: ReservaNotificable, whatsappLocal: string, emailLocal: string | null) {
  const texto = mensajeReserva(r);
  const resultados = await Promise.allSettled([
    (async () => {
      const ok = await enviarWhatsApp(env.WHATSAPP_NOTIFY_TO || whatsappLocal, texto);
      if (ok) await query(`UPDATE reservas SET notificado_whatsapp = now() WHERE id = $1`, [r.id]);
    })(),
    (async () => {
      const to = env.EMAIL_NOTIFY_TO || emailLocal;
      if (!to) return;
      const ok = await enviarEmail(to, `Nueva reserva ${r.codigo} — ${r.nombre_completo}`, texto);
      if (ok) await query(`UPDATE reservas SET notificado_email = now() WHERE id = $1`, [r.id]);
    })(),
  ]);
  for (const x of resultados) if (x.status === 'rejected') console.error('[notificaciones]', x.reason);
}
