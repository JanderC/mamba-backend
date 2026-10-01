import { Router } from 'express';
import { query } from '../../db/pool.js';
import { notFound } from '../../utils/http.js';

export const localRouter = Router();

export async function getLocal() {
  const [config] = await query(`SELECT * FROM configuracion_local WHERE id = 1`);
  if (!config) throw notFound('Configuración del local');
  const horarios = await query(
    `SELECT dia_semana, abierto,
            to_char(hora_apertura,'HH24:MI') AS hora_apertura, to_char(hora_cierre,'HH24:MI') AS hora_cierre,
            to_char(cierre_cocina,'HH24:MI') AS cierre_cocina, to_char(cierre_barra,'HH24:MI') AS cierre_barra, nota
       FROM horarios ORDER BY CASE WHEN dia_semana = 0 THEN 7 ELSE dia_semana END`,
  );
  return { ...config, horarios };
}

/** Todo lo que el sitio necesita en el layout: datos del local + horarios */
localRouter.get('/', async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json(await getLocal());
});

localRouter.get('/promociones', async (_req, res) => {
  const rows = await query(
    `SELECT id, titulo, descripcion, imagen_url, dias_semana
       FROM promociones
      WHERE activo
        AND (vigente_desde IS NULL OR vigente_desde <= current_date)
        AND (vigente_hasta IS NULL OR vigente_hasta >= current_date)
      ORDER BY orden`,
  );
  res.json(rows);
});
