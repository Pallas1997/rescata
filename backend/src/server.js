// Rescatá API — Node puro (sin Express) + PostgreSQL (Neon)
// Única dependencia: "pg".
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const webpush = require('web-push');

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
  await getPost(req, res, rows[0].id);
  // Notificación a todos, sin hacer esperar a quien publica
  pool.query(`SELECT ${COLS}, NULL::float8 AS distance_km FROM posts p WHERE p.id = $2`, [dev.id, rows[0].id])
    .then(r => r.rows[0] && notifyNewPost(shape(r.rows[0], publicBase(req)), dev.id))
    .catch(e => console.error('push fallo', e.message));
}

async function addInterest(req, res, id) {
  const dev = deviceOf(req);
  const client = await pool.connect();
  let added = false;
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO interests (post_id, device_id, device_name)
       SELECT id, $2, $3 FROM posts WHERE id = $1 AND NOT gone AND NOT hidden
       ON CONFLICT DO NOTHING`,
      [id, dev.id, dev.name]
    );
    if (ins.rowCount) { added = true; await client.query('UPDATE posts SET interest_count = interest_count + 1 WHERE id = $1', [id]); }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  await getPost(req, res, id);
  if (added) notifyInterest(id, dev, publicBase(req)).catch(e => console.error('push interés falló', e.message));
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

// ---------- notificaciones push ----------
// Las claves VAPID se generan solas la primera vez y quedan guardadas en la base.
let vapidPublic = null;
async function setupPush() {
  let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const { rows } = await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('vapid_public','vapid_private')`);
    const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
    if (m.vapid_public && m.vapid_private) { pub = m.vapid_public; priv = m.vapid_private; }
    else {
      const k = webpush.generateVAPIDKeys();
      await pool.query(`INSERT INTO app_settings (key, value) VALUES ('vapid_public', $1), ('vapid_private', $2) ON CONFLICT (key) DO NOTHING`, [k.publicKey, k.privateKey]);
      const again = await pool.query(`SELECT key, value FROM app_settings WHERE key IN ('vapid_public','vapid_private')`);
      const m2 = Object.fromEntries(again.rows.map(r => [r.key, r.value]));
      pub = m2.vapid_public; priv = m2.vapid_private;
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://github.com/Pallas1997/rescata', pub, priv);
  vapidPublic = pub;
}

async function pushKey(req, res) { send(req, res, 200, { publicKey: vapidPublic }); }

async function pushSubscribe(req, res) {
  const dev = deviceOf(req);
  const body = await readJson(req);
  const sub = body.subscription || {};
  const endpoint = str(sub.endpoint, 1000);
  const p256dh = str(sub.keys && sub.keys.p256dh, 200), auth = str(sub.keys && sub.keys.auth, 100);
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) throw new HttpError(400, 'Suscripción inválida.');
  const lat = num(body.lat), lng = num(body.lng), radius = num(body.radius_km);
  await pool.query(
    `INSERT INTO push_subs (endpoint, device_id, p256dh, auth, lat, lng, radius_km)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (endpoint) DO UPDATE SET device_id = EXCLUDED.device_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
       lat = COALESCE(EXCLUDED.lat, push_subs.lat), lng = COALESCE(EXCLUDED.lng, push_subs.lng), radius_km = EXCLUDED.radius_km`,
    [endpoint, dev.id, p256dh, auth, lat, lng, radius && radius > 0 ? radius : null]
  );
  send(req, res, 200, { ok: true });
}

async function pushUnsubscribe(req, res) {
  const dev = deviceOf(req);
  const body = await readJson(req);
  const endpoint = str(body.endpoint, 1000);
  if (endpoint) await pool.query('DELETE FROM push_subs WHERE endpoint = $1', [endpoint]);
  else await pool.query('DELETE FROM push_subs WHERE device_id = $1', [dev.id]);
  send(req, res, 200, { ok: true });
}

async function pushStatus(req, res) {
  const dev = deviceOf(req);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM push_subs WHERE device_id = $1', [dev.id]);
  send(req, res, 200, { subscribed: rows[0].n > 0 });
}

function distanceKm(a, b) {
  const R = 6371, toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function sendPush(subs, payload) {
  let sent = 0, removed = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 6 * 3600, urgency: 'high' });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { await pool.query('DELETE FROM push_subs WHERE endpoint = $1', [s.endpoint]); removed++; }
      else console.error('push error', e.statusCode || '', e.body || e.message);
    }
  }
  return { sent, removed };
}

// Avisa a quien publicó que alguien lo va a ir a buscar
async function notifyInterest(postId, dev, base) {
  if (!vapidPublic) return;
  const { rows } = await pool.query('SELECT title, author_id FROM posts WHERE id = $1', [postId]);
  const p = rows[0];
  if (!p || p.author_id === dev.id) return;
  const subs = await pool.query('SELECT endpoint, p256dh, auth FROM push_subs WHERE device_id = $1', [p.author_id]);
  if (!subs.rows.length) return;
  const payload = JSON.stringify({
    type: 'interest', post_id: postId,
    title: `🙋 ${dev.name} va a buscar tu ${p.title}`,
    body: 'Tocá para ver la publicación',
    url: `?p=${postId}`,
    image: `${base}/api/posts/${postId}/image`,
    tag: `i-${postId}-${dev.name}`,
  });
  const r = await sendPush(subs.rows, payload);
  console.log(`push: interés en ${postId} → ${r.sent} enviados`);
}

// Avisa a todos los suscriptos (menos a quien publicó). Corre en segundo plano.
async function notifyNewPost(post, authorId) {
  if (!vapidPublic) return;
  const { rows } = await pool.query('SELECT endpoint, p256dh, auth, lat, lng, radius_km FROM push_subs WHERE device_id <> $1', [authorId]);
  const where = post.hood || post.street;
  const payload = JSON.stringify({
    type: 'post', post_id: post.id,
    title: `📍 Nuevo en Rescatá${where ? ' · ' + where : ''}`,
    body: `${post.title}${post.desc ? ' — ' + post.desc.slice(0, 80) : ''}`,
    url: `?p=${post.id}`,
    image: post.img,
    tag: `post-${post.id}`,
  });
  const targets = rows.filter(s => !(s.radius_km && post.gps && s.lat != null && s.lng != null && distanceKm(post.gps, { lat: s.lat, lng: s.lng }) > s.radius_km));
  const { sent, removed } = await sendPush(targets, payload);
  console.log(`push: nuevo post ${post.id} → ${sent} enviados, ${removed} vencidos borrados`);
}

// ---------- dirección a partir del GPS (OpenStreetMap / Nominatim) ----------
// Nominatim pide: identificarse con User-Agent, máximo 1 pedido por segundo y cachear.
const GEO_URL = process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org/reverse';
const GEO_UA = process.env.GEOCODER_UA || 'RescataApp/1.0 (https://github.com/Pallas1997/rescata)';
const geoCache = new Map();
let geoQueue = Promise.resolve();
let geoLast = 0;

function formatAddress(a) {
  if (!a) return { street: '', hood: '' };
  const road = a.road || a.pedestrian || a.footway || a.path || a.residential || '';
  let street = road;
  if (road && a.house_number) {
    // Altura aproximada: redondeamos a la centena para no marcar una casa puntual
    const n = parseInt(a.house_number, 10);
    street = Number.isFinite(n) ? `${road} ${Math.floor(n / 100) * 100 || n}` : `${road} ${a.house_number}`;
  }
  const hood = a.suburb || a.neighbourhood || a.quarter || a.city_district || a.town || a.city || a.village || a.municipality || '';
  let city = a.city || a.town || a.village || a.municipality || a.state_district || '';
  if (/Ciudad Aut[oó]noma de Buenos Aires/i.test(city)) city = 'CABA';
  return { street, hood: hood && city && hood !== city ? `${hood}, ${city}` : (hood || city) };
}

async function reverseGeocode(req, res, url) {
  const lat = num(url.searchParams.get('lat'));
  const lng = num(url.searchParams.get('lng'));
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, 'Coordenadas inválidas.');
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (geoCache.has(key)) return send(req, res, 200, geoCache.get(key));

  const job = geoQueue.then(async () => {
    const wait = 1100 - (Date.now() - geoLast);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    geoLast = Date.now();
    const q = new URLSearchParams({ format: 'jsonv2', lat, lon: lng, zoom: '18', addressdetails: '1', 'accept-language': 'es' });
    const r = await fetch(`${GEO_URL}?${q}`, { headers: { 'User-Agent': GEO_UA }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new HttpError(502, 'No pude averiguar la dirección.');
    return r.json();
  });
  geoQueue = job.catch(() => {});
  let data;
  try { data = await job; } catch (e) { throw e.status ? e : new HttpError(502, 'No pude averiguar la dirección.'); }
  const out = formatAddress(data.address);
  if (geoCache.size > 5000) geoCache.clear();
  geoCache.set(key, out);
  send(req, res, 200, out);
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
  if (parts[1] === 'geocode' && parts[2] === 'reverse' && req.method === 'GET') return reverseGeocode(req, res, url);
  if (parts[1] === 'push') {
    if (parts[2] === 'key' && req.method === 'GET') return pushKey(req, res);
    if (parts[2] === 'status' && req.method === 'GET') return pushStatus(req, res);
    if (parts[2] === 'subscribe' && req.method === 'POST') return pushSubscribe(req, res);
    if (parts[2] === 'unsubscribe' && req.method === 'POST') return pushUnsubscribe(req, res);
  }

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
  await setupPush();
  server.listen(PORT, () => console.log(`Rescatá API escuchando en el puerto ${PORT}`));
}

if (require.main === module) {
  start().catch(e => { console.error('No pude arrancar:', e); process.exit(1); });
}

module.exports = { server, pool, start, formatAddress };
