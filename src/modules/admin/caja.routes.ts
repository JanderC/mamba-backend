import { Router } from 'express';
import { z } from 'zod';
import { type Db, pool, query, tx } from '../../db/pool.js';
import { R, permitir } from '../../middlewares/auth.js';
import { JORNADA_HOY, TZ, jornada, leerAjustes, tasaVigente } from '../../services/sistema.js';
import { HttpError, notFound } from '../../utils/http.js';
import { MONEDAS, type Moneda, aUSD, desdeUSD, redondear, redondearMoneda } from '../../utils/moneda.js';

export const cajaRouter = Router();
// Ver qué caja está abierta: también el mesonero (para cobrar en la mesa). Todo lo demás, solo quien maneja caja.
cajaRouter.use((req, res, next) =>
  req.method === 'GET' && req.path === '/' ? permitir(...R.cobro, 'mesonero')(req, res, next) : permitir(...R.cobro)(req, res, next));

const porMoneda = () => ({ USD: 0, COP: 0, VES: 0 }) as Record<Moneda, number>;

/**
 * Efectivo que DEBERÍA haber en el cajón por moneda:
 *   fondo inicial + efectivo recibido − vueltos entregados + ingresos − egresos
 * (el vuelto se descuenta en la moneda en la que realmente se entregó).
 */
async function calcularResumen(sesionId: number, db: Db = pool) {
  const [sesion] = await query(
    `SELECT s.*, c.nombre AS caja, u.nombre AS usuario FROM sesiones_caja s
       JOIN cajas c ON c.id = s.caja_id JOIN usuarios u ON u.id = s.usuario_id WHERE s.id = $1`,
    [sesionId], db,
  );
  if (!sesion) throw notFound('Sesión de caja');

  const abonosCredito = await query(
    `SELECT a.pago_moneda AS moneda, SUM(a.pago_monto) AS total, count(*) AS n FROM movimientos_credito a JOIN metodos_pago m ON m.id = a.metodo_pago_id
      WHERE a.sesion_caja_id = $1 AND a.tipo = 'abono' AND m.es_efectivo GROUP BY a.pago_moneda`, [sesionId], db);
  const [recibido, vueltos, movs, metodos, [conteo]] = await Promise.all([
    query(
      `SELECT p.moneda, SUM(p.monto_recibido) AS total FROM pagos p JOIN metodos_pago m ON m.id = p.metodo_pago_id
        WHERE p.sesion_caja_id = $1 AND NOT p.anulado AND m.es_efectivo GROUP BY p.moneda`, [sesionId], db),
    query(
      `SELECT vuelto_moneda AS moneda, SUM(vuelto_monto) AS total FROM pagos
        WHERE sesion_caja_id = $1 AND NOT anulado AND vuelto_monto IS NOT NULL GROUP BY vuelto_moneda`, [sesionId], db),
    query(`SELECT tipo, moneda, SUM(monto) AS total FROM movimientos_caja WHERE sesion_caja_id = $1 GROUP BY tipo, moneda`, [sesionId], db),
    query(
      `SELECT m.nombre AS metodo, m.es_efectivo, p.moneda, SUM(p.monto) AS total, SUM(p.monto_usd) AS total_usd, count(*) AS pagos
         FROM pagos p JOIN metodos_pago m ON m.id = p.metodo_pago_id
        WHERE p.sesion_caja_id = $1 AND NOT p.anulado GROUP BY m.nombre, m.es_efectivo, m.orden, p.moneda ORDER BY m.orden, p.moneda`, [sesionId], db),
    query(
      `SELECT count(DISTINCT cuenta_id) AS cuentas, COALESCE(SUM(monto_usd), 0) AS total_usd FROM pagos WHERE sesion_caja_id = $1 AND NOT anulado`,
      [sesionId], db),
  ]);

  const efectivo = porMoneda(), vuelto = porMoneda(), ingresos = porMoneda(), egresos = porMoneda(), esperado = porMoneda(), abonos = porMoneda();
  for (const r of abonosCredito) abonos[r.moneda as Moneda] = Number(r.total);
  for (const r of recibido) efectivo[r.moneda as Moneda] = Number(r.total);
  for (const r of vueltos) vuelto[r.moneda as Moneda] = Number(r.total);
  for (const r of movs) (r.tipo === 'ingreso' ? ingresos : egresos)[r.moneda as Moneda] = Number(r.total);
  for (const m of MONEDAS)
    esperado[m] = redondear(Number(sesion[`fondo_inicial_${m.toLowerCase()}`]) + efectivo[m] - vuelto[m] + abonos[m] + ingresos[m] - egresos[m], 2);

  return { sesion, efectivo_recibido: efectivo, vueltos: vuelto, abonos_credito: abonos, ingresos, egresos, esperado, por_metodo: metodos,
    cuentas_cobradas: Number(conteo.cuentas), total_usd: Number(conteo.total_usd) };
}

/** Cajas con su sesión abierta (si la tienen) y el fondo que dejó el último cierre */
cajaRouter.get('/', async (_req, res) => {
  res.json(
    await query(
      `SELECT c.*,
              (SELECT row_to_json(x) FROM (
                 SELECT s.id, s.fecha_apertura, s.usuario_id, u.nombre AS usuario
                   FROM sesiones_caja s JOIN usuarios u ON u.id = s.usuario_id
                  WHERE s.caja_id = c.id AND s.estado = 'abierta') x) AS sesion,
              (SELECT row_to_json(y) FROM (
                 SELECT s.fondo_siguiente_usd AS usd, s.fondo_siguiente_cop AS cop, s.fondo_siguiente_ves AS ves, s.fecha_cierre
                   FROM sesiones_caja s WHERE s.caja_id = c.id AND s.estado = 'cerrada' ORDER BY s.fecha_cierre DESC LIMIT 1) y) AS arrastre
         FROM cajas c WHERE c.activo ORDER BY c.id`,
    ),
  );
});

const monto = z.number().min(0).default(0);

cajaRouter.post('/abrir', async (req, res) => {
  const b = z
    .object({ caja_id: z.number().int(), fondo_inicial_usd: monto, fondo_inicial_cop: monto, fondo_inicial_ves: monto })
    .parse(req.body);
  await tasaVigente(); // sin tasa no se puede cobrar: mejor avisar al abrir
  const [abierta] = await query(`SELECT 1 FROM sesiones_caja WHERE caja_id = $1 AND estado = 'abierta'`, [b.caja_id]);
  if (abierta) throw new HttpError(409, 'Esa caja ya tiene una sesión abierta');
  const [s] = await query(
    `INSERT INTO sesiones_caja (caja_id, usuario_id, fondo_inicial_usd, fondo_inicial_cop, fondo_inicial_ves) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [b.caja_id, req.usuario.id, b.fondo_inicial_usd, b.fondo_inicial_cop, b.fondo_inicial_ves],
  );
  res.status(201).json(await calcularResumen(s.id));
});

cajaRouter.get('/sesiones', async (_req, res) => {
  res.json(
    await query(
      `SELECT s.*, c.nombre AS caja, u.nombre AS usuario, uc.nombre AS usuario_cierre,
              (SELECT COALESCE(SUM(monto_usd),0) FROM pagos p WHERE p.sesion_caja_id = s.id AND NOT p.anulado) AS total_usd
         FROM sesiones_caja s JOIN cajas c ON c.id = s.caja_id JOIN usuarios u ON u.id = s.usuario_id
         LEFT JOIN usuarios uc ON uc.id = s.usuario_cierre_id
        ORDER BY s.fecha_apertura DESC LIMIT 60`,
    ),
  );
});

cajaRouter.get('/sesiones/:id', async (req, res) => {
  res.json(await calcularResumen(Number(req.params.id)));
});

/** Línea de tiempo de la sesión: cobros, ingresos y egresos */
cajaRouter.get('/sesiones/:id/movimientos', async (req, res) => {
  const id = Number(req.params.id);
  const [pagos, movs] = await Promise.all([
    query(
      `SELECT p.id, p.fecha, p.moneda, p.monto, p.monto_recibido, p.vuelto_monto, p.vuelto_moneda, p.referencia, m.nombre AS metodo,
              c.numero AS cuenta, c.id AS cuenta_id, u.nombre AS usuario
         FROM pagos p JOIN metodos_pago m ON m.id = p.metodo_pago_id JOIN cuentas c ON c.id = p.cuenta_id
         LEFT JOIN usuarios u ON u.id = p.usuario_id
        WHERE p.sesion_caja_id = $1 AND NOT p.anulado`, [id]),
    query(
      `SELECT mc.id, mc.fecha, mc.tipo, mc.concepto, mc.moneda, mc.monto, u.nombre AS usuario
         FROM movimientos_caja mc LEFT JOIN usuarios u ON u.id = mc.usuario_id WHERE mc.sesion_caja_id = $1`, [id]),
  ]);
  const linea = [
    ...pagos.map((p) => ({ ...p, tipo: 'cobro' })),
    ...movs,
  ].sort((a, b) => +new Date(b.fecha) - +new Date(a.fecha));
  res.json(linea);
});

cajaRouter.post('/sesiones/:id/movimientos', async (req, res) => {
  const b = z
    .object({ tipo: z.enum(['ingreso', 'egreso']), concepto: z.string().trim().min(3, 'Describe el concepto'), moneda: z.enum(MONEDAS), monto: z.number().positive() })
    .parse(req.body);
  const [s] = await query(`SELECT id FROM sesiones_caja WHERE id = $1 AND estado = 'abierta'`, [req.params.id]);
  if (!s) throw new HttpError(409, 'La sesión de caja no está abierta');
  const tasa = await tasaVigente();
  await query(
    `INSERT INTO movimientos_caja (sesion_caja_id, tipo, concepto, moneda, monto, monto_usd, usuario_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [s.id, b.tipo, b.concepto, b.moneda, b.monto, aUSD(b.monto, b.moneda, tasa), req.usuario.id],
  );
  res.status(201).json(await calcularResumen(s.id));
});

/** Cierre: compara lo contado con lo esperado y deja el fondo para el próximo turno */
cajaRouter.post('/sesiones/:id/cerrar', async (req, res) => {
  const id = Number(req.params.id);
  const b = z
    .object({
      conteo_usd: monto, conteo_cop: monto, conteo_ves: monto,
      fondo_siguiente_usd: monto, fondo_siguiente_cop: monto, fondo_siguiente_ves: monto,
      notas_cierre: z.string().max(500).nullish(),
    })
    .parse(req.body);

  await tx(async (db) => {
    const [s] = await query(`SELECT * FROM sesiones_caja WHERE id = $1 FOR UPDATE`, [id], db);
    if (!s) throw notFound('Sesión de caja');
    if (s.estado === 'cerrada') throw new HttpError(409, 'Esta sesión ya está cerrada');

    const conteo = { USD: b.conteo_usd, COP: b.conteo_cop, VES: b.conteo_ves };
    const fondo = { USD: b.fondo_siguiente_usd, COP: b.fondo_siguiente_cop, VES: b.fondo_siguiente_ves };
    for (const m of MONEDAS)
      if (fondo[m] > conteo[m] + 0.005)
        throw new HttpError(400, `El fondo que dejas en ${m} (${fondo[m]}) no puede superar lo contado (${conteo[m]})`);

    const { esperado } = await calcularResumen(id, db);
    await query(
      `UPDATE sesiones_caja SET
         conteo_final_usd=$2, conteo_final_cop=$3, conteo_final_ves=$4,
         esperado_final_usd=$5, esperado_final_cop=$6, esperado_final_ves=$7,
         diferencia_usd=$8, diferencia_cop=$9, diferencia_ves=$10,
         fondo_siguiente_usd=$11, fondo_siguiente_cop=$12, fondo_siguiente_ves=$13,
         estado='cerrada', fecha_cierre=now(), usuario_cierre_id=$14, notas_cierre=$15
       WHERE id=$1`,
      [id, conteo.USD, conteo.COP, conteo.VES, esperado.USD, esperado.COP, esperado.VES,
       redondear(conteo.USD - esperado.USD), redondear(conteo.COP - esperado.COP), redondear(conteo.VES - esperado.VES),
       fondo.USD, fondo.COP, fondo.VES, req.usuario.id, b.notas_cierre || null],
      db,
    );
  });
  res.json(await calcularResumen(id));
});

/**
 * Movimientos del día (una jornada: de 6 a. m. a 6 a. m.): lo que se ha vendido y cobrado, por moneda y método,
 * los ingresos y egresos de caja, lo que falta por cobrar y el detalle de cada cobro. Es lo que mira el
 * administrador para saber cómo va la noche.
 */
cajaRouter.get('/diario', async (req, res) => {
  const { fecha } = z.object({ fecha: z.iso.date().optional() }).parse(req.query);
  const F = fecha ? '$1::date' : JORNADA_HOY;
  const p = fecha ? [fecha] : [];
  const [ajustes, tasa] = await Promise.all([leerAjustes(), tasaVigente()]);
  const principal = ajustes.moneda_principal;
  const enPrincipal = (usd: number) => redondearMoneda(desdeUSD(Number(usd), principal, tasa), principal);

  const [[dia], pagos, movimientos, vendido, [cuentas], porHora, sesiones] = await Promise.all([
    query(`SELECT ${F} AS fecha, (${F} = ${JORNADA_HOY}) AS es_hoy`, p),
    query(
      `SELECT p.id, p.fecha, p.moneda, p.monto, p.monto_recibido, p.monto_usd, p.vuelto_monto, p.vuelto_moneda, p.referencia, p.anulado,
              m.nombre AS metodo, m.es_efectivo, c.id AS cuenta_id, c.numero, c.tipo, c.nombre_cliente,
              me.numero AS mesa_numero, me.nombre AS mesa_nombre, u.nombre AS usuario
         FROM pagos p JOIN metodos_pago m ON m.id = p.metodo_pago_id JOIN cuentas c ON c.id = p.cuenta_id
         LEFT JOIN mesas me ON me.id = c.mesa_id LEFT JOIN usuarios u ON u.id = p.usuario_id
        WHERE ${jornada('p.fecha')} = ${F} ORDER BY p.fecha DESC, p.id DESC`, p),
    query(
      `SELECT mc.id, mc.fecha, mc.tipo, mc.concepto, mc.moneda, mc.monto, mc.monto_usd, u.nombre AS usuario
         FROM movimientos_caja mc LEFT JOIN usuarios u ON u.id = mc.usuario_id
        WHERE ${jornada('mc.fecha')} = ${F} ORDER BY mc.fecha DESC`, p),
    query(
      `SELECT i.nombre, i.presentacion, i.estacion, SUM(i.cantidad)::float AS cantidad, SUM(i.precio_unitario_usd * i.cantidad)::float AS usd
         FROM cuenta_items i JOIN cuentas c ON c.id = i.cuenta_id
        WHERE i.estado <> 'anulado' AND c.estado <> 'anulada' AND ${jornada('i.creado_en')} = ${F}
        GROUP BY i.nombre, i.presentacion, i.estacion ORDER BY SUM(i.cantidad) DESC, i.nombre`, p),
    query(
      `SELECT count(*) FILTER (WHERE c.estado = 'pagada' AND ${jornada('c.cerrada_en')} = ${F})::int AS cobradas,
              count(*) FILTER (WHERE c.estado = 'anulada' AND ${jornada('c.cerrada_en')} = ${F})::int AS anuladas,
              count(*) FILTER (WHERE c.estado = 'fiada' AND ${jornada('c.cerrada_en')} = ${F})::int AS fiadas,
              count(*) FILTER (WHERE c.estado = 'abierta')::int AS abiertas,
              COALESCE(SUM(CASE WHEN c.estado = 'abierta' AND c.total > 0 THEN (c.total - c.pagado) / c.total * c.total_usd END), 0)::float AS por_cobrar_usd
         FROM cuentas c`, p),
    query(
      `SELECT to_char(date_trunc('hour', p.fecha AT TIME ZONE '${TZ}'), 'HH24') AS hora, SUM(p.monto_usd)::float AS usd
         FROM pagos p WHERE NOT p.anulado AND ${jornada('p.fecha')} = ${F}
        GROUP BY 1 ORDER BY min(p.fecha)`, p),
    query(
      `SELECT s.id FROM sesiones_caja s
        WHERE ${jornada('s.fecha_apertura')} = ${F} OR (s.estado = 'abierta' AND ${F} = ${JORNADA_HOY}) ORDER BY s.id`, p),
  ]);

  // Cobrado por moneda: efectivo y demás métodos por separado (lo que de verdad entró en cada moneda)
  const validos = pagos.filter((x) => !x.anulado);
  const porMoneda = Object.fromEntries(MONEDAS.map((m) => [m, { efectivo: 0, otros: 0, total: 0, pagos: 0, vueltos: 0 }])) as Record<Moneda, { efectivo: number; otros: number; total: number; pagos: number; vueltos: number }>;
  const porMetodo = new Map<string, { metodo: string; moneda: Moneda; es_efectivo: boolean; total: number; pagos: number }>();
  for (const x of validos) {
    const m = porMoneda[x.moneda as Moneda];
    m[x.es_efectivo ? 'efectivo' : 'otros'] += Number(x.monto);
    m.total += Number(x.monto);
    m.pagos++;
    if (x.vuelto_monto) porMoneda[x.vuelto_moneda as Moneda].vueltos += Number(x.vuelto_monto);
    const k = `${x.metodo}|${x.moneda}`;
    const e = porMetodo.get(k) ?? { metodo: x.metodo, moneda: x.moneda, es_efectivo: x.es_efectivo, total: 0, pagos: 0 };
    e.total += Number(x.monto); e.pagos++;
    porMetodo.set(k, e);
  }
  const mov = Object.fromEntries(MONEDAS.map((m) => [m, { ingresos: 0, egresos: 0 }])) as Record<Moneda, { ingresos: number; egresos: number }>;
  for (const x of movimientos) mov[x.moneda as Moneda][x.tipo === 'ingreso' ? 'ingresos' : 'egresos'] += Number(x.monto);

  const cobradoUsd = validos.reduce((t, x) => t + Number(x.monto_usd), 0);
  const cuentasCobradas = new Set(validos.map((x) => x.cuenta_id)).size;
  const vendidoUsd = vendido.reduce((t, x) => t + Number(x.usd), 0);

  res.json({
    fecha: dia.fecha, es_hoy: dia.es_hoy, moneda: principal, tasa,
    totales: {
      cobrado: enPrincipal(cobradoUsd), cobrado_usd: redondear(cobradoUsd, 2),
      vendido: enPrincipal(vendidoUsd), vendido_usd: redondear(vendidoUsd, 2),
      por_cobrar: dia.es_hoy ? enPrincipal(cuentas.por_cobrar_usd) : 0, cuentas_abiertas: dia.es_hoy ? cuentas.abiertas : 0,
      cuentas_cobradas: cuentasCobradas, anuladas: cuentas.anuladas, fiadas: cuentas.fiadas,
      ticket_promedio: cuentasCobradas ? enPrincipal(cobradoUsd / cuentasCobradas) : 0,
      unidades: vendido.reduce((t, x) => t + Number(x.cantidad), 0),
    },
    por_moneda: porMoneda,
    por_metodo: [...porMetodo.values()].sort((a, b) => b.total - a.total),
    movimientos_totales: mov,
    por_hora: porHora.map((h) => ({ hora: h.hora, total: enPrincipal(h.usd) })),
    vendido: vendido.map((v) => ({ ...v, total: enPrincipal(v.usd) })),
    pagos,
    movimientos,
    sesiones: await Promise.all(sesiones.map(async (s) => {
      const r = await calcularResumen(s.id);
      return { id: s.id, caja: r.sesion.caja, estado: r.sesion.estado, usuario: r.sesion.usuario, fecha_apertura: r.sesion.fecha_apertura,
        fecha_cierre: r.sesion.fecha_cierre, esperado: r.esperado, total_usd: r.total_usd };
    })),
  });
});
