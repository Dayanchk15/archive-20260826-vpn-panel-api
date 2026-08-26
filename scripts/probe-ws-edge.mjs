#!/usr/bin/env node
/** WebSocket probe for Cloud Run VPN edge (from VPS). */
import https from 'https';

const host = process.argv[2] || 'germany8-5mkfsg2x2a-ey.a.run.app';

function wsProbe(hostname, connectHost) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.request(
      {
        host: connectHost || hostname,
        servername: hostname,
        port: 443,
        path: '/',
        method: 'GET',
        headers: {
          Host: hostname,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
        timeout: 15000,
        rejectUnauthorized: true,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          resolve({
            ok: res.statusCode === 101,
            statusCode: res.statusCode,
            ms: Date.now() - started,
            body: body.slice(0, 200),
            connectHost: connectHost || hostname,
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout', connectHost: connectHost || hostname });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message, connectHost: connectHost || hostname }));
    req.end();
  });
}

const direct = await wsProbe(host);
const masked = await wsProbe(host, '216.58.198.46');

console.log(JSON.stringify({ host, direct, masked }, null, 2));
