#!/usr/bin/env node
import { listUsers } from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { isUserActive } from '../lib/active-users.js';

const EDGE_IP = String(process.env.ALIBABA_ESA_EDGE_IP || '163.181.0.194').trim();
const FRONT_SNI = String(process.env.ALIBABA_ESA_FRONT_SNI || 'www.alibaba.com').trim();
const DOMAIN = String(process.env.ALIBABA_ESA_DOMAIN || 'levospeed.click').trim();

const EXPECTED = [
  { host: `cdn-a1.${DOMAIN}`, path: '/media/v4/fr1/sync' },
  { host: `cdn-a2.${DOMAIN}`, path: '/media/v4/fr2/sync' },
  { host: `cdn-a3.${DOMAIN}`, path: '/media/v4/fornex/sync' },
  { host: `cdn-a4.${DOMAIN}`, path: '/media/v4/tampa/sync' },
];

function plainContent(value) {
  const text = String(value || '');
  if (text.includes('vless://')) return text;
  try {
    return Buffer.from(text, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function parseLines(body) {
  return plainContent(body)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('vless://'))
    .map((line) => {
      try {
        const url = new URL(line);
        const remark = decodeURIComponent(line.split('#', 2)[1] || '');
        return {
          address: url.hostname,
          port: url.port,
          type: url.searchParams.get('type'),
          host: url.searchParams.get('host'),
          path: url.searchParams.get('path'),
          sni: url.searchParams.get('sni'),
          alpn: url.searchParams.get('alpn'),
          mode: url.searchParams.get('mode'),
          remark,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function isAlibaba(line) {
  return (
    line.address === EDGE_IP &&
    line.port === '443' &&
    line.sni === FRONT_SNI &&
    EXPECTED.some((item) => item.host === line.host && item.path === line.path)
  );
}

const users = (await listUsers(10000)).filter(isUserActive);
const daykoo = users.find((user) => String(user.name || '').trim().toLowerCase() === 'daykoo vip');
if (!daykoo?.uuid) throw new Error('Daykoo VIP active user with UUID was not found');

const summaries = [];
let otherUsersWithAlibaba = 0;
for (const user of users) {
  const lines = parseLines(await buildUserSubscriptionBody(user));
  const ali = lines.filter(isAlibaba);
  if (String(user.id) === String(daykoo.id)) {
    summaries.push(...ali.map(({ address, port, type, host, path, sni, alpn, mode, remark }) => ({
      address,
      port,
      type,
      host,
      path,
      sni,
      alpn,
      mode,
      remark,
    })));
  } else if (ali.length > 0) {
    otherUsersWithAlibaba += 1;
  }
}

const missing = EXPECTED.filter((expected) =>
  !summaries.some((line) =>
    line.type === 'xhttp' &&
    line.host === expected.host &&
    line.path === expected.path &&
    line.address === EDGE_IP &&
    line.port === '443' &&
    line.sni === FRONT_SNI &&
    line.alpn === 'h2' &&
    line.mode === 'packet-up'
  )
);

console.log(JSON.stringify({
  ok: missing.length === 0 && otherUsersWithAlibaba === 0,
  user: { id: daykoo.id, name: daykoo.name },
  daykooAlibabaLines: summaries.length,
  otherUsersWithAlibaba,
  missing,
  summaries,
}, null, 2));

if (missing.length > 0 || otherUsersWithAlibaba > 0) process.exit(1);
