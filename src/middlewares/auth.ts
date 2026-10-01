import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const ROLES = ['admin', 'gerente', 'cajero', 'mesonero', 'barra', 'cocina', 'rrpp'] as const;
export type Rol = (typeof ROLES)[number];
export type UsuarioToken = { id: number; nombre: string; rol: Rol };

declare module 'express-serve-static-core' {
  interface Request {
    usuario: UsuarioToken;
  }
}

export const firmarToken = (u: UsuarioToken) =>
  jwt.sign(u, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRA as jwt.SignOptions['expiresIn'] });

/** Exige  Authorization: Bearer <token> */
export const autenticar: RequestHandler = (req, res, next) => {
  const token = req.header('authorization')?.split(' ')[1];
  if (!token) {
    res.status(401).json({ error: 'Sesión no iniciada' });
    return;
  }
  try {
    const { id, nombre, rol } = jwt.verify(token, env.JWT_SECRET) as UsuarioToken;
    req.usuario = { id, nombre, rol };
    next();
  } catch {
    res.status(401).json({ error: 'Sesión expirada. Vuelve a iniciar sesión.' });
  }
};

/** El admin siempre pasa; el resto solo si su rol está en la lista */
export const permitir =
  (...roles: Rol[]): RequestHandler =>
  (req, res, next) => {
    if (req.usuario.rol === 'admin' || roles.includes(req.usuario.rol)) return next();
    res.status(403).json({ error: 'No tienes permiso para esta acción' });
  };

// Grupos de roles por tipo de tarea
export const R = {
  /** Toma pedidos y atiende mesas */
  servicio: ['gerente', 'cajero', 'mesonero', 'barra'] as Rol[],
  /** Recibe dinero */
  cobro: ['gerente', 'cajero', 'barra'] as Rol[],
  /** Ve y despacha comandas */
  comandas: ['gerente', 'cajero', 'mesonero', 'barra', 'cocina'] as Rol[],
  /** Catálogo, inventario, reportes, tasas */
  gestion: ['gerente'] as Rol[],
  /** Reservas, eventos, clientes */
  comercial: ['gerente', 'rrpp', 'cajero'] as Rol[],
  /** Cualquiera con sesión */
  todos: [...ROLES] as Rol[],
};
