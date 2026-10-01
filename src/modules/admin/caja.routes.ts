import { Router } from 'express';
import { z } from 'zod';
import { type Db, pool, query, tx } from '../../db/pool.js';
import { R, permitir } from '../../middlewares/auth.js';
import { tasaVigente } from '../../services/sistema.js';
import { HttpError, notFound } from '../../utils/http.js';
import { MONEDAS, type Moneda, aUSD, redondear } from '../../utils/moneda.js';

export const cajaRouter = Router();
cajaRouter.use(permitir(...R.cobro));

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
