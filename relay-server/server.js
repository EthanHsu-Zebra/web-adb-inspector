import { createServer } from 'http';
import { createWsRelayServer } from '@trystero-p2p/ws-relay/server';

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

// Plain HTTP server so hosting platforms' health checks (a bare GET /) get a normal
// 200 instead of hitting createWsRelayServer's bundled http server, which only knows
// how to handle the WebSocket upgrade handshake.
const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('web-adb-inspector relay: ok\n');
});

// NOTE: createWsRelayServer destructures its options as `{onError, ...wsOptions}` and
// spreads the REST directly into `new WebSocketServer(...)` -- so `server` must be a
// top-level key here, not nested under a `wsOptions` sub-object (that was a real bug:
// it silently ignored our httpServer and spun up its own default WebSocketServer on
// port 8080 instead).
const relay = createWsRelayServer({
  server: httpServer,
  onError: (err) => console.error('[relay] error:', err),
});

httpServer.listen(port, () => {
  console.log(`[relay] listening on port ${port}`);
});

setInterval(() => {
  console.log(`[relay] subscribers: ${relay.getSubscriberCount()}`);
}, 60000);
