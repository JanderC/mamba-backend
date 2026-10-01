-- =====================================================================
--  MAMBA BISTRO BAR 2.0 — Datos iniciales del SISTEMA ADMINISTRATIVO
--  Requiere 03_sistema.sql. Re-ejecutable: no duplica ni pisa lo que ya editaste.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Usuarios  (⚠ contraseña temporal para todos:  Mamba2026*  — cámbiala al entrar)
-- ---------------------------------------------------------------------
INSERT INTO usuarios (nombre, email, password_hash, rol)
SELECT u.nombre, u.email, crypt('Mamba2026*', gen_salt('bf', 10)), u.rol
  FROM (VALUES
    ('Administrador',  'admin@mamba.com',    'admin'),
    ('Caja Principal', 'caja@mamba.com',     'cajero'),
    ('Barra',          'barra@mamba.com',    'barra'),
    ('Cocina',         'cocina@mamba.com',   'cocina'),
    ('Mesonero 1',     'mesonero@mamba.com', 'mesonero'),
    ('RRPP',           'rrpp@mamba.com',     'rrpp')
  ) AS u(nombre, email, rol)
 WHERE NOT EXISTS (SELECT 1 FROM usuarios x WHERE lower(x.email) = lower(u.email));

-- ---------------------------------------------------------------------
-- Ajustes del sistema
-- ---------------------------------------------------------------------
INSERT INTO ajustes (clave, valor, descripcion) VALUES
  ('moneda_principal',          '"COP"', 'Moneda en la que se abren las cuentas y se muestran los precios (USD, COP o VES)'),
  ('servicio_pct',              '10',    'Porcentaje de servicio/propina sugerida'),
  ('servicio_auto_mesas',       'false', 'Aplicar el servicio automáticamente al abrir una cuenta de mesa'),
  ('capacidad_maxima',          '200',   'Aforo máximo del local (personas)'),
  ('permitir_venta_sin_stock',  'false', 'Permitir vender aunque el inventario quede en negativo'),
  ('recordatorio_reserva_horas','3',     'Horas antes de la reserva para avisar al RRPP'),
  ('ticket_pie',                '"¡Gracias por tu visita! 🐍 Muda de piel cada fin de semana."', 'Texto al pie del ticket')
ON CONFLICT (clave) DO NOTHING;

-- ---------------------------------------------------------------------
-- Tasa inicial (referencial). Al arrancar el backend se actualiza sola desde el BCV;
-- también puedes fijarla a mano en Administración → Tasas.
-- ---------------------------------------------------------------------
INSERT INTO tasas_cambio (usd_ves, usd_cop, ves_cop, fuente)
SELECT 100, 4000, 40, 'inicial'
 WHERE NOT EXISTS (SELECT 1 FROM tasas_cambio);

-- ---------------------------------------------------------------------
-- Métodos de pago y cajas
-- ---------------------------------------------------------------------
INSERT INTO metodos_pago (nombre, es_efectivo, monedas, requiere_referencia, orden) VALUES
  ('Efectivo',                 true,  '{COP,USD,VES}', false, 1),
  ('Transferencia Bancolombia',false, '{COP}',         true,  2),
  ('Nequi',                    false, '{COP}',         true,  3),
  ('Pago Móvil',               false, '{VES}',         true,  4),
  ('Punto de Venta',           false, '{VES,COP}',     true,  5),
  ('Zelle',                    false, '{USD}',         true,  6),
  ('Binance / USDT',           false, '{USD}',         true,  7)
ON CONFLICT (nombre) DO NOTHING;

INSERT INTO cajas (nombre, descripcion) VALUES
  ('Caja Principal', 'Cobro de mesas, terraza y zonas VIP'),
  ('Caja Barra',     'Los clientes de barra van cancelando aquí')
ON CONFLICT (nombre) DO NOTHING;

-- ---------------------------------------------------------------------
-- Estaciones de preparación por categoría
-- ---------------------------------------------------------------------
UPDATE categorias_menu SET estacion = 'cocina' WHERE slug IN ('hamburguesas','desgranados','picadas');

-- ---------------------------------------------------------------------
-- Inventario
-- ---------------------------------------------------------------------
INSERT INTO categorias_insumo (nombre, icono) VALUES
  ('Cervezas', '🍺'), ('Licores', '🥃'), ('Mixers y bebidas', '🥤'), ('Cocina', '🍔'), ('Otros', '📦')
ON CONFLICT (nombre) DO NOTHING;

INSERT INTO insumos (codigo, nombre, categoria_insumo_id, unidad, presentacion_compra, factor_compra,
                     stock, stock_minimo, costo_unitario, moneda_costo, recargo_seleccion)
SELECT i.codigo, i.nombre, c.id, i.unidad, i.presentacion, i.factor, i.stock, i.minimo, i.costo, 'COP', i.recargo
  FROM (VALUES
    -- Cervezas (unidad = botella individual)
    ('CER-CLUB', 'Club Colombia Dorada', 'Cervezas', 'und', 'Caja x24', 24, 240, 48, 3200, 0),
    ('CER-AGUI', 'Águila',               'Cervezas', 'und', 'Caja x24', 24, 240, 48, 3000, 0),
    ('CER-POKE', 'Poker',                'Cervezas', 'und', 'Caja x24', 24, 192, 48, 2900, 0),
    ('CER-HEIN', 'Heineken',             'Cervezas', 'und', 'Caja x24', 24,  96, 24, 5500, 2000),
    ('CER-CORO', 'Corona',               'Cervezas', 'und', 'Caja x24', 24, 120, 24, 6000, 3000),
    ('CER-STEL', 'Stella Artois',        'Cervezas', 'und', 'Caja x24', 24,  96, 24, 6200, 3000),
    -- Licores (unidad = ml; se compran por botella de 750 ml)
    ('LIC-BUCH12', 'Buchanan''s 12 años',              'Licores', 'ml', 'Botella 750 ml', 750,  9000, 2250, 240.00, 0),
    ('LIC-OLDP12', 'Old Parr 12 años',                 'Licores', 'ml', 'Botella 750 ml', 750,  9000, 2250, 226.67, 0),
    ('LIC-JWBL',   'Johnnie Walker Black Label',       'Licores', 'ml', 'Botella 750 ml', 750,  7500, 2250, 253.33, 0),
    ('LIC-DJ70',   'Don Julio 70',                     'Licores', 'ml', 'Botella 750 ml', 750,  4500, 1500, 386.67, 0),
    ('LIC-JCUE',   'José Cuervo Especial',             'Licores', 'ml', 'Botella 750 ml', 750,  9000, 2250, 146.67, 0),
    ('LIC-RM8',    'Ron Medellín 8 años',              'Licores', 'ml', 'Botella 750 ml', 750,  9000, 2250, 113.33, 0),
    ('LIC-AGUA',   'Aguardiente Antioqueño Sin Azúcar','Licores', 'ml', 'Botella 750 ml', 750, 18000, 3750,  80.00, 0),
    ('LIC-HEND',   'Hendrick''s Gin',                  'Licores', 'ml', 'Botella 750 ml', 750,  4500, 1500, 280.00, 0),
    ('LIC-MEZC',   'Mezcal (casa)',                    'Licores', 'ml', 'Botella 750 ml', 750,  3750, 1500, 200.00, 0),
    ('LIC-GINC',   'Ginebra (casa)',                   'Licores', 'ml', 'Botella 750 ml', 750,  4500, 1500, 106.67, 0),
    ('LIC-RONB',   'Ron blanco (casa)',                'Licores', 'ml', 'Botella 750 ml', 750,  6000, 1500,  66.67, 0),
    ('LIC-VODK',   'Vodka (casa)',                     'Licores', 'ml', 'Botella 750 ml', 750,  6000, 1500,  80.00, 0),
    ('LIC-TRIP',   'Triple sec',                       'Licores', 'ml', 'Botella 750 ml', 750,  3000,  750,  60.00, 0),
    -- Mixers y bebidas
    ('MIX-GASP', 'Gaseosa personal', 'Mixers y bebidas', 'und', 'Paca x12', 12, 144, 36, 2200, 0),
    ('MIX-GASL', 'Gaseosa litro',    'Mixers y bebidas', 'und', 'Paca x12', 12,  72, 24, 4500, 0),
    ('MIX-AGUA', 'Agua',             'Mixers y bebidas', 'und', 'Paca x24', 24, 120, 24, 1500, 0),
    ('MIX-REDB', 'Red Bull',         'Mixers y bebidas', 'und', 'Caja x24', 24,  96, 24, 7000, 0),
    ('MIX-TONI', 'Agua tónica',      'Mixers y bebidas', 'und', 'Paca x12', 12,  60, 12, 2800, 0),
    -- Cocina
    ('COC-PAN',   'Pan brioche',            'Cocina', 'und', 'Bolsa x8',     8,   120,   24, 1500, 0),
    ('COC-CARNE', 'Carne de res 150 g',     'Cocina', 'und', 'Unidad',       1,   150,   30, 4500, 0),
    ('COC-POLLO', 'Pechuga apanada',        'Cocina', 'und', 'Unidad',       1,    60,   15, 4000, 0),
    ('COC-CHED',  'Queso cheddar (lonja)',  'Cocina', 'und', 'Paquete x50', 50,   300,   50,  700, 0),
    ('COC-HUEV',  'Huevo',                  'Cocina', 'und', 'Cubeta x30',  30,    90,   30,  600, 0),
    ('COC-ALIT',  'Alitas de pollo',        'Cocina', 'und', 'Bolsa x40',   40,   400,   80,  900, 0),
    ('COC-TOCI',  'Tocineta',               'Cocina', 'g',   'Paquete 1 kg',1000, 6000, 1000,   45, 0),
    ('COC-CEBC',  'Cebolla crispy',         'Cocina', 'g',   'Bolsa 1 kg',  1000, 3000,  500,   30, 0),
    ('COC-LECH',  'Lechuga',                'Cocina', 'g',   'Kilo',        1000, 3000,  500,    6, 0),
    ('COC-TOMA',  'Tomate',                 'Cocina', 'g',   'Kilo',        1000, 4000,  500,    5, 0),
    ('COC-PEPI',  'Pepinillos',             'Cocina', 'g',   'Frasco 1 kg', 1000, 2000,  300,   20, 0),
    ('COC-JALA',  'Jalapeños',              'Cocina', 'g',   'Frasco 1 kg', 1000, 2000,  300,   22, 0),
    ('COC-GUAC',  'Guacamole',              'Cocina', 'g',   'Kilo',        1000, 3000,  500,   25, 0),
    ('COC-SALS',  'Salsa de la casa',       'Cocina', 'g',   'Kilo',        1000, 4000,  500,   12, 0),
    ('COC-PAPA',  'Papa a la francesa',     'Cocina', 'g',   'Bolsa 2.5 kg',2500,30000, 5000,    8, 0),
    ('COC-MAIZ',  'Maíz tierno',            'Cocina', 'g',   'Kilo',        1000,15000, 3000,    9, 0)
  ) AS i(codigo, nombre, categoria, unidad, presentacion, factor, stock, minimo, costo, recargo)
  JOIN categorias_insumo c ON c.nombre = i.categoria
ON CONFLICT (codigo) DO NOTHING;

-- Kardex: registra el inventario inicial de lo que aún no tenga movimientos
INSERT INTO movimientos_inventario (insumo_id, tipo, cantidad, stock_resultante, costo_unitario, moneda_costo, nota)
SELECT i.id, 'entrada', i.stock, i.stock, i.costo_unitario, i.moneda_costo, 'Inventario inicial'
  FROM insumos i
 WHERE i.stock > 0 AND NOT EXISTS (SELECT 1 FROM movimientos_inventario m WHERE m.insumo_id = i.id);

-- ---------------------------------------------------------------------
-- Tobos de cerveza: 10 unidades, de una marca o SURTIDAS (se eligen de las cervezas en inventario)
-- ---------------------------------------------------------------------
UPDATE productos
   SET nombre = 'Tobo de Cervezas x10',
       descripcion = 'Diez cervezas bien frías en hielo. Llévalas de una sola marca o surtidas a tu gusto.'
 WHERE slug = 'cubeta';

UPDATE precios_producto pr
   SET presentacion = 'Tobo x10', precio = 75000,
       seleccion_categoria_insumo_id = (SELECT id FROM categorias_insumo WHERE nombre = 'Cervezas'),
       seleccion_cantidad = 10
  FROM productos p
 WHERE p.id = pr.producto_id AND p.slug = 'cubeta' AND pr.seleccion_cantidad IS NULL;

UPDATE productos
   SET nombre = 'Combo Tobo + Alitas', descripcion = 'Tobo de 10 cervezas surtidas + Alitas x16.'
 WHERE slug = 'combo-cerveza';

UPDATE precios_producto pr
   SET precio = 118000,
       seleccion_categoria_insumo_id = (SELECT id FROM categorias_insumo WHERE nombre = 'Cervezas'),
       seleccion_cantidad = 10
  FROM productos p
 WHERE p.id = pr.producto_id AND p.slug = 'combo-cerveza' AND pr.seleccion_cantidad IS NULL;

-- ---------------------------------------------------------------------
-- Recetas: qué descuenta cada producto del inventario
--   (producto, presentación, insumo, cantidad, ¿el cliente lo puede quitar?, etiqueta)
-- ---------------------------------------------------------------------
INSERT INTO receta_items (precio_producto_id, insumo_id, cantidad, removible, etiqueta, orden)
SELECT pr.id, i.id, r.cantidad, r.removible, r.etiqueta, r.orden
  FROM (VALUES
    -- Cervezas
    ('club-colombia', 'Botella', 'CER-CLUB', 1, false, NULL, 1),
    ('aguila',        'Botella', 'CER-AGUI', 1, false, NULL, 1),
    ('corona',        'Botella', 'CER-CORO', 1, false, NULL, 1),
    ('stella-artois', 'Botella', 'CER-STEL', 1, false, NULL, 1),
    -- Licores: botella 750 ml · media 375 ml · trago 45 ml
    ('buchanans-12', 'Botella', 'LIC-BUCH12', 750, false, NULL, 1), ('buchanans-12', 'Media', 'LIC-BUCH12', 375, false, NULL, 1), ('buchanans-12', 'Trago', 'LIC-BUCH12', 45, false, NULL, 1),
    ('old-parr-12',  'Botella', 'LIC-OLDP12', 750, false, NULL, 1), ('old-parr-12',  'Media', 'LIC-OLDP12', 375, false, NULL, 1), ('old-parr-12',  'Trago', 'LIC-OLDP12', 45, false, NULL, 1),
    ('jw-black-label','Botella','LIC-JWBL',   750, false, NULL, 1), ('jw-black-label','Media','LIC-JWBL',   375, false, NULL, 1), ('jw-black-label','Trago','LIC-JWBL',   45, false, NULL, 1),
    ('don-julio-70', 'Botella', 'LIC-DJ70',   750, false, NULL, 1), ('don-julio-70', 'Trago', 'LIC-DJ70',   45, false, NULL, 1),
    ('jose-cuervo-especial','Botella','LIC-JCUE',750,false,NULL,1), ('jose-cuervo-especial','Media','LIC-JCUE',375,false,NULL,1), ('jose-cuervo-especial','Trago','LIC-JCUE',45,false,NULL,1),
    ('ron-medellin-8','Botella','LIC-RM8',    750, false, NULL, 1), ('ron-medellin-8','Media','LIC-RM8',    375, false, NULL, 1), ('ron-medellin-8','Trago','LIC-RM8',    45, false, NULL, 1),
    ('aguardiente-antioqueno','Botella','LIC-AGUA',750,false,NULL,1), ('aguardiente-antioqueno','Media','LIC-AGUA',375,false,NULL,1), ('aguardiente-antioqueno','Trago','LIC-AGUA',45,false,NULL,1),
    ('hendricks',    'Botella', 'LIC-HEND',   750, false, NULL, 1), ('hendricks',    'Trago', 'LIC-HEND',   45, false, NULL, 1),
    -- Coctelería
    ('veneno-de-mamba', 'Coctel', 'LIC-MEZC', 60, false, NULL, 1),
    ('piel-esmeralda',  'Coctel', 'LIC-GINC', 60, false, NULL, 1), ('piel-esmeralda', 'Coctel', 'MIX-TONI', 1, false, NULL, 2),
    ('mordida-dorada',  'Coctel', 'LIC-RM8',  60, false, NULL, 1),
    ('muda-de-piel',    'Coctel', 'LIC-VODK', 60, false, NULL, 1),
    ('mojito',          'Coctel', 'LIC-RONB', 60, false, NULL, 1), ('mojito',    'Jarra', 'LIC-RONB', 240, false, NULL, 1),
    ('margarita',       'Coctel', 'LIC-JCUE', 50, false, NULL, 1), ('margarita', 'Coctel', 'LIC-TRIP', 20, false, NULL, 2),
    ('margarita',       'Jarra',  'LIC-JCUE', 200, false, NULL, 1), ('margarita', 'Jarra', 'LIC-TRIP', 80, false, NULL, 2),
    -- Sin alcohol
    ('gaseosa',  'Personal', 'MIX-GASP', 1, false, NULL, 1), ('gaseosa', 'Litro', 'MIX-GASL', 1, false, NULL, 1),
    ('agua',     'Botella',  'MIX-AGUA', 1, false, NULL, 1),
    ('red-bull', 'Lata',     'MIX-REDB', 1, false, NULL, 1),
    -- Hamburguesas (removible = se puede pedir "sin")
    ('la-mamba', 'Con papas', 'COC-PAN',   1,   false, NULL, 1),
    ('la-mamba', 'Con papas', 'COC-CARNE', 2,   false, NULL, 2),
    ('la-mamba', 'Con papas', 'COC-CHED',  2,   true,  'Queso cheddar', 3),
    ('la-mamba', 'Con papas', 'COC-TOCI',  40,  true,  'Tocineta caramelizada', 4),
    ('la-mamba', 'Con papas', 'COC-CEBC',  20,  true,  'Cebolla crispy', 5),
    ('la-mamba', 'Con papas', 'COC-SALS',  30,  true,  'Salsa de la casa', 6),
    ('la-mamba', 'Con papas', 'COC-PAPA',  150, true,  'Papas a la francesa', 7),
    ('cobra-picante', 'Con papas', 'COC-PAN',   1,   false, NULL, 1),
    ('cobra-picante', 'Con papas', 'COC-CARNE', 1,   false, NULL, 2),
    ('cobra-picante', 'Con papas', 'COC-CHED',  1,   true,  'Queso pepper jack', 3),
    ('cobra-picante', 'Con papas', 'COC-JALA',  20,  true,  'Jalapeños', 4),
    ('cobra-picante', 'Con papas', 'COC-GUAC',  40,  true,  'Guacamole', 5),
    ('cobra-picante', 'Con papas', 'COC-SALS',  30,  true,  'Chipotle', 6),
    ('cobra-picante', 'Con papas', 'COC-PAPA',  150, true,  'Papas a la francesa', 7),
    ('clasica', 'Con papas', 'COC-PAN',   1,   false, NULL, 1),
    ('clasica', 'Con papas', 'COC-CARNE', 1,   false, NULL, 2),
    ('clasica', 'Con papas', 'COC-CHED',  1,   true,  'Queso', 3),
    ('clasica', 'Con papas', 'COC-LECH',  20,  true,  'Lechuga', 4),
    ('clasica', 'Con papas', 'COC-TOMA',  30,  true,  'Tomate', 5),
    ('clasica', 'Con papas', 'COC-SALS',  30,  true,  'Salsas', 6),
    ('clasica', 'Con papas', 'COC-PAPA',  150, true,  'Papas a la francesa', 7),
    ('pollo-crispy', 'Con papas', 'COC-PAN',   1,   false, NULL, 1),
    ('pollo-crispy', 'Con papas', 'COC-POLLO', 1,   false, NULL, 2),
    ('pollo-crispy', 'Con papas', 'COC-LECH',  30,  true,  'Coleslaw', 3),
    ('pollo-crispy', 'Con papas', 'COC-PEPI',  15,  true,  'Pepinillos', 4),
    ('pollo-crispy', 'Con papas', 'COC-SALS',  30,  true,  'Mayo de miel mostaza', 5),
    ('pollo-crispy', 'Con papas', 'COC-PAPA',  150, true,  'Papas a la francesa', 6),
    -- Cocina varios
    ('alitas', 'x8',  'COC-ALIT', 8,  false, NULL, 1), ('alitas', 'x16', 'COC-ALIT', 16, false, NULL, 1),
    ('combo-cerveza', 'Combo', 'COC-ALIT', 16, false, NULL, 1),
    ('desgranado-mamba', 'Personal', 'COC-MAIZ', 250, false, NULL, 1), ('desgranado-mamba', 'Para compartir', 'COC-MAIZ', 450, false, NULL, 1),
    ('desgranado-mamba', 'Personal', 'COC-TOCI', 30, true, 'Tocineta', 2), ('desgranado-mamba', 'Para compartir', 'COC-TOCI', 60, true, 'Tocineta', 2),
    ('desgranado-pollo', 'Personal', 'COC-MAIZ', 250, false, NULL, 1), ('desgranado-pollo', 'Para compartir', 'COC-MAIZ', 450, false, NULL, 1),
    ('salchipapa-mamba', 'Personal', 'COC-PAPA', 300, false, NULL, 1), ('salchipapa-mamba', 'Para compartir', 'COC-PAPA', 550, false, NULL, 1)
  ) AS r(producto, presentacion, insumo, cantidad, removible, etiqueta, orden)
  JOIN productos p         ON p.slug = r.producto
  JOIN precios_producto pr ON pr.producto_id = p.id AND pr.presentacion = r.presentacion
  JOIN insumos i           ON i.codigo = r.insumo
ON CONFLICT (precio_producto_id, insumo_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- Adicionales (tienen su propio precio) y en qué categorías se ofrecen
-- ---------------------------------------------------------------------
INSERT INTO adicionales (nombre, precio, moneda_base, insumo_id, cantidad_insumo, orden)
SELECT a.nombre, a.precio, 'COP', i.id, a.cantidad, a.orden
  FROM (VALUES
    ('Extra queso cheddar', 4000, 'COC-CHED',  1,   1),
    ('Extra tocineta',      5000, 'COC-TOCI',  40,  2),
    ('Carne adicional',     9000, 'COC-CARNE', 1,   3),
    ('Huevo frito',         3000, 'COC-HUEV',  1,   4),
    ('Extra guacamole',     4000, 'COC-GUAC',  40,  5),
    ('Jalapeños',           2500, 'COC-JALA',  20,  6),
    ('Papas adicionales',   7000, 'COC-PAPA',  150, 7),
    ('Shot extra',          9000, NULL,        1,   8),
    ('Escarchado de tajín', 2000, NULL,        1,   9),
    ('Michelado',           4000, NULL,        1,   10)
  ) AS a(nombre, precio, insumo, cantidad, orden)
  LEFT JOIN insumos i ON i.codigo = a.insumo
ON CONFLICT (nombre) DO NOTHING;

INSERT INTO adicional_categorias (adicional_id, categoria_id)
SELECT a.id, c.id
  FROM (VALUES
    ('Extra queso cheddar', 'hamburguesas'), ('Extra queso cheddar', 'desgranados'), ('Extra queso cheddar', 'picadas'),
    ('Extra tocineta', 'hamburguesas'), ('Extra tocineta', 'desgranados'),
    ('Carne adicional', 'hamburguesas'),
    ('Huevo frito', 'hamburguesas'), ('Huevo frito', 'desgranados'),
    ('Extra guacamole', 'hamburguesas'), ('Extra guacamole', 'picadas'),
    ('Jalapeños', 'hamburguesas'), ('Jalapeños', 'picadas'),
    ('Papas adicionales', 'hamburguesas'), ('Papas adicionales', 'picadas'),
    ('Shot extra', 'cocteleria-autor'),
    ('Escarchado de tajín', 'cocteleria-autor'), ('Escarchado de tajín', 'cervezas'),
    ('Michelado', 'cervezas')
  ) AS x(adicional, categoria)
  JOIN adicionales a     ON a.nombre = x.adicional
  JOIN categorias_menu c ON c.slug = x.categoria
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- Salón: 200 personas → 28 puntos de servicio con asientos numerados
--   Salón General 16×6 = 96 · Terraza 8×6 = 48 · VIP Esmeralda 2×10 = 20
--   VIP Oro 1×16 = 16 · Barra 20 taburetes = 20
-- ---------------------------------------------------------------------
INSERT INTO zonas (slug, nombre, descripcion, capacidad_mesa, max_personas, consumo_minimo_cop, es_vip, reservable, orden)
VALUES ('barra', 'Barra', 'Taburetes frente a la barra principal. Se paga al momento.', 1, 20, 0, false, false, 0)
ON CONFLICT (slug) DO NOTHING;

UPDATE zonas SET color = v.color
  FROM (VALUES ('barra', '#3dffb0'), ('salon-general', '#12805a'), ('terraza', '#4aa3df'),
               ('vip-esmeralda', '#d4af37'), ('vip-oro', '#f6e3a1')) AS v(slug, color)
 WHERE zonas.slug = v.slug;

INSERT INTO mesas (zona_id, numero, nombre, tipo, forma, capacidad, pos_x, pos_y)
SELECT z.id, m.numero, m.nombre, m.tipo, m.forma, m.capacidad, m.x, m.y
  FROM (
    -- Salón General: mesas 1–16 en cuadrícula 4×4
    SELECT 'salon-general' AS zona, n AS numero, NULL::text AS nombre, 'mesa' AS tipo, 'redonda' AS forma, 6 AS capacidad,
           (14 + ((n - 1) % 4) * 24)::numeric AS x, (16 + ((n - 1) / 4) * 23)::numeric AS y
      FROM generate_series(1, 16) n
    UNION ALL
    -- Terraza: mesas 17–24 en 2 filas de 4
    SELECT 'terraza', n, NULL, 'mesa', 'cuadrada', 6,
           (14 + ((n - 17) % 4) * 24)::numeric, (30 + ((n - 17) / 4) * 40)::numeric
      FROM generate_series(17, 24) n
    UNION ALL
    SELECT 'vip-esmeralda', 25, 'Palco Esmeralda I',  'vip', 'rectangular', 10, 30, 50
    UNION ALL
    SELECT 'vip-esmeralda', 26, 'Palco Esmeralda II', 'vip', 'rectangular', 10, 70, 50
    UNION ALL
    SELECT 'vip-oro', 27, 'Nido de la Mamba', 'vip', 'rectangular', 16, 50, 50
    UNION ALL
    SELECT 'barra', 28, 'Barra principal', 'barra', 'barra', 20, 50, 50
  ) m
  JOIN zonas z ON z.slug = m.zona
ON CONFLICT (numero) DO NOTHING;

-- ---------------------------------------------------------------------
-- Recordatorios internos de ejemplo (ligados al próximo evento)
-- ---------------------------------------------------------------------
INSERT INTO recordatorios (titulo, detalle, vence_en, evento_id, prioridad)
SELECT r.titulo, r.detalle, e.inicia_en - r.antes, e.id, r.prioridad
  FROM (SELECT id, inicia_en FROM eventos WHERE estado = 'publicado' AND inicia_en > now() ORDER BY inicia_en LIMIT 1) e
 CROSS JOIN (VALUES
    ('Publicar flyer en Instagram y TikTok', 'Historia + post fijado. Etiquetar al DJ.',            interval '3 days',  'alta'),
    ('Confirmar DJ y prueba de sonido',      'Llamar al DJ y coordinar hora de llegada.',           interval '1 day',   'alta'),
    ('Pedir hielo y revisar stock de cerveza','Revisar alertas de inventario antes de la apertura.', interval '8 hours', 'normal')
  ) AS r(titulo, detalle, antes, prioridad)
 WHERE NOT EXISTS (SELECT 1 FROM recordatorios);

COMMIT;
