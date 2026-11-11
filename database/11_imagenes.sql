-- =====================================================================
--  IMÁGENES SUBIDAS DESDE EL PANEL (galería y fotos de productos)
--  Se guardan en la base porque el hosting no conserva archivos subidos.
--  El navegador las achica antes de subirlas (≈200–400 KB c/u). Aditiva e idempotente.
-- =====================================================================
CREATE TABLE IF NOT EXISTS imagenes (
  id          serial PRIMARY KEY,
  tipo        text   NOT NULL,             -- image/webp, image/jpeg, image/png
  datos       bytea  NOT NULL,
  bytes       integer NOT NULL,
  creado_por  integer,
  creado_en   timestamptz NOT NULL DEFAULT now()
);

-- Fila de galería ligada a la imagen subida (para borrar las dos juntas)
ALTER TABLE galeria ADD COLUMN IF NOT EXISTS imagen_id integer REFERENCES imagenes(id) ON DELETE SET NULL;
