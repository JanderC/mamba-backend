import { env } from '../config/env.js';
import { type Db, pool, query } from '../db/pool.js';
import { HttpError } from '../utils/http.js';
import type { Moneda, Tasa } from '../utils/moneda.js';

export const TZ = env.TZ_NEGOCIO;

/**
 * "Jornada": la noche de un bar cruza la medianoche. Todo lo que pasa antes de las 6:00 a.m.
 * cuenta para el día anterior. Esta expresión SQL convierte un timestamptz en su fecha de jornada.
 */
export const jornada = (col: string) => `((${col} AT TIME ZONE '${TZ}') - interval '6 hours')::date`;
export const JORNADA_HOY = `((now() AT TIME ZONE '${TZ}') - interval '6 hours')::date`;

// ------------------------------------------------------------------ Tasas
export async function tasaVigente(db: Db = pool): Promise<Tasa> {
  const [t] = await query<Tasa>(`SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1`, [], db);
  if (!t) throw new HttpError(409, 'No hay una tasa de cambio registrada. Regístrala en Administración → Tasas.');
  return t;
}

/** Consulta la tasa oficial (BCV) y la TRM y guarda un nuevo registro. Respeta el cruce VES/COP fijado a mano. */
export async function actualizarTasaBCV(usuarioId: number | null = null): Promise<Tasa> {
  const [ve, co] = await Promise.all([
    fetch('https://ve.dolarapi.com/v1/dolares', { signal: AbortSignal.timeout(10_000) }).then((r) => r.json() as Promise<any[]>),
    fetch('https://co.dolarapi.com/v1/cotizaciones/usd', { signal: AbortSignal.timeout(10_000) }).then((r) => r.json() as Promise<any>),
  ]);
  const oficial = Array.isArray(ve) ? ve.find((d) => d.fuente === 'oficial') : null;
  const usd_ves = Number(oficial?.promedio);
  const usd_cop = (Number(co?.compra) + Number(co?.venta)) / 2;
  if (!(usd_ves > 0) || !(usd_cop > 0)) throw new HttpError(502, 'No se pudo obtener la tasa oficial. Regístrala manualmente.');

  const [anterior] = await query<Tasa>(`SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1`);
  const manual = anterior?.ves_cop_manual === true;
  const ves_cop = manual ? Number(anterior.ves_cop) : usd_cop / usd_ves;

  const [nueva] = await query<Tasa>(
    `INSERT INTO tasas_cambio (usd_ves, usd_cop, ves_cop, ves_cop_manual, fuente, usuario_id)
     VALUES ($1,$2,$3,$4,'BCV',$5) RETURNING *`,
    [usd_ves, usd_cop, ves_cop, manual, usuarioId],
  );
  return nueva;
}

// ------------------------------------------------------------------ Ajustes
export type Ajustes = {
  moneda_principal: Moneda;
  servicio_pct: number;
  servicio_auto_mesas: boolean;
  capacidad_maxima: number;
  permitir_venta_sin_stock: boolean;
  recordatorio_reserva_horas: number;
  ticket_pie: string;
};

const DEFECTO: Ajustes = {
  moneda_principal: 'COP',
  servicio_pct: 10,
  servicio_auto_mesas: false,
  capacidad_maxima: 200,
  permitir_venta_sin_stock: false,
  recordatorio_reserva_horas: 3,
  ticket_pie: '',
};

export async function leerAjustes(db: Db = pool): Promise<Ajustes> {
  const rows = await query<{ clave: string; valor: unknown }>(`SELECT clave, valor FROM ajustes`, [], db);
  return { ...DEFECTO, ...Object.fromEntries(rows.map((r) => [r.clave, r.valor])) } as Ajustes;
}
