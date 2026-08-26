import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

const OK_STATUSES = new Set([101, 400, 426]);

export function probeMaskedTls(server, addressIp, timeoutMs = 15000) {
  const cloudHost = String(server.host || '').replace(/^https?:\/\//, '');
  const sni = String(server.sni || 'www.google.com');
  const wsPath = String(server.wsPath || server.path || '/').trim() || '/';
  const requestPath = wsPath.startsWith('/') ? wsPath : `/${wsPath}`;
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const socket = tls.connect(
      {
        host: addressIp,
        port: 443,
        servername: sni,
        ALPNProtocols: ['http/1.1'],
        rejectUnauthorized: true,
        timeout: timeoutMs,
      },
      () => {
        const websocketKey = randomBytes(16).toString('base64');
        socket.write(
          `GET ${requestPath} HTTP/1.1\r\nHost: ${cloudHost}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${websocketKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      }
    );
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      const firstLine = data.split('\r\n')[0] || '';
      const status = Number((firstLine.match(/HTTP\/\d\.\d (\d+)/) || [])[1] || 0);
      finish({
        service: server.service,
        addressIp,
        cloudHost,
        sni,
        ok: OK_STATUSES.has(status),
        status: status || null,
        ms: Date.now() - started,
        line: firstLine.slice(0, 80),
        error: OK_STATUSES.has(status) ? null : `status ${status || 'unknown'}`,
      });
      socket.destroy();
    });
    socket.on('error', (err) => {
      finish({
        service: server.service,
        ok: false,
        error: err.message,
        ms: Date.now() - started,
      });
    });
    socket.on('timeout', () => {
      socket.destroy();
      finish({ service: server.service, ok: false, error: 'timeout', ms: Date.now() - started });
    });
    setTimeout(() => {
      socket.destroy();
      finish({ service: server.service, ok: false, error: 'timeout', ms: Date.now() - started });
    }, timeoutMs);
  });
}

export async function probeMaskedTlsWithRetry(
  server,
  addressIp,
  { attempts = 3, retryDelayMs = 20000, timeoutMs = 20000 } = {}
) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await probeMaskedTls(server, addressIp, timeoutMs);
    last.attempt = attempt;
    if (last.ok) return last;
    const retryable = last.status === 429 || last.error === 'timeout';
    if (!retryable || attempt >= attempts) return last;
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  return last;
}

export async function wakeColdNodesSequentially(servers, addressIp, options = {}) {
  const cold = servers.filter((s) => Number(s.minInstances ?? 0) < 1);
  const gapMs = Number(options.gapMs || 45000);
  const results = [];
  for (let i = 0; i < cold.length; i += 1) {
    if (i > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    const result = await probeMaskedTlsWithRetry(cold[i], addressIp, {
      attempts: Number(options.attempts || 3),
      retryDelayMs: Number(options.retryDelayMs || 25000),
      timeoutMs: Number(options.timeoutMs || 25000),
    });
    results.push(result);
    console.log(JSON.stringify({ phase: 'wakeCold', ...result }));
  }
  return results;
}
