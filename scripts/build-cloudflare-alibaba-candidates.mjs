#!/usr/bin/env node
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((value) => {
    const [key, ...rest] = value.replace(/^--/, '').split('=');
    return [key, rest.join('=')];
  })
);
const out = path.resolve(args.out || 'tmp/cf-alibaba-candidates');
const cloudflareLimit = positiveInt(args.cloudflareLimit || args['cloudflare-limit'], 1600);
const alibabaLimit = positiveInt(args.alibabaLimit || args['alibaba-limit'], 6000);

const cloudflareHosts = ['fr1.levospeed.online', 'fr2.levospeed.online', 'fornex.levospeed.online', 'tampa.levospeed.online'];
const alibabaHosts = ['cdn-a1.levospeed.click', 'cdn-a2.levospeed.click', 'cdn-a3.levospeed.click', 'cdn-a4.levospeed.click'];
const cloudflareUrl = 'https://www.cloudflare.com/ips-v4/';
const alibabaUrl = 'https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS24429';

const [cloudflareText, alibabaDoc, cloudflareDns, alibabaDns] = await Promise.all([
  fetchText(cloudflareUrl),
  fetchJson(alibabaUrl),
  resolveHosts(cloudflareHosts),
  resolveHosts(alibabaHosts),
]);

const cloudflarePrefixes = unique(
  cloudflareText.split(/\s+/).filter((value) => /^\d+(?:\.\d+){3}\/\d+$/.test(value))
);
const alibabaPrefixes = unique(
  (alibabaDoc?.data?.prefixes || [])
    .map((row) => String(row.prefix || '').trim())
    .filter((value) => /^\d+(?:\.\d+){3}\/\d+$/.test(value))
);

const cloudflareCandidates = buildCandidates(cloudflarePrefixes, cloudflareDns, cloudflareLimit);
const alibabaCandidates = buildCandidates(alibabaPrefixes, alibabaDns, alibabaLimit);
fs.mkdirSync(out, { recursive: true });
writeLines('cloudflare-prefixes.txt', cloudflarePrefixes);
writeLines('cloudflare-candidates.txt', cloudflareCandidates);
writeLines('alibaba-prefixes.txt', alibabaPrefixes);
writeLines('alibaba-candidates.txt', alibabaCandidates);

const manifest = {
  generatedAt: new Date().toISOString(),
  sources: {
    cloudflare: { url: cloudflareUrl, type: 'official-ip-list' },
    alibaba: { url: alibabaUrl, type: 'RIPEstat-announced-prefixes', asn: 'AS24429' },
  },
  providers: {
    cloudflare: { prefixes: cloudflarePrefixes.length, dnsIps: cloudflareDns, candidates: cloudflareCandidates.length },
    alibaba: { prefixes: alibabaPrefixes.length, dnsIps: alibabaDns, candidates: alibabaCandidates.length },
  },
};
fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, out, ...manifest }, null, 2));

function buildCandidates(prefixes, dnsIps, limit) {
  const selected = [];
  const seen = new Set();
  const push = (ip) => {
    if (selected.length >= limit || !isIpv4(ip) || seen.has(ip)) return;
    seen.add(ip);
    selected.push(ip);
  };
  dnsIps.forEach(push);

  // Round-robin through every prefix. This keeps geographic/network diversity
  // when an ASN announces many ranges and the scan limit is bounded.
  const offsets = [1, 2, 4, 8, 16, 31, 42, 61, 76, 100, 106, 111, 128, 133, 160, 189, 194, 220, 240, 250];
  const parsed = prefixes.map(parseCidr).filter(Boolean);
  for (const wanted of offsets) {
    for (const cidr of parsed) {
      const max = cidr.size > 2 ? cidr.size - 2 : cidr.size - 1;
      push(intToIp((cidr.network + Math.min(Math.max(1, wanted), max)) >>> 0));
      if (selected.length >= limit) return selected;
    }
  }
  for (let round = 1; selected.length < limit && round <= 64; round += 1) {
    for (const cidr of parsed) {
      const max = cidr.size > 2 ? cidr.size - 2 : cidr.size - 1;
      const offset = Math.max(1, Math.floor((max * round) / 65));
      push(intToIp((cidr.network + offset) >>> 0));
      if (selected.length >= limit) return selected;
    }
  }
  return selected;
}

function parseCidr(value) {
  const [ip, lengthText] = value.split('/');
  const length = Number(lengthText);
  if (!isIpv4(ip) || !Number.isInteger(length) || length < 8 || length > 31) return null;
  const size = 2 ** (32 - length);
  const start = ipToInt(ip);
  return { network: (start - (start % size)) >>> 0, size };
}

async function resolveHosts(hosts) {
  const values = [];
  for (const host of hosts) {
    try { values.push(...(await dns.resolve4(host))); } catch {}
  }
  return unique(values.filter(isIpv4));
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function writeLines(name, values) {
  fs.writeFileSync(path.join(out, name), values.length ? `${values.join('\n')}\n` : '');
}
function unique(values) { return [...new Set(values)]; }
function positiveInt(value, fallback) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : fallback; }
function isIpv4(value) { const parts = String(value).split('.'); return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255); }
function ipToInt(ip) { return ip.split('.').map(Number).reduce((value, octet) => ((value << 8) | octet) >>> 0, 0); }
function intToIp(value) { return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.'); }
