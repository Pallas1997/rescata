-- Rescatá: esquema de la base de datos (PostgreSQL / Neon)
-- Se ejecuta solo al arrancar el servidor. Es seguro correrlo varias veces.

CREATE TABLE IF NOT EXISTS posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  description     TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
  category        TEXT NOT NULL DEFAULT 'Otros',
  street          TEXT NOT NULL DEFAULT '',
  hood            TEXT NOT NULL DEFAULT '',
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,
  image           BYTEA NOT NULL,
  image_type      TEXT NOT NULL DEFAULT 'image/jpeg',
  author_id       TEXT NOT NULL,
  author_name     TEXT NOT NULL DEFAULT 'Anónimo',
  interest_count  INTEGER NOT NULL DEFAULT 0,
  gone            BOOLEAN NOT NULL DEFAULT FALSE,
  gone_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS posts_created_idx ON posts (created_at DESC);
CREATE INDEX IF NOT EXISTS posts_author_idx  ON posts (author_id);
CREATE INDEX IF NOT EXISTS posts_geo_idx     ON posts (lat, lng);

-- Quién dijo "Lo voy a buscar" (un voto por dispositivo y publicación)
CREATE TABLE IF NOT EXISTS interests (
  post_id     UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  device_name TEXT NOT NULL DEFAULT 'Alguien',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, device_id)
);

-- Denuncias (fotos inapropiadas, datos personales, etc.)
CREATE TABLE IF NOT EXISTS reports (
  post_id    UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  device_id  TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, device_id)
);

ALTER TABLE posts ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;
