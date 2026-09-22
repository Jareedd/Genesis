# Deploying to Render

This app is one Render **Web Service**: the build compiles the Vite client into
`client/dist`, and the Express server serves both that build and the `/api`
routes from a single port.

---

## 1. Create the service

**Option A — Blueprint (uses `render.yaml` in this repo)**

1. Render dashboard → **New +** → **Blueprint**
2. Connect this repo, pick the branch, **Apply**
3. Render prompts for the `sync: false` env vars — fill them in (see §2)

**Option B — manual Web Service**

| Field | Value |
|---|---|
| Runtime | Node |
| Build Command | `npm ci --include=dev && npm run install:all && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |

> **The `--include=dev` matters.** Render sets `NODE_ENV=production`, and npm
> then skips `devDependencies` — which is where Vite, Tailwind and the React
> plugin live. Without it the build dies with `vite: not found`.

Do **not** set a `PORT` env var. Render injects its own and the server reads
`process.env.PORT`; hardcoding `3001` makes the deploy hang on "port scan
timeout".

---

## 2. Environment variables

Set these in the service's **Environment** tab:

| Var | Required | Notes |
|---|---|---|
| `TESLA_VEHICLE_ID` | yes | numeric id from `GET /api/1/vehicles` |
| `TESLA_REFRESH_TOKEN` | yes (prod) | so the server renews its own token — see §3 |
| `TESLA_CLIENT_ID` | yes (prod) | needed for the refresh call |
| `TESLA_CLIENT_SECRET` | yes | token exchange + refresh |
| `TESLA_REDIRECT_URI` | yes | `https://<your-service>.onrender.com/oauth/callback` — must match the Tesla portal **exactly** |
| `TESLA_ACCESS_TOKEN` | optional | short-lived; only useful for a quick test |
| `TESLA_FLEET_BASE_URL` | no | defaults to the North America host |
| `TESLA_PUBLIC_KEY_PEM` | for partner onboarding | the PEM contents pasted inline (§4) |
| `TESLA_PARTNER_DOMAIN` | no | defaults to the host of `TESLA_REDIRECT_URI` |
| `NODE_VERSION` | no | pinned to `20` in `render.yaml` |

`.env` is gitignored and is **not** read on Render — the dashboard is the only
place these live in production.

---

## 3. Tokens: use the refresh token, not the access token

Tesla access tokens expire after ~8 hours. If you only set
`TESLA_ACCESS_TOKEN`, the deploy works and then starts returning
`unauthorized` the same day.

With `TESLA_REFRESH_TOKEN` + `TESLA_CLIENT_ID` set, the server mints a fresh
access token on startup, when the cached one ages out, and once more on any
401 before giving up.

To get a refresh token:

1. Deploy first, so the service has a public HTTPS URL
2. Set `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`, `TESLA_REDIRECT_URI`
3. Visit `https://<your-service>.onrender.com/oauth/start`
4. The callback page prints `access_token` and `refresh_token` **once** —
   copy the refresh token into the Environment tab and redeploy

Confirm with `GET /api/health`: it reports `canRefresh: true`.

---

## 4. Partner public key

Tesla requires the PEM at
`/.well-known/appspecific/com.tesla.3p.public-key.pem` on your registered
domain. Render has no writable repo directory to drop a file into, so the
server also accepts the key inline:

Tesla requires an **EC key on the prime256v1 (NIST P-256) curve** — an RSA key
is rejected during partner registration.

```bash
# 1. private key — keep this secret, never commit it, never upload it
openssl ecparam -name prime256v1 -genkey -noout -out private-key.pem

# 2. public key — this is the part you host / paste into Render
openssl ec -in private-key.pem -pubout
```

Step 2 prints a short block like:

```
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...
-----END PUBLIC KEY-----
```

Paste that whole block — including both `-----BEGIN/END-----` lines — into
`TESLA_PUBLIC_KEY_PEM` (the Environment tab accepts
multi-line values; single-line `\n` escapes also work). Keep
`private-key.pem` off the server and out of git. Alternatively use a Render
**Secret File** and point `TESLA_PUBLIC_KEY_PATH` at
`/etc/secrets/<filename>`.

Until you set one of those, that route falls back to the shipped **dummy**
example key — fine for routing checks, useless for Tesla onboarding.

Register `https://<your-service>.onrender.com` (or your custom domain) as the
app's domain in the Tesla developer portal. A custom domain is worth adding if
you plan to keep the registration — the free `onrender.com` subdomain is tied
to the service name.

---

## 5. Register your domain with Tesla

Tesla will not return vehicle data until your app's domain is registered. This
is a **one-time** call, and it has to happen *after* the public key is live.

1. Confirm the key loads publicly:
   `https://lyrc.world/.well-known/appspecific/com.tesla.3p.public-key.pem`
2. Visit `https://<your-domain>/api/partner/register` and press the button
3. A success response looks like `{"ok": true, "domain": "...", "status": 200}`

The domain is taken from `TESLA_PARTNER_DOMAIN` if set, otherwise from the
host part of `TESLA_REDIRECT_URI` — so usually there is nothing extra to
configure. Re-running it is harmless.

If it returns 403/412, Tesla could not fetch your public key — fix step 1
first. The registration uses the `client_credentials` grant, so
`TESLA_CLIENT_ID` and `TESLA_CLIENT_SECRET` must both be set.

---

## 6. Free tier caveat

Free Render services sleep after ~15 minutes of no traffic and take ~30–60s to
wake. In the car that means a long first load, then normal behaviour (the 5s
`/api/media_state` poll keeps it awake while the page is open). A paid instance
or an external uptime pinger avoids the cold start.

---

## 7. Troubleshooting

| Symptom | Cause |
|---|---|
| `vite: not found` during build | build command missing `--include=dev` |
| Build succeeds, app shows "Not Found" at `/` | `npm run build` didn't run, or `NODE_ENV` isn't `production` — check `clientBuilt` in `/api/health` |
| Deploy hangs, "no open ports detected" | a `PORT` env var was set, overriding Render's |
| `/api/media_state` → `unauthorized` | token expired; set `TESLA_REFRESH_TOKEN` (§3) |
| Registration returns 403 or 412 | Tesla can't fetch your public key — test that URL in a browser first |
| Vehicle data 403s despite a valid token | domain never registered — do §5 |
| `/api/media_state` → `vehicle_asleep` | wake the car from the Tesla app; Fleet returns 408/504 while asleep |
| OAuth callback → `invalid redirect_uri` | `TESLA_REDIRECT_URI` doesn't byte-match the portal entry (watch the trailing slash) |
