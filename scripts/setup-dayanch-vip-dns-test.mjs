#!/usr/bin/env node
/**
 * Add DNS-test node (germany18) as 8th line ONLY for Dayanch VIP.
 * Keeps 7-server pool for VIP; other clients unchanged.
 */
import { listUsers, listServers, updateUser } from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { buildAutoSubscription } from '../lib/subscription.js';
import { getPanelSettings } from '../lib/settings.js';
import { nowIso } from '../lib/dates.js';

const VIP_NAME_MATCH = /dayanch\s*vip/i;
const DNS_TEST_SERVICE = process.env.DNS_TEST_SERVICE || 'germany18';

const servers = await listServers();
const dnsServer = servers.find((s) => s.service === DNS_TEST_SERVICE);
if (!dnsServer) {
  console.log(JSON.stringify({ ok: false, error: `${DNS_TEST_SERVICE} not found` }));
  process.exit(1);
}
if (!dnsServer.xrayDnsSniffTest) {
  console.log(
    JSON.stringify({
      ok: false,
      error: `${DNS_TEST_SERVICE} is not marked xrayDnsSniffTest — run deploy-dns-test-germany18.mjs first`,
    })
  );
  process.exit(1);
}

const users = await listUsers();
const vip = users.find((u) => VIP_NAME_MATCH.test(String(u.name || '').trim()));
if (!vip) {
  console.log(JSON.stringify({ ok: false, error: 'Dayanch VIP not found' }));
  process.exit(1);
}

const bonusServerIds = [String(dnsServer.id)];
await updateUser(vip.id, {
  bonusServerIds,
  updatedAt: nowIso(),
});

const fresh = {
  ...vip,
  bonusServerIds,
  addressIps: vip.addressIps,
};
await upsertUserSubscriptionFile(fresh);

const body = await buildAutoSubscription(fresh);
const lines = body.split('\n').filter((l) => l.startsWith('vless://'));
const panel = await getPanelSettings();

const serversInSub = lines.map((l, i) => {
  const ip = l.match(/@([^:]+):/)?.[1] || '?';
  let name = '?';
  try {
    name = decodeURIComponent((l.split('#')[1] || '').split('?')[0]);
  } catch {
    /* ignore */
  }
  return { index: i + 1, name, connectIp: ip, dnsTest: /dns-test/i.test(name) };
});

const { buildUrlsForUser } = await import('../lib/user-urls.js');
const { getFileByLinkedUserId } = await import('../lib/files.js');
const urls = await buildUrlsForUser(fresh, await getFileByLinkedUserId(vip.id), panel);

console.log(
  JSON.stringify(
    {
      ok: true,
      user: { id: vip.id, name: vip.name },
      bonusServerIds,
      dnsTestService: dnsServer.service,
      vipAddressIps: fresh.addressIps,
      panelDefaultIp: panel.addressIps,
      otherClientsUnchanged: true,
      subscriptionUrl: urls.panelSubscriptionUrl || urls.subscriptionUrl,
      lineCount: lines.length,
      serversInSub,
      happHint: 'Обновить подписку. Сервер «DNS-TEST» — тест DNS/sniffing. Остальные 7 — как раньше.',
    },
    null,
    2
  )
);
