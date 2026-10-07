import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 10000);
const DERIVE_HTTP = process.env.DERIVE_HTTP || 'https://testnet.api.derive.xyz/v3';
const DERIVE_WS = process.env.DERIVE_WS || 'wss://testnet.api.derive.xyz/v3/ws';

const allowedOrigins = new Set([
  'https://intent-options-v3.onrender.com',
  'https://intent-options-builder.onrender.com',
  'http://localhost:5173',
]);

const allowedHttpMethods = new Set([
  'public/get_all_currencies',
  'public/get_all_instruments',
  'public/get_ticker',
  'public/get_tickers',
  'public/get_instrument',
  'private/set_session_key',
]);

function corsHeaders(req) {
  const origin = req.headers.origin || '';
  const allowOrigin = allowedOrigins.has(origin) ? origin : 'https://intent-options-v3.onrender.com';
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-derivewallet,x-derivetimestamp,x-derivesignature',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  const cors = corsHeaders(req);
  for (const [key, value] of Object.entries(cors)) res.setHeader(key, value);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deriveHttp: DERIVE_HTTP, deriveWs: DERIVE_WS }));
    return;
  }

  if (req.method !== 'POST' || !req.url?.startsWith('/derive/')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  const method = decodeURIComponent(req.url.slice('/derive/'.length));
  if (!allowedHttpMethods.has(method)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method_not_allowed', method }));
    return;
  }

  try {
    const body = await readBody(req);
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'intent-options-api/1.0',
    };

    for (const name of ['x-derivewallet', 'x-derivetimestamp', 'x-derivesignature']) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }

    const upstream = await fetch(DERIVE_HTTP + '/' + method, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });

    const payload = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': method.startsWith('public/') ? 'no-store' : 'private, no-store',
    });
    res.end(payload);
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: 'derive_upstream_error',
      message: error instanceof Error ? error.message : String(error),
    }));
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') {
    socket.destroy();
    return;
  }

  const origin = req.headers.origin || '';
  if (origin && !allowedOrigins.has(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (client) => {
    const upstream = new WebSocket(DERIVE_WS, {
      headers: { 'user-agent': 'intent-options-api/1.0' },
    });

    let upstreamReady = false;
    const pending = [];

    client.on('message', (data, isBinary) => {
      if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      } else {
        pending.push([data, isBinary]);
      }
    });

    upstream.on('open', () => {
      upstreamReady = true;
      for (const [data, isBinary] of pending.splice(0)) upstream.send(data, { binary: isBinary });
    });

    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });

    const closeBoth = (code = 1011, reason = 'upstream closed') => {
      try {
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(code, reason);
      } catch {}
      try {
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
      } catch {}
    };

    client.on('close', () => closeBoth(1000, 'client closed'));
    client.on('error', () => closeBoth());
    upstream.on('close', (code) => closeBoth(code || 1011, 'derive closed'));
    upstream.on('error', () => closeBoth());
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('intent-options-api listening on', PORT);
});
