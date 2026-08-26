#!/usr/bin/env node
import { getUserById } from '/app/lib/db-store.js';
import { getFileByLinkedUserId } from '/app/lib/files.js';
import { buildUrlsForUser } from '/app/lib/user-urls.js';

const user = await getUserById(process.argv[2]);
const file = await getFileByLinkedUserId(user.id);
const urls = await buildUrlsForUser(user, file);
const url = urls.panelSubscriptionUrl || urls.subscriptionUrl;

function plain(value) {
  const text = String(value || '');
  if (text.includes('vless://')) return text;
  try { return Buffer.from(text, 'base64').toString('utf8'); } catch { return ''; }
}

const cases = [
  ['happAndroid', 'Happ/2.9 Android'],
  ['happIos', 'Happ/2.9 iOS'],
  ['hiddifyAndroid', 'Hiddify/2.5 Android'],
];
const output = {};
for (const [name, userAgent] of cases) {
  const response = await fetch(url, { headers: { 'user-agent': userAgent }, signal: AbortSignal.timeout(20000) });
  const lines = plain(await response.text()).split(/\r?\n/).filter((line) => line.startsWith('vless://'));
  const bunny = lines.filter((line) => line.includes('.b-cdn.net'));
  const directBunny = bunny.filter((line) => {
    const parsed = new URL(line);
    return parsed.hostname === parsed.searchParams.get('host');
  });
  output[name] = {
    status: response.status,
    links: lines.length,
    cloudflare: lines.filter((line) => line.includes('.levospeed.click')).length,
    bunny: bunny.length,
    directBunny: directBunny.length,
    bunnyWithEarlyData: bunny.filter((line) => decodeURIComponent(line).includes('?ed=2560')).length,
    bunnyWithUdpReject: bunny.filter((line) => line.includes('xudpProxyUDP443=reject')).length,
    bunnyWithFinalMask: bunny.filter((line) => new URL(line).searchParams.has('fm')).length,
    bunnyWithLegacyFragment: bunny.filter((line) =>
      new URL(line).searchParams.get('fragment') === '2,0-1,tlshello'
    ).length,
    cloudflareWithFinalMask: lines.filter((line) =>
      line.includes('.levospeed.click') && new URL(line).searchParams.has('fm')
    ).length,
    cloudflareWithLegacyFragment: lines.filter((line) =>
      line.includes('.levospeed.click') &&
      new URL(line).searchParams.get('fragment') === '2,0-1,tlshello'
    ).length,
    relayWithFinalMask: lines.filter((line) =>
      line.includes('.run.app') && new URL(line).searchParams.has('fm')
    ).length,
  };
}
console.log(JSON.stringify(output, null, 2));
