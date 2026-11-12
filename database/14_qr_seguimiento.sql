-- =====================================================================
--  SEGUIMIENTO DEL PEDIDO QR EN EL TELÉFONO DEL CLIENTE
--  Al aceptar el pedido se guarda la ronda en que entró a la cuenta: así el cliente ve el estado de
--  cada producto (confirmado → preparando → listo → entregado). Aditiva; se aplica sola al arrancar.
-- =====================================================================
ALTER TABLE pedidos_qr ADD COLUMN IF NOT EXISTS ronda smallint;
