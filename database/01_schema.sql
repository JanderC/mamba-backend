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
