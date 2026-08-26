#!/usr/bin/env node
import https from 'https';

const host = process.argv[2] || 'germany8-5mkfsg2x2a-ey.a.run.app';

function wsProbe({ connectHost, servername, wsHost }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.request(
      {
        host: connectHost,
        servername: servername || connectHost,
        port: 443,
        path: '/',
        method: 'GET',
        headers: {
          Host: wsHost || host,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
        timeout: 20000,
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
            connectHost,
            servername: servername || connectHost,
            wsHost: wsHost || host,
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout', connectHost });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message, connectHost }));
    req.end();
  });
}

const tests = {
  directRunApp: await wsProbe({ connectHost: host, servername: host, wsHost: host }),
  maskedGoogleIp: await wsProbe({
    connectHost: '216.58.198.46',
    servername: 'www.google.com',
    wsHost: host,
  }),
  maskedRunAppSni: await wsProbe({
    connectHost: '216.58.198.46',
    servername: host,
    wsHost: host,
  }),
};

console.log(JSON.stringify({ host, tests }, null, 2));
