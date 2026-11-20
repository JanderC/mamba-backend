import { query } from '../db/pool.js';
import { resumenDiario } from '../modules/admin/caja.routes.js';
import { type Moneda, redondear } from '../utils/moneda.js';
import { enviarEmail, enviarWhatsApp } from './notificaciones.js';
import { JORNADA_HOY, TZ, leerAjustes } from './sistema.js';

const NOMBRE: Record<Moneda, string> = { COP: 'Pesos', USD: 'Dólares', VES: 'Bolívares' };
const fmt = (n: number, m: Moneda) =>
  `${m === 'USD' ? 'US$' : m === 'VES' ? 'Bs' : '$'} ${Number(n).toLocaleString('es-CO', { minimumFractionDigits: m === 'COP' ? 0 : 2, maximumFractionDigits: m === 'COP' ? 0 : 2 })}`;

/** Texto del cierre del día para WhatsApp (con *negritas*) y correo */
export function textoCierre(d: Awaited<ReturnType<typeof resumenDiario>>, local = 'MAMBA BISTRO BAR') {
  const m = d.moneda as Moneda;
  const t = d.totales;
  const fecha = new Date(`${String(d.fecha).slice(0, 10)}T12:00:00`).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
  const L: string[] = [`🐍 *CIERRE DEL DÍA · ${local}*`, `📅 ${fecha}`, ''];
  L.push(`💰 *Cobrado: ${fmt(t.cobrado, m)}*  (≈ ${fmt(t.cobrado_usd, 'USD')})`);
  L.push(`🧾 ${t.cuentas_cobradas} cuentas · ticket promedio ${fmt(t.ticket_promedio, m)}`);
  L.push(`🍻 Vendido: ${fmt(t.vendido, m)} · ${t.unidades} productos`);
  if (t.anuladas) L.push(`🚫 Anuladas: ${t.anuladas}`);
  if (t.fiadas) L.push(`📝 Fiadas: ${t.fiadas}`);
  if (t.por_cobrar) L.push(`⏳ Quedó por cobrar: ${fmt(t.por_cobrar, m)} (${t.cuentas_abiertas} cuentas abiertas)`);
  L.push('', '*Por moneda*');
  for (const mo of ['COP', 'USD', 'VES'] as Moneda[]) {
    const x = d.por_moneda[mo];
    if (!x.total && !d.movimientos_totales[mo].ingresos && !d.movimientos_totales[mo].egresos) continue;
    L.push(`• ${NOMBRE[mo]}: ${fmt(x.total, mo)} (efectivo ${fmt(x.efectivo, mo)} · otros ${fmt(x.otros, mo)})${x.vueltos ? ` · vueltos ${fmt(x.vueltos, mo)}` : ''}`);
    const mv = d.movimientos_totales[mo];
    if (mv.ingresos || mv.egresos) L.push(`   ingresos ${fmt(mv.ingresos, mo)} · egresos ${fmt(mv.egresos, mo)}`);
  }
  if (d.por_metodo.length) {
    L.push('', '*Por método*');
    for (const p of d.por_metodo) L.push(`• ${p.metodo} (${NOMBRE[p.moneda as Moneda].toLowerCase()}): ${fmt(p.total, p.moneda as Moneda)} · ${p.pagos} pagos`);
  }
  if (d.vendido.length) {
    L.push('', '*Lo más vendido*');
    for (const v of d.vendido.slice(0, 10)) L.push(`• ${Number(v.cantidad)} × ${v.nombre}${v.presentacion && !/^(unidad|botella|porci[oó]n)$/i.test(v.presentacion) ? ` (${v.presentacion})` : ''}`);
  }
  if (d.sesiones.length) {
    L.push('', '*Cajas*');
    for (const s of d.sesiones) {
      const esperado = (['COP', 'USD', 'VES'] as Moneda[]).filter((mo) => Number(s.esperado[mo])).map((mo) => fmt(redondear(Number(s.esperado[mo]), 2), mo)).join(' · ');
      L.push(`• ${s.caja} (${s.usuario}) ${s.estado === 'abierta' ? 'ABIERTA' : 'cerrada'}${esperado ? ` · en caja ${esperado}` : ''}`);
    }
  }
  return L.join('\n');
}

/** Arma el cierre y lo manda a los WhatsApp y correos configurados. Devuelve a quiénes salió. */
export async function enviarCierreDiario(fecha?: string) {
  const ajustes = await leerAjustes();
  const [local] = await query<{ nombre: string }>(`SELECT nombre FROM configuracion_local LIMIT 1`);
  const d = await resumenDiario(fecha);
  const texto = textoCierre(d, (local?.nombre ?? 'Mamba Bistro Bar').toUpperCase());
  const numeros = ajustes.cierre_whatsapp.split(/[,;\s]+/).map((x) => x.replace(/\D/g, '')).filter((x) => x.length >= 10);
  const correos = ajustes.cierre_email.split(/[,;\s]+/).map((x) => x.trim()).filter((x) => /@/.test(x));
  const enviados: string[] = [];
  const fallidos: string[] = [];
  for (const n of numeros) {
    try { if (await enviarWhatsApp(n, texto)) enviados.push(`WhatsApp +${n}`); else fallidos.push(`WhatsApp +${n} (no hay WhatsApp vinculado)`); } catch (e) { fallidos.push(`WhatsApp +${n}: ${(e as Error).message}`); }
  }
  for (const c of correos) {
    try { if (await enviarEmail(c, `Cierre del día ${String(d.fecha).slice(0, 10)}`, texto)) enviados.push(c); else fallidos.push(`${c} (correo no configurado)`); } catch (e) { fallidos.push(`${c}: ${(e as Error).message}`); }
  }
  return { fecha: String(d.fecha).slice(0, 10), texto, enviados, fallidos, sin_destinos: !numeros.length && !correos.length };
}

/** Lo llama el cron cada hora: a la hora configurada manda el cierre de la jornada que terminó (una sola vez) */
export async function cierreDiarioProgramado() {
  const ajustes = await leerAjustes();
  if (!ajustes.cierre_whatsapp.trim() && !ajustes.cierre_email.trim()) return null;
  const [{ hora, hoy, ayer }] = await query<{ hora: number; hoy: string; ayer: string }>(
    `SELECT extract(hour FROM now() AT TIME ZONE '${TZ}')::int AS hora, (${JORNADA_HOY})::text AS hoy, (${JORNADA_HOY} - 1)::text AS ayer`);
  if (hora !== Number(ajustes.cierre_hora)) return null;
  // La jornada va de 6 a. m. a 6 a. m.: antes de las 6 todavía es la noche de «hoy»; desde las 6, la que terminó es la de ayer
  const fecha = hora < 6 ? hoy : ayer;
  const [ya] = await query(`SELECT 1 FROM ajustes WHERE clave = 'cierre_ultimo' AND valor = to_jsonb($1::text)`, [fecha]);
  if (ya) return null;
  const r = await enviarCierreDiario(fecha);
  await query(`INSERT INTO ajustes (clave, valor) VALUES ('cierre_ultimo', to_jsonb($1::text)) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`, [fecha]);
  return r;
}
