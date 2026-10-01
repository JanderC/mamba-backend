import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../../db/pool.js';
import { R, permitir } from '../../middlewares/auth.js';
import { HttpError, notFound } from '../../utils/http.js';
import { MONEDAS } from '../../utils/moneda.js';

export const inventarioRouter = Router();

inventarioRouter.get('/categorias', async (_req, res) => {
  res.json(await query(`SELECT * FROM categorias_insumo ORDER BY nombre`));
});

inventarioRouter.post('/categorias', permitir(...R.gestion), async (req, res) => {
  const c = z.object({ nombre: z.string().trim().min(2), icono: z.string().nullish() }).parse(req.body);
  const [n] = await query(
    `INSERT INTO categorias_insumo (nombre, icono) VALUES ($1,$2) ON CONFLICT (nombre) DO UPDATE SET icono = EXCLUDED.icono RETURNING *`,
    [c.nombre, c.icono ?? null],
  );
  res.status(201).json(n);
});

// ====================================================================== Insumos
inventarioRouter.get('/insumos', async (_req, res) => {
  res.json(
    await query(
      `SELECT i.*, c.nombre AS categoria, c.icono,
              (i.stock <= i.stock_minimo) AS bajo,
              round(i.stock * i.costo_unitario, 2) AS valor
         FROM insumos i LEFT JOIN categorias_insumo c ON c.id = i.categoria_insumo_id
        ORDER BY i.activo DESC, c.nombre, i.nombre`,
    ),
  );
});

const insumoSchema = z.object({
  codigo: z.string().trim().nullish(),
  nombre: z.string().trim().min(2),
  categoria_insumo_id: z.number().int().nullish(),
  unidad: z.enum(['und', 'ml', 'g']),
  presentacion_compra: z.string().nullish(),
  factor_compra: z.number().positive().default(1),
  stock_minimo: z.number().min(0).default(0),
  costo_unitario: z.number().min(0).default(0),
  moneda_costo: z.enum(MONEDAS),
  recargo_seleccion: z.number().min(0).default(0),
  activo: z.boolean().default(true),
  stock_inicial: z.number().min(0).optional(), // solo al crear
});

inventarioRouter.post('/insumos', permitir(...R.gestion), async (req, res) => {
  const i = insumoSchema.parse(req.body);
  const id = await tx(async (db) => {
    const codigo = i.codigo || `INS-${Date.now().toString(36).toUpperCase()}`;
    const [dup] = await query(`SELECT 1 FROM insumos WHERE codigo = $1`, [codigo], db);
    if (dup) throw new HttpError(409, 'Ya existe un insumo con ese código');
    const stock = i.stock_inicial ?? 0;
    const [n] = await query<{ id: number }>(
      `INSERT INTO insumos (codigo, nombre, categoria_insumo_id, unidad, presentacion_compra, factor_compra, stock, stock_minimo,
                            costo_unitario, moneda_costo, recargo_seleccion, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [codigo, i.nombre, i.categoria_insumo_id ?? null, i.unidad, i.presentacion_compra ?? null, i.factor_compra, stock, i.stock_minimo,
       i.costo_unitario, i.moneda_costo, i.recargo_seleccion, i.activo], db,
    );
    if (stock > 0)
      await query(
        `INSERT INTO movimientos_inventario (insumo_id, tipo, cantidad, stock_resultante, costo_unitario, moneda_costo, nota, usuario_id)
         VALUES ($1,'entrada',$2,$2,$3,$4,'Inventario inicial',$5)`,
        [n.id, stock, i.costo_unitario, i.moneda_costo, req.usuario.id], db,
      );
    return n.id;
  });
  res.status(201).json({ id });
});

inventarioRouter.put('/insumos/:id', permitir(...R.gestion), async (req, res) => {
  const i = insumoSchema.parse(req.body);
  const [n] = await query(
    `UPDATE insumos SET nombre=$2, categoria_insumo_id=$3, unidad=$4, presentacion_compra=$5, factor_compra=$6, stock_minimo=$7,
            costo_unitario=$8, moneda_costo=$9, recargo_seleccion=$10, activo=$11, codigo = COALESCE(NULLIF($12,''), codigo)
      WHERE id=$1 RETURNING id`,
    [req.params.id, i.nombre, i.categoria_insumo_id ?? null, i.unidad, i.presentacion_compra ?? null, i.factor_compra, i.stock_minimo,
     i.costo_unitario, i.moneda_costo, i.recargo_seleccion, i.activo, i.codigo ?? ''],
  );
  if (!n) throw notFound('Insumo');
  res.json(n);
});

// ====================================================================== Movimientos (kardex)
const movimientoSchema = z.object({
  insumo_id: z.number().int(),
  tipo: z.enum(['entrada', 'ajuste', 'merma', 'consumo_interno']),
  /**
   * entrada / merma / consumo_interno: cantidad que entra o sale (siempre positiva).
   * ajuste: el stock REAL contado físicamente (el sistema calcula la diferencia).
   */
  cantidad: z.number().min(0),
  /** true = la cantidad viene en la presentación de compra (cajas, botellas) y se multiplica por el factor */
  en_presentacion: z.boolean().default(false),
  /** Costo de la unidad de compra o base, según `en_presentacion` (solo entradas) */
  costo: z.number().min(0).nullish(),
  proveedor: z.string().nullish(),
  nota: z.string().nullish(),
});

inventarioRouter.post('/movimientos', permitir(...R.gestion, 'barra', 'cocina'), async (req, res) => {
  const m = movimientoSchema.parse(req.body);
  if (['ajuste', 'entrada'].includes(m.tipo) && !['admin', 'gerente'].includes(req.usuario.rol))
    throw new HttpError(403, 'Solo gerencia puede registrar entradas o ajustes');

  const resultado = await tx(async (db) => {
    const [ins] = await query(`SELECT * FROM insumos WHERE id = $1 FOR UPDATE`, [m.insumo_id], db);
    if (!ins) throw notFound('Insumo');
    const factor = m.en_presentacion ? Number(ins.factor_compra) : 1;
    const base = m.cantidad * factor;

    let delta: number;
    if (m.tipo === 'entrada') delta = base;
    else if (m.tipo === 'ajuste') delta = base - Number(ins.stock);
    else delta = -base;
    if (m.tipo !== 'ajuste' && base <= 0) throw new HttpError(400, 'La cantidad debe ser mayor a cero');
    if (delta === 0) throw new HttpError(400, 'El stock contado es igual al del sistema: no hay nada que ajustar');

    // Entradas: costo promedio ponderado
    let costo = Number(ins.costo_unitario);
    if (m.tipo === 'entrada' && m.costo != null) {
      const costoBase = m.costo / factor;
      const stockPrevio = Math.max(0, Number(ins.stock));
      costo = stockPrevio + base > 0 ? (stockPrevio * costo + base * costoBase) / (stockPrevio + base) : costoBase;
    }

    const [act] = await query<{ stock: number }>(
      `UPDATE insumos SET stock = stock + $2, costo_unitario = $3 WHERE id = $1 RETURNING stock`,
      [ins.id, delta, costo], db,
    );
    await query(
      `INSERT INTO movimientos_inventario (insumo_id, tipo, cantidad, stock_resultante, costo_unitario, moneda_costo, proveedor, nota, usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ins.id, m.tipo, delta, act.stock, costo, ins.moneda_costo, m.proveedor || null, m.nota || null, req.usuario.id], db,
    );
    return { id: ins.id, stock: act.stock, delta };
  });
  res.status(201).json(resultado);
});

inventarioRouter.get('/movimientos', async (req, res) => {
  const f = z
    .object({ insumo_id: z.coerce.number().int().optional(), tipo: z.string().optional(), limite: z.coerce.number().int().max(500).default(200) })
    .parse(req.query);
  res.json(
    await query(
      `SELECT m.*, i.nombre AS insumo, i.unidad, u.nombre AS usuario
         FROM movimientos_inventario m
         JOIN insumos i ON i.id = m.insumo_id
         LEFT JOIN usuarios u ON u.id = m.usuario_id
        WHERE ($1::int IS NULL OR m.insumo_id = $1) AND ($2::text IS NULL OR m.tipo = $2)
        ORDER BY m.fecha DESC, m.id DESC LIMIT $3`,
      [f.insumo_id ?? null, f.tipo || null, f.limite],
    ),
  );
});
