-- WhatsApp vinculado (como WhatsApp Web): el teléfono del local se vincula con un QR o un código desde
-- el panel (/admin/whatsapp) y desde ahí se leen y responden los chats. Aditivo: se puede correr varias veces.
-- El backend también crea estas tablas solo al arrancar si no existen.

-- La sesión de WhatsApp vive en la base (no en archivos): así no hay que volver a escanear el QR en cada deploy
CREATE TABLE IF NOT EXISTS wa_sesion (
  clave          TEXT PRIMARY KEY,
  datos          TEXT NOT NULL,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un chat por número (o grupo)
CREATE TABLE IF NOT EXISTS wa_chats (
  jid          TEXT PRIMARY KEY,
  nombre       TEXT,
  es_grupo     BOOLEAN NOT NULL DEFAULT false,
  ultimo_texto TEXT,
  ultimo_de_mi BOOLEAN NOT NULL DEFAULT false,
  ultimo_en    TIMESTAMPTZ,
  no_leidos    INTEGER NOT NULL DEFAULT 0,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wa_chats_ultimo_idx ON wa_chats (ultimo_en DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS wa_mensajes (
  id          BIGSERIAL PRIMARY KEY,
  wa_id       TEXT UNIQUE,
  jid         TEXT NOT NULL REFERENCES wa_chats (jid) ON DELETE CASCADE,
  de_mi       BOOLEAN NOT NULL DEFAULT false,
  tipo        TEXT NOT NULL DEFAULT 'texto',
  texto       TEXT,
  remitente   TEXT,
  -- quién lo envió desde el panel (null si llegó o se escribió desde el teléfono)
  usuario_id  INTEGER,
  usuario     TEXT,
  estado      TEXT NOT NULL DEFAULT 'enviado',
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wa_mensajes_chat_idx ON wa_mensajes (jid, creado_en DESC);
