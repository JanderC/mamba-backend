import { Router } from 'express';
import { R, autenticar, permitir } from '../../middlewares/auth.js';
import { authRouter, usuariosRouter } from './acceso.routes.js';
import { cajaRouter } from './caja.routes.js';
import { catalogoRouter } from './catalogo.routes.js';
import { clientesRouter, eventosAdminRouter, recordatoriosRouter, reservasAdminRouter } from './comercial.routes.js';
import { cajasCrud, configRouter, metodosRouter, tasasRouter } from './configuracion.routes.js';
import { inventarioRouter } from './inventario.routes.js';
import { reportesRouter } from './reportes.routes.js';
import { salonRouter } from './salon.routes.js';
import { comandasRouter, cuentasRouter, posRouter } from './ventas.routes.js';

/**
 * Panel administrativo — todo bajo /api/admin
 * Salvo el login, todas las rutas exigen  Authorization: Bearer <token>
 */
export const adminRouter = Router();

adminRouter.use('/auth', authRouter);
adminRouter.use(autenticar);

// Operación
adminRouter.use('/salon', salonRouter);
adminRouter.use('/pos', permitir(...R.servicio), posRouter);
adminRouter.use('/cuentas', cuentasRouter);
adminRouter.use('/comandas', comandasRouter);
adminRouter.use('/caja', cajaRouter);
adminRouter.use('/cajas', cajasCrud);

// Catálogo e inventario
adminRouter.use('/catalogo', permitir(...R.comandas), catalogoRouter);
adminRouter.use('/inventario', permitir(...R.gestion, 'barra', 'cocina', 'cajero'), inventarioRouter);

// Comercial
adminRouter.use('/reservas', reservasAdminRouter);
adminRouter.use('/eventos', permitir(...R.comercial), eventosAdminRouter);
adminRouter.use('/recordatorios', recordatoriosRouter);
adminRouter.use('/clientes', clientesRouter);

// Administración
adminRouter.use('/tasas', tasasRouter);
adminRouter.use('/metodos-pago', metodosRouter);
adminRouter.use('/usuarios', usuariosRouter);
adminRouter.use('/config', configRouter);
adminRouter.use('/reportes', reportesRouter);
