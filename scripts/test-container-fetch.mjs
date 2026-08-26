#!/usr/bin/env node
import https from 'node:https';

const hosts = [
  'poland1-6tum7ycmhq-ey.a.run.app',
  'germany1-6tum7ycmhq-ey.a.run.app',
  'turkey1-6tum7ycmhq-ey.a.run.app',
];

function probe(host) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.request(
      {
        hostname: host,
        path: '/',
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
        timeout: 20000,
      },
      (res) => {
        resolve({ host, ok: [101, 400, 426].includes(res.statusCode), status: res.statusCode, ms: Date.now() - started });
        res.resume();
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ host, ok: false, error: 'timeout', ms: Date.now() - started });
    });
    req.on('error', (err) => resolve({ host, ok: false, error: err.message, ms: Date.now() - started }));
    req.end();
  });
}

async function main() {
  const results = await Promise.all(hosts.map(probe));
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
