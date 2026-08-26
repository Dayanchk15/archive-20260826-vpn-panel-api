#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve(process.argv[2] || 'tmp/alibaba-as24429-sampled.txt');
const asn = String(process.argv[3] || 'AS24429').toUpperCase();
const metadataOut = out.replace(/\.txt$/i, '.json');
if (!/^AS\d+$/.test(asn)) throw new Error(`Invalid ASN: ${asn}`);
const sourceUrl = `https://stat.ripe.net/data/announced-prefixes/data.json?resource=${asn}`;
const response = await fetchWithRetry(sourceUrl, 4);
if (!response.ok) throw new Error(`RIPEstat HTTP ${response.status}`);

const payload = await response.json();
const prefixes = (payload?.data?.prefixes || [])
  .map((row) => String(row.prefix || '').trim())
  .filter((prefix) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(prefix));

const preferredOffsets = [194, 173, 197, 137, 252, 2, 8, 20];
const addresses = [];
for (const prefix of prefixes) {
  const [networkText, lengthText] = prefix.split('/');
  const length = Number(lengthText);
  if (length < 8 || length > 30) continue;

  const network = ipv4ToUint(networkText);
  const size = 2 ** (32 - length);
  const usableMax = Math.max(1, size - 2);
  for (const wanted of preferredOffsets) {
    const offset = Math.min(Math.max(1, wanted), usableMax);
    addresses.push(uintToIpv4((network + offset) >>> 0));
  }
}

const unique = [...new Set(addresses)];
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${unique.join('\n')}\n`);
fs.writeFileSync(
  metadataOut,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: `RIPEstat announced-prefixes ${asn}`,
      sourceUrl,
      asn,
      prefixCount: prefixes.length,
      samplesPerPrefix: preferredOffsets.length,
      candidateCount: unique.length,
      output: out,
    },
    null,
    2
  )
);

console.log(JSON.stringify({ asn, out, metadataOut, prefixCount: prefixes.length, candidateCount: unique.length }, null, 2));

function ipv4ToUint(ip) {
  return ip.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function uintToIpv4(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

async function fetchWithRetry(url, attempts) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  throw lastError;
}
