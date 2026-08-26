#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const output = path.resolve(String(args.out || 'ops/ip-lists/tencent-edgeone-expanded-current.txt'));
const metadataOutput = output.replace(/\.txt$/i, '.json');
const asns = String(args.asns || 'AS139341,AS132203')
  .split(/[\s,]+/)
  .map((value) => value.trim().toUpperCase())
  .filter((value) => /^AS\d+$/.test(value));
const samplesPerPrefix = Math.max(4, Number(args.samples || 12));
if (!asns.length) throw new Error('No valid ASNs');

const preferredOffsets = [106, 111, 61, 189, 133, 76, 2, 4, 8, 20, 31, 42];
const addresses = [];
const sources = [];

for (const asn of asns) {
  const sourceUrl = `https://stat.ripe.net/data/announced-prefixes/data.json?resource=${asn}`;
  const response = await fetchWithRetry(sourceUrl, 4);
  if (!response.ok) throw new Error(`RIPEstat ${asn} HTTP ${response.status}`);
  const payload = await response.json();
  const prefixes = (payload?.data?.prefixes || [])
    .map((row) => String(row.prefix || '').trim())
    .filter((prefix) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(prefix));

  sources.push({ asn, sourceUrl, ipv4PrefixCount: prefixes.length });
  for (const prefix of prefixes) {
    const [networkText, lengthText] = prefix.split('/');
    const length = Number(lengthText);
    if (length < 8 || length > 30) continue;
    const network = ipv4ToUint(networkText);
    const size = 2 ** (32 - length);
    const usableMax = Math.max(1, size - 2);
    const offsets = [];
    for (const wanted of preferredOffsets.slice(0, Math.min(preferredOffsets.length, samplesPerPrefix))) {
      offsets.push(Math.min(Math.max(1, wanted), usableMax));
    }
    for (let index = 1; offsets.length < samplesPerPrefix; index += 1) {
      const slots = samplesPerPrefix - Math.min(preferredOffsets.length, samplesPerPrefix) + 1;
      offsets.push(Math.min(usableMax, Math.max(1, Math.floor((usableMax * index) / slots))));
    }
    for (const offset of [...new Set(offsets)]) {
      addresses.push(uintToIpv4((network + offset) >>> 0));
    }
  }
}

const unique = [...new Set(addresses)];
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${unique.join('\n')}\n`);
fs.writeFileSync(metadataOutput, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  sources,
  samplesPerPrefix,
  candidateCount: unique.length,
  output,
}, null, 2)}\n`);

console.log(JSON.stringify({ ok: true, output, metadataOutput, sources, samplesPerPrefix, candidateCount: unique.length }, null, 2));

function parseArgs(argv) {
  const result = {};
  for (const item of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(item);
    if (match) result[match[1].replace(/-([a-z])/g, (_all, char) => char.toUpperCase())] = match[2];
  }
  return result;
}

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
