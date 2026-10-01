-- =====================================================================
--  MAMBA BISTRO BAR 2.0 — SISTEMA ADMINISTRATIVO (esquema + datos)
--  Ejecutar DESPUÉS de mamba_completo.sql. No borra nada: se puede re-ejecutar.
--  Pégalo completo en el Query Tool de pgAdmin o en el SQL Editor de Neon.
-- =====================================================================

-- =====================================================================
--  MAMBA BISTRO BAR 2.0 — SISTEMA ADMINISTRATIVO (POS, caja, inventario…)
--  Migración ADITIVA sobre 01_schema.sql: no borra datos existentes y se
--  puede ejecutar varias veces sin problema.
--  Orden: 01_schema → 02_seed → 03_sistema → 04_sistema_seed
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =====================================================================
--  USUARIOS Y AJUSTES
-- =====================================================================
CREATE TABLE IF NOT EXISTS usuarios (
  id             serial PRIMARY KEY,
  nombre         text NOT NULL,
  email          text NOT NULL,
  password_hash  text NOT NULL,
  rol            text NOT NULL DEFAULT 'mesonero'
                 CHECK (rol IN ('admin','gerente','cajero','mesonero','barra','cocina','rrpp')),
  activo         boolean NOT NULL DEFAULT true,
  ultimo_acceso  timestamptz,
  creado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_usuarios_email ON usuarios (lower(email));

-- Ajustes del sistema (clave → valor JSON)
CREATE TABLE IF NOT EXISTS ajustes (
  clave          text PRIMARY KEY,
  valor          jsonb NOT NULL,
  descripcion    text,
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
--  TASAS DE CAMBIO (USD / COP / VES) — mismo modelo que Cerveloza
-- =====================================================================
CREATE TABLE IF NOT EXISTS tasas_cambio (
  id             serial PRIMARY KEY,
  fecha          date NOT NULL DEFAULT current_date,
  usd_ves        numeric(18,4) NOT NULL CHECK (usd_ves > 0),
  usd_cop        numeric(18,4) NOT NULL CHECK (usd_cop > 0),
  ves_cop        numeric(18,6) NOT NULL CHECK (ves_cop > 0),   -- cuántos COP vale 1 VES
  ves_cop_manual boolean NOT NULL DEFAULT false,               -- true = cruce fijado a mano (tasa de frontera)
  fuente         text NOT NULL DEFAULT 'manual',               -- 'BCV' | 'manual' | 'inicial'
  usuario_id     integer REFERENCES usuarios(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasas_fecha ON tasas_cambio (fecha DESC, created_at DESC);

-- =====================================================================
--  MÉTODOS DE PAGO Y CAJA
-- =====================================================================
CREATE TABLE IF NOT EXISTS metodos_pago (
  id                  serial PRIMARY KEY,
  nombre              text NOT NULL UNIQUE,
  es_efectivo         boolean NOT NULL DEFAULT false,
  monedas             text[]  NOT NULL DEFAULT '{USD,COP,VES}',
  requiere_referencia boolean NOT NULL DEFAULT false,
  orden               smallint NOT NULL DEFAULT 0,
  activo              boolean NOT NULL DEFAULT true
);

-- Puntos de cobro físicos (Caja principal, Barra…)
CREATE TABLE IF NOT EXISTS cajas (
  id          serial PRIMARY KEY,
  nombre      text NOT NULL UNIQUE,
  descripcion text,
  activo      boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS sesiones_caja (
  id                  serial PRIMARY KEY,
  caja_id             integer NOT NULL REFERENCES cajas(id),
  usuario_id          integer NOT NULL REFERENCES usuarios(id),
  estado              text NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta','cerrada')),
  fondo_inicial_usd   numeric(14,2) NOT NULL DEFAULT 0,
  fondo_inicial_cop   numeric(14,2) NOT NULL DEFAULT 0,
  fondo_inicial_ves   numeric(14,2) NOT NULL DEFAULT 0,
  conteo_final_usd    numeric(14,2),
  conteo_final_cop    numeric(14,2),
  conteo_final_ves    numeric(14,2),
  esperado_final_usd  numeric(14,2),
  esperado_final_cop  numeric(14,2),
  esperado_final_ves  numeric(14,2),
  diferencia_usd      numeric(14,2),
  diferencia_cop      numeric(14,2),
  diferencia_ves      numeric(14,2),
  fondo_siguiente_usd numeric(14,2) NOT NULL DEFAULT 0,
  fondo_siguiente_cop numeric(14,2) NOT NULL DEFAULT 0,
  fondo_siguiente_ves numeric(14,2) NOT NULL DEFAULT 0,
  fecha_apertura      timestamptz NOT NULL DEFAULT now(),
  fecha_cierre        timestamptz,
  usuario_cierre_id   integer REFERENCES usuarios(id),
  notas_cierre        text
);
-- Solo una sesión abierta por caja
CREATE UNIQUE INDEX IF NOT EXISTS uq_sesion_abierta_por_caja ON sesiones_caja (caja_id) WHERE estado = 'abierta';

CREATE TABLE IF NOT EXISTS movimientos_caja (
  id             serial PRIMARY KEY,
  sesion_caja_id integer NOT NULL REFERENCES sesiones_caja(id) ON DELETE CASCADE,
  tipo           text NOT NULL CHECK (tipo IN ('ingreso','egreso')),
  concepto       text NOT NULL,
  moneda         char(3) NOT NULL CHECK (moneda IN ('USD','COP','VES')),
  monto          numeric(14,2) NOT NULL CHECK (monto > 0),
  monto_usd      numeric(14,4) NOT NULL DEFAULT 0,
  usuario_id     integer REFERENCES usuarios(id),
  fecha          timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
--  INVENTARIO (insumos: cervezas, botellas, ingredientes de cocina…)
-- =====================================================================
CREATE TABLE IF NOT EXISTS categorias_insumo (
  id     serial PRIMARY KEY,
  nombre text NOT NULL UNIQUE,
  icono  text
);

CREATE TABLE IF NOT EXISTS insumos (
  id                  serial PRIMARY KEY,
  codigo              text UNIQUE,
  nombre              text NOT NULL,
  categoria_insumo_id integer REFERENCES categorias_insumo(id),
  unidad              text NOT NULL DEFAULT 'und' CHECK (unidad IN ('und','ml','g')),
  -- Cómo se compra: "Botella 750 ml" → factor 750; "Caja x24" → factor 24. El stock se guarda en la unidad base.
  presentacion_compra text,
  factor_compra       numeric(14,3) NOT NULL DEFAULT 1 CHECK (factor_compra > 0),
  stock               numeric(14,3) NOT NULL DEFAULT 0,
  stock_minimo        numeric(14,3) NOT NULL DEFAULT 0,
  costo_unitario      numeric(14,4) NOT NULL DEFAULT 0,     -- costo por unidad base
  moneda_costo        char(3) NOT NULL DEFAULT 'COP' CHECK (moneda_costo IN ('USD','COP','VES')),
  -- Recargo cuando se elige dentro de un surtido (ej. cerveza importada en un tobo)
  recargo_seleccion   numeric(14,2) NOT NULL DEFAULT 0,
  activo              boolean NOT NULL DEFAULT true,
  creado_en           timestamptz NOT NULL DEFAULT now(),
  actualizado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_insumos_categoria ON insumos (categoria_insumo_id);
DROP TRIGGER IF EXISTS trg_insumos_upd ON insumos;
CREATE TRIGGER trg_insumos_upd BEFORE UPDATE ON insumos
  FOR EACH ROW EXECUTE FUNCTION fn_set_actualizado_en();

-- Kardex
CREATE TABLE IF NOT EXISTS movimientos_inventario (
  id               bigserial PRIMARY KEY,
  insumo_id        integer NOT NULL REFERENCES insumos(id),
  tipo             text NOT NULL CHECK (tipo IN ('entrada','venta','anulacion','ajuste','merma','consumo_interno')),
  cantidad         numeric(14,3) NOT NULL,            -- con signo: + entra, − sale
  stock_resultante numeric(14,3) NOT NULL,
  costo_unitario   numeric(14,4),
  moneda_costo     char(3),
  proveedor        text,
  cuenta_item_id   bigint,
  nota             text,
  usuario_id       integer REFERENCES usuarios(id),
  fecha            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_movinv_insumo ON movimientos_inventario (insumo_id, fecha DESC);

-- =====================================================================
--  CATÁLOGO: ampliación de las tablas del menú para vender en el POS
-- =====================================================================
ALTER TABLE categorias_menu ADD COLUMN IF NOT EXISTS estacion text NOT NULL DEFAULT 'barra';
DO $$ BEGIN
  ALTER TABLE categorias_menu ADD CONSTRAINT ck_categoria_estacion CHECK (estacion IN ('barra','cocina'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE productos ADD COLUMN IF NOT EXISTS moneda_base char(3) NOT NULL DEFAULT 'COP';
ALTER TABLE productos ADD COLUMN IF NOT EXISTS visible_web boolean NOT NULL DEFAULT true;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS visible_pos boolean NOT NULL DEFAULT true;
DO $$ BEGIN
  ALTER TABLE productos ADD CONSTRAINT ck_producto_moneda CHECK (moneda_base IN ('USD','COP','VES'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- precios_producto pasa a ser la "variante vendible": precio en la moneda base del producto
-- + precios fijos opcionales por moneda (como en Cerveloza) + regla de surtido (tobos).
DROP VIEW IF EXISTS v_menu;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'precios_producto' AND column_name = 'precio_cop') THEN
    ALTER TABLE precios_producto RENAME COLUMN precio_cop TO precio;
    ALTER TABLE precios_producto ALTER COLUMN precio TYPE numeric(14,2);
  END IF;
END $$;
ALTER TABLE precios_producto ADD COLUMN IF NOT EXISTS precio_manual_usd numeric(14,2);
ALTER TABLE precios_producto ADD COLUMN IF NOT EXISTS precio_manual_cop numeric(14,2);
ALTER TABLE precios_producto ADD COLUMN IF NOT EXISTS precio_manual_ves numeric(14,2);
ALTER TABLE precios_producto ADD COLUMN IF NOT EXISTS activo boolean NOT NULL DEFAULT true;
-- Surtido: "elige N unidades entre los insumos de esta categoría" (ej. Tobo x10 de cervezas)
ALTER TABLE precios_producto ADD COLUMN IF NOT EXISTS seleccion_categoria_insumo_id integer REFERENCES categorias_insumo(id);
ALTER TABLE precios_producto ADD COLUMN IF NOT EXISTS seleccion_cantidad smallint;

CREATE OR REPLACE VIEW v_menu AS
SELECT c.id    AS categoria_id, c.slug AS categoria_slug, c.nombre AS categoria, c.tipo, c.icono,
       c.orden AS categoria_orden,
       p.id    AS producto_id, p.slug, p.nombre, p.descripcion, p.ingredientes, p.imagen_url,
       p.etiquetas, p.destacado, p.orden, p.moneda_base,
       COALESCE(
         (SELECT json_agg(json_build_object('presentacion', pr.presentacion, 'precio', pr.precio, 'moneda', p.moneda_base)
                          ORDER BY pr.orden, pr.precio)
            FROM precios_producto pr WHERE pr.producto_id = p.id AND pr.activo),
         '[]'::json) AS precios
  FROM categorias_menu c
  JOIN productos p ON p.categoria_id = c.id
 WHERE c.activo AND p.disponible AND p.visible_web
 ORDER BY c.orden, p.orden, p.nombre;

-- Receta de cada variante: qué descuenta del inventario al venderse.
-- `removible` = el cliente puede pedirlo "sin" (y entonces no se descuenta).
CREATE TABLE IF NOT EXISTS receta_items (
  id                 serial PRIMARY KEY,
  precio_producto_id integer NOT NULL REFERENCES precios_producto(id) ON DELETE CASCADE,
  insumo_id          integer NOT NULL REFERENCES insumos(id),
  cantidad           numeric(14,3) NOT NULL CHECK (cantidad > 0),
  removible          boolean NOT NULL DEFAULT false,
  etiqueta           text,                 -- nombre que ve el mesonero/cliente ("Cebolla crispy")
  orden              smallint NOT NULL DEFAULT 0,
  UNIQUE (precio_producto_id, insumo_id)
);

-- Adicionales con precio propio (extra queso, extra carne, shot extra…)
CREATE TABLE IF NOT EXISTS adicionales (
  id                serial PRIMARY KEY,
  nombre            text NOT NULL UNIQUE,
  precio            numeric(14,2) NOT NULL DEFAULT 0 CHECK (precio >= 0),
  moneda_base       char(3) NOT NULL DEFAULT 'COP' CHECK (moneda_base IN ('USD','COP','VES')),
  precio_manual_usd numeric(14,2),
  precio_manual_cop numeric(14,2),
  precio_manual_ves numeric(14,2),
  insumo_id         integer REFERENCES insumos(id),
  cantidad_insumo   numeric(14,3) NOT NULL DEFAULT 1,
  orden             smallint NOT NULL DEFAULT 0,
  activo            boolean NOT NULL DEFAULT true
);
-- En qué categorías del menú se ofrece cada adicional
CREATE TABLE IF NOT EXISTS adicional_categorias (
  adicional_id integer NOT NULL REFERENCES adicionales(id) ON DELETE CASCADE,
  categoria_id integer NOT NULL REFERENCES categorias_menu(id) ON DELETE CASCADE,
  PRIMARY KEY (adicional_id, categoria_id)
);

-- =====================================================================
--  SALÓN: mesas y asientos numerados
-- =====================================================================
ALTER TABLE zonas ADD COLUMN IF NOT EXISTS reservable boolean NOT NULL DEFAULT true;
ALTER TABLE zonas ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT '#12805a';

CREATE TABLE IF NOT EXISTS mesas (
  id        serial PRIMARY KEY,
  zona_id   integer NOT NULL REFERENCES zonas(id),
  numero    integer NOT NULL UNIQUE,
  nombre    text,                                  -- opcional: "Nido de la Mamba"
  tipo      text NOT NULL DEFAULT 'mesa' CHECK (tipo IN ('mesa','barra','vip')),
  forma     text NOT NULL DEFAULT 'redonda' CHECK (forma IN ('redonda','cuadrada','rectangular','barra')),
  capacidad smallint NOT NULL DEFAULT 4 CHECK (capacidad BETWEEN 1 AND 60),
  pos_x     numeric(6,2) NOT NULL DEFAULT 0,       -- posición en el plano (0–100 %)
  pos_y     numeric(6,2) NOT NULL DEFAULT 0,
  activo    boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS asientos (
  id       serial PRIMARY KEY,
  mesa_id  integer NOT NULL REFERENCES mesas(id) ON DELETE CASCADE,
  numero   smallint NOT NULL,
  etiqueta text NOT NULL,                          -- "M12-3" / "B-07"
  UNIQUE (mesa_id, numero)
);

-- Mantiene los asientos sincronizados con la capacidad de la mesa
CREATE OR REPLACE FUNCTION fn_sincronizar_asientos() RETURNS trigger AS $$
BEGIN
  DELETE FROM asientos WHERE mesa_id = NEW.id AND numero > NEW.capacidad;
  INSERT INTO asientos (mesa_id, numero, etiqueta)
  SELECT NEW.id, n,
         CASE WHEN NEW.tipo = 'barra' THEN 'B-' || lpad(n::text, 2, '0')
              ELSE 'M' || NEW.numero || '-' || n END
    FROM generate_series(1, NEW.capacidad) n
  ON CONFLICT (mesa_id, numero) DO UPDATE SET etiqueta = EXCLUDED.etiqueta;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_mesas_asientos ON mesas;
CREATE TRIGGER trg_mesas_asientos AFTER INSERT OR UPDATE OF capacidad, numero, tipo ON mesas
  FOR EACH ROW EXECUTE FUNCTION fn_sincronizar_asientos();

-- =====================================================================
--  CLIENTES
-- =====================================================================
CREATE TABLE IF NOT EXISTS clientes (
  id               serial PRIMARY KEY,
  nombre           text NOT NULL,
  telefono         text,
  documento        text,
  email            text,
  fecha_nacimiento date,
  vip              boolean NOT NULL DEFAULT false,
  notas            text,
  creado_en        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clientes_telefono ON clientes (telefono);

-- =====================================================================
--  VENTAS: cuentas (comandas) → ítems → modificadores → pagos
-- =====================================================================
CREATE SEQUENCE IF NOT EXISTS seq_numero_cuenta START 1;

CREATE TABLE IF NOT EXISTS cuentas (
  id                bigserial PRIMARY KEY,
  numero            text NOT NULL UNIQUE,
  tipo              text NOT NULL DEFAULT 'mesa' CHECK (tipo IN ('mesa','barra','llevar')),
  mesa_id           integer REFERENCES mesas(id),
  mesonero_id       integer REFERENCES usuarios(id),
  cliente_id        integer REFERENCES clientes(id),
  nombre_cliente    text,
  personas          smallint NOT NULL DEFAULT 1 CHECK (personas > 0),
  estado            text NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta','pagada','anulada')),
  moneda            char(3) NOT NULL DEFAULT 'COP' CHECK (moneda IN ('USD','COP','VES')),
  servicio_pct      numeric(5,2) NOT NULL DEFAULT 0 CHECK (servicio_pct BETWEEN 0 AND 100),
  descuento         numeric(14,2) NOT NULL DEFAULT 0 CHECK (descuento >= 0),
  descuento_motivo  text,
  subtotal          numeric(14,2) NOT NULL DEFAULT 0,
  servicio          numeric(14,2) NOT NULL DEFAULT 0,
  total             numeric(14,2) NOT NULL DEFAULT 0,
  pagado            numeric(14,2) NOT NULL DEFAULT 0,      -- abonado hasta ahora, en la moneda de la cuenta
  total_usd         numeric(14,4) NOT NULL DEFAULT 0,      -- informativo
  tasa_id           integer REFERENCES tasas_cambio(id),
  reserva_id        uuid REFERENCES reservas(id) ON DELETE SET NULL,
  notas             text,
  abierta_en        timestamptz NOT NULL DEFAULT now(),
  cerrada_en        timestamptz,
  usuario_cierre_id integer REFERENCES usuarios(id),
  anulada_motivo    text
);
CREATE INDEX IF NOT EXISTS idx_cuentas_estado ON cuentas (estado, abierta_en DESC);
CREATE INDEX IF NOT EXISTS idx_cuentas_mesa   ON cuentas (mesa_id) WHERE estado = 'abierta';
CREATE INDEX IF NOT EXISTS idx_cuentas_cierre ON cuentas (cerrada_en) WHERE estado = 'pagada';

CREATE OR REPLACE FUNCTION fn_numero_cuenta() RETURNS trigger AS $$
BEGIN
  IF NEW.numero IS NULL OR NEW.numero = '' THEN
    NEW.numero := 'C-' || lpad(nextval('seq_numero_cuenta')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_cuentas_numero ON cuentas;
CREATE TRIGGER trg_cuentas_numero BEFORE INSERT ON cuentas
  FOR EACH ROW EXECUTE FUNCTION fn_numero_cuenta();

CREATE TABLE IF NOT EXISTS cuenta_items (
  id                  bigserial PRIMARY KEY,
  cuenta_id           bigint NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  producto_id         integer REFERENCES productos(id),
  precio_producto_id  integer REFERENCES precios_producto(id) ON DELETE SET NULL,
  nombre              text NOT NULL,                 -- copia: el ticket no cambia si luego editan el producto
  presentacion        text,
  estacion            text NOT NULL DEFAULT 'barra' CHECK (estacion IN ('barra','cocina')),
  cantidad            numeric(10,2) NOT NULL CHECK (cantidad > 0),
  precio_base         numeric(14,2) NOT NULL,        -- precio unitario sin extras, en la moneda de la cuenta
  extras              numeric(14,2) NOT NULL DEFAULT 0,  -- adicionales + recargos, por unidad
  subtotal            numeric(14,2) NOT NULL,
  precio_unitario_usd numeric(14,4) NOT NULL DEFAULT 0,
  asiento             smallint,
  notas               text,
  estado              text NOT NULL DEFAULT 'pendiente'
                      CHECK (estado IN ('pendiente','preparando','listo','entregado','anulado')),
  ronda               smallint NOT NULL DEFAULT 1,
  usuario_id          integer REFERENCES usuarios(id),
  creado_en           timestamptz NOT NULL DEFAULT now(),
  listo_en            timestamptz,
  anulado_motivo      text
);
CREATE INDEX IF NOT EXISTS idx_items_cuenta   ON cuenta_items (cuenta_id);
CREATE INDEX IF NOT EXISTS idx_items_comandas ON cuenta_items (estacion, estado, creado_en) WHERE estado IN ('pendiente','preparando');

CREATE TABLE IF NOT EXISTS cuenta_item_modificadores (
  id           bigserial PRIMARY KEY,
  item_id      bigint NOT NULL REFERENCES cuenta_items(id) ON DELETE CASCADE,
  tipo         text NOT NULL CHECK (tipo IN ('sin','adicional','seleccion')),
  nombre       text NOT NULL,
  insumo_id    integer REFERENCES insumos(id),
  adicional_id integer REFERENCES adicionales(id),
  cantidad     numeric(10,2) NOT NULL DEFAULT 1,
  precio_extra numeric(14,2) NOT NULL DEFAULT 0     -- total de esta línea por unidad del ítem
);
CREATE INDEX IF NOT EXISTS idx_mods_item ON cuenta_item_modificadores (item_id);

CREATE TABLE IF NOT EXISTS pagos (
  id                 bigserial PRIMARY KEY,
  cuenta_id          bigint NOT NULL REFERENCES cuentas(id) ON DELETE CASCADE,
  sesion_caja_id     integer REFERENCES sesiones_caja(id),
  metodo_pago_id     integer NOT NULL REFERENCES metodos_pago(id),
  moneda             char(3) NOT NULL CHECK (moneda IN ('USD','COP','VES')),
  monto              numeric(14,2) NOT NULL CHECK (monto > 0),   -- lo que realmente se aplica a la cuenta
  monto_recibido     numeric(14,2) NOT NULL,                     -- lo que entregó el cliente
  monto_cuenta       numeric(14,2) NOT NULL,                     -- `monto` expresado en la moneda de la cuenta
  monto_usd          numeric(14,4) NOT NULL DEFAULT 0,
  vuelto_monto       numeric(14,2),
  vuelto_moneda      char(3),
  referencia         text,
  asiento            smallint,                                   -- si pagó solo su puesto
  tasa_id            integer REFERENCES tasas_cambio(id),
  usuario_id         integer REFERENCES usuarios(id),
  fecha              timestamptz NOT NULL DEFAULT now(),
  anulado            boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_pagos_cuenta ON pagos (cuenta_id);
CREATE INDEX IF NOT EXISTS idx_pagos_sesion ON pagos (sesion_caja_id);

-- Puesto específico (taburete de barra) cuando la cuenta es de una sola persona
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS asiento smallint;

ALTER TABLE reservas ADD COLUMN IF NOT EXISTS mesa_id integer REFERENCES mesas(id);

-- =====================================================================
--  RECORDATORIOS
-- =====================================================================
-- Internos: tareas del equipo con fecha (publicar flyer, confirmar DJ, pedir hielo…)
CREATE TABLE IF NOT EXISTS recordatorios (
  id            serial PRIMARY KEY,
  titulo        text NOT NULL,
  detalle       text,
  vence_en      timestamptz NOT NULL,
  evento_id     integer REFERENCES eventos(id) ON DELETE CASCADE,
  prioridad     text NOT NULL DEFAULT 'normal' CHECK (prioridad IN ('baja','normal','alta')),
  completado    boolean NOT NULL DEFAULT false,
  completado_en timestamptz,
  creado_por    integer REFERENCES usuarios(id),
  creado_en     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recordatorios_pendientes ON recordatorios (vence_en) WHERE NOT completado;

-- Clientes que pidieron "recuérdame este evento" desde la web
ALTER TABLE eventos ADD COLUMN IF NOT EXISTS recordatorio_horas_antes smallint NOT NULL DEFAULT 6;
CREATE TABLE IF NOT EXISTS suscripciones_evento (
  id         serial PRIMARY KEY,
  evento_id  integer NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
  nombre     text NOT NULL,
  telefono   text NOT NULL,
  estado     text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','enviado','fallido')),
  enviado_en timestamptz,
  detalle    text,
  creado_en  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (evento_id, telefono)
);

-- =====================================================================
--  AFORO (control de puerta)
-- =====================================================================
CREATE TABLE IF NOT EXISTS aforo_registros (
  id         bigserial PRIMARY KEY,
  delta      smallint NOT NULL,                    -- +entradas / −salidas
  nota       text,
  usuario_id integer REFERENCES usuarios(id),
  fecha      timestamptz NOT NULL DEFAULT now()
);

COMMIT;


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
