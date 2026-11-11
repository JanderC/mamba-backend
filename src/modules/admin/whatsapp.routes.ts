import { Router } from 'express';
import { z } from 'zod';
import { permitir } from '../../middlewares/auth.js';
import { listarChats, marcarLeido, mensajesDeChat } from '../../services/whatsapp/bandeja.js';
import {
  cerrarWhatsapp, enviarTexto, estadoWhatsapp, iniciarWhatsapp, pedirCodigoVinculacion, reiniciarWhatsapp,
} from '../../services/whatsapp/conexion.js';
import { asegurarTablas } from '../../services/whatsapp/sesion.js';

/**
 * WhatsApp vinculado — /api/admin/whatsapp
 * Ver y responder chats: gerente, rrpp y cajero. Vincular o desvincular el teléfono: admin y gerente.
 */
export const whatsappRouter = Router();
whatsappRouter.use(permitir('gerente', 'rrpp', 'cajero'));
whatsappRouter.use(async (_req, _res, next) => {
  await asegurarTablas();
  next();
});
const vincula = permitir('gerente');

whatsappRouter.get('/estado', (_req, res) => {
  res.json(estadoWhatsapp());
});

/** Empieza la vinculación: en unos segundos el estado trae el QR para escanear */
whatsappRouter.post('/conectar', vincula, async (_req, res) => {
  const e = estadoWhatsapp();
  if (e.estado !== 'CONECTADO' && e.estado !== 'ESPERANDO_QR') await iniciarWhatsapp();
  res.json(estadoWhatsapp());
});

/** Vincular con número de teléfono (sin escanear): devuelve el código de 8 dígitos */
whatsappRouter.post('/codigo', vincula, async (req, res) => {
  const { numero } = z.object({ numero: z.string().min(10) }).parse(req.body);
  res.json({ codigo: await pedirCodigoVinculacion(numero) });
});

whatsappRouter.post('/desconectar', vincula, async (_req, res) => {
  await cerrarWhatsapp();
  res.json(estadoWhatsapp());
});

/** Borra la sesión y pide un QR nuevo (si quedó trabada) */
whatsappRouter.post('/reiniciar', vincula, async (_req, res) => {
  await reiniciarWhatsapp();
  res.json(estadoWhatsapp());
});

whatsappRouter.get('/chats', async (req, res) => {
  res.json(await listarChats(typeof req.query.q === 'string' ? req.query.q : undefined));
});

whatsappRouter.get('/chats/:jid/mensajes', async (req, res) => {
  const antes = req.query.antes ? Number(req.query.antes) : undefined;
  res.json(await mensajesDeChat(String(req.params.jid), antes));
});

whatsappRouter.post('/chats/:jid/leido', async (req, res) => {
  await marcarLeido(String(req.params.jid));
  res.json({ ok: true });
});

const texto = z.string().trim().min(1, 'Escribe el mensaje').max(4000);

whatsappRouter.post('/chats/:jid/enviar', async (req, res) => {
  const body = z.object({ texto }).parse(req.body);
  res.json(await enviarTexto(String(req.params.jid), body.texto, req.usuario));
});

/** Escribirle a un número que todavía no tiene chat */
whatsappRouter.post('/enviar', async (req, res) => {
  const body = z.object({ telefono: z.string().transform((v) => v.replace(/\D/g, '')).pipe(z.string().min(10, 'Número inválido: incluye el código de país').max(15)), texto }).parse(req.body);
  res.json(await enviarTexto(body.telefono, body.texto, req.usuario));
});
