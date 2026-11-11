import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { query, tx } from '../../db/pool.js';
import { HttpError, notFound } from '../../utils/http.js';

/**
 * Imágenes subidas desde el panel. Se guardan en la base (el hosting no conserva archivos subidos)
 * y se sirven en /api/imagenes/:id con caché larga: una imagen nunca cambia, si se reemplaza es otra.
 */
const TIPOS = ['image/webp', 'image/jpeg', 'image/png'];
const MAX_BYTES = 2.5 * 1024 * 1024;

let lista: Promise<unknown> | null = null;
/** Crea la tabla si el arranque todavía no la aplicó */
const asegurar = () => (lista ??= import('../../services/migraciones.js').then((m) => m.aplicarMigraciones()));

export const imagenesRouter = Router();
imagenesRouter.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw notFound('Imagen');
  await asegurar();
  const [img] = await query<{ tipo: string; datos: Buffer }>(`SELECT tipo, datos FROM imagenes WHERE id = $1`, [id]);
  if (!img) throw notFound('Imagen');
  res.set({
    'Content-Type': img.tipo,
    'Cache-Control': 'public, max-age=31536000, immutable',
    // la web está en otro dominio: sin esto helmet bloquea la imagen
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  res.send(img.datos);
});

const urlDe = (req: Request, id: number) => `${req.protocol}://${req.get('host')}/api/imagenes/${id}`;

async function guardarImagen(req: Request) {
  const tipo = String(req.headers['content-type'] ?? '').split(';')[0].trim();
  if (!TIPOS.includes(tipo)) throw new HttpError(400, 'La foto debe ser JPG, PNG o WebP');
  const datos = req.body;
  if (!Buffer.isBuffer(datos) || !datos.length) throw new HttpError(400, 'No llegó la foto');
  if (datos.length > MAX_BYTES) throw new HttpError(413, 'La foto pesa demasiado (máximo 2,5 MB)');
  await asegurar();
  const [r] = await query<{ id: number }>(
    `INSERT INTO imagenes (tipo, datos, bytes, creado_por) VALUES ($1, $2, $3, $4) RETURNING id`,
    [tipo, datos, datos.length, req.usuario?.id ?? null],
  );
  return { id: r.id, url: urlDe(req, r.id) };
}

const binario = express.raw({ type: TIPOS, limit: MAX_BYTES });

/** /api/admin/imagenes — subir una foto suelta (productos, flyers…). Devuelve su URL pública. */
export const subirImagenRouter = Router();
subirImagenRouter.post('/', binario, async (req, res) => {
  res.status(201).json(await guardarImagen(req));
});

/** /api/admin/galeria — las fotos de la página Galería («El ambiente») */
export const galeriaAdminRouter = Router();
galeriaAdminRouter.use(async (_req, _res, next) => { await asegurar(); next(); });

galeriaAdminRouter.get('/', async (_req, res) => {
  res.json(await query(
    `SELECT id, url, descripcion, activo, orden, publicado_en FROM galeria
      WHERE fuente = 'local' ORDER BY orden, publicado_en DESC`,
  ));
});

/** Sube la foto y la agrega al final de la galería. ?descripcion= opcional */
galeriaAdminRouter.post('/', binario, async (req, res) => {
  const img = await guardarImagen(req);
  const descripcion = typeof req.query.descripcion === 'string' && req.query.descripcion.trim() ? req.query.descripcion.trim().slice(0, 300) : null;
  const [g] = await query(
    `INSERT INTO galeria (tipo, fuente, url, descripcion, imagen_id, orden)
     VALUES ('foto', 'local', $1, $2, $3, COALESCE((SELECT max(orden) + 1 FROM galeria WHERE fuente = 'local'), 0))
     RETURNING id, url, descripcion, activo, orden, publicado_en`,
    [img.url, descripcion, img.id],
  );
  res.status(201).json(g);
});

galeriaAdminRouter.patch('/:id', async (req, res) => {
  const b = z.object({ descripcion: z.string().trim().max(300).nullish(), activo: z.boolean().optional() }).parse(req.body);
  const [g] = await query(
    `UPDATE galeria SET descripcion = CASE WHEN $2::boolean THEN $3 ELSE descripcion END, activo = COALESCE($4, activo)
      WHERE id = $1 AND fuente = 'local' RETURNING id, url, descripcion, activo, orden, publicado_en`,
    [Number(req.params.id), b.descripcion !== undefined, b.descripcion || null, b.activo ?? null],
  );
  if (!g) throw notFound('Foto');
  res.json(g);
});

/** Nuevo orden: lista de ids de arriba hacia abajo */
galeriaAdminRouter.put('/orden', async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.number().int()).max(500) }).parse(req.body);
  await query(
    `UPDATE galeria g SET orden = o.n - 1 FROM unnest($1::int[]) WITH ORDINALITY AS o(id, n)
      WHERE g.id = o.id AND g.fuente = 'local'`,
    [ids],
  );
  res.json({ ok: true });
});

galeriaAdminRouter.delete('/:id', async (req, res) => {
  await tx(async (c) => {
    const { rows } = await c.query(`DELETE FROM galeria WHERE id = $1 AND fuente = 'local' RETURNING imagen_id`, [Number(req.params.id)]);
    if (!rows[0]) throw notFound('Foto');
    if (rows[0].imagen_id) await c.query(`DELETE FROM imagenes WHERE id = $1`, [rows[0].imagen_id]);
  });
  res.status(204).end();
});

