import { app } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { iniciarTareasProgramadas } from './services/recordatorios.js';

const server = app.listen(env.PORT, () => {
  console.log(`🐍 Mamba API escuchando en http://localhost:${env.PORT}/api`);
  iniciarTareasProgramadas();
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') console.error(`❌ El puerto ${env.PORT} ya lo está usando otro programa. Cambia PORT en backend/.env (y NEXT_PUBLIC_API_URL en frontend/.env.local).`);
  else console.error(err);
  process.exit(1);
});

async function shutdown() {
  server.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
