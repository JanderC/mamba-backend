import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../../db/pool.js';
import { R, permitir } from '../../middlewares/auth.js';
import { detalleCuenta, recalcular } from '../../services/cuentas.js';
import { leerAjustes, tasaVigente } from '../../services/sistema.js';
import { emitir } from '../../services/vivo.js';
import { HttpError, notFound } from '../../utils/http.js';
import { MONEDAS, type Moneda, aUSD, convertir, desdeUSD, redondearMoneda, tolerancia } from '../../utils/moneda.js';

/**
 * Créditos: lo que los clientes quedaron debiendo.
 *  - "fiado": el cliente pide que se lo anoten y paga después.
 *  - "se_fue": consumió y se fue sin pagar; la cuenta se cierra y la deuda queda a su nombre.
 * La deuda se lleva en la moneda en que se consumió. Los abonos entran por caja en cualquier moneda.
 */
export const creditosRouter = Router();
creditosRouter.use(permitir(...R.cobro));

/** Deuda por cliente y moneda (cargos − abonos) */
const SALDOS = `
  SELECT cliente_id, moneda,
         SUM(CASE WHEN tipo = 'cargo' THEN monto ELSE -monto END) AS saldo
    FROM movimientos_credito GROUP BY cliente_id, moneda`;

// ====================================================================== Tablero de cobranza
creditosRouter.get('/', async (_req, res) => {
  const [ajustes, tasa] = await Promise.all([leerAjustes(), tasaVigente()]);
  const principal = ajustes.moneda_principal;

  const [saldos, clientes, mesas] = await Promise.all([
    query<{ cliente_id: number; moneda: Moneda; saldo: number }>(SALDOS),
    query(
      `SELECT c.id, c.nombre, c.telefono, c.documento, c.vip, c.notas,
              (SELECT max(fecha) FROM movimientos_credito m WHERE m.cliente_id = c.id AND m.tipo = 'cargo') AS ultimo_cargo,
              (SELECT min(fecha) FROM movimientos_credito m WHERE m.cliente_id = c.id AND m.tipo = 'cargo') AS primer_cargo,
              (SELECT max(fecha) FROM movimientos_credito m WHERE m.cliente_id = c.id AND m.tipo = 'abono') AS ultimo_abono,
              (SELECT count(*) FROM cuentas x WHERE x.cliente_id = c.id AND x.estado = 'fiada') AS cuentas_fiadas,
              EXISTS (SELECT 1 FROM movimientos_credito m WHERE m.cliente_id = c.id AND m.tipo = 'cargo' AND m.motivo = 'se_fue') AS se_fue
         FROM clientes c
        WHERE EXISTS (SELECT 1 FROM movimientos_credito m WHERE m.cliente_id = c.id)`,
    ),
    // Mesas y cuentas abiertas con saldo: lo que todavía hay que cobrar esta noche
    query(
      `SELECT c.id, c.numero, c.tipo, c.asiento, c.personas, c.nombre_cliente, c.moneda, c.total, c.pagado, c.abierta_en, c.cobro_solicitado_en,
              m.numero AS mesa_numero, m.tipo AS mesa_tipo, z.nombre AS zona, u.nombre AS mesonero,
              (SELECT count(*) FROM cuenta_items i WHERE i.cuenta_id = c.id AND i.estado <> 'anulado') AS items
         FROM cuentas c
         LEFT JOIN mesas m ON m.id = c.mesa_id LEFT JOIN zonas z ON z.id = m.zona_id LEFT JOIN usuarios u ON u.id = c.mesonero_id
        WHERE c.estado = 'abierta' AND c.total - c.pagado > 0
        ORDER BY c.abierta_en`,
    ),
  ]);

  const enPrincipal = (monto: number, moneda: Moneda) => convertir(monto, moneda, principal, tasa);
  const deudores = clientes
    .map((c) => {
      const deudas = saldos
        .filter((s) => s.cliente_id === c.id && Number(s.saldo) > tolerancia(s.moneda))
        .map((s) => ({ moneda: s.moneda, saldo: redondearMoneda(Number(s.saldo), s.moneda) }));
      return { ...c, cuentas_fiadas: Number(c.cuentas_fiadas), deudas, deuda_total: redondearMoneda(deudas.reduce((t, d) => t + enPrincipal(d.saldo, d.moneda), 0), principal) };
    })
    .sort((a, b) => b.deuda_total - a.deuda_total);

  const conDeuda = deudores.filter((d) => d.deudas.length);
  const totalMesas = mesas.reduce((t, m) => t + enPrincipal(m.total - m.pagado, m.moneda), 0);
  res.json({
    moneda: principal,
    resumen: {
      deuda_total: redondearMoneda(conDeuda.reduce((t, d) => t + d.deuda_total, 0), principal),
      clientes: conDeuda.length,
      se_fueron: conDeuda.filter((d) => d.se_fue).length,
      por_cobrar_mesas: redondearMoneda(totalMesas, principal),
      mesas: mesas.length,
    },
    deudores: conDeuda,
    al_dia: deudores.filter((d) => !d.deudas.length).slice(0, 30),
    mesas,
  });
});

/** Estado de cuenta de un cliente */
creditosRouter.get('/:clienteId', async (req, res) => {
  const id = Number(req.params.clienteId);
  const [cliente] = await query(`SELECT * FROM clientes WHERE id = $1`, [id]);
  if (!cliente) throw notFound('Cliente');
  const [saldos, movimientos] = await Promise.all([
    query(`SELECT moneda, saldo FROM (${SALDOS}) s WHERE cliente_id = $1 AND saldo > 0.009 ORDER BY moneda`, [id]),
    query(
      `SELECT m.id, m.tipo, m.motivo, m.moneda, m.monto, m.pago_moneda, m.pago_monto, m.referencia, m.nota, m.fecha, m.cuenta_id,
              c.numero AS cuenta, mp.nombre AS metodo, u.nombre AS usuario,
              (SELECT string_agg(i.cantidad::int || '× ' || i.nombre, ', ' ORDER BY i.id)
                 FROM cuenta_items i WHERE i.cuenta_id = m.cuenta_id AND i.estado <> 'anulado') AS consumo
         FROM movimientos_credito m
         LEFT JOIN cuentas c ON c.id = m.cuenta_id
         LEFT JOIN metodos_pago mp ON mp.id = m.metodo_pago_id
         LEFT JOIN usuarios u ON u.id = m.usuario_id
        WHERE m.cliente_id = $1 ORDER BY m.fecha DESC, m.id DESC LIMIT 200`,
      [id],
    ),
  ]);
  res.json({ cliente, deudas: saldos, movimientos });
});

// ====================================================================== Abonos
const abonoSchema = z.object({
  sesion_caja_id: z.number().int(),
  metodo_pago_id: z.number().int(),
  /** Moneda en que paga y monto que entrega */
  moneda: z.enum(MONEDAS),
  monto: z.number().positive(),
  /** A qué deuda se aplica (si debe en más de una moneda) */
  moneda_deuda: z.enum(MONEDAS),
  referencia: z.string().trim().max(80).nullish(),
  nota: z.string().trim().max(200).nullish(),
});

creditosRouter.post('/:clienteId/abonos', async (req, res) => {
  const clienteId = Number(req.params.clienteId);
  const b = abonoSchema.parse(req.body);

  const resultado = await tx(async (db) => {
    const [cliente] = await query(`SELECT id, nombre FROM clientes WHERE id = $1 FOR UPDATE`, [clienteId], db);
    if (!cliente) throw notFound('Cliente');
    const [sesion] = await query(`SELECT id FROM sesiones_caja WHERE id = $1 AND estado = 'abierta'`, [b.sesion_caja_id], db);
    if (!sesion) throw new HttpError(409, 'No hay una caja abierta. Abre la caja antes de recibir abonos.');
    const [metodo] = await query(`SELECT * FROM metodos_pago WHERE id = $1 AND activo`, [b.metodo_pago_id], db);
    if (!metodo) throw new HttpError(400, 'Método de pago inválido');
    if (!metodo.monedas.includes(b.moneda)) throw new HttpError(400, `${metodo.nombre} no recibe ${b.moneda}`);
    if (metodo.requiere_referencia && !b.referencia) throw new HttpError(400, `${metodo.nombre} necesita el número de referencia`);

    const [s] = await query<{ saldo: number }>(`SELECT saldo FROM (${SALDOS}) x WHERE cliente_id = $1 AND moneda = $2`, [clienteId, b.moneda_deuda], db);
    const deuda = redondearMoneda(Number(s?.saldo ?? 0), b.moneda_deuda);
    if (deuda <= tolerancia(b.moneda_deuda)) throw new HttpError(409, `${cliente.nombre} no tiene deuda en ${b.moneda_deuda}`);

    const tasa = await tasaVigente(db);
    let aplicado = redondearMoneda(convertir(b.monto, b.moneda, b.moneda_deuda, tasa), b.moneda_deuda);
    if (aplicado > deuda + tolerancia(b.moneda_deuda)) {
      const maximo = redondearMoneda(convertir(deuda, b.moneda_deuda, b.moneda, tasa), b.moneda);
      throw new HttpError(400, `El abono supera la deuda. Lo máximo a recibir es ${maximo} ${b.moneda}.`);
    }
    if (Math.abs(aplicado - deuda) <= tolerancia(b.moneda_deuda)) aplicado = deuda; // absorbe el redondeo entre monedas

    await query(
      `INSERT INTO movimientos_credito (cliente_id, tipo, moneda, monto, monto_usd, pago_moneda, pago_monto, metodo_pago_id, sesion_caja_id,
                                        referencia, nota, usuario_id)
       VALUES ($1,'abono',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [clienteId, b.moneda_deuda, aplicado, aUSD(aplicado, b.moneda_deuda, tasa), b.moneda, b.monto, metodo.id, sesion.id,
       b.referencia || null, b.nota || null, req.usuario.id],
      db,
    );
    return { aplicado, moneda: b.moneda_deuda, restante: redondearMoneda(deuda - aplicado, b.moneda_deuda), saldado: deuda - aplicado <= tolerancia(b.moneda_deuda) };
  });
  res.status(201).json(resultado);
});

// ====================================================================== Fiar una cuenta
const fiarSchema = z.object({
  cliente_id: z.number().int().nullish(),
  /** Si el cliente no existe aún, se crea con estos datos */
  cliente_nuevo: z.object({ nombre: z.string().trim().min(2, 'Escribe el nombre del cliente'), telefono: z.string().trim().max(30).nullish(), documento: z.string().trim().max(30).nullish() }).nullish(),
  motivo: z.enum(['fiado', 'se_fue']),
  nota: z.string().trim().max(200).nullish(),
});

/**
 * Cierra la cuenta dejando su saldo como deuda del cliente.
 * Lo que ya se haya abonado queda registrado como pago normal; solo se fía lo que falta.
 */
export const fiarCuenta = Router({ mergeParams: true });
fiarCuenta.post('/', permitir(...R.cobro), async (req, res) => {
  const id = Number((req.params as { id: string }).id);
  const b = fiarSchema.parse(req.body);
  if (!b.cliente_id && !b.cliente_nuevo) throw new HttpError(400, 'Indica a qué cliente se le carga la deuda');

  await tx(async (db) => {
    const [c] = await query(`SELECT * FROM cuentas WHERE id = $1 FOR UPDATE`, [id], db);
    if (!c) throw notFound('Cuenta');
    if (c.estado !== 'abierta') throw new HttpError(409, `La cuenta ${c.numero} ya está ${c.estado}`);
    await recalcular(db, id);
    const [{ total, pagado }] = await query<{ total: number; pagado: number }>(`SELECT total, pagado FROM cuentas WHERE id = $1`, [id], db);
    const saldo = redondearMoneda(total - pagado, c.moneda);
    if (saldo <= tolerancia(c.moneda)) throw new HttpError(409, 'Esta cuenta no tiene saldo pendiente: ciérrala normalmente');

    let clienteId = b.cliente_id ?? null;
    if (clienteId) {
      const [existe] = await query(`SELECT 1 FROM clientes WHERE id = $1`, [clienteId], db);
      if (!existe) throw notFound('Cliente');
    } else {
      const n = b.cliente_nuevo!;
      const [nuevo] = await query<{ id: number }>(
        `INSERT INTO clientes (nombre, telefono, documento) VALUES ($1,$2,$3) RETURNING id`,
        [n.nombre, n.telefono?.replace(/[^\d+]/g, '') || null, n.documento || null], db,
      );
      clienteId = nuevo.id;
    }

    const tasa = await tasaVigente(db);
    await query(
      `INSERT INTO movimientos_credito (cliente_id, tipo, motivo, moneda, monto, monto_usd, cuenta_id, nota, usuario_id)
       VALUES ($1,'cargo',$2,$3,$4,$5,$6,$7,$8)`,
      [clienteId, b.motivo, c.moneda, saldo, aUSD(saldo, c.moneda, tasa), id, b.nota || null, req.usuario.id], db,
    );
    await query(
      `UPDATE cuentas SET estado = 'fiada', cliente_id = $2, fiado_monto = $3, fiado_motivo = $4, cerrada_en = now(), usuario_cierre_id = $5,
              cobro_solicitado_en = NULL, cobro_solicitado_por = NULL, cobro_nota = NULL
        WHERE id = $1`,
      [id, clienteId, saldo, b.motivo, req.usuario.id], db,
    );
    await query(`UPDATE cuenta_items SET estado = 'entregado' WHERE cuenta_id = $1 AND estado IN ('pendiente','preparando','listo')`, [id], db);
  });

  const cuenta = await detalleCuenta(id);
  emitir({ tipo: 'cuenta', accion: 'fiada', cuenta_id: id, mesonero_id: cuenta.mesonero_id });
  res.status(201).json(cuenta);
});

/** Deuda total en la moneda principal (para el tablero de inicio) */
export async function deudaTotal() {
  const [ajustes, tasa] = await Promise.all([leerAjustes(), tasaVigente()]);
  const filas = await query<{ moneda: Moneda; saldo: number; clientes: number }>(
    `SELECT moneda, SUM(saldo) AS saldo, count(*) AS clientes FROM (${SALDOS}) s WHERE saldo > 0.009 GROUP BY moneda`,
  );
  const usd = filas.reduce((t, f) => t + aUSD(Number(f.saldo), f.moneda, tasa), 0);
  const [{ n }] = await query<{ n: number }>(`SELECT count(DISTINCT cliente_id) AS n FROM (${SALDOS}) s WHERE saldo > 0.009`);
  return { total: redondearMoneda(desdeUSD(usd, ajustes.moneda_principal, tasa), ajustes.moneda_principal), clientes: Number(n) };
}
