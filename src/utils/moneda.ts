/**
 * Conversión entre USD / COP / VES. Misma lógica que Cerveloza:
 *  - Todo cruza por USD, salvo que origen y destino sean la misma moneda (se devuelve tal cual).
 *  - Si el cruce VES/COP está fijado a mano (tasa de frontera), el USD→VES efectivo sale de usd_cop / ves_cop.
 *  - Un producto puede tener precio fijo por moneda (precio_manual_*), que manda sobre la conversión.
 */
export const MONEDAS = ['USD', 'COP', 'VES'] as const;
export type Moneda = (typeof MONEDAS)[number];

export type Tasa = { id: number; usd_ves: number; usd_cop: number; ves_cop: number; ves_cop_manual: boolean; fuente?: string; fecha?: string };

/** Decimales con los que se cobra cada moneda (el peso colombiano no usa centavos) */
const DECIMALES: Record<Moneda, number> = { USD: 2, COP: 0, VES: 2 };

export function redondear(n: number, decimales = 2) {
  if (n == null || Number.isNaN(Number(n))) return 0;
  const f = 10 ** decimales;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
}

export const redondearMoneda = (n: number, moneda: Moneda) => redondear(n, DECIMALES[moneda]);

/** Diferencia mínima que se considera "saldo en cero" */
export const tolerancia = (moneda: Moneda) => (moneda === 'COP' ? 1 : 0.01);

const usdVesEfectivo = (t: Tasa) => (t.ves_cop_manual ? Number(t.usd_cop) / Number(t.ves_cop) : Number(t.usd_ves));

export function aUSD(monto: number, moneda: Moneda, t: Tasa) {
  const m = Number(monto);
  if (moneda === 'USD') return m;
  if (moneda === 'COP') return m / Number(t.usd_cop);
  return m / usdVesEfectivo(t);
}

export function desdeUSD(usd: number, moneda: Moneda, t: Tasa) {
  const m = Number(usd);
  if (moneda === 'USD') return m;
  if (moneda === 'COP') return m * Number(t.usd_cop);
  return m * usdVesEfectivo(t);
}

export function convertir(monto: number, origen: Moneda, destino: Moneda, t: Tasa) {
  if (origen === destino) return Number(monto);
  return desdeUSD(aUSD(monto, origen, t), destino, t);
}

export type ConPrecio = {
  precio: number;
  moneda_base: Moneda;
  precio_manual_usd?: number | null;
  precio_manual_cop?: number | null;
  precio_manual_ves?: number | null;
};

/** Precio de un producto/adicional en la moneda pedida, respetando los precios fijos */
export function precioEn(p: ConPrecio, destino: Moneda, t: Tasa) {
  if (destino === p.moneda_base) return redondearMoneda(Number(p.precio), destino);
  const manual = p[`precio_manual_${destino.toLowerCase()}` as 'precio_manual_usd'];
  if (manual != null) return redondearMoneda(Number(manual), destino);
  if (destino === 'VES' && p.precio_manual_cop != null) return redondearMoneda(convertir(p.precio_manual_cop, 'COP', 'VES', t), destino);
  if (destino === 'COP' && p.precio_manual_ves != null) return redondearMoneda(convertir(p.precio_manual_ves, 'VES', 'COP', t), destino);
  return redondearMoneda(convertir(Number(p.precio), p.moneda_base, destino, t), destino);
}

/** { USD, COP, VES } de un mismo precio */
export const preciosEnTodas = (p: ConPrecio, t: Tasa) =>
  Object.fromEntries(MONEDAS.map((m) => [m, precioEn(p, m, t)])) as Record<Moneda, number>;

export const montoEnTodas = (monto: number, moneda: Moneda, t: Tasa) =>
  Object.fromEntries(MONEDAS.map((m) => [m, redondearMoneda(convertir(monto, moneda, m, t), m)])) as Record<Moneda, number>;
