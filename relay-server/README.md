# web-adb-inspector relay server

A tiny always-on WebSocket signaling relay for the main app's Remote Session feature, using `@trystero-p2p/ws-relay`'s server helper. It replaces public Nostr relays as the signaling transport — those turned out to be unreliable for a quick 1:1 host/viewer rendezvous (rate-limiting, and independent random relay selection meant host and viewer often shared no relay in common; see `PROJECT_CONTEXT.md` section 12 in the repo root for the full debugging history).

This server does **not** relay ADB commands or device data itself — it only helps two browsers find each other and exchange the WebRTC handshake. Once connected, all actual traffic (device state, shell commands/output) flows peer-to-peer between host and viewer, not through this server.

## Local test

```bash
cd relay-server
npm install
npm start
```

Listens on `PORT` (default `8080`). A plain `GET /` returns `200 ok` (for hosting-platform health checks); the actual relay protocol is WebSocket-only.

## Deploying

Needs a host that runs a real, always-on Node process — **not** an edge/serverless platform like Cloudflare Workers or Deno Deploy, since `@trystero-p2p/ws-relay`'s server is built on the standard Node `ws` package (a persistent listening socket), not their per-request Worker model.

**Render.com (free tier, no credit card required)** — `render.yaml` at the repo root is a Render Blueprint for this. In the Render dashboard: New → Blueprint → connect this repo → it should pick up `render.yaml` and deploy `relay-server/` automatically. Once live, the WebSocket URL is `wss://<your-service-name>.onrender.com`.

Note: Render's free tier spins the service down after 15 minutes of no traffic and takes ~30-50s to cold-start on the next connection — the first remote session after a period of inactivity will be slow to connect (but should actually connect, unlike the public-relay failures this replaces).

Other options that work equally well (same "needs a real Node process" requirement): Fly.io, Railway, a small VPS, or any other Node hosting.

## Wiring into the main app

Once deployed, put the WebSocket URL into `src/index.js`'s `REMOTE_RELAY_URLS` (or equivalent `relayConfig.urls`) for both the host and viewer `joinRoom()` calls, and switch the import from `@trystero-p2p/nostr` to `@trystero-p2p/ws-relay`.
