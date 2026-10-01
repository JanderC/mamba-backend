import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { ROLES, autenticar, firmarToken, permitir } from '../../middlewares/auth.js';
import { HttpError, notFound } from '../../utils/http.js';

// ====================================================================== Login
export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera unos minutos.' },
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = z.object({ email: z.string().min(1), password: z.string().min(1) }).parse(req.body);
  const [u] = await query(`SELECT * FROM usuarios WHERE lower(email) = lower($1) AND activo`, [email.trim()]);
  if (!u || !(await bcrypt.compare(password, u.password_hash))) throw new HttpError(401, 'Correo o contraseña incorrectos');
  await query(`UPDATE usuarios SET ultimo_acceso = now() WHERE id = $1`, [u.id]);
  const usuario = { id: u.id, nombre: u.nombre, rol: u.rol };
  res.json({ token: firmarToken(usuario), usuario: { ...usuario, email: u.email } });
});

authRouter.get('/yo', autenticar, async (req, res) => {
  const [u] = await query(`SELECT id, nombre, email, rol FROM usuarios WHERE id = $1 AND activo`, [req.usuario.id]);
  if (!u) throw new HttpError(401, 'Usuario desactivado');
  res.json(u);
});

authRouter.post('/cambiar-password', autenticar, async (req, res) => {
  const { actual, nueva } = z
    .object({ actual: z.string().min(1), nueva: z.string().min(8, 'La nueva contraseña debe tener al menos 8 caracteres') })
    .parse(req.body);
  const [u] = await query(`SELECT password_hash FROM usuarios WHERE id = $1`, [req.usuario.id]);
  if (!u || !(await bcrypt.compare(actual, u.password_hash))) throw new HttpError(400, 'La contraseña actual no coincide');
  await query(`UPDATE usuarios SET password_hash = $2 WHERE id = $1`, [req.usuario.id, await bcrypt.hash(nueva, 10)]);
  res.json({ ok: true });
});

// ====================================================================== Usuarios
export const usuariosRouter = Router();

/** Lista corta para asignar mesoneros (cualquier rol operativo la puede ver) */
usuariosRouter.get('/equipo', async (_req, res) => {
  res.json(await query(`SELECT id, nombre, rol FROM usuarios WHERE activo ORDER BY nombre`));
});

usuariosRouter.use(permitir());

usuariosRouter.get('/', async (_req, res) => {
  res.json(await query(`SELECT id, nombre, email, rol, activo, ultimo_acceso, creado_en FROM usuarios ORDER BY activo DESC, nombre`));
});

const usuarioSchema = z.object({
  nombre: z.string().trim().min(2),
  email: z.email('Correo inválido'),
  rol: z.enum(ROLES),
  activo: z.boolean().default(true),
  password: z.string().min(8, 'Mínimo 8 caracteres').optional().or(z.literal('')),
});

usuariosRouter.post('/', async (req, res) => {
  const u = usuarioSchema.parse(req.body);
  if (!u.password) throw new HttpError(400, 'La contraseña es obligatoria para un usuario nuevo');
  const [existe] = await query(`SELECT 1 FROM usuarios WHERE lower(email) = lower($1)`, [u.email]);
  if (existe) throw new HttpError(409, 'Ya existe un usuario con ese correo');
  const [nuevo] = await query(
    `INSERT INTO usuarios (nombre, email, password_hash, rol, activo) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [u.nombre, u.email, await bcrypt.hash(u.password, 10), u.rol, u.activo],
  );
  res.status(201).json(nuevo);
});

usuariosRouter.put('/:id', async (req, res) => {
  const u = usuarioSchema.parse(req.body);
  const id = Number(req.params.id);
  if (id === req.usuario.id && (!u.activo || u.rol !== 'admin')) throw new HttpError(400, 'No puedes quitarte a ti mismo el rol de administrador');
  const [dup] = await query(`SELECT 1 FROM usuarios WHERE lower(email) = lower($1) AND id <> $2`, [u.email, id]);
  if (dup) throw new HttpError(409, 'Ya existe un usuario con ese correo');
  const hash = u.password ? await bcrypt.hash(u.password, 10) : null;
  const [act] = await query(
    `UPDATE usuarios SET nombre=$2, email=$3, rol=$4, activo=$5, password_hash = COALESCE($6, password_hash) WHERE id=$1 RETURNING id`,
    [id, u.nombre, u.email, u.rol, u.activo, hash],
  );
  if (!act) throw notFound('Usuario');
  res.json(act);
});
