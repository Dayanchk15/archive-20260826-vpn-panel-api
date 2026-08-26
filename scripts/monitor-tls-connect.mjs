#!/usr/bin/env node
/**
 * Cron: masked TLS probe euphoric nodes (same path as Happ client).
 * Alerts only after PROBE_ALERT_CONSECUTIVE failures in a row (default 2).
 */
import { listServers } from '../lib/db-store.js';
import { getPanelSettings } from '../lib/settings.js';
import { probeMaskedTlsWithRetry } from '../lib/masked-tls-probe.js';
import { evaluateProbeAlerts } from '../lib/tls-probe-alert.js';
import { acquireScriptLock } from '../lib/script-lock.mjs';

const lock = acquireScriptLock('heavy-vpn-ops');
if (!lock.ok) {
  console.log(JSON.stringify({ skipped: true, reason: 'heavy-vpn-ops lock held' }));
  process.exit(0);
}
process.on('exit', () => lock.release());

const warmOnly = process.env.PROBE_WARM_ONLY !== 'false';
const delayMs = Number(process.env.PROBE_DELAY_MS || 3000);
const consecutiveRequired = Number(process.env.PROBE_ALERT_CONSECUTIVE || 2);

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

const panel = await getPanelSettings();
const panelIp = panel.addressIps?.[0] || '216.58.198.50';

let servers = (await listServers()).filter(
  (s) => s.enabled !== false && s.cloudRunProfileId === 'gcp-euphoric' && s.host
);
if (warmOnly) {
  servers = servers.filter((s) => Number(s.minInstances ?? 0) >= 1);
}

const results = [];
for (let i = 0; i < servers.length; i++) {
  const server = servers[i];
  if (i > 0 && delayMs > 0) await sleep(delayMs);
  const ip = String(server.addressIp || panelIp).trim() || panelIp;
  const warm = Number(server.minInstances ?? 0) >= 1;
  const result = await probeMaskedTlsWithRetry(server, ip, {
    attempts: warm ? 2 : 1,
    retryDelayMs: 8000,
    timeoutMs: 15000,
  });
  results.push({ service: server.service, ip, warm, ...result });
  console.log(JSON.stringify(results[results.length - 1]));
}

const bad = results.filter((r) => !r.ok);
const evaluation = evaluateProbeAlerts(results, { consecutiveRequired });

if (evaluation.shouldAlert) {
  try {
    const { alertTlsProbeFailures } = await import('../lib/telegram-alert.js');
    await alertTlsProbeFailures({ ...evaluation, consecutiveRequired });
  } catch {
    /* optional */
  }
}

if (evaluation.shouldRecover) {
  try {
    const { alertTlsProbeRecovered } = await import('../lib/telegram-alert.js');
    await alertTlsProbeRecovered(evaluation);
  } catch {
    /* optional */
  }
}

console.log(
  JSON.stringify({
    ok: bad.length === 0,
    panelIp,
    probed: servers.map((s) => s.service),
    bad: bad.map((b) => b.service),
    alertNow: evaluation.alertItems.map((a) => a.service),
    recovered: evaluation.recovered.map((r) => r.service),
    consecutiveRequired,
  })
);
process.exit(bad.length ? 1 : 0);
