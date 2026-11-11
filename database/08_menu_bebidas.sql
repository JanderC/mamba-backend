-- =====================================================================
--  MENÚ REAL DE BARRA: Micheladas, Shots, Tragos Premium, Malteadas y Cafés fríos (COP)
--  Idempotente: actualiza nombre, descripción y precio si el producto ya existe (por slug).
-- =====================================================================
BEGIN;

INSERT INTO categorias_menu (slug, nombre, tipo, estacion, icono, orden, activo) VALUES
  ('micheladas',     'Micheladas',     'bebida', 'barra', '🍹', 7,  true),
  ('shots',          'Shots',          'bebida', 'barra', '🥃', 8,  true),
  ('tragos-premium', 'Tragos Premium', 'bebida', 'barra', '🥂', 9,  true),
  ('malteadas',      'Malteadas',      'bebida', 'barra', '🥤', 10, true),
  ('cafes-frios',    'Cafés fríos',    'bebida', 'barra', '🧋', 11, true)
ON CONFLICT (slug) DO UPDATE SET nombre = EXCLUDED.nombre, tipo = EXCLUDED.tipo, estacion = EXCLUDED.estacion,
  icono = EXCLUDED.icono, activo = true;

WITH datos (categoria, slug, nombre, descripcion, orden, presentacion, vorden, precio) AS (VALUES
  ('micheladas', 'michelada-la-toxica',    'La Tóxica',    'De frutos rojos', 1, 'Vaso', 1, 15000),
  ('micheladas', 'michelada-la-chingada',  'La Chingada',  'De frutos amarillos', 2, 'Vaso', 1, 15000),
  ('micheladas', 'michelada-la-tochelada', 'La Tochelada', 'Tequila, zumo de limón, hierbabuena y fresas', 3, 'Vaso', 1, 15000),

  ('shots', 'shot-tequila',          'Tequila',          '3 shots por 20.000', 1, '3 shots', 1, 20000),
  ('shots', 'shot-tequila-premium',  'Tequila premium',  NULL, 2, 'Shot', 1, 15000),
  ('shots', 'shot-semen-de-pitufo',  'Semen de pitufo',  NULL, 3, 'Shot', 1, 15000),
  ('shots', 'shot-bazooka',          'Shot Bazooka',     NULL, 4, 'Shot', 1, 15000),
  ('shots', 'shot-jager',            'Shot de Jäger',    NULL, 5, 'Shot', 1, 15000),
  ('shots', 'shot-sambuca',          'Shot de sambuca',  NULL, 6, 'Shot', 1, 10000),

  ('tragos-premium', 'trago-whisky-12',         'Trago de whisky 12 años',          NULL, 1, 'Trago', 1, 18000),
  ('tragos-premium', 'trago-doble-whisky',      'Trago doble de whisky',            NULL, 2, 'Doble', 1, 32000),
  ('tragos-premium', 'trago-black-and-white',   'Trago de Black & White 12 años',   NULL, 3, 'Trago', 1, 15000),
  ('tragos-premium', 'trago-ron-500-linaje',    'Trago de ron 500 Años / Linaje',   NULL, 4, 'Trago', 1, 12000),
  ('tragos-premium', 'trago-ginebra',           'Trago de ginebra',                 NULL, 5, 'Trago', 1, 11000),

  ('malteadas', 'malteada-oreo',  'Malteada de Oreo',  NULL, 1, 'Vaso', 1, 18000),
  ('malteadas', 'malteada-samba', 'Malteada de Samba', NULL, 2, 'Vaso', 1, 13000),
  ('malteadas', 'malteada-fresa', 'Malteada de fresa', NULL, 3, 'Vaso', 1, 13000),

  ('cafes-frios', 'frapuccino',       'Frapuccino',       'Leche, café, leche condensada y crema batida', 1, 'Vaso', 1, 16000),
  ('cafes-frios', 'mocca-frapuccino', 'Mocca Frapuccino', 'Leche, café, cocoa, leche condensada y crema batida', 2, 'Vaso', 1, 13000),
  -- El sabor del granizado se elige como presentación: así la barra sabe cuál preparar
  ('cafes-frios', 'granizado-natural', 'Granizado natural', 'Fresa, parchita, piña o naranja', 3, 'Fresa',    1, 10000),
  ('cafes-frios', 'granizado-natural', 'Granizado natural', 'Fresa, parchita, piña o naranja', 3, 'Parchita', 2, 10000),
  ('cafes-frios', 'granizado-natural', 'Granizado natural', 'Fresa, parchita, piña o naranja', 3, 'Piña',     3, 10000),
  ('cafes-frios', 'granizado-natural', 'Granizado natural', 'Fresa, parchita, piña o naranja', 3, 'Naranja',  4, 10000)
), prods AS (
  INSERT INTO productos (categoria_id, slug, nombre, descripcion, orden, moneda_base, disponible, visible_web, visible_pos)
  SELECT DISTINCT ON (d.slug) c.id, d.slug, d.nombre, d.descripcion, d.orden, 'COP', true, true, true
    FROM datos d JOIN categorias_menu c ON c.slug = d.categoria
  ON CONFLICT (slug) DO UPDATE SET categoria_id = EXCLUDED.categoria_id, nombre = EXCLUDED.nombre,
    descripcion = EXCLUDED.descripcion, orden = EXCLUDED.orden
  RETURNING id, slug
)
INSERT INTO precios_producto (producto_id, presentacion, precio, orden, activo)
SELECT p.id, d.presentacion, d.precio, d.vorden, true FROM prods p JOIN datos d ON d.slug = p.slug
ON CONFLICT (producto_id, presentacion) DO UPDATE SET precio = EXCLUDED.precio, orden = EXCLUDED.orden, activo = true;

COMMIT;
