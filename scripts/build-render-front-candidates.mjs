#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const output = path.resolve(process.argv[2] || 'ops/ip-lists/render-as397273-candidates.txt');
const metadataOutput = output.replace(/\.txt$/i, '.json');
const sourceUrl = 'https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS397273';
const fallbackPrefixes = ['216.24.57.0/24', '74.220.56.0/24'];

let prefixes = fallbackPrefixes;
let liveSource = false;
try {
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  const live = (payload?.data?.prefixes || [])
    .map((row) => String(row.prefix || '').trim())
    .filter((value) => /^\d+(?:\.\d+){3}\/\d+$/.test(value));
  if (live.length) {
    prefixes = [...new Set(live)];
    liveSource = true;
  }
} catch (error) {
  console.warn(`RIPEstat unavailable; using bundled AS397273 prefixes: ${error.message}`);
}

const ips = [];
for (const cidr of prefixes) ips.push(...expandUsable(cidr));
const uniqueIps = [...new Set(ips)];
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${uniqueIps.join('\n')}\n`);
fs.writeFileSync(metadataOutput, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  sourceUrl,
  liveSource,
  asn: 'AS397273',
  provider: 'Render',
  prefixes,
  candidates: uniqueIps.length,
  knownWorking: '216.24.57.1',
  requiredProtocol: 'VLESS WS TLS / HTTP 101',
}, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, output, metadataOutput, liveSource, prefixes, candidates: uniqueIps.length }, null, 2));

function expandUsable(cidr) {
  const [base, lengthText] = cidr.split('/');
  const length = Number(lengthText);
  if (!Number.isInteger(length) || length < 16 || length > 30) return [];
  const size = 2 ** (32 - length);
  const baseInt = ipToInt(base);
  const network = baseInt - (baseInt % size);
  const out = [];
  for (let offset = 1; offset < size - 1; offset += 1) out.push(intToIp((network + offset) >>> 0));
  return out;
}
function ipToInt(ip) { return ip.split('.').map(Number).reduce((value, octet) => ((value << 8) | octet) >>> 0, 0); }
function intToIp(value) { return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.'); }
