#!/usr/bin/env node
/**
 * Validate preliminary Alibaba TLS hits against the exact Levospeed ESA
 * VLESS WebSocket + TLS profile.
 * Read-only network probe: it does not change DNS, servers, or the panel.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';

const args = parseArgs(process.argv.slice(2));
const INPUT = path.resolve(String(args.input || ''));
if (!INPUT || !fs.existsSync(INPUT)) throw new Error(`Input file not found: ${INPUT}`);

const OUT_IPS = path.resolve(String(args.outIps || INPUT.replace(/\.txt$/i, '.qualified.txt')));
const OUT_JSONL = path.resolve(String(args.outJsonl || INPUT.replace(/\.txt$/i, '.qualified.jsonl')));
const OUT_REPORT = path.resolve(String(args.outReport || INPUT.replace(/\.txt$/i, '.qualified.report.json')));
const OUT_FAILURES = args.outFailures
  ? path.resolve(String(args.outFailures))
  : null;
const LOCAL_ADDRESS = String(args.local || '').trim();
const CONCURRENCY = positiveInt(args.concurrency, 12);
const TIMEOUT_MS = positiveInt(args.timeout, 4500);
const MAX_SOURCE_MS = nonNegativeInt(args.maxSourceMs, 0);
const MAX_TCP_MS = positiveInt(args.maxTcpMs, 1500);
const MAX_TLS_MS = positiveInt(args.maxTlsMs, 2500);
const MAX_APP_MS = positiveInt(args.maxAppMs, 3500);
const LIMIT = nonNegativeInt(args.limit, 0);
const PASSES = positiveInt(args.passes, 3);
const FRONT_SNI = String(args.sni || 'www.alibaba.com').trim();

const ALL_TARGETS = [
  { id: 'fr1', host: 'cdn-a1.levospeed.click', path: '/' },
  { id: 'fr2', host: 'cdn-a2.levospeed.click', path: '/' },
  { id: 'fornex', host: 'cdn-a3.levospeed.click', path: '/' },
  { id: 'tampa', host: 'cdn-a4.levospeed.click', path: '/' },
];
const TARGET_FILTER = String(args.target || 'all').trim().toLowerCase();
const TARGETS = TARGET_FILTER === 'all'
  ? ALL_TARGETS
  : ALL_TARGETS.filter((target) => target.id === TARGET_FILTER);
if (!TARGETS.length) {
  throw new Error(`Unknown target: ${TARGET_FILTER}. Use all, fr1, fr2, fornex, or tampa.`);
}

for (const output of [OUT_IPS, OUT_JSONL, OUT_REPORT, OUT_FAILURES].filter(Boolean)) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
}

const parsed = parseCandidates(fs.readFileSync(INPUT, 'utf8'));
const candidates = parsed
  .filter((row) => MAX_SOURCE_MS === 0 || row.sourceTlsMs <= MAX_SOURCE_MS)
  .sort((left, right) => left.sourceTlsMs - right.sourceTlsMs)
  .slice(0, LIMIT || undefined);

const alreadyFound = readExistingIps(OUT_IPS);
const ipFd = fs.openSync(OUT_IPS, 'a');
const jsonlFd = fs.openSync(OUT_JSONL, 'a');
const failureFd = OUT_FAILURES ? fs.openSync(OUT_FAILURES, 'a') : null;
const targetOutputs = Object.fromEntries(TARGETS.map((target) => [
  target.id,
  OUT_IPS.replace(/\.txt$/i, `.${target.id}.txt`),
]));
const targetFds = Object.fromEntries(Object.entries(targetOutputs).map(([id, output]) => {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  return [id, fs.openSync(output, 'a')];
}));
let completed = 0;
let qualified = alreadyFound.size;
const qualifiedByTarget = Object.fromEntries(TARGETS.map((target) => [target.id, 0]));
let stopped = false;
const failures = {};
const startedAt = new Date().toISOString();

console.log('=== Alibaba ESA exact-profile scan ===');
console.log(`input: ${INPUT}`);
console.log(`parsed unique IPs: ${parsed.length}`);
console.log(`selected candidates: ${candidates.length}`);
console.log(`source TLS ceiling: ${MAX_SOURCE_MS || 'disabled'} ms`);
console.log(`local address: ${LOCAL_ADDRESS || '(system default route)'}`);
console.log(`concurrency: ${CONCURRENCY}, timeout: ${TIMEOUT_MS} ms`);
console.log(`required WebSocket passes per hostname: ${PASSES}/${PASSES}`);
console.log(`target: ${TARGET_FILTER}`);
console.log(`live qualified IPs: ${OUT_IPS}`);
console.log(`live details: ${OUT_JSONL}`);
console.log('criteria: TCP + TLS certificate + ALPN http/1.1 + WebSocket 101 per ESA hostname');
console.log('');

process.on('SIGINT', () => {
  stopped = true;
  console.log('\nStopping after active probes finish...');
});

try {
  await mapPool(candidates, CONCURRENCY, async (candidate) => {
    if (stopped || alreadyFound.has(candidate.ip)) return;
    const result = await inspectCandidate(candidate);
    completed += 1;
    if (result.ok) {
      qualified += 1;
      alreadyFound.add(candidate.ip);
      writeAndSync(ipFd, `${candidate.ip}\n`);
      writeAndSync(jsonlFd, `${JSON.stringify({ foundAt: new Date().toISOString(), ...result })}\n`);
      for (const targetId of result.passedTargets) {
        qualifiedByTarget[targetId] += 1;
        writeAndSync(targetFds[targetId], `${candidate.ip}\n`);
      }
      console.log(`[FOUND ${qualified}] ${candidate.ip} targets=${result.passedTargets.join(',')} source=${candidate.sourceTlsMs}ms tcp=${result.tcpMs}ms tls=${result.tlsMs}ms app=${result.maxAppMs}ms`);
    } else {
      failures[result.reason] = (failures[result.reason] || 0) + 1;
      if (failureFd !== null) {
        fs.writeSync(failureFd, `${JSON.stringify({ failedAt: new Date().toISOString(), ...result })}\n`);
      }
    }
    if (completed % 100 === 0) {
      console.log(`[progress] tested=${completed}/${candidates.length} qualified=${qualified}`);
    }
  });
} finally {
  fs.closeSync(ipFd);
  fs.closeSync(jsonlFd);
  if (failureFd !== null) fs.closeSync(failureFd);
  for (const fd of Object.values(targetFds)) fs.closeSync(fd);
}

const report = {
  ok: !stopped,
  stopped,
  startedAt,
  finishedAt: new Date().toISOString(),
  input: INPUT,
  outputs: { ips: OUT_IPS, jsonl: OUT_JSONL, failures: OUT_FAILURES, byTarget: targetOutputs },
  settings: {
    localAddress: LOCAL_ADDRESS || null,
    concurrency: CONCURRENCY,
    timeoutMs: TIMEOUT_MS,
    maxSourceMs: MAX_SOURCE_MS,
    maxTcpMs: MAX_TCP_MS,
    maxTlsMs: MAX_TLS_MS,
    maxAppMs: MAX_APP_MS,
    passes: PASSES,
    frontSni: FRONT_SNI,
    target: TARGET_FILTER,
    targets: TARGETS,
  },
  parsedUnique: parsed.length,
  selected: candidates.length,
  testedThisRun: completed,
  qualifiedTotal: qualified,
  qualifiedByTarget,
  failures,
};
fs.writeFileSync(OUT_REPORT, `${JSON.stringify(report, null, 2)}\n`);
console.log('');
console.log(JSON.stringify(report, null, 2));

async function inspectCandidate(candidate) {
  const tcp = await tcpProbe(candidate.ip);
  if (!tcp.ok) return failed(candidate, `tcp_${tcp.error || 'failed'}`, { tcpMs: tcp.ms });
  if (tcp.ms > MAX_TCP_MS) return failed(candidate, 'tcp_too_slow', { tcpMs: tcp.ms });

  const tlsResult = await tlsProbe(candidate.ip);
  if (!tlsResult.ok) return failed(candidate, `tls_${tlsResult.error || 'failed'}`, { tcpMs: tcp.ms, tlsMs: tlsResult.ms });
  if (!tlsResult.certValidForSni) return failed(candidate, 'certificate_mismatch', { tcpMs: tcp.ms, tlsMs: tlsResult.ms });
  if (tlsResult.alpn !== 'http/1.1') return failed(candidate, 'alpn_not_http11', { tcpMs: tcp.ms, tlsMs: tlsResult.ms, alpn: tlsResult.alpn });
  if (tlsResult.ms > MAX_TLS_MS) return failed(candidate, 'tls_too_slow', { tcpMs: tcp.ms, tlsMs: tlsResult.ms });

  const routes = [];
  for (const target of TARGETS) {
    const attempts = [];
    for (let pass = 1; pass <= PASSES; pass += 1) {
      const app = await websocketProbe(candidate.ip, target);
      const passed = app.ok && app.status === 101 && app.ms <= MAX_APP_MS;
      attempts.push({
        pass,
        status: app.status || 0,
        ms: app.ms,
        server: app.server || null,
        error: app.error || null,
        passed,
      });
      if (!passed) break;
    }
    routes.push({
      ...target,
      status: attempts.at(-1)?.status || 0,
      ms: Math.max(...attempts.map((attempt) => attempt.ms)),
      server: attempts.at(-1)?.server || null,
      error: attempts.at(-1)?.error || null,
      passed: attempts.length === PASSES && attempts.every((attempt) => attempt.passed),
      attempts,
    });
  }

  const passedRoutes = routes.filter((route) => route.passed);
  if (!passedRoutes.length) {
    return failed(candidate, 'no_ws_101', { tcpMs: tcp.ms, tlsMs: tlsResult.ms, routes });
  }

  return {
    ok: true,
    ip: candidate.ip,
    sourceTlsMs: candidate.sourceTlsMs,
    tcpMs: tcp.ms,
    tlsMs: tlsResult.ms,
    alpn: tlsResult.alpn,
    certificateCn: tlsResult.cn,
    maxAppMs: Math.max(...passedRoutes.map((route) => route.ms)),
    passedTargets: passedRoutes.map((route) => route.id),
    routes,
  };
}

function failed(candidate, reason, extra = {}) {
  return { ok: false, ip: candidate.ip, sourceTlsMs: candidate.sourceTlsMs, reason, ...extra };
}

function tcpProbe(ip) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect(socketOptions(ip));
    let done = false;
    const finish = (ok, error = null) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, ms: Date.now() - started, error });
    };
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false, 'timeout'));
    socket.on('error', (error) => finish(false, error.code || error.message));
  });
}

function tlsProbe(ip) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = tls.connect({
      ...socketOptions(ip),
      servername: FRONT_SNI,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: false,
    });
    let done = false;
    const finish = (ok, error = null, extra = {}) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, ms: Date.now() - started, error, ...extra });
    };
    socket.on('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const identityError = tls.checkServerIdentity(FRONT_SNI, cert);
      finish(true, null, {
        alpn: socket.alpnProtocol || null,
        cn: cert?.subject?.CN || null,
        certValidForSni: !identityError,
      });
    });
    socket.on('timeout', () => finish(false, 'timeout'));
    socket.on('error', (error) => finish(false, error.code || error.message));
  });
}

function websocketProbe(ip, target) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = tls.connect({
      ...socketOptions(ip),
      servername: FRONT_SNI,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: false,
    });
    let response = '';
    let done = false;
    const finish = (ok, error = null, extra = {}) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, error, ms: Date.now() - started, ...extra });
    };
    socket.on('secureConnect', () => {
      socket.write([
        `GET ${target.path} HTTP/1.1`,
        `Host: ${target.host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'User-Agent: levospeed-alibaba-ws-qualifier/1.0',
        'Cache-Control: no-cache',
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('latin1');
      if (!response.includes('\r\n\r\n')) return;
      const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d+)/.exec(response)?.[1] || 0);
      const server = /^server:\s*(.+)$/im.exec(response)?.[1]?.trim() || null;
      finish(status === 101, status === 101 ? null : `http_${status || 'invalid'}`, { status, server });
    });
    socket.on('timeout', () => finish(false, 'timeout'));
    socket.on('error', (error) => finish(false, error.code || error.message));
    socket.on('end', () => {
      if (!done) finish(false, 'connection_closed');
    });
  });
}

function socketOptions(ip) {
  return {
    host: ip,
    port: 443,
    family: 4,
    localAddress: LOCAL_ADDRESS || undefined,
    timeout: TIMEOUT_MS,
  };
}

function parseCandidates(text) {
  const best = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(\d{1,3}(?:\.\d{1,3}){3})(?:\s+(\d+)ms\b)?/.exec(line);
    if (!match || !validIpv4(match[1])) continue;
    const row = { ip: match[1], sourceTlsMs: match[2] ? Number(match[2]) : 0 };
    const previous = best.get(row.ip);
    if (!previous || row.sourceTlsMs < previous.sourceTlsMs) best.set(row.ip, row);
  }
  return [...best.values()];
}

function validIpv4(ip) {
  const octets = ip.split('.').map(Number);
  return octets.length === 4 && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255);
}

function readExistingIps(file) {
  if (!fs.existsSync(file)) return new Set();
  return new Set(fs.readFileSync(file, 'utf8').split(/\s+/).filter(validIpv4));
}

function writeAndSync(fd, value) {
  fs.writeSync(fd, value);
  fs.fsyncSync(fd);
}

async function mapPool(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!stopped) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

function parseArgs(argv) {
  const result = {};
  for (const item of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(item);
    if (match) result[toCamel(match[1])] = match[2];
  }
  return result;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_match, character) => character.toUpperCase());
}

function positiveInt(value, fallback) {
  const parsedValue = Number(value);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsedValue = Number(value);
  return Number.isInteger(parsedValue) && parsedValue >= 0 ? parsedValue : fallback;
}
