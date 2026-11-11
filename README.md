# Rescatá 📍

App para avisar cuando encontrás algo interesante tirado en la calle (muebles, electrónica, libros…) y que lo pueda ir a buscar otra persona.

- **Frontend**: `frontend/`, HTML + JS sin dependencias, publicado en **GitHub Pages**
- **Backend**: `backend/`, Node.js (sin Express, una sola dependencia: `pg`), alojado en **Render**
- **Base de datos**: PostgreSQL en **Neon**; las fotos también se guardan ahí

```
Celular ──► GitHub Pages (frontend) ──► Render (API) ──► Neon (Postgres)
```

## Puesta en marcha (una sola vez)

### 1. Base de datos en Neon
1. Entrá a https://console.neon.tech y creá un proyecto nuevo llamado `rescata` (región **São Paulo** si aparece, es la más cercana).
2. En **Connection string** copiá la URL que empieza con `postgresql://...` (con `?sslmode=require`).
3. No hace falta crear tablas: el backend las crea solo al arrancar (`backend/src/schema.sql`).

### 2. Backend en Render
1. En https://dashboard.render.com → **New → Blueprint** y elegí este repo. Render lee `render.yaml` y arma el servicio `rescata-api`.
2. Cuando te pida `DATABASE_URL`, pegá la connection string de Neon.
3. Esperá a que termine el deploy y abrí `https://rescata-api.onrender.com/api/health`. Tiene que decir `{"ok":true}`.
   - Si Render te asigna otra URL, cambiala en `frontend/config.js`.

> Plan gratis: si nadie usa la app por 15 minutos, el servidor se duerme y la primera carga tarda ~1 minuto. La app muestra "Conectando con el servidor…" mientras tanto.

### 3. Frontend en GitHub Pages
1. En el repo: **Settings → Pages → Source: GitHub Actions**.
2. Cada push a `main` que toque `frontend/` se publica solo (`.github/workflows/pages.yml`).
3. Queda en `https://pallas1997.github.io/rescata/`.
4. (Opcional, más seguro) En Render cambiá `ALLOWED_ORIGINS` a `https://pallas1997.github.io`.

En el iPhone: abrí la URL en Safari → Compartir → **Agregar a inicio**, y queda como una app.

## API

Todas las rutas piden el header `X-Device-Id` (lo genera la app) y opcionalmente `X-Device-Name`.

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/health` | Chequeo de vida |
| GET | `/api/posts?lat=&lng=&radius_km=&cat=&q=&mine=1` | Lista publicaciones (sin la foto) |
| POST | `/api/posts` | Publica `{title, desc, cat, street, hood, lat, lng, image(dataURL)}` |
| GET | `/api/posts/:id` | Una publicación |
| GET | `/api/posts/:id/image` | La foto |
| POST | `/api/posts/:id/interest` | "Lo voy a buscar" (1 por dispositivo) |
| POST | `/api/posts/:id/gone` | `{gone:true/false}` marca si ya no está |
| POST | `/api/posts/:id/report` | Denunciar (con 3 denuncias se oculta) |
| DELETE | `/api/posts/:id` | Borrar (solo quien publicó) |
| GET | `/api/notifications?since=&lat=&lng=` | Interesados en lo tuyo + hallazgos nuevos cerca |
| GET | `/api/geocode/reverse?lat=&lng=` | Calle y barrio a partir del GPS (OpenStreetMap) |
| GET | `/api/push/key` | Clave pública para suscribirse a notificaciones |
| POST | `/api/push/subscribe` | `{subscription, radius_km?, lat?, lng?}` activa notificaciones |
| POST | `/api/push/unsubscribe` | Desactiva notificaciones |

Reglas: las publicaciones duran 30 días, las marcadas "ya no está" se ven 2 días más, máximo 15 publicaciones por hora por dispositivo.

## Correrlo en tu compu

```bash
cd backend
cp .env.example .env    # y pegá tu DATABASE_URL
npm install
node --env-file=.env src/server.js
```
Después abrí `frontend/index.html` con `API_URL: 'http://localhost:3000'` en `config.js`.

## Próximos pasos para escalar
- **Fotos** → mover de la base a Cloudinary o Cloudflare R2 cuando haya muchas (Neon gratis tiene 0,5 GB).
- **Cuentas** → hoy cada celular tiene un ID anónimo; sumar login (Google / mail) para poder cambiar de celular.
- **Notificaciones push** → ya funcionan con Web Push (claves VAPID generadas solas y guardadas en la base). En iPhone requieren iOS 16.4+ y la app agregada a la pantalla de inicio.
- **App nativa** → el mismo backend sirve para una versión con Expo (React Native).
