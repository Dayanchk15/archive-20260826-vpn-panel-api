#!/usr/bin/env node
/**
 * Find Google IPs that support masked VLESS routing to Cloud Run.
 * Tests full TLS + WebSocket Upgrade (exactly what Happ does in masked mode).
 * Applies the best IP to panel + all servers and refreshes subscriptions.
 */
import tls from 'node:tls';
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { listServers, updateServer, listUsers } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { nowIso } from '../lib/dates.js';

const APPLY = process.env.APPLY === 'true';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 8000);
const SNI = 'www.google.com';

// Candidate Google IPs that proxy Cloud Run via Host header
const CANDIDATES = [
  { ip: '216.58.198.46',  label: 'Milan-1 (current)' },
  { ip: '216.58.198.45',  label: 'Milan-2' },
  { ip: '216.58.198.44',  label: 'Milan-3' },
  { ip: '216.58.198.47',  label: 'Milan-4' },
  { ip: '216.58.198.48',  label: 'Milan-5' },
  { ip: '216.58.198.42',  label: 'Milan-6' },
  { ip: '216.58.198.50',  label: 'Milan-7' },
  { ip: '216.58.198.144', label: 'Frankfurt-1' },
  { ip: '216.58.198.145', label: 'Frankfurt-2' },
  { ip: '216.58.198.150', label: 'Frankfurt-3' },
  { ip: '216.58.198.140', label: 'Frankfurt-4' },
  { ip: '74.125.24.100',  label: 'Google-EU-1' },
  { ip: '74.125.24.113',  label: 'Google-EU-2' },
  { ip: '74.125.68.100',  label: 'Google-EU-3' },
  { ip: '172.217.18.100', label: 'Google-EU-4' },
  { ip: '172.217.22.100', label: 'Google-EU-5' },
  { ip: '216.58.209.68',  label: 'Google-EU-6' },
];

// Test using germany8 as reference (always warm)
const panel = await getPanelSettings();
const servers = (await listServers()).filter(
  s => s.enabled !== false && s.cloudRunProfileId === 'gcp-euphoric'
);
const refServer = servers.find(s => s.service === 'germany8') || servers[0];
if (!refServer) { console.error('No reference server found'); process.exit(1); }
const cloudHost = String(refServer.host || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

console.log(JSON.stringify({ refServer: refServer.service, cloudHost, sni: SNI, testing: CANDIDATES.length }));

function probeMasked(ip) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    const timer = setTimeout(() => {
      finish({ ip, ok: false, error: 'timeout', ms: Date.now() - started });
    }, TIMEOUT_MS);

    const socket = tls.connect({
      host: ip, port: 443, servername: SNI,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: true,
      timeout: TIMEOUT_MS,
    }, () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${cloudHost}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });

    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      const firstLine = data.split('\r\n')[0] || '';
      const status = Number((firstLine.match(/HTTP\/\d(?:\.\d)? (\d+)/) || [])[1] || 0);
      if (status > 0) {
        clearTimeout(timer);
        const ok = [101, 400, 426].includes(status);
        finish({ ip, ok, status, ms: Date.now() - started, line: firstLine });
        socket.destroy();
      }
    });
    socket.on('error', (err) => { clearTimeout(timer); finish({ ip, ok: false, error: err.message, ms: Date.now() - started }); });
    socket.on('timeout', () => { clearTimeout(timer); socket.destroy(); finish({ ip, ok: false, error: 'timeout', ms: Date.now() - started }); });
  });
}

const results = [];
for (const c of CANDIDATES) {
  const r = await probeMasked(c.ip);
  results.push({ ...c, ...r });
  const mark = r.ok ? '✓ OK' : `✗ ${r.error || r.status}`;
  console.log(`${mark}\t${c.ip}\t${r.ms}ms\t${c.label}`);
}

const working = results.filter(r => r.ok).sort((a, b) => a.ms - b.ms);
console.log('\n=== RESULTS ===');
console.log(JSON.stringify({ working: working.map(r => ({ ip: r.ip, label: r.label, ms: r.ms })) }));

if (!working.length) {
  console.error('No working masked IPs found from VPS network');
  process.exit(1);
}

const best = working[0];
const currentIp = panel.addressIps?.[0];
console.log(JSON.stringify({ currentIp, bestIp: best.ip, label: best.label, ms: best.ms }));

if (!APPLY) {
  console.log('Run with APPLY=true to apply the best IP');
  process.exit(0);
}

// Apply to panel + all servers
await updatePanelSettings({ addressIps: [best.ip], connectionMode: 'masked' });
for (const s of servers) {
  await updateServer(s.id, { addressIp: best.ip, updatedAt: nowIso() });
}

// Refresh subscriptions
const users = await listUsers();
let refreshed = 0;
for (const u of users) { await upsertUserSubscriptionFile(u); refreshed++; }

console.log(JSON.stringify({ applied: best.ip, connectionMode: 'masked', serversUpdated: servers.length, subscriptionsRefreshed: refreshed, done: true }));
