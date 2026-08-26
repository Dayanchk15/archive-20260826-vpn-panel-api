#!/usr/bin/env node
/**
 * Per-client IP rotation (Dayanch VIP): 3 TM Google IPs rotate across subscription servers.
 * Other clients keep panel default IP unchanged.
 */
import net from 'net';
import { listUsers, updateUser } from '../lib/db-store.js';
import { getPanelSettings } from '../lib/settings.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { buildAutoSubscription } from '../lib/subscription.js';
import { nowIso } from '../lib/dates.js';

const VIP_NAME_MATCH = /dayanch\s*vip/i;

/** User-confirmed working in TM + neighbors (exclude .46 — blocked in TM) */
const TM_IP_CANDIDATES = [
  '216.58.198.50',
  '142.250.180.14',
  '216.58.198.45',
  '216.58.198.47',
  '216.58.198.48',
  '216.58.198.42',
  '142.251.39.142',
  '142.251.153.119',
];

const TM_IP_BLOCKLIST = new Set(['216.58.198.46', '172.217.16.142']);

const TIMEOUT_MS = 5000;

function probeTcp(host) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port: 443, timeout: TIMEOUT_MS });
    const finish = (ok, error) => {
      socket.destroy();
      resolve({ ok, ms: Date.now() - started, error });
    };
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false, 'timeout'));
    socket.on('error', (err) => finish(false, err.code || err.message));
  });
}

async function pickWorkingIps() {
  const confirmed = ['216.58.198.50', '142.250.180.14'];
  const thirdFallback = '216.58.198.45';
  const probes = [];
  for (const ip of TM_IP_CANDIDATES) {
    const r = await probeTcp(ip);
    probes.push({ ip, ...r });
  }
  const working = probes.filter((p) => p.ok).map((p) => p.ip);
  const pool = [];
  for (const ip of confirmed) {
    if (!pool.includes(ip)) pool.push(ip);
  }
  if (pool.length < 3 && !pool.includes(thirdFallback)) {
    pool.push(thirdFallback);
  }
  for (const ip of working) {
    if (pool.length >= 3) break;
    if (TM_IP_BLOCKLIST.has(ip)) continue;
    if (!pool.includes(ip)) pool.push(ip);
  }
  while (pool.length < 3 && working.length) {
    const next = working.find((ip) => !pool.includes(ip));
    if (!next) break;
    pool.push(next);
  }
  return { pool: pool.slice(0, 3), probes, working };
}

const users = await listUsers();
const vip = users.find((u) => VIP_NAME_MATCH.test(String(u.name || '').trim()));
if (!vip) {
  const similar = users
    .filter((u) => /dayanch/i.test(String(u.name || '')))
    .map((u) => ({ id: u.id, name: u.name }));
  console.log(JSON.stringify({ ok: false, error: 'Dayanch VIP user not found', similar }, null, 2));
  process.exit(1);
}

const { pool, probes, working } = await pickWorkingIps();
if (pool.length < 2) {
  console.log(JSON.stringify({ ok: false, error: 'Not enough working IPs', probes }, null, 2));
  process.exit(1);
}

await updateUser(vip.id, {
  addressIps: pool,
  updatedAt: nowIso(),
});

const fresh = { ...vip, addressIps: pool };
await upsertUserSubscriptionFile(fresh);

const body = await buildAutoSubscription(fresh);
const lines = body.split('\n').filter((l) => l.startsWith('vless://'));
const servers = lines.map((l, i) => {
  const ip = l.match(/@([^:]+):/)?.[1] || '?';
  let name = '?';
  try {
    name = decodeURIComponent((l.split('#')[1] || '').split('?')[0]);
  } catch {
    /* ignore */
  }
  return { index: i + 1, name, connectIp: ip };
});

const panel = await getPanelSettings();
const { buildUrlsForUser } = await import('../lib/user-urls.js');
const { getFileByLinkedUserId } = await import('../lib/files.js');
const urls = await buildUrlsForUser(fresh, await getFileByLinkedUserId(vip.id), panel);

console.log(
  JSON.stringify(
    {
      ok: true,
      user: { id: vip.id, name: vip.name },
      vipAddressIps: pool,
      panelDefaultIp: panel.addressIps,
      otherClientsUnchanged: true,
      probeFromVps: probes,
      workingFromVps: working,
      subscriptionUrl: urls.panelSubscriptionUrl || urls.subscriptionUrl,
      serversInSub: servers,
      note: 'VIP: each server uses IP from pool by rotation. Others still use panel IP 142.251.39.142',
    },
    null,
    2
  )
);
