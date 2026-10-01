import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { errorHandler, notFoundHandler } from './middlewares/error.js';
import { adminRouter } from './modules/admin/index.js';
import { eventosRouter } from './modules/eventos/eventos.routes.js';
import { galeriaRouter } from './modules/galeria/galeria.routes.js';
import { localRouter } from './modules/local/local.routes.js';
import { menuRouter } from './modules/menu/menu.routes.js';
import { reservasRouter } from './modules/reservas/reservas.routes.js';

export const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
// Orígenes permitidos: se toleran comillas, espacios y la barra final al pegarlos en el hosting
const origenes = env.CORS_ORIGIN.split(',')
  .map((o) => o.trim().replace(/^['"]|['"]$/g, '').replace(/\/+$/, ''))
  .filter(Boolean);
app.use(cors({ origin: origenes }));
app.use(express.json({ limit: '100kb' }));

app.get('/api/salud', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, servicio: 'mamba-api', hora: new Date().toISOString() });
});

app.use('/api/local', localRouter);
app.use('/api/menu', menuRouter);
app.use('/api/eventos', eventosRouter);
app.use('/api/reservas', reservasRouter);
app.use('/api/galeria', galeriaRouter);
app.use('/api/admin', adminRouter);

app.use(notFoundHandler);
app.use(errorHandler);
