import { z } from 'zod';
import { type Db, pool, query } from '../db/pool.js';
import type { UsuarioToken } from '../middlewares/auth.js';
import { HttpError, notFound } from '../utils/http.js';
import { MONEDAS, type Moneda, aUSD, convertir, montoEnTodas, precioEn, redondearMoneda, tolerancia } from '../utils/moneda.js';
import { leerAjustes, tasaVigente } from './sistema.js';

// ====================================================================== Esquemas
export const itemSchema = z.object({
  variante_id: z.number().int(),
  cantidad: z.number().positive().max(200),
  asiento: z.number().int().min(1).max(60).nullish(),
  notas: z.string().trim().max(200).nullish(),
  /** ids de receta_items que el cliente NO quiere (sin cebolla, sin salsa…) */
  sin: z.array(z.number().int()).default([]),
  /** Adicionales con precio (extra queso ×2) */
  adicionales: z.array(z.object({ id: z.number().int(), cantidad: z.number().int().min(1).max(20).default(1) })).default([]),
  /** Surtido: qué insumos componen el tobo (deben sumar la cantidad exigida por la variante) */
  seleccion: z.array(z.object({ insumo_id: z.number().int(), cantidad: z.number().int().min(1) })).default([]),
});
export type ItemInput = z.infer<typeof itemSchema>;

export const pagoSchema = z.object({
  metodo_pago_id: z.number().int(),
  moneda: z.enum(MONEDAS),
  monto: z.number().positive(),
  referencia: z.string().trim().max(80).nullish(),
});

// ====================================================================== Lectura
export async function detalleCuenta(id: number, db: Db = pool) {
  const [cuenta] = await query(
    `SELECT c.*, m.numero AS mesa_numero, m.nombre AS mesa_nombre, m.capacidad AS mesa_capacidad, m.tipo AS mesa_tipo,
            z.nombre AS zona, u.nombre AS mesonero, cl.nombre AS cliente
       FROM cuentas c
       LEFT JOIN mesas m ON m.id = c.mesa_id
       LEFT JOIN zonas z ON z.id = m.zona_id
       LEFT JOIN usuarios u ON u.id = c.mesonero_id
       LEFT JOIN clientes cl ON cl.id = c.cliente_id
      WHERE c.id = $1`,
    [id], db,
  );
  if (!cuenta) throw notFound('Cuenta');

  const items = await query(
    `SELECT i.*, u.nombre AS usuario,
            COALESCE((SELECT json_agg(json_build_object('tipo', m.tipo, 'nombre', m.nombre, 'cantidad', m.cantidad, 'precio_extra', m.precio_extra)
                                      ORDER BY m.tipo, m.id)
                        FROM cuenta_item_modificadores m WHERE m.item_id = i.id), '[]'::json) AS modificadores
       FROM cuenta_items i LEFT JOIN usuarios u ON u.id = i.usuario_id
      WHERE i.cuenta_id = $1 ORDER BY i.id`,
    [id], db,
  );
  const pagos = await query(
    `SELECT p.*, mp.nombre AS metodo, u.nombre AS usuario
       FROM pagos p JOIN metodos_pago mp ON mp.id = p.metodo_pago_id LEFT JOIN usuarios u ON u.id = p.usuario_id
      WHERE p.cuenta_id = $1 AND NOT p.anulado ORDER BY p.id`,
    [id], db,
  );

  const tasa = await tasaVigente(db);
  const saldo = redondearMoneda(Math.max(0, cuenta.total - cuenta.pagado), cuenta.moneda);
  return {
    ...cuenta,
    saldo,
    equivalentes: { total: montoEnTodas(cuenta.total, cuenta.moneda, tasa), saldo: montoEnTodas(saldo, cuenta.moneda, tasa) },
    items,
    pagos,
  };
}

// ====================================================================== Totales
export async function recalcular(db: Db, cuentaId: number) {
  const [c] = await query(`SELECT moneda, servicio_pct, descuento FROM cuentas WHERE id = $1`, [cuentaId], db);
  const [{ subtotal }] = await query<{ subtotal: number }>(
    `SELECT COALESCE(SUM(subtotal), 0) AS subtotal FROM cuenta_items WHERE cuenta_id = $1 AND estado <> 'anulado'`,
    [cuentaId], db,
  );
  const [{ pagado }] = await query<{ pagado: number }>(
    `SELECT COALESCE(SUM(monto_cuenta), 0) AS pagado FROM pagos WHERE cuenta_id = $1 AND NOT anulado`,
    [cuentaId], db,
  );
  const base = Math.max(0, subtotal - Number(c.descuento));
  const servicio = redondearMoneda((base * Number(c.servicio_pct)) / 100, c.moneda);
  const total = redondearMoneda(base + servicio, c.moneda);
  const tasa = await tasaVigente(db);
  await query(
    `UPDATE cuentas SET subtotal=$2, servicio=$3, total=$4, pagado=$5, total_usd=$6, tasa_id=$7 WHERE id=$1`,
    [cuentaId, subtotal, servicio, total, pagado, aUSD(total, c.moneda, tasa), tasa.id], db,
  );
}

async function cuentaAbierta(db: Db, id: number) {
  const [c] = await query(`SELECT * FROM cuentas WHERE id = $1 FOR UPDATE`, [id], db);
  if (!c) throw notFound('Cuenta');
  if (c.estado !== 'abierta') throw new HttpError(409, `La cuenta ${c.numero} ya está ${c.estado}`);
  return c;
}

// ====================================================================== Agregar pedido
/**
 * Agrega una ronda de ítems a la cuenta:
 *  - calcula el precio en la moneda de la cuenta (con precios fijos y tasa vigente),
 *  - aplica "sin" (ingredientes retirados), adicionales (con su precio) y surtidos (tobos),
 *  - descuenta del inventario según la receta y deja el movimiento en el kardex.
 */
export async function agregarItems(db: Db, cuentaId: number, items: ItemInput[], usuario: UsuarioToken, directo = false) {
  const cuenta = await cuentaAbierta(db, cuentaId);
  const moneda = cuenta.moneda as Moneda;
  const [tasa, ajustes] = [await tasaVigente(db), await leerAjustes(db)];
  const [{ ronda }] = await query<{ ronda: number }>(`SELECT COALESCE(MAX(ronda), 0) + 1 AS ronda FROM cuenta_items WHERE cuenta_id = $1`, [cuentaId], db);

  for (const it of items) {
    const [v] = await query(
      `SELECT v.*, p.id AS producto_id, p.nombre, p.moneda_base, p.disponible, p.categoria_id, c.estacion
         FROM precios_producto v JOIN productos p ON p.id = v.producto_id JOIN categorias_menu c ON c.id = p.categoria_id
        WHERE v.id = $1 AND v.activo`,
      [it.variante_id], db,
    );
    if (!v) throw new HttpError(400, 'Producto no encontrado o retirado del menú');
    if (!v.disponible) throw new HttpError(409, `"${v.nombre}" está marcado como agotado`);

    const precioBase = precioEn(v, moneda, tasa);
    let extras = 0;
    const mods: { tipo: string; nombre: string; insumo_id: number | null; adicional_id: number | null; cantidad: number; precio_extra: number }[] = [];
    /** insumo_id → cantidad a descontar por UNA unidad del ítem */
    const consumo = new Map<number, number>();
    const sumar = (insumoId: number, cant: number) => consumo.set(insumoId, (consumo.get(insumoId) ?? 0) + cant);

    // --- Receta e ingredientes retirados
    const receta = await query(
      `SELECT r.*, i.nombre AS insumo FROM receta_items r JOIN insumos i ON i.id = r.insumo_id WHERE r.precio_producto_id = $1`,
      [v.id], db,
    );
    for (const r of receta) {
      if (it.sin.includes(r.id)) {
        if (!r.removible) throw new HttpError(400, `"${r.etiqueta ?? r.insumo}" no se puede retirar de ${v.nombre}`);
        mods.push({ tipo: 'sin', nombre: r.etiqueta ?? r.insumo, insumo_id: r.insumo_id, adicional_id: null, cantidad: 1, precio_extra: 0 });
      } else sumar(r.insumo_id, Number(r.cantidad));
    }

    // --- Adicionales (tienen precio propio)
    for (const ad of it.adicionales) {
      const [a] = await query(
        `SELECT a.* FROM adicionales a JOIN adicional_categorias ac ON ac.adicional_id = a.id
          WHERE a.id = $1 AND a.activo AND ac.categoria_id = $2`,
        [ad.id, v.categoria_id], db,
      );
      if (!a) throw new HttpError(400, `Ese adicional no aplica para ${v.nombre}`);
      const precio = redondearMoneda(precioEn(a, moneda, tasa) * ad.cantidad, moneda);
      extras += precio;
      mods.push({ tipo: 'adicional', nombre: a.nombre, insumo_id: a.insumo_id, adicional_id: a.id, cantidad: ad.cantidad, precio_extra: precio });
      if (a.insumo_id) sumar(a.insumo_id, Number(a.cantidad_insumo) * ad.cantidad);
    }

    // --- Surtido (tobo de cervezas): se elige entre los insumos de la categoría, con stock real
    if (v.seleccion_cantidad) {
      const elegidas = it.seleccion.reduce((s, x) => s + x.cantidad, 0);
      if (elegidas !== v.seleccion_cantidad)
        throw new HttpError(400, `${v.nombre} lleva ${v.seleccion_cantidad} unidades: elegiste ${elegidas}`);
      for (const s of it.seleccion) {
        const [ins] = await query(
          `SELECT id, nombre, recargo_seleccion FROM insumos WHERE id = $1 AND activo AND categoria_insumo_id = $2`,
          [s.insumo_id, v.seleccion_categoria_insumo_id], db,
        );
        if (!ins) throw new HttpError(400, 'Una de las opciones elegidas no está disponible en inventario');
        const recargo = redondearMoneda(convertir(Number(ins.recargo_seleccion) * s.cantidad, v.moneda_base, moneda, tasa), moneda);
        extras += recargo;
        mods.push({ tipo: 'seleccion', nombre: ins.nombre, insumo_id: ins.id, adicional_id: null, cantidad: s.cantidad, precio_extra: recargo });
        sumar(ins.id, s.cantidad);
      }
    } else if (it.seleccion.length) throw new HttpError(400, `${v.nombre} no admite surtido`);

    const subtotal = redondearMoneda((precioBase + extras) * it.cantidad, moneda);
    const [item] = await query<{ id: number }>(
      `INSERT INTO cuenta_items (cuenta_id, producto_id, precio_producto_id, nombre, presentacion, estacion, cantidad, precio_base, extras,
                                 subtotal, precio_unitario_usd, asiento, notas, estado, ronda, usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [cuentaId, v.producto_id, v.id, v.nombre, v.presentacion, v.estacion, it.cantidad, precioBase, extras, subtotal,
       aUSD(precioBase + extras, moneda, tasa), it.asiento ?? null, it.notas || null, directo ? 'entregado' : 'pendiente', ronda, usuario.id],
      db,
    );
    for (const m of mods)
      await query(
        `INSERT INTO cuenta_item_modificadores (item_id, tipo, nombre, insumo_id, adicional_id, cantidad, precio_extra) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [item.id, m.tipo, m.nombre, m.insumo_id, m.adicional_id, m.cantidad, m.precio_extra], db,
      );

    // --- Inventario
    for (const [insumoId, porUnidad] of consumo) {
      const cant = porUnidad * it.cantidad;
      const [ins] = await query<{ stock: number; nombre: string; unidad: string }>(
        `UPDATE insumos SET stock = stock - $2 WHERE id = $1 RETURNING stock, nombre, unidad`,
        [insumoId, cant], db,
      );
      if (ins.stock < 0 && !ajustes.permitir_venta_sin_stock)
        throw new HttpError(409, `Stock insuficiente de ${ins.nombre}: faltan ${Math.abs(ins.stock)} ${ins.unidad} para ${v.nombre}`);
      await query(
        `INSERT INTO movimientos_inventario (insumo_id, tipo, cantidad, stock_resultante, cuenta_item_id, nota, usuario_id)
         VALUES ($1,'venta',$2,$3,$4,$5,$6)`,
        [insumoId, -cant, ins.stock, item.id, `${cuenta.numero} · ${v.nombre}`, usuario.id], db,
      );
    }
  }
  await recalcular(db, cuentaId);
}

/** Devuelve al inventario lo que consumió un ítem */
async function devolverStock(db: Db, itemId: number, usuarioId: number, nota: string) {
  const movs = await query(
    `SELECT insumo_id, SUM(cantidad) AS cantidad FROM movimientos_inventario
      WHERE cuenta_item_id = $1 AND tipo IN ('venta','anulacion') GROUP BY insumo_id HAVING SUM(cantidad) < 0`,
    [itemId], db,
  );
  for (const m of movs) {
    const [ins] = await query<{ stock: number }>(`UPDATE insumos SET stock = stock + $2 WHERE id = $1 RETURNING stock`, [m.insumo_id, -m.cantidad], db);
    await query(
      `INSERT INTO movimientos_inventario (insumo_id, tipo, cantidad, stock_resultante, cuenta_item_id, nota, usuario_id)
       VALUES ($1,'anulacion',$2,$3,$4,$5,$6)`,
      [m.insumo_id, -m.cantidad, ins.stock, itemId, nota, usuarioId], db,
    );
  }
}

export async function anularItem(db: Db, cuentaId: number, itemId: number, motivo: string, usuario: UsuarioToken) {
  const cuenta = await cuentaAbierta(db, cuentaId);
  const [item] = await query(`SELECT * FROM cuenta_items WHERE id = $1 AND cuenta_id = $2 FOR UPDATE`, [itemId, cuentaId], db);
  if (!item) throw notFound('Ítem');
  if (item.estado === 'anulado') throw new HttpError(409, 'El ítem ya estaba anulado');
  // Un mesonero solo puede corregir lo que aún no salió de cocina/barra
  if (usuario.rol === 'mesonero' && item.estado !== 'pendiente')
    throw new HttpError(403, 'Ese pedido ya está en preparación: pide a caja o gerencia que lo anule');
  await query(`UPDATE cuenta_items SET estado = 'anulado', anulado_motivo = $2 WHERE id = $1`, [itemId, motivo], db);
  await devolverStock(db, itemId, usuario.id, `Anulación ${cuenta.numero}: ${motivo}`);
  await recalcular(db, cuentaId);
}

export async function anularCuenta(db: Db, cuentaId: number, motivo: string, usuario: UsuarioToken) {
  const cuenta = await cuentaAbierta(db, cuentaId);
  if (Number(cuenta.pagado) > 0) throw new HttpError(409, 'La cuenta ya tiene pagos registrados: no se puede anular');
  const items = await query<{ id: number }>(`SELECT id FROM cuenta_items WHERE cuenta_id = $1 AND estado <> 'anulado'`, [cuentaId], db);
  for (const i of items) await devolverStock(db, i.id, usuario.id, `Cuenta ${cuenta.numero} anulada`);
  await query(`UPDATE cuenta_items SET estado = 'anulado', anulado_motivo = $2 WHERE cuenta_id = $1 AND estado <> 'anulado'`, [cuentaId, motivo], db);
  await query(
    `UPDATE cuentas SET estado = 'anulada', anulada_motivo = $2, cerrada_en = now(), usuario_cierre_id = $3 WHERE id = $1`,
    [cuentaId, motivo, usuario.id], db,
  );
  await recalcular(db, cuentaId);
}

// ====================================================================== Cobro
/**
 * Registra uno o varios pagos (cualquier moneda y método). Se puede abonar parte de la cuenta
 * —en la barra los clientes "van cancelando"— o cobrar el total. Si sobra, calcula el vuelto.
 */
export async function pagar(
  db: Db,
  cuentaId: number,
  datos: { pagos: z.infer<typeof pagoSchema>[]; sesion_caja_id: number; asiento?: number | null; vuelto_moneda?: Moneda | null; cerrar: boolean },
  usuario: UsuarioToken,
) {
  const cuenta = await cuentaAbierta(db, cuentaId);
  const moneda = cuenta.moneda as Moneda;
  const tasa = await tasaVigente(db);

  const [sesion] = await query(`SELECT id FROM sesiones_caja WHERE id = $1 AND estado = 'abierta'`, [datos.sesion_caja_id], db);
  if (!sesion) throw new HttpError(409, 'No hay una caja abierta. Abre la caja antes de cobrar.');

  await recalcular(db, cuentaId);
  const [{ total, pagado }] = await query<{ total: number; pagado: number }>(`SELECT total, pagado FROM cuentas WHERE id = $1`, [cuentaId], db);
  let restante = redondearMoneda(total - pagado, moneda);
  if (restante <= tolerancia(moneda) && total > 0) throw new HttpError(409, 'Esta cuenta ya está pagada');

  let vuelto: { monto: number; moneda: Moneda } | null = null;

  for (const p of datos.pagos) {
    const [metodo] = await query(`SELECT * FROM metodos_pago WHERE id = $1 AND activo`, [p.metodo_pago_id], db);
    if (!metodo) throw new HttpError(400, 'Método de pago inválido');
    if (!metodo.monedas.includes(p.moneda)) throw new HttpError(400, `${metodo.nombre} no recibe ${p.moneda}`);
    if (metodo.requiere_referencia && !p.referencia) throw new HttpError(400, `${metodo.nombre} necesita el número de referencia`);
    if (restante <= tolerancia(moneda)) throw new HttpError(400, 'Los pagos superan el saldo: quita el pago sobrante');

    const recibidoEnCuenta = redondearMoneda(convertir(p.monto, p.moneda, moneda, tasa), moneda);
    let aplicadoCuenta = recibidoEnCuenta;
    let aplicadoPago = p.monto;
    let vueltoMonto: number | null = null;
    let vueltoMoneda: Moneda | null = null;

    if (recibidoEnCuenta > restante + tolerancia(moneda)) {
      // Esta línea cubre lo que falta y sobra vuelto
      aplicadoCuenta = restante;
      aplicadoPago = p.moneda === moneda ? restante : redondearMoneda(convertir(restante, moneda, p.moneda, tasa), p.moneda);
      vueltoMoneda = datos.vuelto_moneda ?? p.moneda;
      vueltoMonto = redondearMoneda(convertir(recibidoEnCuenta - restante, moneda, vueltoMoneda, tasa), vueltoMoneda);
      if (!metodo.es_efectivo) throw new HttpError(400, `El monto por ${metodo.nombre} supera el saldo. Solo el efectivo da vuelto.`);
      vuelto = { monto: vueltoMonto, moneda: vueltoMoneda };
    } else if (Math.abs(recibidoEnCuenta - restante) <= tolerancia(moneda)) {
      aplicadoCuenta = restante; // absorbe diferencias de redondeo entre monedas
    }

    await query(
      `INSERT INTO pagos (cuenta_id, sesion_caja_id, metodo_pago_id, moneda, monto, monto_recibido, monto_cuenta, monto_usd,
                          vuelto_monto, vuelto_moneda, referencia, asiento, tasa_id, usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [cuentaId, sesion.id, metodo.id, p.moneda, aplicadoPago, p.monto, aplicadoCuenta, aUSD(aplicadoCuenta, moneda, tasa),
       vueltoMonto, vueltoMoneda, p.referencia || null, datos.asiento ?? null, tasa.id, usuario.id],
      db,
    );
    restante = redondearMoneda(restante - aplicadoCuenta, moneda);
  }

  await recalcular(db, cuentaId);
  const saldado = restante <= tolerancia(moneda);
  if (datos.cerrar) {
    if (!saldado) throw new HttpError(409, `Aún faltan ${restante} ${moneda} para cerrar la cuenta`);
    await cerrar(db, cuentaId, usuario);
  }
  return { saldado, restante: Math.max(0, restante), vuelto };
}

export async function cerrar(db: Db, cuentaId: number, usuario: UsuarioToken) {
  const cuenta = await cuentaAbierta(db, cuentaId);
  await recalcular(db, cuentaId);
  const [{ total, pagado }] = await query<{ total: number; pagado: number }>(`SELECT total, pagado FROM cuentas WHERE id = $1`, [cuentaId], db);
  if (total - pagado > tolerancia(cuenta.moneda)) throw new HttpError(409, 'La cuenta todavía tiene saldo pendiente');
  await query(`UPDATE cuentas SET estado = 'pagada', cerrada_en = now(), usuario_cierre_id = $2 WHERE id = $1`, [cuentaId, usuario.id], db);
  // Lo que quedó sin despachar se da por entregado al cerrar
  await query(`UPDATE cuenta_items SET estado = 'entregado' WHERE cuenta_id = $1 AND estado IN ('pendiente','preparando','listo')`, [cuentaId], db);
}
