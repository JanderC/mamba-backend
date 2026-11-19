-- =====================================================================
--  CLIENTES NUEVOS EN UNA MESA OCUPADA (QR)
--  Si la mesa sigue con la cuenta del grupo anterior, el cliente elige al pedir: sumarse a esa cuenta o
--  abrir una aparte. El pedido guarda a qué cuenta va (cuenta_destino) o si es cuenta nueva.
--  Aditiva; se aplica sola al arrancar.
-- =====================================================================
ALTER TABLE pedidos_qr ADD COLUMN IF NOT EXISTS cuenta_destino bigint;
ALTER TABLE pedidos_qr ADD COLUMN IF NOT EXISTS cuenta_nueva boolean NOT NULL DEFAULT false;
