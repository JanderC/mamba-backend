-- =====================================================================
--  ÁREAS DE INVENTARIO (cocina · barra · general) — se aplica sola al arrancar
--  Es la misma migración de 03_sistema.sql, pero en archivo propio para que llegue
--  a las bases que ya estaban instaladas (03 solo corre con db:instalar).
--  Idempotente. La asignación inicial de áreas solo corre la primera vez,
--  para no pisar lo que el equipo haya cambiado después a mano.
-- =====================================================================
DO $$
DECLARE nueva boolean := NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'insumos' AND column_name = 'area');
BEGIN
  ALTER TABLE categorias_insumo ADD COLUMN IF NOT EXISTS area text NOT NULL DEFAULT 'general';
  ALTER TABLE insumos           ADD COLUMN IF NOT EXISTS area text NOT NULL DEFAULT 'general';
  BEGIN
    ALTER TABLE categorias_insumo ADD CONSTRAINT ck_cat_insumo_area CHECK (area IN ('cocina','barra','general'));
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    ALTER TABLE insumos ADD CONSTRAINT ck_insumo_area CHECK (area IN ('cocina','barra','general'));
  EXCEPTION WHEN duplicate_object THEN NULL; END;

  IF nueva THEN
    -- Área por defecto de las categorías que ya existían
    UPDATE categorias_insumo SET area = CASE
             WHEN nombre ILIKE '%cocina%'                          THEN 'cocina'
             WHEN nombre ILIKE '%licor%' OR nombre ILIKE '%mixer%' THEN 'barra'
             ELSE 'general' END;
    -- Los insumos heredan el área de su categoría
    UPDATE insumos i SET area = c.area FROM categorias_insumo c
     WHERE c.id = i.categoria_insumo_id AND c.area <> 'general';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_insumos_area ON insumos (area, activo);
