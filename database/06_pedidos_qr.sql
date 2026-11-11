-- Pedidos desde el QR de la mesa: el cliente escanea, ve la carta y envía su pedido; llega a la barra,
-- que lo acepta (entra a la cuenta de la mesa y sale a cocina/barra como cualquier comanda) o lo rechaza.
-- Aditivo: se puede correr varias veces. El backend también lo aplica solo al arrancar.

-- Cada mesa tiene un código secreto para su QR: no se puede pedir a otra mesa cambiando un número en la URL
ALTER TABLE mesas ADD COLUMN IF NOT EXISTS qr_token text;
UPDATE mesas SET qr_token = substr(md5(random()::text || clock_timestamp()::text || id::text), 1, 12) WHERE qr_token IS NULL;
ALTER TABLE mesas ALTER COLUMN qr_token SET DEFAULT substr(md5(random()::text || clock_timestamp()::text), 1, 12);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mesas_qr_token ON mesas (qr_token);

CREATE TABLE IF NOT EXISTS pedidos_qr (
  id              bigserial PRIMARY KEY,
  mesa_id         integer NOT NULL REFERENCES mesas(id),
  cuenta_id       bigint REFERENCES cuentas(id),
  nombre_cliente  text,
  nota            text,
  -- Lo que pidió, tal como se enviará a agregarItems (variante, cantidad, sin, adicionales, surtido)
  items           jsonb NOT NULL,
  -- Copia legible para la barra y el cliente: nombre, presentación, detalle, precio
  resumen         jsonb NOT NULL,
  moneda          char(3) NOT NULL,
  total_estimado  numeric(14,2) NOT NULL DEFAULT 0,
  estado          text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','aceptado','rechazado')),
  motivo          text,
  ip              text,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  atendido_en     timestamptz,
  atendido_por    integer REFERENCES usuarios(id)
);
CREATE INDEX IF NOT EXISTS idx_pedidos_qr_pendientes ON pedidos_qr (creado_en) WHERE estado = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_pedidos_qr_mesa ON pedidos_qr (mesa_id, creado_en DESC);

-- Interruptor general (Configuración): si está en false, el QR muestra la carta pero no deja pedir
INSERT INTO ajustes (clave, valor) VALUES ('pedidos_qr_activo', 'true'::jsonb) ON CONFLICT (clave) DO NOTHING;
