# Deploying Chatty on Nginx

Plan for setting up Chatty as static files behind Nginx. Written to be handed to an agent on the server.

## What Chatty is (deploy-relevant facts)

- Fully client-side app. `npm run build` produces `dist/` (~32 MB: `index.html`, `debug.html`, `assets/*.js|css|wasm`, `sw.js`, manifests, icons). No server-side code, no Node at runtime.
- AI models are **not** in `dist/`. Each browser downloads them on first use from `huggingface.co` (~3 GB chat model) and `cdn.jsdelivr.net`, then caches them in OPFS. The server only hosts the app.
- Hard requirements on the server:
  1. **HTTPS** — WebGPU, microphone, service worker, and OPFS only work in a secure context.
  2. **Cross-origin isolation headers** on every response (needed for SharedArrayBuffer / multithreaded WASM):
     - `Cross-Origin-Opener-Policy: same-origin`
     - `Cross-Origin-Embedder-Policy: credentialless`
  3. **Correct MIME types**: `.wasm` → `application/wasm`, `.js`/`.mjs` → `text/javascript`.
  4. **Served at the site root** (`https://chatty.example.com/`). `sw.js`, the manifests (`start_url`/`scope`), and Vite's asset paths assume `/`. A subpath like `/chatty/` needs code changes (see the end).

## Steps

### 1. Build

Either build on a dev machine and copy `dist/`, or on the server (needs Node 22.18+; `cactus-needle` declares `node >=22.18.0`):

```bash
npm ci
npm run build
```

Confirm `dist/index.html` and `dist/assets/*.wasm` exist.

### 2. Copy files

```bash
sudo mkdir -p /var/www/chatty
sudo rsync -a --delete dist/ /var/www/chatty/
sudo chown -R www-data:www-data /var/www/chatty   # or the nginx user on this distro (e.g. nginx)
```

### 3. Nginx site config

Create `/etc/nginx/sites-available/chatty` (or `/etc/nginx/conf.d/chatty.conf` on RHEL-style distros). Replace `chatty.example.com`.

> Nginx gotcha: `add_header` directives are **not inherited** by a `location` block that has its own `add_header`. That's why the isolation headers are in a snippet included in every location.

`/etc/nginx/snippets/chatty-isolation.conf`:

```nginx
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Embedder-Policy "credentialless" always;
add_header X-Content-Type-Options "nosniff" always;
```

Site config:

```nginx
server {
    listen 80;
    server_name chatty.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;   # on nginx < 1.25.1 use: listen 443 ssl http2;
    server_name chatty.example.com;

    # Certbot fills these in (step 4)
    # ssl_certificate     /etc/letsencrypt/live/chatty.example.com/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/chatty.example.com/privkey.pem;

    root /var/www/chatty;
    index index.html;

    # MIME types: ensure wasm and mjs are known (older mime.types lack them)
    include /etc/nginx/mime.types;
    types {
        application/wasm wasm;
        text/javascript  mjs;
    }

    gzip on;
    gzip_types text/css text/javascript application/javascript application/json application/wasm application/manifest+json image/svg+xml;

    # Hashed build output: cache forever
    location /assets/ {
        include snippets/chatty-isolation.conf;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files $uri =404;
    }

    # Service worker and manifests must never be stale
    location = /sw.js {
        include snippets/chatty-isolation.conf;
        add_header Cache-Control "no-cache" always;
        try_files $uri =404;
    }
    location ~ ^/manifest\.(json|webmanifest)$ {
        include snippets/chatty-isolation.conf;
        add_header Cache-Control "no-cache" always;
        try_files $uri =404;
    }

    # HTML and everything else
    location / {
        include snippets/chatty-isolation.conf;
        add_header Cache-Control "no-cache" always;
        try_files $uri $uri/ /index.html;
    }
}
```

Enable it (Debian/Ubuntu layout):

```bash
sudo ln -s /etc/nginx/sites-available/chatty /etc/nginx/sites-enabled/chatty
sudo nginx -t && sudo systemctl reload nginx
```

### 4. HTTPS

DNS for `chatty.example.com` must point at the server first. Then:

```bash
sudo apt install certbot python3-certbot-nginx   # or the distro equivalent
sudo certbot --nginx -d chatty.example.com
```

Re-check after certbot edits the file: `sudo nginx -t && sudo systemctl reload nginx`. Make sure the `include snippets/chatty-isolation.conf;` lines survived.

### 5. Verify

From any machine:

```bash
curl -sI https://chatty.example.com/ | grep -iE 'cross-origin|content-type|cache-control'
curl -sI https://chatty.example.com/sw.js | grep -iE 'cross-origin|cache-control'
curl -sI "https://chatty.example.com/assets/$(curl -s https://chatty.example.com/ | grep -o 'assets/[^"]*\.js' | head -1 | cut -d/ -f2)" | grep -iE 'cross-origin|content-type|cache-control'
```

Expected: both `Cross-Origin-*` headers on every response, `text/javascript` for JS, `application/wasm` for `.wasm`, `immutable` cache on `/assets/`.

In a desktop Chrome/Edge browser on the site, open DevTools console:

- `crossOriginIsolated` → `true`
- `!!navigator.gpu` → `true` (WebGPU available)
- Reload: the app should start pulling the model (progress bar shows "Pulling Assets") with no CORS/COEP errors in the console.

### 6. Updating later

```bash
npm ci && npm run build
sudo rsync -a --delete dist/ /var/www/chatty/
```

No Nginx reload needed. The service worker picks up the new `sw.js` (served `no-cache`); users may need one extra reload.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `crossOriginIsolated` is `false` | Isolation headers missing on the HTML response — usually an `add_header` in a location block without the snippet include. |
| Model/TTS loads fail with COEP errors in console | Same as above, or a proxy/CDN in front (e.g. Cloudflare) stripping headers. |
| `.wasm` fails with "Incorrect response MIME type" | `application/wasm` mapping missing. |
| Mic/WebGPU unavailable | Site not on HTTPS. |
| Blank page, 404s for `/assets/...` | Deployed under a subpath, or `root` points at the wrong folder. |
| Old version keeps showing | Service worker cache; hard-reload or DevTools → Application → Service Workers → Unregister. |

## If it must live under a subpath (e.g. `/chatty/`)

Not supported as-is. Needs code changes before building: set `base: '/chatty/'` in `vite.config.ts`, make the precache paths in `public/sw.js` relative to the SW scope, set `start_url`/`scope` in both manifests to `/chatty/`, and register the service worker with the right scope. Prefer a dedicated subdomain instead.
