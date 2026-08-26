#!/usr/bin/env node
/**
 * DNS-TEST 8th line: move to proven warm neth8 (NL) — germany18/dns-sniff times out from TM.
 * Reverts germany18 to cold + standard image. Only Dayanch VIP gets 8th line on neth8.
 */
import { listServers, listUsers, updateServer, getServerById } from '../lib/db-store.js';
import { applyCloudRunServerPanelState } from '../lib/vpn-edge-sync.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { buildAutoSubscription } from '../lib/subscription.js';
import { probeMaskedTlsWithRetry } from '../lib/masked-tls-probe.js';
import { nowIso } from '../lib/dates.js';

const VIP_MATCH = /dayanch\s*vip/i;
const BONUS_SERVICE = 'neth8';
const DNS_TEST_IP = '216.58.198.50';

const servers = await listServers();
const bonus = servers.find((s) => s.service === BONUS_SERVICE);
const germany18 = servers.find((s) => s.service === 'germany18');

if (!bonus) {
  console.log(JSON.stringify({ ok: false, error: 'neth8 not found' }));
  process.exit(1);
}

await updateServer(bonus.id, {
  dnsTestLabel: '🇳🇱 Netherlands DNS-TEST',
  dnsTestNode: true,
  updatedAt: nowIso(),
});

if (germany18) {
  await updateServer(germany18.id, {
    minInstances: 0,
    maxInstances: 2,
    xrayDnsSniffTest: false,
    dnsTestNode: false,
    edgeImageTag: null,
    newUsersOnly: true,
    updatedAt: nowIso(),
  });
  try {
    const g18 = await getServerById(germany18.id);
    await applyCloudRunServerPanelState({ ...g18, minInstances: 0, edgeImageTag: 'latest', xrayDnsSniffTest: false });
  } catch (err) {
    console.log(JSON.stringify({ germany18RevertWarn: err.message }));
  }
}

const vip = (await listUsers()).find((u) => VIP_MATCH.test(String(u.name || '')));
if (!vip) {
  console.log(JSON.stringify({ ok: false, error: 'Dayanch VIP not found' }));
  process.exit(1);
}

const { updateUser } = await import('../lib/db-store.js');
await updateUser(vip.id, {
  bonusServerIds: [String(bonus.id)],
  updatedAt: nowIso(),
});

const fresh = { ...vip, bonusServerIds: [String(bonus.id)] };
await upsertUserSubscriptionFile(fresh);

const sub = await buildAutoSubscription(fresh);
const lines = sub.split('\n').filter((l) => l.startsWith('vless://'));
const last = lines[lines.length - 1];
const probe = await probeMaskedTlsWithRetry(bonus, DNS_TEST_IP, { attempts: 2, timeoutMs: 25000 });

console.log(
  JSON.stringify(
    {
      ok: probe.ok,
      change: 'DNS-TEST moved from germany18 to warm neth8 (same backend as working NL nodes)',
      bonusService: BONUS_SERVICE,
      germany18: 'reverted to cold + latest image',
      lineCount: lines.length,
      dnsTestLine: {
        remark: last ? decodeURIComponent((last.split('#')[1] || '').split('?')[0]) : null,
        ip: last?.match(/@([^:]+):/)?.[1],
        wsHost: last ? new URL(last).searchParams.get('host') : null,
      },
      probe,
      happHint: 'Обновить подписку. 8-й сервер теперь Netherlands DNS-TEST (neth8 warm).',
    },
    null,
    2
  )
);

process.exit(probe.ok ? 0 : 1);
