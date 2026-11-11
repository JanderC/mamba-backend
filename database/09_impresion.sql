-- =====================================================================
--  IMPRESIÓN DE COMANDAS (impresora térmica de la barra / cocina)
--  Se aplica sola al arrancar el backend. Idempotente.
--  impreso_en marca qué ítems ya salieron por papel: así un pedido se imprime
--  una sola vez aunque haya dos pantallas con impresora o se caiga la conexión.
-- =====================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cuenta_items' AND column_name = 'impreso_en') THEN
    ALTER TABLE cuenta_items ADD COLUMN impreso_en timestamptz;
    -- Lo que ya existía antes de la impresora no se imprime de golpe al conectarla
    UPDATE cuenta_items SET impreso_en = creado_en;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_items_por_imprimir ON cuenta_items (estacion, creado_en) WHERE impreso_en IS NULL;
