-- =====================================================================
--  CAJAS Y MÉTODOS DE PAGO DE BASE — se aplica sola al arrancar
--  Sin cajas no se puede abrir turno y sin métodos de pago no se puede cobrar. Si una base quedó
--  instalada sin ellos, se crean los de siempre. Solo actúa cuando la tabla está vacía: si el equipo
--  ya creó o cambió los suyos, no toca nada.
-- =====================================================================
INSERT INTO metodos_pago (nombre, es_efectivo, monedas, requiere_referencia, orden)
SELECT v.* FROM (VALUES
  ('Efectivo',                 true,  '{COP,USD,VES}'::text[], false, 1),
  ('Transferencia Bancolombia',false, '{COP}'::text[],         true,  2),
  ('Nequi',                    false, '{COP}'::text[],         true,  3),
  ('Pago Móvil',               false, '{VES}'::text[],         true,  4),
  ('Punto de Venta',           false, '{VES,COP}'::text[],     true,  5),
  ('Zelle',                    false, '{USD}'::text[],         true,  6),
  ('Binance / USDT',           false, '{USD}'::text[],         true,  7)
) AS v(nombre, es_efectivo, monedas, requiere_referencia, orden)
WHERE NOT EXISTS (SELECT 1 FROM metodos_pago)
ON CONFLICT (nombre) DO NOTHING;

-- Una sola caja para todo el local
INSERT INTO cajas (nombre, descripcion)
SELECT v.* FROM (VALUES
  ('Caja Principal', 'La caja del local: aquí entra todo lo que se cobra')
) AS v(nombre, descripcion)
WHERE NOT EXISTS (SELECT 1 FROM cajas)
ON CONFLICT (nombre) DO NOTHING;
