-- =====================================================================
--  DATOS DE PAGO PARA EL CLIENTE (QR)
--  Lo que ve el cliente al pedir la cuenta: número de Nequi, datos de Pago Móvil, correo de Zelle…
--  Aditiva; se aplica sola al arrancar.
-- =====================================================================
ALTER TABLE metodos_pago ADD COLUMN IF NOT EXISTS datos_pago text;
