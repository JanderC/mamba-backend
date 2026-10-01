import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../../db/pool.js';
import { R, permitir } from '../../middlewares/auth.js';
import { HttpError, notFound } from '../../utils/http.js';
import { MONEDAS } from '../../utils/moneda.js';

export const catalogoRouter = Router();

const slugify = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const precioOpc = z.number().min(0).nullish();

// ====================================================================== Categorías
catalogoRouter.get('/categorias', async (_req, res) => {
  res.json(
    await query(
      `SELECT c.*, (SELECT count(*) FROM productos p WHERE p.categoria_id = c.id AND p.disponible) AS productos
         FROM categorias_menu c ORDER BY c.activo DESC, c.orden, c.nombre`,
    ),
  );
});

const categoriaSchema = z.object({
  nombre: z.string().trim().min(2),
  descripcion: z.string().nullish(),
  tipo: z.enum(['bebida', 'comida', 'combo']),
  estacion: z.enum(['barra', 'cocina']),
  icono: z.string().nullish(),
  orden: z.number().int().default(0),
  activo: z.boolean().default(true),
});

catalogoRouter.post('/categorias', permitir(...R.gestion), async (req, res) => {
  const c = categoriaSchema.parse(req.body);
  const [n] = await query(
    `INSERT INTO categorias_menu (slug, nombre, descripcion, tipo, estacion, icono, orden, activo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [`${slugify(c.nombre)}-${Date.now().toString(36).slice(-4)}`, c.nombre, c.descripcion ?? null, c.tipo, c.estacion, c.icono ?? null, c.orden, c.activo],
  );
  res.status(201).json(n);
});

catalogoRouter.put('/categorias/:id', permitir(...R.gestion), async (req, res) => {
  const c = categoriaSchema.parse(req.body);
  const [n] = await query(
    `UPDATE categorias_menu SET nombre=$2, descripcion=$3, tipo=$4, estacion=$5, icono=$6, orden=$7, activo=$8 WHERE id=$1 RETURNING *`,
    [req.params.id, c.nombre, c.descripcion ?? null, c.tipo, c.estacion, c.icono ?? null, c.orden, c.activo],
  );
  if (!n) throw notFound('Categoría');
  res.json(n);
});

// ====================================================================== Productos
const SELECT_PRODUCTO = `
  SELECT p.id, p.slug, p.nombre, p.descripcion, p.ingredientes, p.etiquetas, p.imagen_url, p.destacado, p.disponible,
         p.visible_web, p.visible_pos, p.orden, p.moneda_base, p.categoria_id, c.nombre AS categoria, c.icono, c.estacion,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'id', v.id, 'presentacion', v.presentacion, 'precio', v.precio, 'orden', v.orden,
                    'precio_manual_usd', v.precio_manual_usd, 'precio_manual_cop', v.precio_manual_cop, 'precio_manual_ves', v.precio_manual_ves,
                    'seleccion_categoria_insumo_id', v.seleccion_categoria_insumo_id, 'seleccion_cantidad', v.seleccion_cantidad,
                    'receta', COALESCE((
                       SELECT json_agg(json_build_object('insumo_id', r.insumo_id, 'insumo', i.nombre, 'unidad', i.unidad,
                                'cantidad', r.cantidad, 'removible', r.removible, 'etiqueta', r.etiqueta) ORDER BY r.orden, r.id)
                         FROM receta_items r JOIN insumos i ON i.id = r.insumo_id WHERE r.precio_producto_id = v.id), '[]'::json)
                  ) ORDER BY v.orden, v.precio)
             FROM precios_producto v WHERE v.producto_id = p.id AND v.activo), '[]'::json) AS variantes
    FROM productos p JOIN categorias_menu c ON c.id = p.categoria_id`;

catalogoRouter.get('/productos', async (_req, res) => {
  res.json(await query(`${SELECT_PRODUCTO} ORDER BY c.orden, p.orden, p.nombre`));
});

const productoSchema = z.object({
  nombre: z.string().trim().min(2),
  categoria_id: z.number().int(),
  descripcion: z.string().nullish(),
  ingredientes: z.array(z.string()).default([]),
  etiquetas: z.array(z.string()).default([]),
  imagen_url: z.string().nullish(),
  moneda_base: z.enum(MONEDAS),
  destacado: z.boolean().default(false),
  disponible: z.boolean().default(true),
  visible_web: z.boolean().default(true),
  visible_pos: z.boolean().default(true),
  orden: z.number().int().default(0),
  variantes: z
    .array(
      z.object({
        id: z.number().int().nullish(),
        presentacion: z.string().trim().min(1, 'Cada presentación necesita nombre'),
        precio: z.number().min(0),
        precio_manual_usd: precioOpc,
        precio_manual_cop: precioOpc,
        precio_manual_ves: precioOpc,
        seleccion_categoria_insumo_id: z.number().int().nullish(),
        seleccion_cantidad: z.number().int().min(1).max(100).nullish(),
        receta: z
          .array(
            z.object({
              insumo_id: z.number().int(),
              cantidad: z.number().positive(),
              removible: z.boolean().default(false),
              etiqueta: z.string().nullish(),
            }),
          )
          .default([]),
      }),
    )
    .min(1, 'Agrega al menos una presentación con su precio'),
});

async function guardarProducto(id: number | null, p: z.infer<typeof productoSchema>) {
  const nombres = p.variantes.map((v) => v.presentacion.toLowerCase());
  if (new Set(nombres).size !== nombres.length) throw new HttpError(400, 'Hay presentaciones repetidas');

  return tx(async (db) => {
    const vals = [p.nombre, p.categoria_id, p.descripcion ?? null, p.ingredientes, p.etiquetas, p.imagen_url ?? null, p.moneda_base,
      p.destacado, p.disponible, p.visible_web, p.visible_pos, p.orden];
    let productoId = id;
    if (id) {
      const r = await query(
        `UPDATE productos SET nombre=$1, categoria_id=$2, descripcion=$3, ingredientes=$4, etiquetas=$5, imagen_url=$6, moneda_base=$7,
                destacado=$8, disponible=$9, visible_web=$10, visible_pos=$11, orden=$12 WHERE id=$13 RETURNING id`,
        [...vals, id], db,
      );
      if (!r[0]) throw notFound('Producto');
    } else {
      const [n] = await query<{ id: number }>(
        `INSERT INTO productos (nombre, categoria_id, descripcion, ingredientes, etiquetas, imagen_url, moneda_base, destacado,
                                disponible, visible_web, visible_pos, orden, slug)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [...vals, `${slugify(p.nombre)}-${Date.now().toString(36).slice(-4)}`], db,
      );
      productoId = n.id;
    }

    // Variantes: se actualizan por id, las nuevas se insertan y las que ya no vienen se desactivan
    // (no se borran: las ventas históricas las referencian).
    const conservar: number[] = [];
    for (const [i, v] of p.variantes.entries()) {
      const sel = v.seleccion_categoria_insumo_id && v.seleccion_cantidad ? [v.seleccion_categoria_insumo_id, v.seleccion_cantidad] : [null, null];
      const datos = [v.presentacion, v.precio, i + 1, v.precio_manual_usd ?? null, v.precio_manual_cop ?? null, v.precio_manual_ves ?? null, ...sel];
      let varianteId = v.id ?? null;
      if (varianteId) {
        const r = await query(
          `UPDATE precios_producto SET presentacion=$1, precio=$2, orden=$3, precio_manual_usd=$4, precio_manual_cop=$5,
                  precio_manual_ves=$6, seleccion_categoria_insumo_id=$7, seleccion_cantidad=$8, activo=true
            WHERE id=$9 AND producto_id=$10 RETURNING id`,
          [...datos, varianteId, productoId], db,
        );
        if (!r[0]) varianteId = null;
      }
      if (!varianteId) {
        const [n] = await query<{ id: number }>(
          `INSERT INTO precios_producto (presentacion, precio, orden, precio_manual_usd, precio_manual_cop, precio_manual_ves,
                                         seleccion_categoria_insumo_id, seleccion_cantidad, producto_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (producto_id, presentacion) DO UPDATE SET precio=EXCLUDED.precio, orden=EXCLUDED.orden, activo=true,
             precio_manual_usd=EXCLUDED.precio_manual_usd, precio_manual_cop=EXCLUDED.precio_manual_cop, precio_manual_ves=EXCLUDED.precio_manual_ves,
             seleccion_categoria_insumo_id=EXCLUDED.seleccion_categoria_insumo_id, seleccion_cantidad=EXCLUDED.seleccion_cantidad
           RETURNING id`,
          [...datos, productoId], db,
        );
        varianteId = n.id;
      }
      conservar.push(varianteId);

      await query(`DELETE FROM receta_items WHERE precio_producto_id = $1`, [varianteId], db);
      const vistos = new Set<number>();
      for (const [j, r] of v.receta.entries()) {
        if (vistos.has(r.insumo_id)) throw new HttpError(400, `El insumo está repetido en la receta de "${v.presentacion}"`);
        vistos.add(r.insumo_id);
        await query(
          `INSERT INTO receta_items (precio_producto_id, insumo_id, cantidad, removible, etiqueta, orden) VALUES ($1,$2,$3,$4,$5,$6)`,
          [varianteId, r.insumo_id, r.cantidad, r.removible, r.etiqueta || null, j + 1], db,
        );
      }
    }
    // Se renombran para liberar el nombre de la presentación (hay un UNIQUE por producto)
    await query(
      `UPDATE precios_producto SET activo = false, presentacion = presentacion || ' (retirada ' || id || ')'
        WHERE producto_id = $1 AND activo AND NOT (id = ANY($2::int[]))`,
      [productoId, conservar], db,
    );
    return productoId;
  });
}

catalogoRouter.post('/productos', permitir(...R.gestion), async (req, res) => {
  res.status(201).json({ id: await guardarProducto(null, productoSchema.parse(req.body)) });
});

catalogoRouter.put('/productos/:id', permitir(...R.gestion), async (req, res) => {
  res.json({ id: await guardarProducto(Number(req.params.id), productoSchema.parse(req.body)) });
});

/** Cambios rápidos desde la lista (agotado, destacado, visible) */
catalogoRouter.patch('/productos/:id', permitir(...R.gestion, 'cajero', 'barra'), async (req, res) => {
  const b = z
    .object({ disponible: z.boolean(), destacado: z.boolean(), visible_web: z.boolean(), visible_pos: z.boolean() })
    .partial()
    .parse(req.body);
  const [p] = await query(
    `UPDATE productos SET disponible = COALESCE($2, disponible), destacado = COALESCE($3, destacado),
            visible_web = COALESCE($4, visible_web), visible_pos = COALESCE($5, visible_pos)
      WHERE id = $1 RETURNING id`,
    [req.params.id, b.disponible ?? null, b.destacado ?? null, b.visible_web ?? null, b.visible_pos ?? null],
  );
  if (!p) throw notFound('Producto');
  res.json(p);
});

// ====================================================================== Adicionales
catalogoRouter.get('/adicionales', async (_req, res) => {
  res.json(
    await query(
      `SELECT a.*, i.nombre AS insumo, i.unidad,
              COALESCE((SELECT array_agg(ac.categoria_id) FROM adicional_categorias ac WHERE ac.adicional_id = a.id), '{}') AS categorias
         FROM adicionales a LEFT JOIN insumos i ON i.id = a.insumo_id
        ORDER BY a.activo DESC, a.orden, a.nombre`,
    ),
  );
});

const adicionalSchema = z.object({
  nombre: z.string().trim().min(2),
  precio: z.number().min(0),
  moneda_base: z.enum(MONEDAS),
  precio_manual_usd: precioOpc,
  precio_manual_cop: precioOpc,
  precio_manual_ves: precioOpc,
  insumo_id: z.number().int().nullish(),
  cantidad_insumo: z.number().positive().default(1),
  orden: z.number().int().default(0),
  activo: z.boolean().default(true),
  categorias: z.array(z.number().int()).default([]),
});

async function guardarAdicional(id: number | null, a: z.infer<typeof adicionalSchema>) {
  return tx(async (db) => {
    const vals = [a.nombre, a.precio, a.moneda_base, a.precio_manual_usd ?? null, a.precio_manual_cop ?? null, a.precio_manual_ves ?? null,
      a.insumo_id ?? null, a.cantidad_insumo, a.orden, a.activo];
    const [dup] = await query(`SELECT 1 FROM adicionales WHERE lower(nombre) = lower($1) AND id <> COALESCE($2, 0)`, [a.nombre, id], db);
    if (dup) throw new HttpError(409, 'Ya existe un adicional con ese nombre');
    const [row] = id
      ? await query<{ id: number }>(
          `UPDATE adicionales SET nombre=$1, precio=$2, moneda_base=$3, precio_manual_usd=$4, precio_manual_cop=$5, precio_manual_ves=$6,
                  insumo_id=$7, cantidad_insumo=$8, orden=$9, activo=$10 WHERE id=$11 RETURNING id`,
          [...vals, id], db,
        )
      : await query<{ id: number }>(
          `INSERT INTO adicionales (nombre, precio, moneda_base, precio_manual_usd, precio_manual_cop, precio_manual_ves, insumo_id,
                                    cantidad_insumo, orden, activo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          vals, db,
        );
    if (!row) throw notFound('Adicional');
    await query(`DELETE FROM adicional_categorias WHERE adicional_id = $1`, [row.id], db);
    for (const c of new Set(a.categorias))
      await query(`INSERT INTO adicional_categorias (adicional_id, categoria_id) VALUES ($1,$2)`, [row.id, c], db);
    return row.id;
  });
}

catalogoRouter.post('/adicionales', permitir(...R.gestion), async (req, res) => {
  res.status(201).json({ id: await guardarAdicional(null, adicionalSchema.parse(req.body)) });
});
catalogoRouter.put('/adicionales/:id', permitir(...R.gestion), async (req, res) => {
  res.json({ id: await guardarAdicional(Number(req.params.id), adicionalSchema.parse(req.body)) });
});
