// Rescatá API — Node puro (sin Express) + PostgreSQL (Neon)
// Única dependencia: "pg".
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
const MAX_BODY = 3 * 1024 * 1024;        // 3 MB por request
const MAX_IMAGE = 1.5 * 1024 * 1024;     // 1.5 MB por foto (el front ya la achica)
const REPORTS_TO_HIDE = 3;               // denuncias para ocultar una publicación
const CATEGORIES = ['Muebles', 'Electrónica', 'Deco', 'Ropa', 'Libros', 'Plantas', 'Bicis', 'Otros'];

if (!process.env.DATABASE_URL) {
  console.error('Falta la variable DATABASE_URL (connection string de Neon).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});

// ---------- utilidades ----------
function corsHeaders(req) {
  const origin = req.headers.origin;
  let allow = '*';
  if (!ALLOWED_ORIGINS.includes('*')) allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Device-Id, X-Device-Name',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function send(req, res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(req) });
  res.end(JSON.stringify(data));
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'La publicación es demasiado pesada.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'JSON inválido.')); }
    });
    req.on('error', reject);
  });
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function deviceOf(req) {
  const id = str(req.headers['x-device-id'], 80);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new HttpError(400, 'Falta un X-Device-Id válido.');
  let name = 'Alguien';
  try { name = str(decodeURIComponent(req.headers['x-device-name'] || ''), 40) || 'Alguien'; } catch { /* nombre inválido */ }
  return { id, name };
}

function parseImage(dataUrl) {
  const m = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw new HttpError(400, 'La foto es obligatoria (JPG, PNG o WEBP).');
  const buf = Buffer.from(m[3], 'base64');
  if (buf.length > MAX_IMAGE) throw new HttpError(413, 'La foto pesa demasiado.');
  return { type: m[1], buf };
}

// Límite simple de publicaciones: 15 por hora por dispositivo/IP (en memoria)
const hits = new Map();
function rateLimit(key, limit = 15, windowMs = 60 * 60 * 1000) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (list.length >= limit) throw new HttpError(429, 'Publicaste muchas cosas seguidas. Probá en un rato.');
  list.push(now);
  hits.set(key, list);
}

function publicBase(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

function shape(row, base) {
  return {
    id: row.id,
    title: row.title,
    desc: row.description,
    cat: row.category,
    street: row.street,
    hood: row.hood,
    gps: row.lat != null && row.lng != null ? { lat: row.lat, lng: row.lng } : null,
    img: `${base}/api/posts/${row.id}/image`,
    user: row.author_name,
    interest: row.interest_count,
    gone: row.gone,
    mine: !!row.mine,
    going: !!row.going,
    distance_km: row.distance_km == null ? null : Math.round(row.distance_km * 10) / 10,
    t: new Date(row.created_at).getTime(),
  };
}

// Columnas comunes (sin la foto, para que el listado sea liviano)
const COLS = `
  p.id, p.title, p.description, p.category, p.street, p.hood, p.lat, p.lng,
  p.author_name, p.interest_count, p.gone, p.created_at,
  (p.author_id = $1) AS mine,
  EXISTS (SELECT 1 FROM interests i WHERE i.post_id = p.id AND i.device_id = $1) AS going`;

const DIST = `
  CASE WHEN $2::float8 IS NULL OR $3::float8 IS NULL OR p.lat IS NULL OR p.lng IS NULL THEN NULL
  ELSE 6371 * acos(LEAST(1, GREATEST(-1,
    cos(radians($2)) * cos(radians(p.lat)) * cos(radians(p.lng) - radians($3)) +
    sin(radians($2)) * sin(radians(p.lat))))) END`;

// ---------- rutas ----------
async function listPosts(req, res, url) {
  const dev = deviceOf(req);
  const lat = num(url.searchParams.get('lat'));
  const lng = num(url.searchParams.get('lng'));
  const radius = num(url.searchParams.get('radius_km'));
  const cat = CATEGORIES.includes(url.searchParams.get('cat')) ? url.searchParams.get('cat') : null;
  const qRaw = str(url.searchParams.get('q'), 60);
  const q = qRaw ? qRaw.replace(/[\\%_]/g, m => '\\' + m) : null;
  const mineOnly = url.searchParams.get('mine') === '1';

  const { rows } = await pool.query(
    `SELECT ${COLS}, ${DIST} AS distance_km
       FROM posts p
      WHERE NOT p.hidden
        AND ($6::boolean OR p.created_at > now() - interval '30 days')
        AND ($6::boolean OR NOT p.gone OR p.gone_at > now() - interval '2 days')
        AND ($4::text IS NULL OR p.category = $4)
        AND ($5::text IS NULL OR (p.title || ' ' || p.description || ' ' || p.street || ' ' || p.hood) ILIKE '%' || $5 || '%')
        AND (NOT $6::boolean OR p.author_id = $1)
      ORDER BY p.gone ASC, p.created_at DESC
      LIMIT 150`,
    [dev.id, lat, lng, cat, q, mineOnly]
  );
  let list = rows;
  if (radius && lat != null && lng != null) list = rows.filter(r => r.distance_km == null || r.distance_km <= radius);
  const base = publicBase(req);
  send(req, res, 200, { posts: list.map(r => shape(r, base)) });
}

async function getPost(req, res, id) {
  const dev = deviceOf(req);
  const { rows } = await pool.query(
    `SELECT ${COLS}, NULL::float8 AS distance_km FROM posts p WHERE p.id = $2 AND NOT p.hidden`,
    [dev.id, id]
  );
  if (!rows.length) throw new HttpError(404, 'La publicación no existe.');
  send(req, res, 200, { post: shape(rows[0], publicBase(req)) });
}

async function getImage(req, res, id) {
  const { rows } = await pool.query('SELECT image, image_type FROM posts WHERE id = $1 AND NOT hidden', [id]);
  if (!rows.length) throw new HttpError(404, 'Foto no encontrada.');
  res.writeHead(200, {
    'Content-Type': rows[0].image_type,
    'Cache-Control': 'public, max-age=31536000, immutable',
    ...corsHeaders(req),
  });
  res.end(rows[0].image);
}

async function createPost(req, res) {
  const dev = deviceOf(req);
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const body = await readJson(req);
  const title = str(body.title, 60);
  if (!title) throw new HttpError(400, 'Poné qué encontraste.');
  const street = str(body.street, 120);
  const hood = str(body.hood, 80);
  const lat = num(body.lat), lng = num(body.lng);
  const hasGps = lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  if (!street && !hood && !hasGps) throw new HttpError(400, 'Indicá dónde está (calle, barrio o GPS).');
  const img = parseImage(body.image);
  rateLimit(`dev:${dev.id}`);
  rateLimit(`ip:${ip}`, 40);

  const { rows } = await pool.query(
    `INSERT INTO posts (title, description, category, street, hood, lat, lng, image, image_type, author_id, author_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [title, str(body.desc, 300), CATEGORIES.includes(body.cat) ? body.cat : 'Otros',
     street || (hasGps ? 'Ubicación por GPS' : ''), hood,
     hasGps ? lat : null, hasGps ? lng : null, img.buf, img.type, dev.id, dev.name]
  );
  return getPost(req, res, rows[0].id);
}

async function addInterest(req, res, id) {
  const dev = deviceOf(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO interests (post_id, device_id, device_name)
       SELECT id, $2, $3 FROM posts WHERE id = $1 AND NOT gone AND NOT hidden
       ON CONFLICT DO NOTHING`,
      [id, dev.id, dev.name]
    );
    if (ins.rowCount) await client.query('UPDATE posts SET interest_count = interest_count + 1 WHERE id = $1', [id]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  return getPost(req, res, id);
}

async function setGone(req, res, id) {
  deviceOf(req);
  const body = await readJson(req);
  const gone = body.gone !== false;
  const { rowCount } = await pool.query(
    `UPDATE posts SET gone = $2, gone_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1 AND NOT hidden`,
    [id, gone]
  );
  if (!rowCount) throw new HttpError(404, 'La publicación no existe.');
  return getPost(req, res, id);
}

async function reportPost(req, res, id) {
  const dev = deviceOf(req);
  const body = await readJson(req);
  await pool.query(
    `INSERT INTO reports (post_id, device_id, reason) SELECT id, $2, $3 FROM posts WHERE id = $1 ON CONFLICT DO NOTHING`,
    [id, dev.id, str(body.reason, 200)]
  );
  await pool.query(
    `UPDATE posts SET hidden = TRUE WHERE id = $1 AND (SELECT count(*) FROM reports WHERE post_id = $1) >= $2`,
    [id, REPORTS_TO_HIDE]
  );
  send(req, res, 200, { ok: true });
}

async function deletePost(req, res, id) {
  const dev = deviceOf(req);
  const { rowCount } = await pool.query('DELETE FROM posts WHERE id = $1 AND author_id = $2', [id, dev.id]);
  if (!rowCount) throw new HttpError(403, 'Solo quien publicó puede borrarlo.');
  send(req, res, 200, { ok: true });
}

// Avisos: gente interesada en tus cosas + hallazgos nuevos cerca
async function notifications(req, res, url) {
  const dev = deviceOf(req);
  const sinceMs = num(url.searchParams.get('since'));
  const since = new Date(sinceMs || Date.now() - 3 * 24 * 3600 * 1000);
  const lat = num(url.searchParams.get('lat'));
  const lng = num(url.searchParams.get('lng'));
  const radius = num(url.searchParams.get('radius_km')) || 10;
  const base = publicBase(req);

  const interests = await pool.query(
    `SELECT p.id, p.title, i.device_name, i.created_at
       FROM interests i JOIN posts p ON p.id = i.post_id
      WHERE p.author_id = $1 AND i.device_id <> $1 AND i.created_at > $2 AND NOT p.hidden
      ORDER BY i.created_at DESC LIMIT 30`,
    [dev.id, since]
  );
  const nearby = await pool.query(
    `SELECT ${COLS}, ${DIST} AS distance_km
       FROM posts p
      WHERE p.author_id <> $1 AND p.created_at > $4 AND NOT p.gone AND NOT p.hidden
      ORDER BY p.created_at DESC LIMIT 30`,
    [dev.id, lat, lng, since]
  );
  const near = nearby.rows.filter(r => r.distance_km == null || r.distance_km <= radius);
  send(req, res, 200, {
    interests: interests.rows.map(r => ({
      post_id: r.id, title: r.title, who: r.device_name, img: `${base}/api/posts/${r.id}/image`,
      t: new Date(r.created_at).getTime(),
    })),
    nearby: near.map(r => shape(r, base)),
    now: Date.now(),
  });
}

// ---------- router ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean); // ['api','posts',id,action]

  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders(req)); return res.end(); }
  if (url.pathname === '/' || url.pathname === '/api/health') {
    await pool.query('SELECT 1');
    return send(req, res, 200, { ok: true, app: 'rescata-api' });
  }
  if (parts[0] !== 'api') throw new HttpError(404, 'Ruta no encontrada.');

  if (parts[1] === 'notifications' && req.method === 'GET' && parts.length === 2) return notifications(req, res, url);

  if (parts[1] === 'posts') {
    if (parts.length === 2 && req.method === 'GET') return listPosts(req, res, url);
    if (parts.length === 2 && req.method === 'POST') return createPost(req, res);
    const id = parts[2];
    if (!UUID_RE.test(id || '')) throw new HttpError(404, 'La publicación no existe.');
    if (parts.length === 3 && req.method === 'GET') return getPost(req, res, id);
    if (parts.length === 3 && req.method === 'DELETE') return deletePost(req, res, id);
    if (parts.length === 4 && req.method === 'GET' && parts[3] === 'image') return getImage(req, res, id);
    if (parts.length === 4 && req.method === 'POST') {
      if (parts[3] === 'interest') return addInterest(req, res, id);
      if (parts[3] === 'gone') return setGone(req, res, id);
      if (parts[3] === 'report') return reportPost(req, res, id);
    }
  }
  throw new HttpError(404, 'Ruta no encontrada.');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (!res.headersSent) send(req, res, status, { error: status >= 500 ? 'Error del servidor.' : err.message });
  });
});

async function start() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  server.listen(PORT, () => console.log(`Rescatá API escuchando en el puerto ${PORT}`));
}

if (require.main === module) {
  start().catch(e => { console.error('No pude arrancar:', e); process.exit(1); });
}

module.exports = { server, pool, start };
