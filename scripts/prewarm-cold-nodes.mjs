#!/usr/bin/env node
/**
 * Pre-warm cold Cloud Run nodes via masked TLS probe (euphoric + soppy).
 * PREWARM_PEAK_ONLY=true — only during peak hours (Asia/Ashgabat by default).
 * Run every 8 min from cron.
 */
import { listServers } from '../lib/db-store.js';
import { getPanelSettings } from '../lib/settings.js';
import { probeMaskedTlsWithRetry } from '../lib/masked-tls-probe.js';
import { sendTelegramAlert } from '../lib/telegram-alert.js';

const GAP_MS = Number(process.env.PREWARM_GAP_MS || 3000);
const TIMEOUT_MS = Number(process.env.PREWARM_TIMEOUT_MS || 20000);

function isPeakHour() {
  if (process.env.PREWARM_PEAK_ONLY !== 'true') return true;
  const tz = process.env.PREWARM_TIMEZONE || 'Asia/Ashgabat';
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(
      new Date()
    )
  );
  const ranges = String(process.env.PREWARM_PEAK_HOURS || '6-11,17-23')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const range of ranges) {
    const [start, end] = range.split('-').map((v) => Number(v.trim()));
    if (Number.isFinite(start) && Number.isFinite(end) && hour >= start && hour <= end) {
      return true;
    }
  }
  return false;
}

const panel = await getPanelSettings();
const panelIps = panel.addressIps?.length ? panel.addressIps : ['216.58.198.50'];

if (!isPeakHour()) {
  console.log(JSON.stringify({ skipped: true, reason: 'off-peak', peakOnly: true }));
  process.exit(0);
}

const servers = (await listServers()).filter(
  (s) =>
    s.enabled !== false &&
    s.host &&
    (s.cloudRunProfileId === 'gcp-euphoric' || s.cloudRunProfileId === 'gcp-soppy')
);

const warm = servers.filter((s) => Number(s.minInstances ?? 0) >= 1);
const cold = servers.filter((s) => Number(s.minInstances ?? 0) < 1);

console.log(
  JSON.stringify({
    warm: warm.map((s) => s.service),
    cold: cold.map((s) => s.service),
    panelIps,
    peakOnly: process.env.PREWARM_PEAK_ONLY === 'true',
  })
);

const failed = [];
for (let i = 0; i < cold.length; i += 1) {
  if (i > 0) await new Promise((r) => setTimeout(r, GAP_MS));
  const s = cold[i];
  const ip = s.addressIp || panelIps[i % panelIps.length];
  const r = await probeMaskedTlsWithRetry(s, ip, {
    attempts: 2,
    retryDelayMs: 6000,
    timeoutMs: TIMEOUT_MS,
  });
  const status = r.ok ? 'warm' : r.status === 429 ? 'starting' : 'fail';
  console.log(JSON.stringify({ service: s.service, profile: s.cloudRunProfileId, ip, status, ms: r.ms, code: r.status || r.error }));
  if (!r.ok && r.status !== 429) failed.push(s.service);
}

if (failed.length) {
  try {
    await sendTelegramAlert(`⚠️ Pre-warm failed (not 429): ${failed.join(', ')}`);
  } catch {
    /* optional */
  }
}

console.log(JSON.stringify({ done: true, coldTotal: cold.length, failed: failed.length, failedServices: failed }));
process.exit(failed.length ? 1 : 0);
