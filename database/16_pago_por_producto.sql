-- =====================================================================
--  COBRO POR PRODUCTO (cuentas separadas: «yo pago la hamburguesa y la malteada»)
--  Cada producto guarda cuántas unidades ya se pagaron, para que nadie pague dos veces lo mismo.
--  Aditiva; se aplica sola al arrancar.
-- =====================================================================
ALTER TABLE cuenta_items ADD COLUMN IF NOT EXISTS pagado_cantidad numeric(10,2) NOT NULL DEFAULT 0;
