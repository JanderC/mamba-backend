import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { type Db, pool, query, tx } from '../db/pool.js';
import type { UsuarioToken } from '../middlewares/auth.js';
import { abrirCuentaEn, armarCatalogo } from '../modules/admin/ventas.routes.js';
import { HttpError, notFound } from '../utils/http.js';
import { type Moneda, type Tasa, convertir, precioEn, redondearMoneda } from '../utils/moneda.js';
import { agregarItems, detalleCuenta, itemSchema } from './cuentas.js';
import { leerAjustes, tasaVigente } from './sistema.js';
import { emitir, lugarDe } from './vivo.js';

/**
 * Pedidos desde el QR de la mesa.
 *   cliente escanea → /pedir/<token> → arma su pedido → POST /api/qr/<token>/pedidos
 *   → llega en vivo a la barra → «Aceptar» lo pasa a la cuenta de la mesa (y a comandas) · «Rechazar» avisa al cliente
 * El cliente nunca toca cuentas ni inventario: solo deja una solicitud que el personal confirma.
 */

// ---------------------------------------------------------------------- Tablas (se crean solas al arrancar)
let listas: Promise<void> | null = null;
export function asegurarTablasQr() {
  listas ??= (async () => {
    const archivo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', '06_pedidos_qr.sql');
    await pool.query(await readFile(archivo, 'utf8'));
  })().catch((e) => {
    listas = null;
    throw e;
  });
  return listas;
}

// ---------------------------------------------------------------------- Mesa por su código
type MesaQr = { id: number; numero: number; nombre: string | null; tipo: string; zona: string | null; activo: boolean };

async function mesaPorToken(token: string, db: Db = pool): Promise<MesaQr> {
  if (!/^[a-z0-9]{6,40}$/i.test(token)) throw notFound('Mesa');
  const [m] = await query<MesaQr>(
    `SELECT m.id, m.numero, m.nombre, m.tipo, m.activo, z.nombre AS zona FROM mesas m LEFT JOIN zonas z ON z.id = m.zona_id WHERE m.qr_token = $1`,
    [token], db,
  );
  if (!m || !m.activo) throw new HttpError(404, 'Este código QR ya no está activo. Pide ayuda a tu mesero.');
  return m;
}

const lugarMesa = (m: Pick<MesaQr, 'numero' | 'tipo'>) => lugarDe({ tipo: m.tipo === 'barra' ? 'barra' : 'mesa', mesa_numero: m.numero, mesa_tipo: m.tipo });

/** Carta para el cliente: la misma del POS, sin cifras exactas de inventario */
export async function cartaQr(token: string) {
  const [mesa, ajustes, catalogo, local] = await Promise.all([
    mesaPorToken(token), leerAjustes(), armarCatalogo(),
    query<{ nombre: string }>(`SELECT nombre FROM configuracion_local LIMIT 1`).then((r) => r[0]),
  ]);
  const tope = (n: number | null) => (n == null ? null : Math.min(n, 50));
  return {
    local: { nombre: local?.nombre ?? 'Mamba Bistro Bar 2.0' },
    mesa: { numero: mesa.numero, nombre: mesa.nombre, zona: mesa.zona, lugar: lugarMesa(mesa) },
    moneda: ajustes.moneda_principal,
    pedidos_activos: ajustes.pedidos_qr_activo,
    categorias: catalogo.categorias.map((c) => ({
      ...c,
      productos: c.productos.map((p: any) => ({
        ...p,
        variantes: p.variantes.map((v: any) => ({
          ...v,
          disponibles: tope(v.disponibles),
          seleccion: v.seleccion && { ...v.seleccion, opciones: v.seleccion.opciones.map((o: any) => ({ ...o, stock: tope(o.stock) ?? 0 })) },
        })),
      })),
    })),
  };
}

// ---------------------------------------------------------------------- Cotizar sin tocar nada
export type LineaResumen = { nombre: string; presentacion: string | null; cantidad: number; detalle: string[]; notas: string | null; estacion: string; unitario: number; subtotal: number };

/** Valida el pedido con las mismas reglas del POS y calcula su precio, sin escribir en la base */
async function cotizar(db: Db, items: z.infer<typeof itemSchema>[], moneda: Moneda, tasa: Tasa) {
  const lineas: LineaResumen[] = [];
  for (const it of items) {
    const [v] = await query(
      `SELECT v.*, p.nombre, p.moneda_base, p.disponible, p.visible_pos, p.categoria_id, c.estacion, c.activo AS cat_activa
         FROM precios_producto v JOIN productos p ON p.id = v.producto_id JOIN categorias_menu c ON c.id = p.categoria_id
        WHERE v.id = $1 AND v.activo`,
      [it.variante_id], db,
    );
    if (!v || !v.visible_pos || !v.cat_activa) throw new HttpError(400, 'Uno de los productos ya no está en la carta. Actualiza la página.');
    if (!v.disponible) throw new HttpError(409, `"${v.nombre}" se agotó por ahora`);

    let extras = 0;
    const detalle: string[] = [];
    if (it.sin.length) {
      const quitables = await query(
        `SELECT r.id, COALESCE(r.etiqueta, i.nombre) AS etiqueta FROM receta_items r JOIN insumos i ON i.id = r.insumo_id
          WHERE r.precio_producto_id = $1 AND r.removible AND r.id = ANY($2::int[])`,
        [v.id, it.sin], db,
      );
      if (quitables.length !== new Set(it.sin).size) throw new HttpError(400, `Revisa los ingredientes de ${v.nombre}`);
      for (const r of quitables) detalle.push(`SIN ${r.etiqueta}`);
    }
    for (const ad of it.adicionales) {
      const [a] = await query(
        `SELECT a.* FROM adicionales a JOIN adicional_categorias ac ON ac.adicional_id = a.id WHERE a.id = $1 AND a.activo AND ac.categoria_id = $2`,
        [ad.id, v.categoria_id], db,
      );
      if (!a) throw new HttpError(400, `Ese adicional no aplica para ${v.nombre}`);
      extras += redondearMoneda(precioEn(a, moneda, tasa) * ad.cantidad, moneda);
      detalle.push(`+ ${ad.cantidad > 1 ? `${ad.cantidad}× ` : ''}${a.nombre}`);
    }
    if (v.seleccion_cantidad) {
      const elegidas = it.seleccion.reduce((s, x) => s + x.cantidad, 0);
      if (elegidas !== v.seleccion_cantidad) throw new HttpError(400, `${v.nombre} lleva ${v.seleccion_cantidad} unidades: elegiste ${elegidas}`);
      for (const s of it.seleccion) {
        const [ins] = await query(
          `SELECT nombre, recargo_seleccion FROM insumos WHERE id = $1 AND activo AND categoria_insumo_id = $2`,
          [s.insumo_id, v.seleccion_categoria_insumo_id], db,
        );
        if (!ins) throw new HttpError(400, `Una de las opciones de ${v.nombre} ya no está disponible`);
        extras += redondearMoneda(convertir(Number(ins.recargo_seleccion) * s.cantidad, v.moneda_base, moneda, tasa), moneda);
        detalle.push(`${s.cantidad} × ${ins.nombre}`);
      }
    } else if (it.seleccion.length) throw new HttpError(400, `${v.nombre} no admite surtido`);

    const unitario = precioEn(v, moneda, tasa) + extras;
    lineas.push({
      nombre: v.nombre, presentacion: v.presentacion, cantidad: it.cantidad, detalle, notas: it.notas || null, estacion: v.estacion,
      unitario, subtotal: redondearMoneda(unitario * it.cantidad, moneda),
    });
  }
  return { lineas, total: redondearMoneda(lineas.reduce((s, l) => s + l.subtotal, 0), moneda) };
}

// ---------------------------------------------------------------------- El cliente pide
export const pedidoQrSchema = z.object({
  nombre_cliente: z.string().trim().max(60).nullish(),
  nota: z.string().trim().max(200).nullish(),
  // Desde el QR no se eligen puestos: la cuenta se divide luego en caja si hace falta
  items: z.array(itemSchema.omit({ asiento: true })).min(1, 'Agrega al menos un producto').max(30, 'Máximo 30 productos por pedido'),
});

const ultimoPorIp = new Map<string, number>();

export async function crearPedidoQr(token: string, datos: z.infer<typeof pedidoQrSchema>, ip: string) {
  const mesa = await mesaPorToken(token);
  const ajustes = await leerAjustes();
  if (!ajustes.pedidos_qr_activo) throw new HttpError(403, 'En este momento los pedidos se toman con tu mesero. ¡Llámalo y con gusto te atiende!');

  // Freno a pedidos en ráfaga (doble toque, bromas): uno cada 15 s por teléfono y máx. 4 sin atender por mesa
  const ahora = Date.now();
  if (ahora - (ultimoPorIp.get(ip) ?? 0) < 15_000) throw new HttpError(429, 'Ya recibimos tu pedido. Espera unos segundos antes de enviar otro.');
  const [{ n }] = await query<{ n: number }>(`SELECT count(*)::int AS n FROM pedidos_qr WHERE mesa_id = $1 AND estado = 'pendiente'`, [mesa.id]);
  if (n >= 4) throw new HttpError(429, 'Tu mesa ya tiene pedidos esperando confirmación. En un momento te atienden.');

  const items = datos.items.map((i) => ({ ...i, asiento: null }));
  const moneda = ajustes.moneda_principal;
  const { lineas, total } = await cotizar(pool, items, moneda, await tasaVigente());

  const [p] = await query<{ id: number; creado_en: string }>(
    `INSERT INTO pedidos_qr (mesa_id, nombre_cliente, nota, items, resumen, moneda, total_estimado, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, creado_en`,
    [mesa.id, datos.nombre_cliente || null, datos.nota || null, JSON.stringify(items), JSON.stringify(lineas), moneda, total, ip],
  );
  ultimoPorIp.set(ip, ahora);
  if (ultimoPorIp.size > 5000) ultimoPorIp.clear();

  emitir({ tipo: 'pedido_qr', accion: 'nuevo', id: p.id, mesa_id: mesa.id, lugar: lugarMesa(mesa), cliente: datos.nombre_cliente || null,
    items: lineas.reduce((s, l) => s + l.cantidad, 0), total, moneda });
  return { id: p.id, estado: 'pendiente', creado_en: p.creado_en, resumen: lineas, total, moneda };
}

/** Lo que el cliente ve de sus pedidos (solo los de su mesa) */
export async function estadoPedidosQr(token: string, ids: number[]) {
  const mesa = await mesaPorToken(token);
  if (!ids.length) return [];
  // Cada producto con su estado en cocina/barra (si ya fue aceptado): confirmado → preparando → listo → entregado
  return query(
    `SELECT p.id, p.estado, p.motivo, p.resumen, p.total_estimado AS total, p.moneda, p.creado_en, p.atendido_en,
            COALESCE((SELECT json_agg(json_build_object('nombre', i.nombre, 'presentacion', i.presentacion, 'cantidad', i.cantidad,
                                                        'estado', CASE WHEN i.en_barra_desde IS NOT NULL THEN 'pendiente' ELSE i.estado END,
                                                        'estacion', i.estacion) ORDER BY i.id)
                        FROM cuenta_items i
                       WHERE p.estado = 'aceptado' AND i.cuenta_id = p.cuenta_id AND i.ronda = p.ronda AND i.estado <> 'anulado'), '[]'::json) AS items
       FROM pedidos_qr p WHERE p.mesa_id = $1 AND p.id = ANY($2::bigint[]) ORDER BY p.id DESC`,
    [mesa.id, ids.slice(0, 20)],
  );
}

// ---------------------------------------------------------------------- La barra atiende
export async function bandejaQr() {
  return query(
    `SELECT p.id, p.mesa_id, p.cuenta_id, p.nombre_cliente, p.nota, p.resumen, p.moneda, p.total_estimado AS total, p.estado, p.motivo,
            p.creado_en, p.atendido_en, u.nombre AS atendido_por, m.numero AS mesa_numero, m.nombre AS mesa_nombre, m.tipo AS mesa_tipo, z.nombre AS zona,
            COALESCE((SELECT json_agg(json_build_object('id', c.id, 'numero', c.numero, 'nombre_cliente', c.nombre_cliente, 'mesonero', mu.nombre) ORDER BY c.abierta_en)
                        FROM cuentas c LEFT JOIN usuarios mu ON mu.id = c.mesonero_id
                       WHERE c.mesa_id = p.mesa_id AND c.estado = 'abierta'), '[]'::json) AS cuentas_abiertas
       FROM pedidos_qr p
       JOIN mesas m ON m.id = p.mesa_id
       LEFT JOIN zonas z ON z.id = m.zona_id
       LEFT JOIN usuarios u ON u.id = p.atendido_por
      WHERE p.estado = 'pendiente' OR p.atendido_en > now() - interval '45 minutes'
      ORDER BY (p.estado = 'pendiente') DESC, p.creado_en`,
  );
}

async function pedidoPendiente(db: Db, id: number) {
  const [p] = await query(`SELECT * FROM pedidos_qr WHERE id = $1 FOR UPDATE`, [id], db);
  if (!p) throw notFound('Pedido');
  if (p.estado !== 'pendiente') throw new HttpError(409, `Ese pedido ya fue ${p.estado}`);
  return p;
}

/**
 * Pasa el pedido a una cuenta: la indicada, la única abierta de la mesa, o una nueva a nombre del cliente.
 * Desde ahí sigue el camino normal: descuenta inventario y sale a comandas de cocina/barra.
 */
export async function aceptarPedidoQr(id: number, usuario: UsuarioToken, cuentaElegida: number | null) {
  const { cuentaId, pedido, mesa } = await tx(async (db) => {
    const pedido = await pedidoPendiente(db, id);
    const [mesa] = await query(`SELECT id, numero, tipo FROM mesas WHERE id = $1`, [pedido.mesa_id], db);
    let cuentaId: number | null = cuentaElegida;
    if (cuentaId) {
      const [c] = await query(`SELECT estado FROM cuentas WHERE id = $1`, [cuentaId], db);
      if (!c || c.estado !== 'abierta') throw new HttpError(409, 'Esa cuenta ya no está abierta');
    } else {
      const abiertas = await query<{ id: number }>(`SELECT id FROM cuentas WHERE mesa_id = $1 AND estado = 'abierta' ORDER BY abierta_en`, [pedido.mesa_id], db);
      if (abiertas.length > 1) throw new HttpError(409, 'La mesa tiene varias cuentas abiertas: elige a cuál va el pedido');
      cuentaId = abiertas[0]?.id ?? await abrirCuentaEn(db, {
        tipo: mesa.tipo === 'barra' ? 'barra' : 'mesa', mesa_id: mesa.id, personas: 1, nombre_cliente: pedido.nombre_cliente,
      }, usuario.id);
    }
    const items = (pedido.items as z.infer<typeof itemSchema>[]).map((i) => ({ ...i, notas: [i.notas, pedido.nota].filter(Boolean).join(' · ') || null }));
    await agregarItems(db, cuentaId!, items, usuario, false);
    // La ronda con la que entró a la cuenta: el cliente sigue esos productos desde su teléfono
    const [{ ronda }] = await query<{ ronda: number }>(`SELECT MAX(ronda) AS ronda FROM cuenta_items WHERE cuenta_id = $1`, [cuentaId], db);
    await query(`UPDATE pedidos_qr SET estado = 'aceptado', cuenta_id = $2, atendido_en = now(), atendido_por = $3, ronda = $4 WHERE id = $1`, [id, cuentaId, usuario.id, ronda], db);
    return { cuentaId: cuentaId!, pedido, mesa };
  });

  const cuenta = await detalleCuenta(cuentaId);
  const ronda = Math.max(...cuenta.items.map((i: { ronda: number }) => i.ronda));
  const nuevos = cuenta.items.filter((i: { ronda: number }) => i.ronda === ronda);
  // Mismo aviso que un pedido del mesonero: suena en comandas de cocina y barra
  emitir({ tipo: 'pedido', cuenta_id: cuentaId, numero: cuenta.numero, lugar: lugarDe(cuenta), cliente: cuenta.nombre_cliente, mesonero: `QR · ${usuario.nombre}`,
    estaciones: [...new Set(nuevos.map((i: { estacion: string }) => i.estacion))] as string[], items: nuevos.length, directo: false });
  emitir({ tipo: 'pedido_qr', accion: 'aceptado', id, mesa_id: mesa.id, lugar: lugarMesa(mesa), cliente: pedido.nombre_cliente, items: nuevos.length,
    total: Number(pedido.total_estimado), moneda: pedido.moneda, cuenta_id: cuentaId });
  emitir({ tipo: 'cuenta', accion: 'pedido_qr', cuenta_id: cuentaId, mesonero_id: cuenta.mesonero_id });
  return { cuenta_id: cuentaId };
}

export async function rechazarPedidoQr(id: number, usuario: UsuarioToken, motivo: string) {
  const { pedido, mesa } = await tx(async (db) => {
    const pedido = await pedidoPendiente(db, id);
    await query(`UPDATE pedidos_qr SET estado = 'rechazado', motivo = $2, atendido_en = now(), atendido_por = $3 WHERE id = $1`, [id, motivo, usuario.id], db);
    const [mesa] = await query(`SELECT id, numero, tipo FROM mesas WHERE id = $1`, [pedido.mesa_id], db);
    return { pedido, mesa };
  });
  emitir({ tipo: 'pedido_qr', accion: 'rechazado', id, mesa_id: mesa.id, lugar: lugarMesa(mesa), cliente: pedido.nombre_cliente, items: 0,
    total: Number(pedido.total_estimado), moneda: pedido.moneda });
}

/** Cambia el código del QR de una mesa (si se filtró o se dañó el adhesivo): el QR viejo deja de funcionar */
export async function regenerarQr(mesaId: number) {
  const [m] = await query<{ qr_token: string }>(
    `UPDATE mesas SET qr_token = substr(md5(random()::text || clock_timestamp()::text || id::text), 1, 12) WHERE id = $1 RETURNING qr_token`,
    [mesaId],
  );
  if (!m) throw notFound('Mesa');
  return m;
}
