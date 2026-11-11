import makeWASocket, {
  Browsers, DisconnectReason, isLidUser, jidNormalizedUser, makeCacheableSignalKeyStore, type WASocket,
} from '@whiskeysockets/baileys';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import QRCode from 'qrcode';
import { pool } from '../../db/pool.js';
import { HttpError } from '../../utils/http.js';
import { emitir } from '../vivo.js';
import { asegurarChatSaliente, guardarMensaje, jidDeTelefono, ponerNombreGrupo, procesarActualizaciones, procesarEntrantes } from './bandeja.js';
import { asegurarTablas, borrarSesion, haySesionGuardada, usarSesionBd } from './sesion.js';

// El WhatsApp del local vinculado como un dispositivo más (igual que WhatsApp Web), con Baileys.
// - fallas de red: reintento sin límite con espera creciente (máx. 60 s); NUNCA se borra la sesión
// - 515 restartRequired (normal justo después de vincular): reinicio inmediato
// - 401 loggedOut (lo desvincularon desde el teléfono): se borra la sesión y se pide un QR nuevo
// - 440 connectionReplaced: otra instancia abrió la misma sesión; no se reconecta solo

export type EstadoConexion = 'DESCONECTADO' | 'CONECTANDO' | 'ESPERANDO_QR' | 'CONECTADO' | 'REEMPLAZADA';

const logger = pino({ level: process.env.WA_LOG_LEVEL ?? 'warn' });

const L = {
  sock: null as WASocket | null,
  generacion: 0, // cada socket nuevo sube el número; los eventos de sockets viejos se ignoran
  estado: 'DESCONECTADO' as EstadoConexion,
  qr: null as string | null,
  huboQr: false,
  intentos: 0,
  timer: null as NodeJS.Timeout | null,
  ultimoError: null as string | null,
  conectadoDesde: null as Date | null,
  esperandoQr: [] as (() => void)[],
};
const nombresGrupos = new Map<string, string>();

export function estadoWhatsapp() {
  return {
    estado: L.estado,
    qr: L.estado === 'ESPERANDO_QR' ? L.qr : null,
    numero: L.sock?.user?.id ? jidNormalizedUser(L.sock.user.id).split('@')[0] : null,
    nombre: L.sock?.user?.name ?? null,
    ultimoError: L.ultimoError,
    conectadoDesde: L.conectadoDesde,
  };
}

export const whatsappConectado = () => L.estado === 'CONECTADO' && !!L.sock;

function cambiarEstado(nuevo: EstadoConexion) {
  L.estado = nuevo;
  emitir({ tipo: 'whatsapp', accion: 'conexion', estado: nuevo });
}

function soltarSocket() {
  const viejo = L.sock;
  if (!viejo) return;
  L.sock = null;
  try {
    viejo.ev.removeAllListeners(undefined as never);
    viejo.end(undefined);
  } catch { /* ya estaba cerrado */ }
}

/** En v7 los chats pueden llegar como @lid: se guardan siempre como <numero>@s.whatsapp.net */
async function jidCanonico(jid: string, alternativo?: string | null) {
  if (!isLidUser(jid)) return jidNormalizedUser(jid);
  if (alternativo && !isLidUser(alternativo)) return jidNormalizedUser(alternativo);
  const pn = await L.sock?.signalRepository.lidMapping.getPNForLID(jid).catch(() => null);
  return jidNormalizedUser(pn ?? jid);
}

async function nombreDeGrupo(jid: string) {
  const sabido = nombresGrupos.get(jid);
  if (sabido) return sabido;
  try {
    const meta = await L.sock?.groupMetadata(jid);
    if (meta?.subject) nombresGrupos.set(jid, meta.subject);
    return meta?.subject ?? null;
  } catch {
    return null;
  }
}

export async function iniciarWhatsapp(): Promise<void> {
  await asegurarTablas();
  if (L.timer) clearTimeout(L.timer);
  L.timer = null;
  soltarSocket();
  const miGeneracion = ++L.generacion;
  L.huboQr = false;
  L.qr = null;
  cambiarEstado('CONECTANDO');

  const { state, saveCreds } = await usarSesionBd();
  if (miGeneracion !== L.generacion) return;

  const s = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: false, // así el teléfono del local sigue recibiendo notificaciones
    syncFullHistory: false,
    getMessage: async (key) => {
      const r = await pool.query(`SELECT texto FROM wa_mensajes WHERE wa_id = $1`, [key.id]);
      return r.rows[0]?.texto ? { conversation: r.rows[0].texto } : undefined;
    },
  });
  L.sock = s;
  const vigente = () => miGeneracion === L.generacion;

  s.ev.on('creds.update', () => {
    if (vigente()) saveCreds().catch((e) => console.error('[wa] no se pudo guardar la sesión', e));
  });

  s.ev.on('connection.update', async (u) => {
    if (!vigente()) return;
    if (u.qr) {
      L.huboQr = true;
      L.qr = await QRCode.toDataURL(u.qr);
      if (!vigente()) return;
      cambiarEstado('ESPERANDO_QR');
      const pendientes = L.esperandoQr;
      L.esperandoQr = [];
      pendientes.forEach((f) => f());
    }
    if (u.connection === 'open') {
      L.intentos = 0;
      L.ultimoError = null;
      L.conectadoDesde = new Date();
      cambiarEstado('CONECTADO');
      console.log(`[wa] conectado como ${estadoWhatsapp().numero}`);
      s.groupFetchAllParticipating()
        .then(async (grupos) => {
          for (const g of Object.values(grupos)) {
            nombresGrupos.set(g.id, g.subject);
            await pool.query(`UPDATE wa_chats SET nombre = $2 WHERE jid = $1`, [g.id, g.subject]);
          }
        })
        .catch(() => {});
    }
    if (u.connection === 'close') {
      const codigo = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      L.ultimoError = u.lastDisconnect?.error?.message ?? null;
      L.conectadoDesde = null;
      await manejarCierre(codigo);
    }
  });

  s.ev.on('messages.upsert', ({ messages, type }) => {
    if (!vigente()) return;
    void procesarEntrantes(messages, type, jidCanonico, nombreDeGrupo);
  });
  s.ev.on('messages.update', (updates) => {
    if (vigente()) procesarActualizaciones(updates).catch((e) => console.error('[wa] estados', e));
  });
  s.ev.on('groups.update', (cambios) => {
    if (!vigente()) return;
    for (const g of cambios) {
      if (!g.id || !g.subject) continue;
      nombresGrupos.set(g.id, g.subject);
      void ponerNombreGrupo(g.id, g.subject).catch(() => {});
    }
  });
}

async function manejarCierre(codigo: number | undefined) {
  if (codigo === DisconnectReason.restartRequired) return iniciarWhatsapp();
  if (codigo === DisconnectReason.loggedOut) {
    console.warn('[wa] 401: lo desvincularon desde el teléfono; se pide un QR nuevo');
    soltarSocket();
    await borrarSesion();
    return iniciarWhatsapp();
  }
  if (codigo === DisconnectReason.connectionReplaced) {
    console.warn('[wa] 440: otra instancia abrió la sesión; no se reconecta solo');
    soltarSocket();
    return cambiarEstado('REEMPLAZADA');
  }
  soltarSocket();
  L.intentos++;
  const espera = Math.min(60_000, 1_000 * 2 ** Math.min(L.intentos, 6));
  console.warn(`[wa] conexión cerrada (${codigo ?? 'sin código'}); reintento ${L.intentos} en ${espera / 1000} s`);
  cambiarEstado('DESCONECTADO');
  L.timer = setTimeout(() => {
    L.timer = null;
    iniciarWhatsapp().catch((e) => console.error('[wa] error al reconectar', e));
  }, espera);
}

const conStatus = (status: number, mensaje: string) => new HttpError(status, mensaje);

/** Código de 8 dígitos para vincular sin escanear (WhatsApp → Dispositivos vinculados → Vincular con número). */
export async function pedirCodigoVinculacion(numero: string) {
  const limpio = numero.replace(/\D/g, '');
  if (limpio.length < 10) throw conStatus(400, 'Número inválido: incluye el código de país (ej. 573001234567)');
  if (L.estado === 'CONECTADO') throw conStatus(409, 'El WhatsApp ya está vinculado');
  if (!L.sock || L.estado === 'REEMPLAZADA' || L.estado === 'DESCONECTADO') await iniciarWhatsapp();
  if (!L.huboQr) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(conStatus(504, 'WhatsApp tardó demasiado en responder')), 30_000);
      L.esperandoQr.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  if (!L.sock) throw conStatus(503, 'No hay conexión con WhatsApp');
  return L.sock.requestPairingCode(limpio);
}

/** Desvincula el teléfono y borra la sesión. */
export async function cerrarWhatsapp() {
  const s = L.sock;
  if (s) await s.logout().catch(() => {});
  soltarSocket();
  L.generacion++;
  if (L.timer) clearTimeout(L.timer);
  L.timer = null;
  await borrarSesion();
  cambiarEstado('DESCONECTADO');
}

/** Borra la sesión y arranca de cero con un QR nuevo, sin avisar a WhatsApp (para sesiones dañadas). */
export async function reiniciarWhatsapp() {
  soltarSocket();
  L.generacion++;
  await borrarSesion();
  await iniciarWhatsapp();
}

/** Al arrancar el backend: si ya había un teléfono vinculado, se reconecta solo. */
export async function autoIniciarWhatsapp() {
  if (process.env.WA_AUTOSTART === 'false') return console.log('[wa] WA_AUTOSTART=false: WhatsApp no arranca solo');
  try {
    await asegurarTablas();
    if (!(await haySesionGuardada())) return console.log('[wa] sin teléfono vinculado: vincúlalo desde /admin/whatsapp');
    await iniciarWhatsapp();
  } catch (e) {
    console.error('[wa] no se pudo iniciar', (e as Error).message);
  }
}

/**
 * Envía un texto por el WhatsApp vinculado. `destino` es un número con código de país o el jid de un chat.
 * Queda en la bandeja como enviado desde el panel (con quién lo envió).
 */
export async function enviarTexto(destino: string, texto: string, usuario?: { id: number; nombre: string } | null) {
  const s = L.sock;
  if (!s || L.estado !== 'CONECTADO') throw conStatus(503, 'El WhatsApp no está vinculado o está desconectado');
  let jid = destino.includes('@') ? destino : jidDeTelefono(destino);
  if (!destino.includes('@')) {
    const r = await s.onWhatsApp(destino.replace(/\D/g, ''));
    const encontrado = r?.find((x) => x.exists);
    if (!encontrado) throw conStatus(404, `El número +${destino.replace(/\D/g, '')} no tiene WhatsApp`);
    jid = jidNormalizedUser(encontrado.jid);
  }
  await asegurarChatSaliente(jid, null);
  const waId = `3EB0${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
  // se guarda antes de enviar: así el eco que devuelve WhatsApp no se duplica
  const fila = await guardarMensaje({
    jid, waId, deMi: true, tipo: 'texto', texto, usuarioId: usuario?.id ?? null, usuario: usuario?.nombre ?? null,
    estado: 'pendiente', fecha: new Date(), cuentaNoLeido: false,
  });
  try {
    await s.sendMessage(jid, { text: texto }, { messageId: waId });
    await pool.query(`UPDATE wa_mensajes SET estado = 'enviado' WHERE wa_id = $1 AND estado = 'pendiente'`, [waId]);
  } catch (e) {
    await pool.query(`UPDATE wa_mensajes SET estado = 'fallido' WHERE wa_id = $1`, [waId]);
    throw conStatus(502, `No se pudo enviar: ${(e as Error).message}`);
  }
  return { ...fila, estado: 'enviado', jid };
}
