#!/usr/bin/env node
/**
 * Probe candidate Google IPs for TM masking (TCP 443).
 * Run from TM: node scripts/probe-tm-google-ips.mjs
 */
import net from 'net';

const CANDIDATES = [
  { ip: '216.58.198.46', label: 'Milan ✓ known TM', priority: 1 },
  { ip: '216.58.198.45', label: 'Milan neighbor', priority: 1 },
  { ip: '216.58.198.44', label: 'Milan', priority: 1 },
  { ip: '216.58.198.47', label: 'Milan', priority: 1 },
  { ip: '216.58.198.48', label: 'Milan', priority: 1 },
  { ip: '216.58.198.42', label: 'Milan', priority: 1 },
  { ip: '216.58.198.50', label: 'Milan', priority: 1 },
  { ip: '216.58.198.144', label: 'Frankfurt fra02', priority: 2 },
  { ip: '216.58.198.145', label: 'Frankfurt', priority: 2 },
  { ip: '216.58.198.150', label: 'Frankfurt', priority: 2 },
  { ip: '216.58.198.140', label: 'Frankfurt', priority: 2 },
  { ip: '216.58.198.100', label: 'London', priority: 3 },
  { ip: '216.58.198.200', label: 'Paris', priority: 3 },
  { ip: '216.58.198.204', label: 'Paris', priority: 3 },
  { ip: '172.217.16.142', label: 'OLD blocked in TM?', priority: 9 },
  { ip: '142.251.153.119', label: 'OLD blocked in TM?', priority: 9 },
];

const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 5000);

function probeTcp(host, port = 443) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port, timeout: TIMEOUT_MS });
    const finish = (ok, error) => {
      socket.destroy();
      resolve({ ok, ms: Date.now() - started, error });
    };
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false, 'timeout'));
    socket.on('error', (err) => finish(false, err.code || err.message));
  });
}

const results = [];
for (const item of CANDIDATES) {
  const r = await probeTcp(item.ip);
  results.push({ ...item, ...r });
  console.log(`${r.ok ? 'OK' : 'FAIL'}\t${item.ip}\t${r.ms}ms\t${item.label}${r.error ? `\t${r.error}` : ''}`);
}

const working = results.filter((r) => r.ok).map((r) => r.ip);
console.log('\nWorking from this network:', working.join(', ') || '(none)');
