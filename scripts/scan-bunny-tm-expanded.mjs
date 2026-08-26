#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

const input = process.argv[2];
const output = process.argv[3];
const localAddress = process.argv[4] || '';
const tcpTimeout = Number(process.env.TCP_TIMEOUT_MS || 1800);
const tlsTimeout = Number(process.env.TLS_TIMEOUT_MS || 7000);
const tcpConcurrency = Number(process.env.TCP_CONCURRENCY || 140);
const tlsConcurrency = Number(process.env.TLS_CONCURRENCY || 24);

if (!input || !output) {
  throw new Error('Usage: node scan-bunny-tm-expanded.mjs INPUT OUTPUT [LOCAL_ADDRESS]');
}

const ips = [
  ...new Set(
    fs
      .readFileSync(input, 'utf8')
      .split(/\s+/)
      .map((value) => value.trim())
      .filter((value) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value))
  ),
];

function tcpProbe(ip) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({
      host: ip,
      port: 443,
      localAddress: localAddress || undefined,
      timeout: tcpTimeout,
    });
    let finished = false;
    const done = (ok, error = null) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve({ ip, ok, ms: Date.now() - started, error });
    };
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false, 'timeout'));
    socket.on('error', (error) => done(false, error.code || error.message));
  });
}

function tlsProbe(ip) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = tls.connect({
      host: ip,
      port: 443,
      servername: 'www.google.com',
      localAddress: localAddress || undefined,
      rejectUnauthorized: false,
      timeout: tlsTimeout,
      ALPNProtocols: ['h2', 'http/1.1'],
    });
    let finished = false;
    const done = (ok, extra = {}) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve({ ip, ok, ms: Date.now() - started, ...extra });
    };
    socket.on('secureConnect', () => {
      const certificate = socket.getPeerCertificate() || {};
      const cn = certificate.subject?.CN || '';
      done(true, {
        cn,
        alpn: socket.alpnProtocol || null,
        pullEdge: cn.includes('b-cdn.net') && !cn.includes('storage'),
      });
    });
    socket.on('timeout', () => done(false, { error: 'timeout' }));
    socket.on('error', (error) => done(false, { error: error.code || error.message }));
  });
}

async function pool(items, concurrency, probe, progressLabel) {
  const outputRows = new Array(items.length);
  let cursor = 0;
  let completed = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      outputRows[index] = await probe(items[index]);
      completed += 1;
      if (completed % 250 === 0 || completed === items.length) {
        console.log(`${progressLabel} ${completed}/${items.length}`);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return outputRows;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

console.log(`START candidates=${ips.length} local=${localAddress || 'default'}`);
const tcpRows = await pool(ips, tcpConcurrency, tcpProbe, 'TCP');
const tcpOk = tcpRows.filter((row) => row.ok).sort((a, b) => a.ms - b.ms);
console.log(`TCP_OK ${tcpOk.length}/${ips.length}`);

const tlsRows = await pool(tcpOk.map((row) => row.ip), tlsConcurrency, tlsProbe, 'TLS');
const pullRows = tlsRows
  .filter((row) => row.ok && row.pullEdge)
  .sort((a, b) => a.ms - b.ms);
console.log(`PULL_TLS_OK ${pullRows.length}/${tcpOk.length}`);

const finalists = pullRows.slice(0, 30);
const repeated = [];
for (const finalist of finalists) {
  const attempts = [finalist.ms];
  for (let index = 0; index < 2; index += 1) {
    const result = await tlsProbe(finalist.ip);
    if (result.ok && result.pullEdge) attempts.push(result.ms);
  }
  const tcpMs = tcpOk.find((row) => row.ip === finalist.ip)?.ms || null;
  repeated.push({
    ip: finalist.ip,
    tcpMs,
    tlsAttemptsMs: attempts,
    tlsMedianMs: median(attempts),
    successfulAttempts: attempts.length,
    alpn: finalist.alpn,
    cn: finalist.cn,
  });
}
repeated.sort((a, b) => {
  if (a.successfulAttempts !== b.successfulAttempts) {
    return b.successfulAttempts - a.successfulAttempts;
  }
  return a.tlsMedianMs - b.tlsMedianMs;
});

const report = {
  at: new Date().toISOString(),
  localAddress: localAddress || null,
  candidates: ips.length,
  tcpOk: tcpOk.length,
  pullTlsOk: pullRows.length,
  top: repeated,
  tcpRows,
  tlsRows,
};
fs.writeFileSync(output, JSON.stringify(report, null, 2));

console.log('TOP');
for (const row of repeated.slice(0, 20)) {
  console.log(
    `${row.ip} tcp=${row.tcpMs} tlsMedian=${row.tlsMedianMs} attempts=${row.tlsAttemptsMs.join(',')}`
  );
}
console.log(`DONE ${output}`);
