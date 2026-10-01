import { Router } from 'express';
import { env } from '../../config/env.js';
import { query } from '../../db/pool.js';

export const galeriaRouter = Router();

type Media = { id: string; tipo: 'foto' | 'video' | 'reel'; fuente: string; url: string; miniatura_url: string | null; descripcion: string | null; enlace: string | null; publicado_en: string };

let cache: { at: number; data: Media[] } | null = null;
const TTL = 10 * 60 * 1000;

async function fromInstagram(): Promise<Media[] | null> {
  if (!env.INSTAGRAM_ACCESS_TOKEN) return null;
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  try {
    const url = new URL('https://graph.instagram.com/me/media');
    url.searchParams.set('fields', 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp');
    url.searchParams.set('limit', '18');
    url.searchParams.set('access_token', env.INSTAGRAM_ACCESS_TOKEN);
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`Instagram ${r.status}`);
    const { data } = (await r.json()) as { data: any[] };
    const media: Media[] = data.map((m) => ({
      id: m.id,
      tipo: m.media_type === 'VIDEO' ? 'reel' : 'foto',
      fuente: 'instagram',
      url: m.media_url,
      miniatura_url: m.thumbnail_url ?? m.media_url,
      descripcion: m.caption ?? null,
      enlace: m.permalink,
      publicado_en: m.timestamp,
    }));
    cache = { at: Date.now(), data: media };
    return media;
  } catch (err) {
    console.warn('[galeria] Instagram no disponible, usando galería local:', (err as Error).message);
    return null;
  }
}

galeriaRouter.get('/', async (_req, res) => {
  const ig = await fromInstagram();
  const media =
    ig ??
    (await query<Media>(
      `SELECT id::text, tipo, fuente, url, miniatura_url, descripcion, enlace, publicado_en
         FROM galeria WHERE activo ORDER BY orden, publicado_en DESC LIMIT 30`,
    ));
  res.set('Cache-Control', 'public, max-age=300');
  res.json(media);
});
