import type { Request, Response } from 'express';

/**
 * Tiempo real con Server-Sent Events: cada tablet, la barra, la cocina y la caja mantienen una
 * conexión abierta y el servidor les empuja lo que pasa (pedido nuevo, plato listo, cuenta por cobrar).
 *
 * Vive en la memoria del proceso: sirve mientras el backend corra en UNA instancia (Railway por defecto).
 * Si algún día se escala a varias, hay que cambiar el `emitir` por Postgres LISTEN/NOTIFY o Redis.
 */
export type EventoVivo =
  /** Un mesonero envió una ronda a preparación */
  | { tipo: 'pedido'; cuenta_id: number; numero: string; lugar: string; cliente: string | null; mesonero: string; estaciones: string[]; items: number; directo: boolean }
  /** Barra o cocina cambió el estado de uno o varios ítems */
  | { tipo: 'comanda'; estado: string; items: { id: number; nombre: string; cantidad: number; cuenta_id: number; lugar: string; cliente: string | null; mesonero_id: number | null; estacion: string }[] }
  /** Un mesonero pasó (o retiró) una cuenta a la cola de cobro */
  | { tipo: 'cobro'; accion: 'solicitado' | 'cancelado' | 'cobrado'; cuenta_id: number; numero: string; lugar: string; cliente: string | null; mesonero: string | null; mesonero_id: number | null }
  /** Cualquier otro cambio en una cuenta (abierta, pagada, anulada, ítem anulado…) */
  | { tipo: 'cuenta'; accion: string; cuenta_id: number; mesonero_id?: number | null };

const conexiones = new Set<Response>();

export function emitir(evento: EventoVivo) {
  const trama = `event: ${evento.tipo}\ndata: ${JSON.stringify(evento)}\n\n`;
  for (const res of conexiones) res.write(trama);
}

/** GET /api/admin/vivo — flujo de eventos (requiere sesión) */
export function conectarVivo(req: Request, res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // que ningún proxy acumule la respuesta
  });
  res.write(`event: conectado\ndata: {"ok":true}\n\n`);
  conexiones.add(res);
  req.on('close', () => conexiones.delete(res));
}

// Latido: mantiene viva la conexión a través de proxies y deja que el cliente detecte cortes
setInterval(() => {
  for (const res of conexiones) res.write(`: latido\n\n`);
}, 20_000).unref();

export const conectados = () => conexiones.size;

/** "Mesa 7", "Barra · puesto 4", "Para llevar" */
export function lugarDe(c: { tipo: string; mesa_numero?: number | null; mesa_tipo?: string | null; asiento?: number | null }) {
  if (c.mesa_tipo === 'barra' || (c.tipo === 'barra' && !c.mesa_numero)) return `Barra${c.asiento ? ` · puesto ${c.asiento}` : ''}`;
  if (c.tipo === 'llevar') return 'Para llevar';
  return `Mesa ${c.mesa_numero}`;
}
