import { Router } from 'express';
import { z } from 'zod';
import { R, permitir } from '../../middlewares/auth.js';
import {
  aceptarPedidoQr, asegurarTablasQr, bandejaQr, cartaQr, crearPedidoQr, estadoPedidosQr, pedidoQrSchema, rechazarPedidoQr, regenerarQr,
} from '../../services/pedidosQr.js';
import { HttpError } from '../../utils/http.js';

const idNum = (v: string | string[]) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Identificador inválido');
  return n;
};

// ====================================================================== Público: /api/qr/:token (lo abre el cliente desde la mesa)
export const qrRouter = Router();
qrRouter.use(async (_req, _res, next) => {
  await asegurarTablasQr();
  next();
});

qrRouter.get('/:token', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await cartaQr(String(req.params.token)));
});

qrRouter.post('/:token/pedidos', async (req, res) => {
  const datos = pedidoQrSchema.parse(req.body);
  res.status(201).json(await crearPedidoQr(String(req.params.token), datos, req.ip ?? 'desconocida'));
});

/** ?ids=12,15 → estado de los pedidos que este teléfono envió */
qrRouter.get('/:token/pedidos', async (req, res) => {
  const ids = String(req.query.ids ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  res.set('Cache-Control', 'no-store');
  res.json(await estadoPedidosQr(String(req.params.token), ids));
});

// ====================================================================== Panel: /api/admin/pedidos-qr (barra, caja, mesoneros, gerencia)
export const pedidosQrRouter = Router();
pedidosQrRouter.use(async (_req, _res, next) => {
  await asegurarTablasQr();
  next();
});

pedidosQrRouter.get('/', permitir(...R.servicio), async (_req, res) => {
  res.json(await bandejaQr());
});

pedidosQrRouter.post('/:id/aceptar', permitir(...R.servicio), async (req, res) => {
  const { cuenta_id } = z.object({ cuenta_id: z.number().int().nullish() }).parse(req.body ?? {});
  res.json(await aceptarPedidoQr(idNum(req.params.id), req.usuario, cuenta_id ?? null));
});

pedidosQrRouter.post('/:id/rechazar', permitir(...R.servicio), async (req, res) => {
  const { motivo } = z.object({ motivo: z.string().trim().min(3, 'Indica el motivo para el cliente').max(160) }).parse(req.body ?? {});
  await rechazarPedidoQr(idNum(req.params.id), req.usuario, motivo);
  res.json({ ok: true });
});

pedidosQrRouter.post('/mesas/:id/regenerar', permitir(...R.gestion), async (req, res) => {
  res.json(await regenerarQr(idNum(req.params.id)));
});
