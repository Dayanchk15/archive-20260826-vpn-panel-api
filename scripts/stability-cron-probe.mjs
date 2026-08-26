#!/usr/bin/env node
/**
 * Read-only stability cron: probe 8 active relays + prewarm cold nodes.
 * No deploy, no recreate, no subscription refresh — safe for live sessions.
 */
import { listServers } from '/app/lib/db-store.js';
import { getPanelSettings } from '/app/lib/settings.js';
import { probeMaskedTls } from '/app/lib/masked-tls-probe.js';
import { saveRelayHealthFromProbes } from '/app/lib/relay-health.js';

const ACTIVE = new Set([
  'gcp2-eu-nl',
  'gcp2-eu-de',
  'gcp2-eu-am',
  'gcp2-eu-gb',
  'gcp2-eu-de2',
  'gcp2-eu-fr1',
  'gcp2-eu-fr2',
  'gcp2-usa',
]);

/** Cold nodes — extra probe keeps instances warm without min=1. */
const COLD_PREWARM = new Set(['gcp2-eu-am', 'gcp2-eu-gb', 'gcp2-eu-fr2']);

const WARM_CRITICAL = new Set(['gcp2-eu-nl', 'gcp2-eu-de', 'gcp2-eu-de2', 'gcp2-eu-fr1', 'gcp2-usa']);

const panel = await getPanelSettings();
const maskedIp = String(panel.addressIps?.[0] || '216.58.198.50').trim();
const servers = (await listServers()).filter((s) => ACTIVE.has(String(s.id)));

const probes = [];
for (const s of servers) {
  const p = await probeMaskedTls(s, maskedIp, 20000);
  probes.push({
    id: s.id,
    region: s.region,
    min: s.minInstances ?? 0,
    ok: p.ok,
    status: p.status,
    ms: p.ms,
    error: p.error || null,
  });
  await new Promise((r) => setTimeout(r, 2500));
  if (COLD_PREWARM.has(s.id)) {
    await new Promise((r) => setTimeout(r, 3000));
    const p2 = await probeMaskedTls(s, maskedIp, 20000);
    probes.push({
      id: s.id,
      region: s.region,
      min: s.minInstances ?? 0,
      pass: 'prewarm',
      ok: p2.ok,
      status: p2.status,
      ms: p2.ms,
      error: p2.error || null,
    });
  }
}

const pingOk = [...new Set(probes.filter((p) => p.ok && !p.pass).map((p) => p.id))];
const pingFail = probes.filter((p) => !p.ok && !p.pass);
const warmFail = pingFail.filter((p) => WARM_CRITICAL.has(p.id));

const out = {
  ts: new Date().toISOString(),
  maskedIp,
  pingOk,
  pingFail: pingFail.map((p) => ({ id: p.id, status: p.status, error: p.error, ms: p.ms })),
  warmCriticalFail: warmFail.map((p) => p.id),
  all8Ok: pingOk.length === 8,
  probes,
};

const health = await saveRelayHealthFromProbes(probes);
out.healthUpdatedAt = health.updatedAt;

console.log(JSON.stringify(out));

if (warmFail.length) {
  console.error(
    `[ALERT] warm relay probe fail: ${warmFail.map((p) => p.id).join(', ')} — manual fix only (no auto-recreate)`
  );
  process.exitCode = 1;
}
