#!/usr/bin/env node
/**
 * Curl relay Cloud Run hosts — flag HTTP 429/503 and slow responses.
 *
 *   node scripts/relay-perf-monitor.mjs
 *   RELAY_HOSTS=relay-eu-nl-xxx.run.app,tampa-relay-xxx.run.app node scripts/relay-perf-monitor.mjs
 */
import { listServers } from '../lib/db-store.js';
import { isRelaySubscriptionServer } from '../lib/relay-subscription.js';

const TIMEOUT_MS = Math.max(3000, Number(process.env.RELAY_PROBE_TIMEOUT_MS || 12000));
const SLOW_MS = Math.max(1000, Number(process.env.RELAY_PROBE_SLOW_MS || 5000));

async function probeHost(host) {
  const url = `https://${host.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/health`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const elapsedMs = Date.now() - started;
    const body = await res.text().catch(() => '');
    return {
      host,
      ok: res.ok,
      status: res.status,
      elapsedMs,
      slow: elapsedMs >= SLOW_MS,
      rateLimited: res.status === 429,
      unavailable: res.status === 503,
      bodyPreview: body.slice(0, 120),
    };
  } catch (err) {
    return {
      host,
      ok: false,
      status: 0,
      elapsedMs: Date.now() - started,
      error: err.name === 'AbortError' ? `timeout ${TIMEOUT_MS}ms` : err.message || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

let hosts = String(process.env.RELAY_HOSTS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!hosts.length) {
  const servers = await listServers();
  hosts = servers
    .filter((s) => s.enabled !== false && isRelaySubscriptionServer(s) && s.host)
    .map((s) => String(s.host).trim())
    .filter(Boolean);
}

if (!hosts.length) {
  console.error('No relay hosts found (set RELAY_HOSTS or configure relay servers in panel)');
  process.exit(1);
}

const results = [];
for (const host of hosts) {
  const result = await probeHost(host);
  results.push(result);
  console.log(JSON.stringify({ step: 'probe', ...result }));
}

const bad = results.filter(
  (r) => !r.ok || r.rateLimited || r.unavailable || r.slow || r.status === 429 || r.status === 503
);

console.log(
  JSON.stringify(
    {
      ok: bad.length === 0,
      probed: results.length,
      badCount: bad.length,
      bad: bad.map((r) => ({
        host: r.host,
        status: r.status,
        elapsedMs: r.elapsedMs,
        rateLimited: r.rateLimited,
        unavailable: r.unavailable,
      })),
      results,
    },
    null,
    2
  )
);
process.exit(bad.length === 0 ? 0 : 1);
