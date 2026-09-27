#!/usr/bin/env node
// Dependency-free HTTP Basic Auth reverse proxy. Sits between the public
// Cloudflare quick tunnel and the local Web app so the public URL isn't
// wide open — most of the API's own routes have no auth guard of their
// own (see start-mac.command), so the login wall has to live here instead.
// Started by share-mac.command; not part of the normal local (start-mac)
// path at all.
const http = require('http');

const LISTEN_PORT = process.env.PROXY_PORT;
const TARGET_PORT = process.env.TARGET_PORT;
const USER = process.env.TUNNEL_USER;
const PASS = process.env.TUNNEL_PASS;

if (!LISTEN_PORT || !TARGET_PORT || !USER || !PASS) {
  console.error('PROXY_PORT, TARGET_PORT, TUNNEL_USER and TUNNEL_PASS env vars are required.');
  process.exit(1);
}

const expected = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== expected) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="FindUrJob"',
      'Content-Type': 'text/plain',
    });
    res.end('Authentication required.');
    return;
  }

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: TARGET_PORT,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', (err) => {
    res.writeHead(502);
    res.end('Bad gateway: ' + err.message);
  });
  req.pipe(proxyReq);
});

// The verification/remote-login SSE streams are long-lived responses —
// don't let Node's default timeouts cut them off.
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`Auth proxy: 127.0.0.1:${LISTEN_PORT} -> 127.0.0.1:${TARGET_PORT}`);
});
