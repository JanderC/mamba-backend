-- =====================================================================
--  LO DE COCINA QUE PIDE EL MESONERO PASA PRIMERO POR LA BARRA
--  El ítem queda «en barra» (en_barra_desde) hasta que la barra lo envía: recién ahí aparece en la
--  pantalla de cocina y se imprime la comanda. Aditiva e idempotente; se aplica sola al arrancar.
-- =====================================================================
ALTER TABLE cuenta_items ADD COLUMN IF NOT EXISTS en_barra_desde timestamptz;
CREATE INDEX IF NOT EXISTS idx_items_en_barra ON cuenta_items (en_barra_desde) WHERE en_barra_desde IS NOT NULL;

-- Interruptor en Configuración (encendido por defecto)
INSERT INTO ajustes (clave, valor) VALUES ('cocina_pasa_por_barra', 'true'::jsonb) ON CONFLICT (clave) DO NOTHING;
