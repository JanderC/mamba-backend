import { Router } from 'express';
import { query } from '../../db/pool.js';

export const menuRouter = Router();

/** Menú completo agrupado por categoría (una sola consulta, ideal para el QR en mesa) */
menuRouter.get('/', async (_req, res) => {
  const rows = await query(`
    SELECT c.slug, c.nombre, c.descripcion, c.tipo, c.icono,
           COALESCE(json_agg(json_build_object(
             'id', v.producto_id, 'slug', v.slug, 'nombre', v.nombre, 'descripcion', v.descripcion,
             'ingredientes', v.ingredientes, 'imagen_url', v.imagen_url, 'etiquetas', v.etiquetas,
             'destacado', v.destacado, 'precios', v.precios
           ) ORDER BY v.orden, v.nombre) FILTER (WHERE v.producto_id IS NOT NULL), '[]') AS productos
      FROM categorias_menu c
      LEFT JOIN v_menu v ON v.categoria_id = c.id
     WHERE c.activo
     GROUP BY c.id
     ORDER BY c.orden`);
  res.set('Cache-Control', 'public, max-age=60');
  res.json(rows);
});

menuRouter.get('/destacados', async (_req, res) => {
  const rows = await query(
    `SELECT producto_id AS id, slug, nombre, descripcion, categoria, icono, etiquetas, precios, imagen_url
       FROM v_menu WHERE destacado ORDER BY categoria_orden, orden LIMIT 8`,
  );
  res.json(rows);
});
