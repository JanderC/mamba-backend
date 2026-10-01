const cop = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
export const formatCOP = (v: number) => cop.format(v);

export const MOTIVOS: Record<string, string> = {
  cumpleanos: 'Cumpleaños 🎂',
  corporativo: 'Evento corporativo 💼',
  casual: 'Salida casual 🍸',
  despedida: 'Despedida 🎉',
  aniversario: 'Aniversario 💍',
  otro: 'Otro',
};

export function formatFecha(fecha: string) {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('es-CO', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
}

export function formatHora(hora: string) {
  const [h, m] = hora.split(':').map(Number);
  const suf = h >= 12 ? 'p.m.' : 'a.m.';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${suf}`;
}
