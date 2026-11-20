-- =====================================================================
--  ASISTENCIA DEL PERSONAL (hora de entrada y salida)
--  Cada empleado marca su entrada al empezar y su salida al irse. Aditiva; se aplica sola al arrancar.
-- =====================================================================
CREATE TABLE IF NOT EXISTS asistencias (
  id          serial PRIMARY KEY,
  usuario_id  integer NOT NULL REFERENCES usuarios(id),
  entrada     timestamptz NOT NULL DEFAULT now(),
  salida      timestamptz,
  nota        text
);
CREATE INDEX IF NOT EXISTS idx_asistencias_usuario ON asistencias (usuario_id, entrada DESC);
CREATE INDEX IF NOT EXISTS idx_asistencias_abiertas ON asistencias (usuario_id) WHERE salida IS NULL;

-- Cierre diario automático: a quién se le manda y a qué hora (vacío = no se manda)
INSERT INTO ajustes (clave, valor) VALUES ('cierre_whatsapp', '""'::jsonb), ('cierre_email', '""'::jsonb), ('cierre_hora', '6'::jsonb)
ON CONFLICT (clave) DO NOTHING;
