import {
  getContentType, isJidBroadcast, isJidGroup, isJidNewsletter, isJidStatusBroadcast, normalizeMessageContent,
  type WAMessage, type WAMessageUpdate,
} from '@whiskeysockets/baileys';
import { pool, query } from '../../db/pool.js';
import { emitir } from '../vivo.js';

// La bandeja: los chats y mensajes del WhatsApp vinculado, guardados en la base para verlos desde el panel.
// Los adjuntos (fotos, audios, documentos) no se descargan: se anota qué llegó y se ve en el teléfono.

const IGNORAR = new Set(['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'pollUpdateMessage', 'keepInChatMessage', 'messageContextInfo']);

function parsear(c: NonNullable<WAMessage['message']>): { tipo: string; texto: string } | null {
  const t = getContentType(c);
  if (!t || IGNORAR.has(t)) return null;
  switch (t) {
    case 'conversation': return { tipo: 'texto', texto: c.conversation ?? '' };
    case 'extendedTextMessage': return { tipo: 'texto', texto: c.extendedTextMessage?.text ?? '' };
    case 'imageMessage': return { tipo: 'imagen', texto: c.imageMessage?.caption ? `📷 ${c.imageMessage.caption}` : '📷 Foto' };
    case 'videoMessage': return { tipo: 'video', texto: c.videoMessage?.caption ? `🎥 ${c.videoMessage.caption}` : '🎥 Video' };
    case 'audioMessage': return { tipo: 'audio', texto: '🎤 Nota de voz' };
    case 'documentMessage': return { tipo: 'documento', texto: `📄 ${c.documentMessage?.fileName || 'Documento'}` };
    case 'stickerMessage': return { tipo: 'sticker', texto: '🙂 Sticker' };
    case 'locationMessage': return { tipo: 'texto', texto: `📍 Ubicación: ${c.locationMessage?.degreesLatitude}, ${c.locationMessage?.degreesLongitude}` };
    case 'contactMessage': return { tipo: 'texto', texto: `👤 Contacto: ${c.contactMessage?.displayName ?? ''}` };
    default: return { tipo: 'texto', texto: `[${t}]` };
  }
}

export const telefonoDeJid = (jid: string) => jid.split('@')[0]?.split(':')[0] ?? jid;
export const jidDeTelefono = (tel: string) => `${tel.replace(/\D/g, '')}@s.whatsapp.net`;

/** Crea el chat si no existe; si llega un nombre y el chat no tenía, lo pone. */
async function asegurarChat(jid: string, nombre: string | null, esGrupo: boolean) {
  await pool.query(
    `INSERT INTO wa_chats (jid, nombre, es_grupo) VALUES ($1, $2, $3)
     ON CONFLICT (jid) DO UPDATE SET nombre = COALESCE(wa_chats.nombre, EXCLUDED.nombre)`,
    [jid, nombre, esGrupo],
  );
}

export async function ponerNombreGrupo(jid: string, nombre: string) {
  await pool.query(
    `INSERT INTO wa_chats (jid, nombre, es_grupo) VALUES ($1, $2, true) ON CONFLICT (jid) DO UPDATE SET nombre = EXCLUDED.nombre`,
    [jid, nombre],
  );
}

type NuevoMensaje = {
  jid: string; waId: string | null; deMi: boolean; tipo: string; texto: string; remitente?: string | null;
  usuarioId?: number | null; usuario?: string | null; estado: string; fecha: Date; cuentaNoLeido: boolean;
};

/** Guarda un mensaje y actualiza el chat. Devuelve null si ya estaba (mismo id de WhatsApp). */
export async function guardarMensaje(m: NuevoMensaje) {
  const r = await pool.query(
    `INSERT INTO wa_mensajes (wa_id, jid, de_mi, tipo, texto, remitente, usuario_id, usuario, estado, creado_en)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (wa_id) DO NOTHING RETURNING *`,
    [m.waId, m.jid, m.deMi, m.tipo, m.texto, m.remitente ?? null, m.usuarioId ?? null, m.usuario ?? null, m.estado, m.fecha],
  );
  const fila = r.rows[0];
  if (!fila) return null;
  await pool.query(
    `UPDATE wa_chats SET ultimo_texto = $2, ultimo_de_mi = $3, ultimo_en = GREATEST(COALESCE(ultimo_en, $4), $4),
            no_leidos = CASE WHEN $3 THEN 0 WHEN $5 THEN no_leidos + 1 ELSE no_leidos END
      WHERE jid = $1`,
    [m.jid, m.texto, m.deMi, m.fecha, m.cuentaNoLeido],
  );
  emitir({ tipo: 'whatsapp', accion: 'mensaje', jid: m.jid, de_mi: m.deMi, texto: m.texto.slice(0, 120), nuevo: m.cuentaNoLeido });
  return fila;
}

/** Lo que entra por messages.upsert: lo que escriben los clientes ("notify"), el historial al vincular ("append"),
 *  lo que se escribe desde el teléfono y el eco de lo que enviamos desde el panel (ya guardado: no se duplica). */
export async function procesarEntrantes(
  mensajes: WAMessage[],
  tipoUpsert: 'notify' | 'append',
  canonico: (jid: string, alt?: string | null) => Promise<string>,
  nombreGrupo: (jid: string) => Promise<string | null>,
) {
  for (const msg of mensajes) {
    try {
      const key = msg.key;
      const remoto = key.remoteJid;
      if (!remoto || isJidBroadcast(remoto) || isJidStatusBroadcast(remoto) || isJidNewsletter(remoto)) continue;
      const contenido = normalizeMessageContent(msg.message);
      if (!contenido) continue;
      const p = parsear(contenido);
      if (!p) continue;
      const grupo = !!isJidGroup(remoto);
      const jid = grupo ? remoto : await canonico(remoto, key.remoteJidAlt);
      const deMi = !!key.fromMe;
      await asegurarChat(jid, grupo ? await nombreGrupo(jid) : deMi ? null : (msg.pushName ?? null), grupo);
      const ts = Number(msg.messageTimestamp ?? 0);
      await guardarMensaje({
        jid,
        waId: key.id ?? null,
        deMi,
        tipo: p.tipo,
        texto: p.texto,
        remitente: grupo && !deMi ? msg.pushName?.trim() || (key.participant ? `+${telefonoDeJid(key.participant)}` : null) : null,
        estado: deMi ? 'enviado' : 'recibido',
        fecha: ts > 0 ? new Date(ts * 1000) : new Date(),
        cuentaNoLeido: tipoUpsert === 'notify' && !deMi,
      });
    } catch (err) {
      console.error('[wa] error con un mensaje entrante', err);
    }
  }
}

const ESTADOS: Record<number, string> = { 2: 'enviado', 3: 'entregado', 4: 'leido', 5: 'leido' };
const ORDEN = ['pendiente', 'enviado', 'entregado', 'leido'];

/** ✓ / ✓✓ / azul de lo que enviamos. Nunca retrocede. */
export async function procesarActualizaciones(updates: WAMessageUpdate[]) {
  for (const { key, update } of updates) {
    if (!key.fromMe || !key.id || update.status == null) continue;
    const estado = ESTADOS[update.status];
    if (!estado) continue;
    const r = await pool.query(
      `UPDATE wa_mensajes SET estado = $2 WHERE wa_id = $1 AND array_position($3::text[], estado) < array_position($3::text[], $2) RETURNING jid`,
      [key.id, estado, ORDEN],
    );
    if (r.rows[0]) emitir({ tipo: 'whatsapp', accion: 'estado', jid: r.rows[0].jid, wa_id: key.id, estado });
  }
}

export function listarChats(buscar?: string) {
  const q = buscar?.trim();
  return query(
    `SELECT jid, nombre, es_grupo, ultimo_texto, ultimo_de_mi, ultimo_en, no_leidos
       FROM wa_chats
      WHERE ultimo_en IS NOT NULL AND ($1::text IS NULL OR nombre ILIKE '%' || $1 || '%' OR jid ILIKE '%' || $1 || '%')
      ORDER BY ultimo_en DESC LIMIT 200`,
    [q || null],
  );
}

export async function mensajesDeChat(jid: string, antesDe?: number) {
  const filas = await query(
    `SELECT id, wa_id, de_mi, tipo, texto, remitente, usuario, estado, creado_en FROM wa_mensajes
      WHERE jid = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY creado_en DESC, id DESC LIMIT 80`,
    [jid, antesDe ?? null],
  );
  return filas.reverse();
}

export async function marcarLeido(jid: string) {
  await pool.query(`UPDATE wa_chats SET no_leidos = 0 WHERE jid = $1`, [jid]);
}

export async function asegurarChatSaliente(jid: string, nombre: string | null) {
  await asegurarChat(jid, nombre, jid.endsWith('@g.us'));
}
