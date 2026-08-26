import { resolve4 } from 'node:dns/promises';
import httpsMod from 'node:https';
import { randomBytes } from 'node:crypto';

function wsHeaders() {
  return {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
    'Sec-WebSocket-Version': '13',
  };
}

export async function probeWsHost(host, timeoutMs = 15000) {
  const hostname = String(host || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!hostname) {
    return { ok: false, status: 0, ms: 0, error: 'empty host' };
  }
  let ip;
  try {
    const ips = await resolve4(hostname);
    ip = ips[0];
  } catch (err) {
    return { ok: false, status: 0, ms: 0, error: err.message || String(err) };
  }
  if (!ip) {
    return { ok: false, status: 0, ms: 0, error: 'no IPv4 address' };
  }

  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let req;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        req?.destroy();
      } catch {
        /* ignore */
      }
      finish({ ok: false, status: 0, ms: Date.now() - started, error: 'timeout' });
    }, timeoutMs);

    req = httpsMod.request(
      {
        host: ip,
        path: '/',
        method: 'GET',
        headers: { ...wsHeaders(), Host: hostname },
        servername: hostname,
      },
      (res) => {
        const ms = Date.now() - started;
        const ok = [101, 400, 426].includes(res.statusCode);
        finish({ ok, status: res.statusCode, ms, error: ok ? null : `unexpected status ${res.statusCode}` });
        res.resume();
      }
    );
    req.on('error', (err) => {
      finish({ ok: false, status: 0, ms: Date.now() - started, error: err.message || String(err) });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish({ ok: false, status: 0, ms: Date.now() - started, error: 'timeout' });
    });
    req.end();
  });
}
