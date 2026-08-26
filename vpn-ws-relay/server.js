import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM_WS_URL = String(process.env.UPSTREAM_WS_URL || '').trim();

function parseUpstreamRoutes() {
  const raw = String(process.env.UPSTREAM_ROUTES || '').trim();
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('UPSTREAM_ROUTES must be a JSON object of path -> ws url');
  }
  const routes = new Map();
  for (const [pathKey, url] of Object.entries(parsed)) {
    const path = String(pathKey || '').trim();
    const upstream = String(url || '').trim();
    if (!path.startsWith('/')) continue;
    if (!upstream) continue;
    routes.set(path, upstream);
  }
  if (!routes.size) throw new Error('UPSTREAM_ROUTES is empty');
  return routes;
}

const UPSTREAM_ROUTES = parseUpstreamRoutes();

if (!UPSTREAM_WS_URL && !UPSTREAM_ROUTES) {
  console.error('UPSTREAM_WS_URL or UPSTREAM_ROUTES is required');
  process.exit(1);
}

function resolveUpstreamUrl(requestUrl) {
  const url = String(requestUrl || '/').split('?')[0] || '/';
  if (UPSTREAM_ROUTES) {
    if (UPSTREAM_ROUTES.has(url)) return UPSTREAM_ROUTES.get(url);
    const withSlash = url.endsWith('/') ? url : `${url}/`;
    if (UPSTREAM_ROUTES.has(withSlash)) return UPSTREAM_ROUTES.get(withSlash);
    const noSlash = url.replace(/\/+$/, '') || '/';
    if (UPSTREAM_ROUTES.has(noSlash)) return UPSTREAM_ROUTES.get(noSlash);
    return null;
  }
  return UPSTREAM_WS_URL;
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url === '/health' || url.startsWith('/health?')) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }
  res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Bad Request');
});

const wss = new WebSocketServer({ server, perMessageDeflate: false });

wss.on('connection', (clientSocket, request) => {
  const upstreamWsUrl = resolveUpstreamUrl(request.url);
  if (!upstreamWsUrl) {
    console.error('no upstream route for', request.url);
    try {
      clientSocket.close(1008, 'unknown path');
    } catch {}
    return;
  }

  const upstream = new WebSocket(upstreamWsUrl, {
    perMessageDeflate: false,
    handshakeTimeout: 15000,
    headers: {
      Host: request.headers.host || '',
    },
  });

  const closeQuietly = (code, reason) => {
    try {
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close(code, reason);
    } catch {}
    try {
      if (upstream.readyState === WebSocket.OPEN) upstream.close(code, reason);
    } catch {}
  };

  upstream.on('open', () => {
    const pingMs = Number(process.env.RELAY_WS_PING_MS || 30000);
    const pingTimer = setInterval(() => {
      if (upstream.readyState === WebSocket.OPEN) upstream.ping();
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.ping();
    }, pingMs);
    pingTimer.unref?.();

    const stopPing = () => clearInterval(pingTimer);
    upstream.once('close', stopPing);
    clientSocket.once('close', stopPing);

    clientSocket.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    });
    upstream.on('message', (data, isBinary) => {
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(data, { binary: isBinary });
    });
  });

  upstream.on('error', (err) => {
    console.error(`upstream error (${upstreamWsUrl}):`, err.message);
    closeQuietly(1011, 'upstream error');
  });
  clientSocket.on('error', (err) => {
    console.error('client error:', err.message);
    closeQuietly(1011, 'client error');
  });
  upstream.on('close', () => closeQuietly());
  clientSocket.on('close', () => closeQuietly());
});

server.listen(PORT, () => {
  if (UPSTREAM_ROUTES) {
    const paths = [...UPSTREAM_ROUTES.keys()].join(', ');
    console.log(`vpn-ws-relay listening on :${PORT} routes: ${paths}`);
  } else {
    console.log(`vpn-ws-relay listening on :${PORT} -> ${UPSTREAM_WS_URL}`);
  }
});
