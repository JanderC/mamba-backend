import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { R, permitir } from '../../middlewares/auth.js';
import { JORNADA_HOY, TZ, jornada, leerAjustes, tasaVigente } from '../../services/sistema.js';
import { desdeUSD, redondearMoneda } from '../../utils/moneda.js';
import { deudaTotal } from './creditos.routes.js';

export const reportesRouter = Router();

/** Tablero de inicio: lo que pasa esta noche */
reportesRouter.get('/tablero', async (req, res) => {
  const verDinero = ['admin', 'gerente', 'cajero'].includes(req.usuario.rol);
  const [ajustes, tasa] = await Promise.all([leerAjustes(), tasaVigente().catch(() => null)]);
  const J = jornada('p.fecha');

  const [[cobrado], [abiertas], porHora, top, [stock], [reservas], eventos, [comandas], cajas] = await Promise.all([
    query(`SELECT COALESCE(SUM(p.monto_usd),0) AS usd, count(DISTINCT p.cuenta_id) AS cuentas FROM pagos p WHERE NOT p.anulado AND ${J} = ${JORNADA_HOY}`),
    query(`SELECT count(*) AS n, COALESCE(SUM(personas),0) AS personas, COALESCE(SUM(total_usd),0) AS usd FROM cuentas WHERE estado = 'abierta'`),
    query(
      `SELECT to_char(date_trunc('hour', p.fecha AT TIME ZONE '${TZ}'), 'HH24:00') AS hora, SUM(p.monto_usd) AS usd
         FROM pagos p WHERE NOT p.anulado AND ${J} = ${JORNADA_HOY}
        GROUP BY date_trunc('hour', p.fecha AT TIME ZONE '${TZ}') ORDER BY date_trunc('hour', p.fecha AT TIME ZONE '${TZ}')`),
    query(
      `SELECT i.nombre, SUM(i.cantidad) AS cantidad
         FROM cuenta_items i WHERE i.estado <> 'anulado' AND ${jornada('i.creado_en')} = ${JORNADA_HOY}
        GROUP BY i.nombre ORDER BY SUM(i.cantidad) DESC LIMIT 6`),
    query(`SELECT count(*) AS n FROM insumos WHERE activo AND stock <= stock_minimo`),
    query(
      `SELECT count(*) FILTER (WHERE estado = 'pendiente') AS pendientes, count(*) FILTER (WHERE estado = 'confirmada') AS confirmadas,
              COALESCE(SUM(personas) FILTER (WHERE estado IN ('pendiente','confirmada')), 0) AS personas
         FROM reservas WHERE fecha = ${JORNADA_HOY}`),
    query(
      `SELECT e.id, e.titulo, e.inicia_en, (SELECT count(*) FROM suscripciones_evento s WHERE s.evento_id = e.id) AS suscritos
         FROM eventos e WHERE e.estado = 'publicado' AND e.inicia_en > now() - interval '8 hours' ORDER BY e.inicia_en LIMIT 3`),
    query(`SELECT count(*) FILTER (WHERE i.estacion = 'cocina') AS cocina, count(*) FILTER (WHERE i.estacion = 'barra') AS barra
             FROM cuenta_items i JOIN cuentas c ON c.id = i.cuenta_id WHERE c.estado = 'abierta' AND i.estado IN ('pendiente','preparando')`),
    query(`SELECT c.nombre, (SELECT u.nombre FROM sesiones_caja s JOIN usuarios u ON u.id = s.usuario_id
                              WHERE s.caja_id = c.id AND s.estado = 'abierta') AS abierta_por FROM cajas c WHERE c.activo ORDER BY c.id`),
  ]);

  const enPrincipal = (usd: number) => (tasa ? redondearMoneda(desdeUSD(Number(usd), ajustes.moneda_principal, tasa), ajustes.moneda_principal) : 0);
  res.json({
    moneda: ajustes.moneda_principal,
    tasa,
    ventas: verDinero
      ? { total: enPrincipal(cobrado.usd), usd: Number(cobrado.usd), cuentas: Number(cobrado.cuentas),
          ticket_promedio: Number(cobrado.cuentas) ? enPrincipal(cobrado.usd / cobrado.cuentas) : 0,
          por_cobrar: enPrincipal(abiertas.usd), por_hora: porHora.map((h) => ({ hora: h.hora, total: enPrincipal(h.usd) })) }
      : null,
    creditos: verDinero && tasa ? await deudaTotal() : null,
    cuentas_abiertas: Number(abiertas.n),
    personas_con_cuenta: Number(abiertas.personas),
    capacidad: ajustes.capacidad_maxima,
    top_productos: top,
    stock_bajo: Number(stock.n),
    reservas_hoy: reservas,
    proximos_eventos: eventos,
    comandas,
    cajas,
  });
});

const rango = z.object({ desde: z.iso.date(), hasta: z.iso.date() });

/** Reporte de ventas por rango de jornadas */
reportesRouter.get('/ventas', permitir(...R.gestion), async (req, res) => {
  const { desde, hasta } = rango.parse(req.query);
  const [ajustes, tasa] = await Promise.all([leerAjustes(), tasaVigente()]);
  const P = `NOT p.anulado AND ${jornada('p.fecha')} BETWEEN $1 AND $2`;
  const I = `i.estado <> 'anulado' AND c.estado IN ('pagada','fiada') AND ${jornada('c.cerrada_en')} BETWEEN $1 AND $2`;
  const params = [desde, hasta];

  const [porDia, porMetodo, porProducto, porCategoria, porMesonero, porZona, [resumen], [anulaciones]] = await Promise.all([
    query(`SELECT ${jornada('p.fecha')} AS dia, SUM(p.monto_usd) AS usd, count(DISTINCT p.cuenta_id) AS cuentas FROM pagos p WHERE ${P} GROUP BY 1 ORDER BY 1`, params),
    query(
      `SELECT m.nombre AS metodo, p.moneda, SUM(p.monto) AS total_moneda, SUM(p.monto_usd) AS usd, count(*) AS pagos
         FROM pagos p JOIN metodos_pago m ON m.id = p.metodo_pago_id WHERE ${P} GROUP BY m.nombre, p.moneda ORDER BY SUM(p.monto_usd) DESC`, params),
    query(
      `SELECT i.nombre, i.presentacion, SUM(i.cantidad) AS cantidad, SUM(i.precio_unitario_usd * i.cantidad) AS usd
         FROM cuenta_items i JOIN cuentas c ON c.id = i.cuenta_id WHERE ${I}
        GROUP BY i.nombre, i.presentacion ORDER BY SUM(i.precio_unitario_usd * i.cantidad) DESC LIMIT 50`, params),
    query(
      `SELECT COALESCE(cm.nombre, 'Sin categoría') AS categoria, SUM(i.cantidad) AS cantidad, SUM(i.precio_unitario_usd * i.cantidad) AS usd
         FROM cuenta_items i JOIN cuentas c ON c.id = i.cuenta_id
         LEFT JOIN productos pr ON pr.id = i.producto_id LEFT JOIN categorias_menu cm ON cm.id = pr.categoria_id
        WHERE ${I} GROUP BY 1 ORDER BY 3 DESC`, params),
    query(
      `SELECT COALESCE(u.nombre, '—') AS mesonero, count(*) AS cuentas, SUM(c.total_usd) AS usd, SUM(c.personas) AS personas
         FROM cuentas c LEFT JOIN usuarios u ON u.id = c.mesonero_id
        WHERE c.estado IN ('pagada','fiada') AND ${jornada('c.cerrada_en')} BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 3 DESC`, params),
    query(
      `SELECT COALESCE(z.nombre, CASE c.tipo WHEN 'llevar' THEN 'Para llevar' ELSE 'Barra (sin puesto)' END) AS zona,
              count(*) AS cuentas, SUM(c.total_usd) AS usd
         FROM cuentas c LEFT JOIN mesas m ON m.id = c.mesa_id LEFT JOIN zonas z ON z.id = m.zona_id
        WHERE c.estado IN ('pagada','fiada') AND ${jornada('c.cerrada_en')} BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 3 DESC`, params),
    query(
      `SELECT count(*) AS cuentas, COALESCE(SUM(total_usd),0) AS usd, COALESCE(SUM(personas),0) AS personas,
              COALESCE(SUM(servicio / NULLIF(total,0) * total_usd),0) AS servicio_usd,
              COALESCE(SUM(descuento / NULLIF(total,0) * total_usd),0) AS descuento_usd
         FROM cuentas c WHERE c.estado IN ('pagada','fiada') AND ${jornada('c.cerrada_en')} BETWEEN $1 AND $2`, params),
    query(`SELECT count(*) AS n FROM cuenta_items i WHERE i.estado = 'anulado' AND ${jornada('i.creado_en')} BETWEEN $1 AND $2`, params),
  ]);

  const m = ajustes.moneda_principal;
  const conv = (usd: number) => redondearMoneda(desdeUSD(Number(usd ?? 0), m, tasa), m);
  const conTotal = <T extends { usd: number }>(rows: T[]) => rows.map((r) => ({ ...r, usd: Number(r.usd), total: conv(r.usd) }));

  res.json({
    moneda: m,
    resumen: {
      cuentas: Number(resumen.cuentas), personas: Number(resumen.personas), total: conv(resumen.usd), usd: Number(resumen.usd),
      ticket_promedio: Number(resumen.cuentas) ? conv(resumen.usd / resumen.cuentas) : 0,
      consumo_por_persona: Number(resumen.personas) ? conv(resumen.usd / resumen.personas) : 0,
      servicio: conv(resumen.servicio_usd), descuentos: conv(resumen.descuento_usd), items_anulados: Number(anulaciones.n),
    },
    por_dia: conTotal(porDia), por_metodo: conTotal(porMetodo), por_producto: conTotal(porProducto),
    por_categoria: conTotal(porCategoria), por_mesonero: conTotal(porMesonero), por_zona: conTotal(porZona),
  });
});

/** Valor del inventario y consumo por insumo en el rango */
reportesRouter.get('/inventario', permitir(...R.gestion), async (req, res) => {
  const { desde, hasta } = rango.parse(req.query);
  res.json(
    await query(
      `SELECT i.id, i.nombre, i.unidad, i.stock, i.stock_minimo, c.nombre AS categoria,
              COALESCE(-SUM(m.cantidad) FILTER (WHERE m.tipo IN ('venta','anulacion')), 0) AS vendido,
              COALESCE(-SUM(m.cantidad) FILTER (WHERE m.tipo IN ('merma','consumo_interno')), 0) AS merma,
              COALESCE(SUM(m.cantidad) FILTER (WHERE m.tipo = 'entrada'), 0) AS entradas
         FROM insumos i LEFT JOIN categorias_insumo c ON c.id = i.categoria_insumo_id
         LEFT JOIN movimientos_inventario m ON m.insumo_id = i.id AND ${jornada('m.fecha')} BETWEEN $1 AND $2
        WHERE i.activo GROUP BY i.id, c.nombre ORDER BY vendido DESC, i.nombre`,
      [desde, hasta],
    ),
  );
});
