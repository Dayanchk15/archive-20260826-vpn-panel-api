#!/usr/bin/env node
/**
 * Build candidate Bunny/BunnyWay IP lists from live public sources:
 * - RIPE Stat announced-prefixes for AS200325
 * - official Bunny edge list
 * - current A records of the subscription domain
 *
 * Outputs:
 * - tmp/bunny-as200325-prefixes.txt
 * - tmp/bunny-as200325-sampled-ips.txt
 * - tmp/bunny-all-candidates-merged.txt
 */
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';

const domain = String(process.argv[2] || 'levospeed.it.com').trim();
const officialUrl = 'https://bunnycdn.com/api/system/edgeserverlist/plain';
const ripeUrl = 'https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS200325';

const tmp = path.join(process.cwd(), 'tmp');
fs.mkdirSync(tmp, { recursive: true });

const ripePath = path.join(tmp, 'bunny-asn-ripe-stat.json');
const officialPath = path.join(tmp, 'bunny-all-ips.txt');

const [officialResult, ripeResult, dnsResult] = await Promise.allSettled([
  fetchText(officialUrl),
  fetchJson(ripeUrl),
  dns.resolve4(domain),
]);

if (officialResult.status === 'fulfilled') {
  const liveIps = parseIps(officialResult.value);
  if (liveIps.length) fs.writeFileSync(officialPath, `${liveIps.join('\n')}\n`);
}

if (ripeResult.status === 'fulfilled') {
  fs.writeFileSync(ripePath, JSON.stringify(ripeResult.value, null, 2));
}

const dnsIps = dnsResult.status === 'fulfilled' ? uniqueValidIps(dnsResult.value) : [];

const prefixes = new Set();

if (fs.existsSync(ripePath)) {
  const doc = JSON.parse(fs.readFileSync(ripePath, 'utf8'));
  for (const row of doc?.data?.prefixes || []) {
    const p = row.prefix || row.prefix_v4 || row.prefix_v6;
    if (typeof p === 'string' && p.includes('.') && p.includes('/')) prefixes.add(p);
  }
}

const prefixList = [...prefixes].sort(cidrSort);
fs.writeFileSync(path.join(tmp, 'bunny-as200325-prefixes.txt'), prefixList.join('\n') + '\n');

const sampled = new Set();
for (const cidr of prefixList) {
  for (const ip of sampleCidr(cidr)) sampled.add(ip);
}

const sampledList = [...sampled].sort(ipSort);
fs.writeFileSync(path.join(tmp, 'bunny-as200325-sampled-ips.txt'), sampledList.join('\n') + '\n');

const officialIps = [];
if (fs.existsSync(officialPath)) {
  for (const line of fs.readFileSync(officialPath, 'utf8').split(/\s+/)) {
    if (isValidIpv4(line.trim())) officialIps.push(line.trim());
  }
}

// Preserve priority. A limited scan must always test the current DNS answer and
// the official edge inventory before the much larger ASN expansion.
const knownGood = ['138.199.37.232', '138.199.36.9', '89.187.188.228', '89.187.162.249', '84.17.59.119', '94.20.154.22'];
const mergedList = uniqueValidIps([...dnsIps, ...knownGood, ...officialIps, ...sampledList]);
fs.writeFileSync(path.join(tmp, 'bunny-all-candidates-merged.txt'), mergedList.join('\n') + '\n');
fs.writeFileSync(path.join(tmp, 'bunny-subscription-candidates.txt'), mergedList.join('\n') + '\n');

const metadata = {
  generatedAt: new Date().toISOString(),
  domain,
  dnsIps,
  officialSource: officialUrl,
  officialSourceLive: officialResult.status === 'fulfilled',
  ripeSource: ripeUrl,
  ripeSourceLive: ripeResult.status === 'fulfilled',
  ipv4Prefixes: prefixList.length,
  officialIps: uniqueValidIps(officialIps).length,
  sampledIps: sampledList.length,
  mergedCandidates: mergedList.length,
};
fs.writeFileSync(path.join(tmp, 'bunny-subscription-candidates.meta.json'), JSON.stringify(metadata, null, 2));

console.log(
  JSON.stringify(
    {
      ok: true,
      domain,
      dnsIps,
      officialIps: uniqueValidIps(officialIps).length,
      prefixes: prefixList.length,
      sampledIps: sampledList.length,
      mergedCandidates: mergedList.length,
      files: {
        prefixes: path.join(tmp, 'bunny-as200325-prefixes.txt'),
        sampledIps: path.join(tmp, 'bunny-as200325-sampled-ips.txt'),
        mergedCandidates: path.join(tmp, 'bunny-all-candidates-merged.txt'),
        subscriptionCandidates: path.join(tmp, 'bunny-subscription-candidates.txt'),
        metadata: path.join(tmp, 'bunny-subscription-candidates.meta.json'),
      },
    },
    null,
    2
  )
);

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function parseIps(text) {
  return uniqueValidIps(String(text).match(/(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g) || []);
}

function uniqueValidIps(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(isValidIpv4))];
}

function isValidIpv4(value) {
  const parts = String(value).split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function sampleCidr(cidr) {
  const [base, lenText] = cidr.split('/');
  const len = Number(lenText);
  if (!Number.isFinite(len) || len < 0 || len > 32) return [];
  const start = ipToInt(base);
  const size = 2 ** (32 - len);
  const network = start & mask(len);
  const firstHost = size <= 2 ? network : network + 1;
  const lastHost = size <= 2 ? network + size - 1 : network + size - 2;

  if (size <= 512) {
    const out = [];
    for (let n = firstHost; n <= lastHost; n++) out.push(intToIp(n));
    return out;
  }

  const points = new Set([
    firstHost,
    firstHost + 1,
    firstHost + 2,
    firstHost + 8,
    firstHost + 16,
    firstHost + 32,
    firstHost + 64,
    firstHost + 128,
    network + Math.floor(size * 0.25),
    network + Math.floor(size * 0.5),
    network + Math.floor(size * 0.75),
    lastHost - 128,
    lastHost - 64,
    lastHost - 32,
    lastHost - 16,
    lastHost - 8,
    lastHost - 2,
    lastHost - 1,
    lastHost,
  ]);

  return [...points].filter((n) => n >= firstHost && n <= lastHost).map(intToIp);
}

function mask(len) {
  return len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
}

function ipToInt(ip) {
  return ip
    .split('.')
    .map(Number)
    .reduce((acc, n) => ((acc << 8) + n) >>> 0, 0);
}

function intToIp(n) {
  return [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');
}

function ipSort(a, b) {
  return ipToInt(a) - ipToInt(b);
}

function cidrSort(a, b) {
  const [ipa, la] = a.split('/');
  const [ipb, lb] = b.split('/');
  return ipToInt(ipa) - ipToInt(ipb) || Number(la) - Number(lb);
}
