import { BufferJSON, initAuthCreds, proto, type AuthenticationState, type SignalDataTypeMap } from '@whiskeysockets/baileys';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../../db/pool.js';

// Igual que useMultiFileAuthState de Baileys, pero cada "archivo" es una fila de wa_sesion.
// Railway borra el disco en cada deploy: si la sesión viviera en archivos habría que volver a escanear el QR.

let tablasListas: Promise<void> | null = null;

/** Crea las tablas de WhatsApp si no existen (database/05_whatsapp.sql, aditivo). */
export function asegurarTablas() {
  tablasListas ??= (async () => {
    const archivo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'database', '05_whatsapp.sql');
    await pool.query(await readFile(archivo, 'utf8'));
  })().catch((e) => {
    tablasListas = null;
    throw e;
  });
  return tablasListas;
}

async function leer(clave: string) {
  const r = await pool.query(`SELECT datos FROM wa_sesion WHERE clave = $1`, [clave]);
  return r.rows[0] ? JSON.parse(r.rows[0].datos, BufferJSON.reviver) : null;
}

async function escribir(filas: { clave: string; valor: unknown }[]) {
  if (!filas.length) return;
  await pool.query(
    `INSERT INTO wa_sesion (clave, datos, actualizado_en)
     SELECT c, d, now() FROM unnest($1::text[], $2::text[]) AS t(c, d)
     ON CONFLICT (clave) DO UPDATE SET datos = EXCLUDED.datos, actualizado_en = now()`,
    [filas.map((f) => f.clave), filas.map((f) => JSON.stringify(f.valor, BufferJSON.replacer))],
  );
}

async function borrar(claves: string[]) {
  if (!claves.length) return;
  await pool.query(`DELETE FROM wa_sesion WHERE clave = ANY($1::text[])`, [claves]);
}

export async function haySesionGuardada() {
  const r = await pool.query(`SELECT 1 FROM wa_sesion WHERE clave = 'creds'`);
  return r.rows.length > 0;
}

/** Borra la sesión (al desvincular o si WhatsApp la cerró desde el teléfono). */
export async function borrarSesion() {
  await pool.query(`DELETE FROM wa_sesion`);
}

export async function usarSesionBd(): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const creds = (await leer('creds')) ?? initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (tipo, ids) => {
          const r = await pool.query(`SELECT clave, datos FROM wa_sesion WHERE clave = ANY($1::text[])`, [ids.map((id) => `${tipo}-${id}`)]);
          const porClave = new Map<string, string>(r.rows.map((f) => [f.clave, f.datos]));
          const datos: { [id: string]: SignalDataTypeMap[typeof tipo] } = {};
          for (const id of ids) {
            const crudo = porClave.get(`${tipo}-${id}`);
            if (!crudo) continue;
            let valor = JSON.parse(crudo, BufferJSON.reviver);
            if (tipo === 'app-state-sync-key' && valor) valor = proto.Message.AppStateSyncKeyData.fromObject(valor);
            datos[id] = valor;
          }
          return datos;
        },
        set: async (data) => {
          const aEscribir: { clave: string; valor: unknown }[] = [];
          const aBorrar: string[] = [];
          for (const categoria in data) {
            const grupo = data[categoria as keyof SignalDataTypeMap];
            for (const id in grupo) {
              const valor = grupo[id];
              if (valor) aEscribir.push({ clave: `${categoria}-${id}`, valor });
              else aBorrar.push(`${categoria}-${id}`);
            }
          }
          await escribir(aEscribir);
          await borrar(aBorrar);
        },
      },
    },
    saveCreds: () => escribir([{ clave: 'creds', valor: creds }]),
  };
}
