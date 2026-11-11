-- =====================================================================
--  MENÚ REAL DE COCINA: Entradas y Hamburguesas (precios en COP)
--  Idempotente: se puede correr varias veces; actualiza nombre, descripción
--  y precio si el producto ya existe (se identifica por su slug).
-- =====================================================================
BEGIN;

INSERT INTO categorias_menu (slug, nombre, tipo, estacion, icono, orden, activo) VALUES
  ('entradas',     'Entradas',     'comida', 'cocina', '🍟', 5, true),
  ('hamburguesas', 'Hamburguesas', 'comida', 'cocina', '🍔', 6, true)
ON CONFLICT (slug) DO UPDATE SET nombre = EXCLUDED.nombre, tipo = EXCLUDED.tipo, estacion = EXCLUDED.estacion,
  icono = EXCLUDED.icono, activo = true;

WITH datos (categoria, slug, nombre, descripcion, etiquetas, destacado, orden, presentacion, precio) AS (VALUES
  -- Entradas
  ('entradas', 'servicio-tequenos',      'Servicio de tequeños',      '10 unidades', '{}'::text[], false, 1, 'Porción', 20000),
  ('entradas', 'servicio-nuggets',       'Servicio de nuggets',       '10 unidades', '{}', false, 2, 'Porción', 23000),
  ('entradas', 'chicharron-carnudo',     'Chicharrón carnudo',        'Con palitos de yuca', '{}', false, 3, 'Porción', 30000),
  ('entradas', 'choripapas',             'Choripapas',                'Chorizo en rodajas acompañado de papas fritas', '{}', false, 4, 'Porción', 28000),
  ('entradas', 'servicio-chorizo',       'Servicio de chorizo',       'Con jamón ahumado y palitos de yuca', '{}', false, 5, 'Porción', 20000),
  ('entradas', 'servicio-salchipapas',   'Servicio de salchipapas',   'Queso fundido americano y bacon', '{}', false, 6, 'Porción', 25000),
  ('entradas', 'servicio-morcillitas',   'Servicio de morcillitas',   'Morcillas fritas acompañadas de deditos de yuca o papa', '{}', false, 7, 'Porción', 30000),
  ('entradas', 'servicio-papas-fritas',  'Servicio de papas fritas',  NULL, '{}', false, 8, 'Porción', 8000),
  -- Hamburguesas
  ('hamburguesas', 'hamburguesa-la-clasica', 'La Clásica',
   'Croqueta de carne de res 150 g, lechuga, tomate, cebolla confitada, bacon, queso fundido, huevo y salsa de la casa. Acompañada de porción de papas fritas.',
   '{promo}', true, 1, 'Unidad', 22000),
  ('hamburguesas', 'hamburguesa-la-especial', 'La Especial',
   'Croqueta de carne de res 180 g, lechuga, tomate, pepinillo, cebolla confitada, bacon, huevo y queso fundido. Acompañada de porción de papas fritas.',
   '{}', false, 2, 'Unidad', 28000),
  ('hamburguesas', 'hamburguesa-lomito-prestige', 'Lomito Prestige',
   'Lomo de carne de res 180 g, lechuga, tomate, pepinillo, cebolla confitada, bacon, huevo, queso fundido y salsa de la casa. Acompañada de porción de papas fritas.',
   '{}', false, 3, 'Unidad', 28000),
  ('hamburguesas', 'hamburguesa-crispy-chicken', 'Crispy Chicken',
   'Pechuga de pollo crujiente 200 g, lechuga, tomate, pepinillo, cebolla confitada, bacon, queso fundido, huevo, miel, mostaza y salsa de la casa. Acompañada de porción de papas fritas y un vaso de refresco.',
   '{}', false, 4, 'Unidad', 28000),
  ('hamburguesas', 'hamburguesa-grilled-chicken', 'Grilled Chicken',
   'Pechuga de pollo a la parrilla 200 g, lechuga, tomate, pepinillo, cebolla confitada, bacon, queso fundido y salsa de la casa. Acompañada de porción de papas fritas.',
   '{}', false, 5, 'Unidad', 28000),
  ('hamburguesas', 'hamburguesa-mamba-deluxe', 'Mamba Deluxe',
   'Croqueta de carne de res 180 g, chuleta ahumada, doble bacon, doble queso fundido, huevo, lechuga, tomate, cebolla confitada, pepinillos y salsa de la casa. Acompañada de porción de papas fritas.',
   '{}', true, 6, 'Unidad', 30000),
  ('hamburguesas', 'hamburguesa-mamba-black', 'Mamba Black',
   'Lomito de res 180 g, pechuga de pollo al grill 150 g, doble bacon, doble queso fundido, huevo, lechuga, tomate, cebolla confitada, pepinillo y salsa de la casa. Acompañada de porción de papas fritas y un vaso de refresco.',
   '{}', true, 7, 'Unidad', 37000),
  ('hamburguesas', 'hamburguesa-mamba-premium', 'Mamba Premium',
   'Croqueta de carne de res 180 g, pechuga crispy 200 g, chorizo ahumado, doble bacon, doble huevo, doble queso fundido, lechuga, tomate, pepinillos, cebolla confitada y salsa de la casa. Acompañada de porción de papas fritas.',
   '{}', true, 8, 'Unidad', 40000),
  ('hamburguesas', 'hamburguesa-mamba-supreme', 'Mamba Supreme',
   'Chicharrón al barril, chorizo ahumado, chuleta ahumada, huevo, bacon, queso asado, salsa de la casa, lechuga, tomate, cebolla y pepinillos. Acompañada de porción de papas fritas y un vaso de refresco.',
   '{}', true, 9, 'Unidad', 37000)
), prods AS (
  INSERT INTO productos (categoria_id, slug, nombre, descripcion, etiquetas, destacado, orden, moneda_base, disponible, visible_web, visible_pos)
  SELECT c.id, d.slug, d.nombre, d.descripcion, d.etiquetas, d.destacado, d.orden, 'COP', true, true, true
    FROM datos d JOIN categorias_menu c ON c.slug = d.categoria
  ON CONFLICT (slug) DO UPDATE SET categoria_id = EXCLUDED.categoria_id, nombre = EXCLUDED.nombre, descripcion = EXCLUDED.descripcion,
    etiquetas = EXCLUDED.etiquetas, destacado = EXCLUDED.destacado, orden = EXCLUDED.orden
  RETURNING id, slug
)
INSERT INTO precios_producto (producto_id, presentacion, precio, orden, activo)
SELECT p.id, d.presentacion, d.precio, 1, true FROM prods p JOIN datos d ON d.slug = p.slug
ON CONFLICT (producto_id, presentacion) DO UPDATE SET precio = EXCLUDED.precio, activo = true;

COMMIT;
