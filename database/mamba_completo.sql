-- =====================================================================
--  MAMBA BISTRO BAR 2.0 — SCRIPT COMPLETO (esquema + datos iniciales)
--  Pégalo completo en el Query Tool de pgAdmin o en el SQL Editor de Neon.
-- =====================================================================

-- =====================================================================
--  MAMBA BISTRO BAR 2.0 — Esquema de base de datos (PostgreSQL 14+)
--  Compatible con PostgreSQL local (pgAdmin) y Neon.
--  Ejecutar primero este archivo y luego 02_seed.sql
-- =====================================================================

BEGIN;

-- Limpieza (permite re-ejecutar el script desde cero) ------------------
DROP VIEW  IF EXISTS v_reservas_detalle, v_menu, v_eventos_proximos CASCADE;
DROP TABLE IF EXISTS
  reservas, politicas_reserva, zonas,
  artistas_evento, eventos,
  precios_producto, productos, categorias_menu,
  promociones, galeria, horarios, configuracion_local
CASCADE;
DROP TYPE IF EXISTS estado_reserva, motivo_reserva, estado_evento, tipo_media, fuente_media CASCADE;
DROP FUNCTION IF EXISTS fn_set_actualizado_en() CASCADE;
DROP FUNCTION IF EXISTS fn_generar_codigo_reserva() CASCADE;
DROP SEQUENCE IF EXISTS seq_codigo_reserva;

-- Tipos -------------------------------------------------------------------
CREATE TYPE estado_reserva AS ENUM ('pendiente','confirmada','rechazada','cancelada','asistio','no_asistio');
CREATE TYPE motivo_reserva AS ENUM ('cumpleanos','corporativo','casual','despedida','aniversario','otro');
CREATE TYPE estado_evento  AS ENUM ('borrador','publicado','cancelado');
CREATE TYPE tipo_media     AS ENUM ('foto','video','reel');
CREATE TYPE fuente_media   AS ENUM ('local','instagram','tiktok');

-- Utilidades --------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_set_actualizado_en() RETURNS trigger AS $$
BEGIN
  NEW.actualizado_en := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
--  CONFIGURACIÓN DEL LOCAL (una sola fila)
-- =====================================================================
CREATE TABLE configuracion_local (
  id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  nombre           text        NOT NULL,
  eslogan          text,
  descripcion      text,
  direccion        text        NOT NULL,
  ciudad           text        NOT NULL,
  departamento     text,
  pais             text        NOT NULL DEFAULT 'Colombia',
  latitud          numeric(9,6),
  longitud         numeric(9,6),
  whatsapp         text        NOT NULL,            -- formato internacional sin '+', ej: 573001234567
  telefono         text,
  email_reservas   text,
  instagram        text,
  tiktok           text,
  facebook         text,
  dress_code       text,
  edad_minima      smallint    NOT NULL DEFAULT 18,
  actualizado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_configuracion_local_upd BEFORE UPDATE ON configuracion_local
  FOR EACH ROW EXECUTE FUNCTION fn_set_actualizado_en();

-- =====================================================================
--  HORARIOS
-- =====================================================================
CREATE TABLE horarios (
  id                 smallserial PRIMARY KEY,
  dia_semana         smallint NOT NULL UNIQUE CHECK (dia_semana BETWEEN 0 AND 6), -- 0=domingo … 6=sábado
  abierto            boolean  NOT NULL DEFAULT true,
  hora_apertura      time,
  hora_cierre        time,        -- puede ser menor que apertura (cierra al día siguiente)
  cierre_cocina      time,
  cierre_barra       time,
  nota               text,
  CHECK (NOT abierto OR (hora_apertura IS NOT NULL AND hora_cierre IS NOT NULL))
);

-- =====================================================================
--  MENÚ
-- =====================================================================
CREATE TABLE categorias_menu (
  id             serial PRIMARY KEY,
  slug           text    NOT NULL UNIQUE,
  nombre         text    NOT NULL,
  descripcion    text,
  tipo           text    NOT NULL CHECK (tipo IN ('bebida','comida','combo')),
  icono          text,                    -- emoji o nombre de icono
  orden          smallint NOT NULL DEFAULT 0,
  activo         boolean  NOT NULL DEFAULT true,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_categorias_menu_upd BEFORE UPDATE ON categorias_menu
  FOR EACH ROW EXECUTE FUNCTION fn_set_actualizado_en();

CREATE TABLE productos (
  id             serial PRIMARY KEY,
  categoria_id   integer NOT NULL REFERENCES categorias_menu(id) ON DELETE RESTRICT,
  slug           text    NOT NULL UNIQUE,
  nombre         text    NOT NULL,
  descripcion    text,
  ingredientes   text[]  NOT NULL DEFAULT '{}',
  imagen_url     text,
  etiquetas      text[]  NOT NULL DEFAULT '{}',   -- 'premium','nuevo','picante','para compartir'…
  destacado      boolean NOT NULL DEFAULT false,
  disponible     boolean NOT NULL DEFAULT true,
  orden          smallint NOT NULL DEFAULT 0,
  sku_pos        text UNIQUE,                     -- enlace futuro con el Sistema de Ventas en Tablets
  creado_en      timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_productos_categoria ON productos(categoria_id, orden);
CREATE TRIGGER trg_productos_upd BEFORE UPDATE ON productos
  FOR EACH ROW EXECUTE FUNCTION fn_set_actualizado_en();

CREATE TABLE precios_producto (
  id             serial PRIMARY KEY,
  producto_id    integer NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  presentacion   text    NOT NULL,                -- 'Botella','Media','Trago','Personal','Para compartir'…
  precio_cop     integer NOT NULL CHECK (precio_cop >= 0),
  orden          smallint NOT NULL DEFAULT 0,
  UNIQUE (producto_id, presentacion)
);

-- =====================================================================
--  PROMOCIONES DE LA SEMANA
-- =====================================================================
CREATE TABLE promociones (
  id             serial PRIMARY KEY,
  titulo         text    NOT NULL,
  descripcion    text,
  imagen_url     text,
  dias_semana    smallint[] NOT NULL DEFAULT '{}',   -- vacío = todos los días
  vigente_desde  date,
  vigente_hasta  date,
  activo         boolean NOT NULL DEFAULT true,
  orden          smallint NOT NULL DEFAULT 0,
  CHECK (vigente_hasta IS NULL OR vigente_desde IS NULL OR vigente_hasta >= vigente_desde)
);

-- =====================================================================
--  EVENTOS / CARTELERA
-- =====================================================================
CREATE TABLE eventos (
  id             serial PRIMARY KEY,
  slug           text NOT NULL UNIQUE,
  titulo         text NOT NULL,
  tematica       text,
  descripcion    text,
  flyer_url      text,
  inicia_en      timestamptz NOT NULL,
  termina_en     timestamptz,
  cover_cop      integer CHECK (cover_cop >= 0),   -- NULL o 0 = entrada libre
  nota_cover     text,                              -- ej: "Cover consumible", "Mujeres free hasta 11pm"
  estado         estado_evento NOT NULL DEFAULT 'publicado',
  destacado      boolean NOT NULL DEFAULT false,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  CHECK (termina_en IS NULL OR termina_en > inicia_en)
);
CREATE INDEX idx_eventos_inicio ON eventos(inicia_en) WHERE estado = 'publicado';
CREATE TRIGGER trg_eventos_upd BEFORE UPDATE ON eventos
  FOR EACH ROW EXECUTE FUNCTION fn_set_actualizado_en();

CREATE TABLE artistas_evento (
  id             serial PRIMARY KEY,
  evento_id      integer NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
  nombre         text NOT NULL,
  rol            text NOT NULL DEFAULT 'DJ',        -- 'DJ','Artista invitado','Host','Banda'
  instagram      text,
  orden          smallint NOT NULL DEFAULT 0
);
CREATE INDEX idx_artistas_evento ON artistas_evento(evento_id);

-- =====================================================================
--  RESERVAS
-- =====================================================================
CREATE TABLE zonas (
  id                 serial PRIMARY KEY,
  slug               text    NOT NULL UNIQUE,
  nombre             text    NOT NULL,
  descripcion        text,
  capacidad_mesa     smallint NOT NULL DEFAULT 6 CHECK (capacidad_mesa > 0),
  max_personas       smallint NOT NULL DEFAULT 20 CHECK (max_personas > 0),
  consumo_minimo_cop integer  NOT NULL DEFAULT 0 CHECK (consumo_minimo_cop >= 0),
  es_vip             boolean  NOT NULL DEFAULT false,
  beneficios         text[]   NOT NULL DEFAULT '{}',
  activo             boolean  NOT NULL DEFAULT true,
  orden              smallint NOT NULL DEFAULT 0
);

CREATE TABLE politicas_reserva (
  id       serial PRIMARY KEY,
  titulo   text NOT NULL,
  cuerpo   text NOT NULL,
  icono    text,
  orden    smallint NOT NULL DEFAULT 0,
  activo   boolean NOT NULL DEFAULT true
);

CREATE SEQUENCE seq_codigo_reserva START 1001;

CREATE TABLE reservas (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo               text NOT NULL UNIQUE,
  nombre_completo      text NOT NULL CHECK (length(trim(nombre_completo)) >= 3),
  telefono             text NOT NULL,
  email                text,
  fecha                date NOT NULL,
  hora                 time NOT NULL,
  personas             smallint NOT NULL CHECK (personas BETWEEN 1 AND 60),
  zona_id              integer NOT NULL REFERENCES zonas(id),
  motivo               motivo_reserva NOT NULL DEFAULT 'casual',
  evento_id            integer REFERENCES eventos(id) ON DELETE SET NULL,
  notas                text,
  acepta_politicas     boolean NOT NULL DEFAULT false CHECK (acepta_politicas),
  estado               estado_reserva NOT NULL DEFAULT 'pendiente',
  origen               text NOT NULL DEFAULT 'web',
  notificado_whatsapp  timestamptz,
  notificado_email     timestamptz,
  nota_interna         text,                       -- uso exclusivo RRPP / administrador
  ip_origen            inet,
  creado_en            timestamptz NOT NULL DEFAULT now(),
  actualizado_en       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_reservas_fecha  ON reservas(fecha, hora);
CREATE INDEX idx_reservas_estado ON reservas(estado);
CREATE INDEX idx_reservas_tel    ON reservas(telefono);

CREATE OR REPLACE FUNCTION fn_generar_codigo_reserva() RETURNS trigger AS $$
BEGIN
  IF NEW.codigo IS NULL OR NEW.codigo = '' THEN
    NEW.codigo := 'MB-' || to_char(NEW.fecha, 'MMDD') || '-' || nextval('seq_codigo_reserva');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reservas_codigo BEFORE INSERT ON reservas
  FOR EACH ROW EXECUTE FUNCTION fn_generar_codigo_reserva();
CREATE TRIGGER trg_reservas_upd BEFORE UPDATE ON reservas
  FOR EACH ROW EXECUTE FUNCTION fn_set_actualizado_en();

-- =====================================================================
--  GALERÍA / FEED SOCIAL
-- =====================================================================
CREATE TABLE galeria (
  id             serial PRIMARY KEY,
  tipo           tipo_media   NOT NULL DEFAULT 'foto',
  fuente         fuente_media NOT NULL DEFAULT 'local',
  url            text NOT NULL,
  miniatura_url  text,
  descripcion    text,
  enlace         text,           -- permalink del post en Instagram / TikTok
  publicado_en   timestamptz NOT NULL DEFAULT now(),
  activo         boolean NOT NULL DEFAULT true,
  orden          smallint NOT NULL DEFAULT 0
);
CREATE INDEX idx_galeria_publicado ON galeria(publicado_en DESC) WHERE activo;

-- =====================================================================
--  VISTAS
-- =====================================================================
CREATE VIEW v_eventos_proximos AS
SELECT e.*,
       COALESCE(
         (SELECT json_agg(json_build_object('nombre', a.nombre, 'rol', a.rol, 'instagram', a.instagram)
                          ORDER BY a.orden)
            FROM artistas_evento a WHERE a.evento_id = e.id),
         '[]'::json) AS artistas
  FROM eventos e
 WHERE e.estado = 'publicado'
   AND COALESCE(e.termina_en, e.inicia_en + interval '8 hours') >= now()
 ORDER BY e.inicia_en;

CREATE VIEW v_menu AS
SELECT c.id    AS categoria_id, c.slug AS categoria_slug, c.nombre AS categoria, c.tipo, c.icono,
       c.orden AS categoria_orden,
       p.id    AS producto_id, p.slug, p.nombre, p.descripcion, p.ingredientes, p.imagen_url,
       p.etiquetas, p.destacado, p.orden,
       COALESCE(
         (SELECT json_agg(json_build_object('presentacion', pr.presentacion, 'precio', pr.precio_cop)
                          ORDER BY pr.orden, pr.precio_cop)
            FROM precios_producto pr WHERE pr.producto_id = p.id),
         '[]'::json) AS precios
  FROM categorias_menu c
  JOIN productos p ON p.categoria_id = c.id
 WHERE c.activo AND p.disponible
 ORDER BY c.orden, p.orden, p.nombre;

CREATE VIEW v_reservas_detalle AS
SELECT r.id, r.codigo, r.estado, r.fecha, r.hora, r.personas, r.motivo,
       r.nombre_completo, r.telefono, r.email, r.notas, r.nota_interna,
       z.nombre AS zona, z.es_vip, z.consumo_minimo_cop,
       e.titulo AS evento,
       r.notificado_whatsapp, r.notificado_email, r.creado_en
  FROM reservas r
  JOIN zonas z   ON z.id = r.zona_id
  LEFT JOIN eventos e ON e.id = r.evento_id
 ORDER BY r.fecha DESC, r.hora DESC;

COMMIT;


-- =====================================================================
--  MAMBA BISTRO BAR 2.0 — Datos iniciales
--  ⚠ Reemplaza los valores marcados con [EDITAR] por los reales del local.
--  Las fechas de eventos se calculan desde hoy, para que siempre haya cartelera.
-- =====================================================================

BEGIN;

TRUNCATE reservas, politicas_reserva, zonas, artistas_evento, eventos,
         precios_producto, productos, categorias_menu, promociones, galeria,
         horarios, configuracion_local RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------------
-- Configuración del local
-- ---------------------------------------------------------------------
INSERT INTO configuracion_local
  (nombre, eslogan, descripcion, direccion, ciudad, departamento, latitud, longitud,
   whatsapp, telefono, email_reservas, instagram, tiktok, facebook, dress_code, edad_minima)
VALUES
  ('Mamba Bistro Bar 2.0',
   'Muda de piel cada fin de semana',
   'Bistro, coctelería de autor y la mejor rumba de la ciudad. Cocina hasta tarde, DJs en vivo y zonas VIP para que la noche sea tuya.',
   'Calle 00 # 00-00',            -- [EDITAR]
   'Tu Ciudad',                  -- [EDITAR]
   'Tu Departamento',            -- [EDITAR]
   4.711000, -74.072100,         -- [EDITAR] lat/lng exactos (clic derecho en Google Maps)
   '573000000000',               -- [EDITAR] WhatsApp Business sin '+'
   '+57 300 000 0000',           -- [EDITAR]
   'reservas@mambabistrobar.com',-- [EDITAR]
   'mambabistrobar',             -- [EDITAR] usuario de Instagram sin @
   'mambabistrobar',             -- [EDITAR] usuario de TikTok sin @
   NULL,
   'Casual elegante. No se permite ingreso con gorra, esqueleto (camisilla), pantaloneta ni chanclas.',
   18);

-- ---------------------------------------------------------------------
-- Horarios (0=domingo … 6=sábado)
-- ---------------------------------------------------------------------
INSERT INTO horarios (dia_semana, abierto, hora_apertura, hora_cierre, cierre_cocina, cierre_barra, nota) VALUES
  (0, true,  '16:00', '00:00', '22:00', '23:30', 'Domingo de puente: abrimos hasta las 2:00 a.m.'),
  (1, false, NULL,    NULL,    NULL,    NULL,    NULL),
  (2, false, NULL,    NULL,    NULL,    NULL,    NULL),
  (3, true,  '17:00', '00:00', '23:00', '23:30', 'Miércoles de cocteles 2x1'),
  (4, true,  '17:00', '01:00', '23:30', '00:30', 'Jueves de crossover'),
  (5, true,  '17:00', '03:00', '01:00', '02:30', 'Viernes de DJ invitado'),
  (6, true,  '17:00', '03:00', '01:00', '02:30', 'Sábado de noche temática');

-- ---------------------------------------------------------------------
-- Categorías del menú
-- ---------------------------------------------------------------------
INSERT INTO categorias_menu (slug, nombre, descripcion, tipo, icono, orden) VALUES
  ('licores-premium',   'Licores Premium',     'Whisky, ron, tequila, aguardiente y ginebra por botella, media o trago.', 'bebida', '🥃', 1),
  ('cocteleria-autor',  'Coctelería de Autor', 'Creaciones de la casa con el veneno de la Mamba.',                        'bebida', '🍸', 2),
  ('cervezas',          'Cervezas',            'Nacionales, importadas y micheladas.',                                      'bebida', '🍺', 3),
  ('sin-alcohol',       'Sin Alcohol',         'Sodas, jugos, energizantes y mocktails.',                                   'bebida', '🧃', 4),
  ('hamburguesas',      'Hamburguesas',        'Carne 100% res, pan brioche y papas a la francesa.',                        'comida', '🍔', 5),
  ('desgranados',       'Desgranados',         'El clásico colombiano, servido en grande.',                                 'comida', '🌽', 6),
  ('picadas',           'Picadas',             'Para compartir entre ronda y ronda.',                                       'comida', '🍖', 7),
  ('combos',            'Combos de la Noche',  'Botella + acompañantes + picada. La forma más inteligente de rumbear.',      'combo',  '🔥', 8);

-- ---------------------------------------------------------------------
-- Productos + precios
-- Usamos un bloque para enlazar precios con el id del producto recién creado.
-- ---------------------------------------------------------------------
CREATE TEMP TABLE _seed_productos (
  categoria text, slug text, nombre text, descripcion text, ingredientes text[],
  etiquetas text[], destacado boolean, orden smallint, precios jsonb
) ON COMMIT DROP;

INSERT INTO _seed_productos VALUES
-- Licores premium
('licores-premium','buchanans-12','Buchanan''s 12 años','Whisky escocés blended, suave y con notas de chocolate y naranja.','{}','{premium}',true,1,
 '[{"p":"Botella","v":280000},{"p":"Media","v":160000},{"p":"Trago","v":28000}]'),
('licores-premium','old-parr-12','Old Parr 12 años','Clásico de la noche colombiana. Notas de fruta seca y madera.','{}','{premium}',false,2,
 '[{"p":"Botella","v":260000},{"p":"Media","v":150000},{"p":"Trago","v":26000}]'),
('licores-premium','jw-black-label','Johnnie Walker Black Label','Whisky ahumado y complejo, 12 años.','{}','{premium}',false,3,
 '[{"p":"Botella","v":290000},{"p":"Media","v":165000},{"p":"Trago","v":29000}]'),
('licores-premium','don-julio-70','Don Julio 70','Tequila añejo cristalino. Servido con limón y sal de gusano.','{}','{premium,nuevo}',true,4,
 '[{"p":"Botella","v":420000},{"p":"Trago","v":42000}]'),
('licores-premium','jose-cuervo-especial','José Cuervo Especial','Tequila reposado para la primera ronda.','{}','{}',false,5,
 '[{"p":"Botella","v":180000},{"p":"Media","v":100000},{"p":"Trago","v":18000}]'),
('licores-premium','ron-medellin-8','Ron Medellín 8 años','Ron añejo colombiano, redondo y dulce.','{}','{}',false,6,
 '[{"p":"Botella","v":150000},{"p":"Media","v":85000},{"p":"Trago","v":15000}]'),
('licores-premium','aguardiente-antioqueno','Aguardiente Antioqueño Sin Azúcar','El que no puede faltar.','{}','{}',false,7,
 '[{"p":"Botella","v":120000},{"p":"Media","v":70000},{"p":"Trago","v":10000}]'),
('licores-premium','hendricks','Hendrick''s Gin','Ginebra escocesa con pepino y pétalos de rosa. Preparado como gin tonic.','{}','{premium}',false,8,
 '[{"p":"Botella","v":320000},{"p":"Trago","v":35000}]'),
-- Coctelería de autor
('cocteleria-autor','veneno-de-mamba','Veneno de Mamba','Nuestro cóctel insignia: mezcal, maracuyá, jengibre y un toque de ají, con escarcha de sal de oro.','{mezcal,maracuyá,jengibre,ají,sal de oro}','{insignia,picante}',true,1,
 '[{"p":"Coctel","v":38000}]'),
('cocteleria-autor','piel-esmeralda','Piel Esmeralda','Ginebra, pepino, albahaca, limón y tónica artesanal. Verde como la Mamba.','{ginebra,pepino,albahaca,limón,tónica}','{refrescante}',true,2,
 '[{"p":"Coctel","v":34000}]'),
('cocteleria-autor','mordida-dorada','Mordida Dorada','Ron añejo, miel de panela ahumada, bitter de naranja y hoja de oro comestible.','{ron añejo,panela,bitter de naranja,oro comestible}','{premium}',false,3,
 '[{"p":"Coctel","v":42000}]'),
('cocteleria-autor','muda-de-piel','Muda de Piel','Vodka, frutos rojos, lychee y espuma de rosas. Cambia de color al servirse.','{vodka,frutos rojos,lychee,rosas}','{nuevo}',false,4,
 '[{"p":"Coctel","v":36000}]'),
('cocteleria-autor','mojito','Mojito Clásico','Ron blanco, hierbabuena, limón y soda.','{ron blanco,hierbabuena,limón,soda}','{}',false,5,
 '[{"p":"Coctel","v":26000},{"p":"Jarra","v":85000}]'),
('cocteleria-autor','margarita','Margarita','Tequila, triple sec y limón. Clásica o de maracuyá.','{tequila,triple sec,limón}','{}',false,6,
 '[{"p":"Coctel","v":28000},{"p":"Jarra","v":90000}]'),
-- Cervezas
('cervezas','club-colombia','Club Colombia Dorada','','{}','{}',false,1,'[{"p":"Botella","v":9000}]'),
('cervezas','aguila','Águila','','{}','{}',false,2,'[{"p":"Botella","v":8000}]'),
('cervezas','corona','Corona','Con limón y sal.','{}','{importada}',false,3,'[{"p":"Botella","v":14000}]'),
('cervezas','stella-artois','Stella Artois','','{}','{importada}',false,4,'[{"p":"Botella","v":14000}]'),
('cervezas','michelada','Michelada de la Casa','Limón, sal, salsas secretas y escarcha de tajín.','{limón,sal,salsas,tajín}','{}',false,5,'[{"p":"Adición","v":4000}]'),
('cervezas','cubeta','Cubeta x6','Seis cervezas nacionales bien frías.','{}','{para compartir}',true,6,'[{"p":"Cubeta","v":45000}]'),
-- Sin alcohol
('sin-alcohol','gaseosa','Gaseosa','Coca-Cola, Sprite, Quatro, Ginger.','{}','{}',false,1,'[{"p":"Personal","v":6000},{"p":"Litro","v":12000}]'),
('sin-alcohol','agua','Agua','Con o sin gas.','{}','{}',false,2,'[{"p":"Botella","v":5000}]'),
('sin-alcohol','red-bull','Red Bull','','{}','{}',false,3,'[{"p":"Lata","v":14000}]'),
('sin-alcohol','mocktail-esmeralda','Mocktail Esmeralda','Pepino, limonada de coco, hierbabuena y soda.','{pepino,coco,hierbabuena,soda}','{sin alcohol}',false,4,'[{"p":"Vaso","v":18000}]'),
-- Hamburguesas
('hamburguesas','la-mamba','La Mamba','Doble carne 150 g, cheddar, tocineta caramelizada, cebolla crispy y salsa de la casa.','{doble carne,cheddar,tocineta,cebolla crispy,salsa de la casa}','{insignia}',true,1,
 '[{"p":"Con papas","v":36000}]'),
('hamburguesas','cobra-picante','Cobra Picante','Carne 150 g, jalapeños, pepper jack, guacamole y chipotle.','{carne,jalapeños,pepper jack,guacamole,chipotle}','{picante}',false,2,
 '[{"p":"Con papas","v":32000}]'),
('hamburguesas','clasica','Clásica','Carne 150 g, queso, lechuga, tomate y salsas.','{carne,queso,lechuga,tomate}','{}',false,3,
 '[{"p":"Con papas","v":26000}]'),
('hamburguesas','pollo-crispy','Pollo Crispy','Pechuga apanada, coleslaw, pepinillos y mayo de miel mostaza.','{pollo apanado,coleslaw,pepinillos,miel mostaza}','{}',false,4,
 '[{"p":"Con papas","v":28000}]'),
-- Desgranados
('desgranados','desgranado-mamba','Desgranado Mamba','Maíz tierno, pollo, carne desmechada, tocineta, maduro, queso gratinado y salsas.','{maíz,pollo,carne desmechada,tocineta,maduro,queso}','{para compartir}',true,1,
 '[{"p":"Personal","v":28000},{"p":"Para compartir","v":48000}]'),
('desgranados','desgranado-pollo','Desgranado de Pollo','Maíz tierno, pollo desmechado, queso gratinado, papa ripio y salsas.','{maíz,pollo,queso,papa ripio}','{}',false,2,
 '[{"p":"Personal","v":24000},{"p":"Para compartir","v":42000}]'),
('desgranados','salchipapa-mamba','Salchipapa Mamba','Papa a la francesa, salchicha ranchera, chorizo, queso y huevos de codorniz.','{papa,salchicha,chorizo,queso,huevos de codorniz}','{}',false,3,
 '[{"p":"Personal","v":22000},{"p":"Para compartir","v":40000}]'),
-- Picadas
('picadas','picada-mamba','Picada Mamba','Chicharrón, chorizo, morcilla, carne de res, pollo, costilla BBQ, papa criolla, arepitas y guacamole.','{chicharrón,chorizo,morcilla,res,pollo,costilla BBQ,papa criolla,arepa,guacamole}','{para compartir,insignia}',true,1,
 '[{"p":"2 personas","v":58000},{"p":"4 personas","v":98000},{"p":"6 personas","v":138000}]'),
('picadas','alitas','Alitas','BBQ, búfalo o miel mostaza. Con palitos de apio y ranch.','{alitas,salsa a elección,apio,ranch}','{}',false,2,
 '[{"p":"x8","v":28000},{"p":"x16","v":52000}]'),
('picadas','nachos','Nachos Supremos','Totopos, carne, queso fundido, pico de gallo, guacamole y sour cream.','{totopos,carne,queso,pico de gallo,guacamole,sour cream}','{para compartir}',false,3,
 '[{"p":"Para compartir","v":34000}]'),
-- Combos
('combos','combo-vip-whisky','Combo VIP Whisky','Botella de Buchanan''s 12 + 4 sodas + 2 aguas + hielo + Picada Mamba para 4.','{}','{premium,para compartir}',true,1,
 '[{"p":"Combo","v":360000}]'),
('combos','combo-aguardiente','Combo Parche','Botella de Aguardiente Antioqueño + 2 gaseosas litro + hielo + Desgranado para compartir.','{}','{para compartir}',true,2,
 '[{"p":"Combo","v":165000}]'),
('combos','combo-tequila','Combo Tequila Night','Botella de José Cuervo + limones + sal + 4 Red Bull + Nachos Supremos.','{}','{para compartir}',false,3,
 '[{"p":"Combo","v":255000}]'),
('combos','combo-cerveza','Combo Cubeta + Alitas','Cubeta x6 nacional + Alitas x16.','{}','{para compartir}',false,4,
 '[{"p":"Combo","v":88000}]');

WITH nuevos AS (
  INSERT INTO productos (categoria_id, slug, nombre, descripcion, ingredientes, etiquetas, destacado, orden)
  SELECT c.id, s.slug, s.nombre, NULLIF(s.descripcion,''), s.ingredientes, s.etiquetas, s.destacado, s.orden
    FROM _seed_productos s JOIN categorias_menu c ON c.slug = s.categoria
  RETURNING id, slug
)
INSERT INTO precios_producto (producto_id, presentacion, precio_cop, orden)
SELECT n.id, p.value->>'p', (p.value->>'v')::int, p.ordinality::smallint
  FROM nuevos n
  JOIN _seed_productos s ON s.slug = n.slug
  CROSS JOIN LATERAL jsonb_array_elements(s.precios) WITH ORDINALITY AS p(value, ordinality);

-- ---------------------------------------------------------------------
-- Promociones de la semana (dias_semana: 0=dom … 6=sáb)
-- ---------------------------------------------------------------------
INSERT INTO promociones (titulo, descripcion, dias_semana, orden) VALUES
  ('Miércoles 2x1 en Coctelería', 'Todos los cócteles de autor 2x1 de 5 a 9 p.m.', '{3}', 1),
  ('Ladies Night',                'Jueves: cover free para mujeres hasta las 11 p.m. y shot de bienvenida.', '{4}', 2),
  ('Cumpleañero VIP',             'Reserva para tu cumpleaños con 8+ personas y te regalamos una botella de champaña.', '{}', 3);

-- ---------------------------------------------------------------------
-- Eventos (relativos a la fecha actual, hora Colombia)
-- ---------------------------------------------------------------------
WITH base AS (
  SELECT current_date AS hoy,
         current_date + ((5 - extract(isodow FROM current_date)::int + 7) % 7) AS viernes,
         current_date + ((6 - extract(isodow FROM current_date)::int + 7) % 7) AS sabado
)
INSERT INTO eventos (slug, titulo, tematica, descripcion, inicia_en, termina_en, cover_cop, nota_cover, destacado)
SELECT * FROM (
  SELECT 'serpiente-dorada', 'Serpiente Dorada', 'Black & Gold Party',
         'Dress code negro y dorado. Show de fuego, bengalas en cada botella y el mejor reggaetón old school vs. new school.',
         ((viernes + time '21:00') AT TIME ZONE 'America/Bogota'),
         ((viernes + 1 + time '03:00') AT TIME ZONE 'America/Bogota'),
         20000, 'Cover consumible en barra', true FROM base
  UNION ALL
  SELECT 'noche-esmeralda', 'Noche Esmeralda', 'Crossover & Tech House',
         'Dos cabinas, dos mundos: crossover en el salón y tech house en la terraza. Luces láser verdes toda la noche.',
         ((sabado + time '21:00') AT TIME ZONE 'America/Bogota'),
         ((sabado + 1 + time '03:00') AT TIME ZONE 'America/Bogota'),
         30000, 'Incluye un coctel de bienvenida', true FROM base
  UNION ALL
  SELECT 'salsa-y-veneno', 'Salsa & Veneno', 'Salsa brava y vieja guardia',
         'Jueves de salsa con orquesta en vivo y clases gratis de 8 a 9 p.m.',
         ((viernes + 6 + time '20:00') AT TIME ZONE 'America/Bogota'),
         ((viernes + 7 + time '01:00') AT TIME ZONE 'America/Bogota'),
         0, 'Entrada libre', false FROM base
  UNION ALL
  SELECT 'reggaeton-2000', 'Reggaetón 2000', 'Throwback',
         'Una noche para los clásicos del perreo de los 2000.',
         ((viernes - 7 + time '21:00') AT TIME ZONE 'America/Bogota'),
         ((viernes - 6 + time '03:00') AT TIME ZONE 'America/Bogota'),
         15000, NULL, false FROM base
) t;

INSERT INTO artistas_evento (evento_id, nombre, rol, instagram, orden)
SELECT e.id, a.nombre, a.rol, a.ig, a.orden
  FROM (VALUES
    ('serpiente-dorada', 'DJ Kobra',       'DJ',               'djkobra',   1),
    ('serpiente-dorada', 'Fire Crew',      'Show de fuego',    NULL,        2),
    ('noche-esmeralda',  'DJ Venom',       'DJ · Salón',       'djvenom',   1),
    ('noche-esmeralda',  'Nyx',            'DJ · Terraza',     'nyx.music', 2),
    ('salsa-y-veneno',   'Orquesta La 33', 'Banda en vivo',    NULL,        1),
    ('reggaeton-2000',   'DJ Mamba',       'DJ residente',     NULL,        1)
  ) AS a(evento, nombre, rol, ig, orden)
  JOIN eventos e ON e.slug = a.evento;

-- ---------------------------------------------------------------------
-- Zonas
-- ---------------------------------------------------------------------
INSERT INTO zonas (slug, nombre, descripcion, capacidad_mesa, max_personas, consumo_minimo_cop, es_vip, beneficios, orden) VALUES
  ('salon-general', 'Salón General', 'En el corazón de la pista, cerca de la cabina del DJ.', 6, 12, 0, false,
   '{"Mesa asegurada hasta las 10:30 p.m."}', 1),
  ('terraza', 'Terraza', 'Al aire libre, ideal para parchar, fumar y conversar.', 6, 15, 150000, false,
   '{"Mesa asegurada hasta las 11:00 p.m.","Zona de fumadores"}', 2),
  ('vip-esmeralda', 'VIP Esmeralda', 'Palco elevado con vista a la pista y mesero exclusivo.', 10, 20, 500000, true,
   '{"Ingreso sin fila","Mesero exclusivo","Bengalas con la botella","Consumo mínimo 100% consumible"}', 3),
  ('vip-oro', 'VIP Oro — Nido de la Mamba', 'El espacio más exclusivo: sala privada, sonido propio y cortesía de la casa.', 15, 30, 1200000, true,
   '{"Ingreso sin fila","Sala privada","Botella de champaña de cortesía","Show de bengalas","Parqueadero preferencial"}', 4);

-- ---------------------------------------------------------------------
-- Políticas de reserva
-- ---------------------------------------------------------------------
INSERT INTO politicas_reserva (titulo, cuerpo, icono, orden) VALUES
  ('Consumo mínimo',   'Las zonas Terraza y VIP tienen consumo mínimo por mesa. El valor es 100% consumible en licores, cocteles o comida.', '💳', 1),
  ('Hora de llegada',  'Tu mesa se guarda hasta la hora indicada en tu zona. Después de ese tiempo puede ser liberada.', '⏰', 2),
  ('Dress code',       'Casual elegante. No se permite ingreso con gorra, esqueleto (camisilla), pantaloneta ni chanclas.', '👔', 3),
  ('Mayoría de edad',  'Ingreso solo para mayores de 18 años con documento de identidad original.', '🪪', 4),
  ('Confirmación',     'Tu reserva queda confirmada cuando nuestro RRPP te escriba por WhatsApp. Te respondemos en minutos.', '✅', 5),
  ('Derecho de admisión', 'Nos reservamos el derecho de admisión y permanencia.', '🛡️', 6);

-- ---------------------------------------------------------------------
-- Galería: agrega aquí las fotos reales del local (sube las imágenes a
-- frontend/public/galeria/ o a un CDN y registra la URL).
-- Si configuras INSTAGRAM_ACCESS_TOKEN en el backend, el feed se toma de Instagram.
-- ---------------------------------------------------------------------
-- INSERT INTO galeria (tipo, fuente, url, descripcion, orden) VALUES
--   ('foto', 'local', '/galeria/barra.jpg', 'Nuestra barra', 1),
--   ('foto', 'local', '/galeria/vip.jpg',   'Zona VIP Oro',  2);

-- Reserva de ejemplo (para ver el flujo en el panel)
INSERT INTO reservas (nombre_completo, telefono, email, fecha, hora, personas, zona_id, motivo, notas, acepta_politicas, estado)
SELECT 'Cliente de Prueba', '573001112233', 'prueba@correo.com',
       current_date + 3, '22:00', 8, z.id, 'cumpleanos', 'Llevamos torta 🎂', true, 'pendiente'
  FROM zonas z WHERE z.slug = 'vip-esmeralda';

COMMIT;
