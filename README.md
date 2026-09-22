# Tesla Live-Synced Lyrics

Local web app that reads **now playing** media from a Tesla vehicle via the **Tesla Fleet API**, fetches **synced LRC lyrics** from [LRCLIB](https://lrclib.net), and displays them in a React UI tuned for the Tesla in-car browser.

```
tesla-lyrics-app/
  .env.example
  README.md
  package.json          # root scripts (dev / build / start)
  server/               # Express + Axios (Fleet API + LRCLIB)
  client/               # Vite + React + Tailwind
```

---

## Features

- Polls `/api/media_state` every **5 seconds**
- While playback status is **Playing**, interpolates position with `requestAnimationFrame` from the last `now_playing_elapsed` + wall-clock delta (Tesla units normalized: values &lt; 10000 treated as **seconds**)
- Fetches lyrics when **title/artist** change
- Smooth centered lyric scroll (active line large/white; inactive gray)
- Serves Tesla partner public key at  
  `/.well-known/appspecific/com.tesla.3p.public-key.pem`
- Optional OAuth start/callback scaffolding

---

## Prerequisites

- Node.js 18+ (20+ recommended)
- A Tesla **Fleet API** third-party application from the [Tesla Developer](https://developer.tesla.com) partner portal
- A publicly reachable **HTTPS** origin for the partner public key (and OAuth redirect) — see tunnel note below
- Your vehicle paired / virtual key registered with your third-party app (Tesla partner requirements)

---

## Tesla partner setup (OAuth + PEM)

### 1. Create a Fleet API application

In the Tesla developer portal, create an application and note:

| Env var | Purpose |
|--------|---------|
| `TESLA_CLIENT_ID` | OAuth client id |
| `TESLA_CLIENT_SECRET` | OAuth client secret |
| `TESLA_REDIRECT_URI` | Must match portal exactly (e.g. `https://your-host/oauth/callback`) |

Default Fleet base URL (North America):

```
TESLA_FLEET_BASE_URL=https://fleet-api.prd.na.vn.cloud.tesla.com
```

Other regions use different Fleet hostnames — set `TESLA_FLEET_BASE_URL` accordingly.

### 2. Public key (required by Tesla for 3P apps)

Tesla requires your app domain to serve a PEM public key at:

```
https://<your-registered-domain>/.well-known/appspecific/com.tesla.3p.public-key.pem
```

This server maps that path to a local file:

1. Generate a real key pair for production (do **not** use the dummy example in production):

   ```bash
   openssl genrsa -out private-key.pem 2048
   openssl rsa -in private-key.pem -pubout -out server/keys/com.tesla.3p.public-key.pem
   ```

2. Keep `private-key.pem` **offline / secret**. Only the **public** PEM is served.

3. A **dummy** public PEM is shipped as  
   `server/keys/com.tesla.3p.public-key.pem.example`  
   so local routing works. **Copy it** (or place your real public PEM) to:

   ```bash
   cp server/keys/com.tesla.3p.public-key.pem.example \
      server/keys/com.tesla.3p.public-key.pem
   ```

   Or set `TESLA_PUBLIC_KEY_PATH` in `.env`.

> **Note:** The included `.example` key is a randomly generated RSA public key for **local testing of the well-known route only**. It is not registered with Tesla and will not satisfy partner onboarding by itself.

### 3. Register domain + virtual key

Follow Tesla’s partner docs to:

- Verify domain ownership / public key hosting
- Add a virtual key to the vehicle for your third-party app

### 4. Obtain tokens

**Option A — built-in scaffolding**

1. Set `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`, `TESLA_REDIRECT_URI` in `.env`
2. Start the server
3. Open `http://localhost:3001/oauth/start` (or your HTTPS tunnel URL)
4. After consent, the callback page shows `access_token` / `refresh_token` once — paste `access_token` into `.env` as `TESLA_ACCESS_TOKEN`

**Option B — any OAuth client / partner tooling**

Paste a valid Fleet access token into `.env` as `TESLA_ACCESS_TOKEN`.

Also set `TESLA_VEHICLE_ID` (numeric id from `GET /api/1/vehicles`).

> **No secrets are committed.** Copy `.env.example` → `.env` and fill locally.

---

## HTTPS / tunnel note (critical for car + partner)

Tesla’s in-car browser and partner public-key checks need **HTTPS** on a hostname you control (or a tunnel).

Common local approach:

```bash
# Example with Cloudflare Tunnel / ngrok / similar — point at Express :3001
# Ensure /.well-known/... and /oauth/callback are reachable on that hostname
```

- Register that HTTPS origin in the Tesla partner portal
- Set `TESLA_REDIRECT_URI` to `https://<tunnel-host>/oauth/callback`
- Open the **same HTTPS URL** from the Tesla browser (not `localhost`)

In **development** on a laptop only, HTTP + Vite proxy is fine; the car will not trust plain `http://localhost`.

---

## Setup & run

```bash
cd tesla-lyrics-app
cp .env.example .env
# edit .env — at minimum TESLA_ACCESS_TOKEN + TESLA_VEHICLE_ID for media

cp server/keys/com.tesla.3p.public-key.pem.example \
   server/keys/com.tesla.3p.public-key.pem

# Install dependencies
npm install
npm run install:all
# (or: npm install --prefix server && npm install --prefix client)

# Development — Express :3001 + Vite :5173 (proxies /api)
npm run dev
# Then open http://localhost:5173

# Production — build client, serve from Express
npm run build
NODE_ENV=production npm start
# Open http://localhost:3001
```

## Deploying (Render)

See **[RENDER.md](RENDER.md)** for the full walkthrough — blueprint, build
command, env vars, and the token/public-key setup that hosted deploys need.
Short version: the repo ships a `render.yaml`, the build command must be
`npm ci --include=dev && npm run install:all && npm run build`, and production
should use `TESLA_REFRESH_TOKEN` rather than a static access token.

---

### Useful endpoints

| Path | Description |
|------|-------------|
| `GET /api/health` | Token / vehicle / PEM presence |
| `GET /api/media_state` | Live media from Fleet `vehicle_data` |
| `GET /api/lyrics?title=&artist=&duration=` | LRCLIB synced lines |
| `GET /oauth/start` | Begin OAuth |
| `GET /.well-known/appspecific/com.tesla.3p.public-key.pem` | Partner public key |

Without a token, `/api/media_state` returns JSON like `{ ok: false, error: "missing_token", ... }` and the server **keeps running**.

---

## Tesla in-car browser tips

- Prefer a **simple dark UI** (this app uses solid black, high-contrast text, no heavy blur/filters)
- Use large tap targets; avoid hover-only interactions
- Keep animations light (`transform` / opacity); Tesla’s Chromium build can stutter on heavy CSS
- Bookmark your **HTTPS** tunnel/production URL in the car browser
- Wake the vehicle if Fleet returns asleep / timeout errors (408/504)
- Media fields depend on the source (Spotify, Bluetooth, radio, etc.); some sources omit title/artist

---

## LRCLIB

Lyrics are fetched from `https://lrclib.net/api/get` with a descriptive `User-Agent` (required by LRCLIB). Synced `syncedLyrics` LRC is parsed into `{ timeMs, text }[]`. If only plain lyrics exist, they are shown as a scrollable block.

Please respect [LRCLIB usage guidelines](https://lrclib.net).

---

## Units & timing

Tesla Fleet `now_playing_duration` / `now_playing_elapsed` are treated as **seconds** when the numeric value is &lt; 10000 (typical), otherwise as milliseconds. The UI stores everything in **ms** and interpolates between 5s polls while status is Playing.

---

## License / disclaimer

Unofficial personal project. Not affiliated with Tesla, Inc. You are responsible for complying with Tesla’s developer terms, regional regulations, and not distributing secrets or abusing APIs.
