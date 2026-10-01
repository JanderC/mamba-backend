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
  estado            text NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta','pagada','anulada','fiada')),
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

-- Cola de cobro: el mesonero pasa la cuenta a caja desde la tablet
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS cobro_solicitado_en  timestamptz;
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS cobro_solicitado_por integer REFERENCES usuarios(id);
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS cobro_nota           text;
CREATE INDEX IF NOT EXISTS idx_cuentas_cola_cobro ON cuentas (cobro_solicitado_en) WHERE estado = 'abierta' AND cobro_solicitado_en IS NOT NULL;

ALTER TABLE reservas ADD COLUMN IF NOT EXISTS mesa_id integer REFERENCES mesas(id);

-- =====================================================================
--  CRÉDITOS: cuentas fiadas y clientes que consumieron y se fueron
-- =====================================================================
-- Una cuenta 'fiada' está cerrada pero su saldo quedó como deuda del cliente
ALTER TABLE cuentas DROP CONSTRAINT IF EXISTS cuentas_estado_check;
ALTER TABLE cuentas ADD CONSTRAINT cuentas_estado_check CHECK (estado IN ('abierta','pagada','anulada','fiada'));
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS fiado_monto  numeric(14,2);
ALTER TABLE cuentas ADD COLUMN IF NOT EXISTS fiado_motivo text;          -- 'fiado' | 'se_fue'

-- Estado de cuenta del cliente: cargos (lo que quedó debiendo) y abonos (lo que va pagando).
-- La deuda se lleva en la moneda en que se consumió; el abono puede entrar en cualquier moneda.
CREATE TABLE IF NOT EXISTS movimientos_credito (
  id             bigserial PRIMARY KEY,
  cliente_id     integer NOT NULL REFERENCES clientes(id),
  tipo           text NOT NULL CHECK (tipo IN ('cargo','abono')),
  motivo         text CHECK (motivo IN ('fiado','se_fue')),
  moneda         char(3) NOT NULL CHECK (moneda IN ('USD','COP','VES')),   -- moneda de la deuda
  monto          numeric(14,2) NOT NULL CHECK (monto > 0),                 -- en la moneda de la deuda
  monto_usd      numeric(14,4) NOT NULL DEFAULT 0,
  cuenta_id      bigint REFERENCES cuentas(id) ON DELETE SET NULL,
  -- Solo abonos: lo que realmente entregó el cliente y por dónde entró
  pago_moneda    char(3) CHECK (pago_moneda IN ('USD','COP','VES')),
  pago_monto     numeric(14,2),
  metodo_pago_id integer REFERENCES metodos_pago(id),
  sesion_caja_id integer REFERENCES sesiones_caja(id),
  referencia     text,
  nota           text,
  usuario_id     integer REFERENCES usuarios(id),
  fecha          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credito_cliente ON movimientos_credito (cliente_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_credito_sesion  ON movimientos_credito (sesion_caja_id) WHERE tipo = 'abono';

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
