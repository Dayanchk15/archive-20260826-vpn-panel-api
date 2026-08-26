#!/usr/bin/env node
/**
 * Scan Bunny/Fastly/Tencent EdgeOne/Alibaba ESA edge IPs from the CURRENT network path.
 *
 * Safe by design:
 * - does not change panel, servers, DNS, Caddy, Fastly or Bunny settings
 * - only opens outbound TCP/TLS/HTTP/WebSocket probes
 * - writes a report to tmp/ or the path passed via OUT
 *
 * Typical TM test:
 *   set LOCAL_ADDRESS=172.20.10.2
 *   node scripts/tm-cdn-ip-scan.mjs --provider=all --limit=250
 *
 * If LOCAL_ADDRESS is omitted, the script tries to auto-detect an iPhone/Android
 * USB tether adapter on Windows. If it cannot find one, Windows routing is used.
 */
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));

const PROVIDER = String(args.provider || process.env.PROVIDER || 'all').toLowerCase();
const LIMIT = Number(args.limit || process.env.LIMIT || 350);
const CONCURRENCY = Number(args.concurrency || process.env.CONCURRENCY || 35);
const TIMEOUT_MS = Number(args.timeout || process.env.TIMEOUT_MS || 4500);
const TOP = Number(args.top || process.env.TOP || 25);
const PROGRESS_EVERY = Math.max(1, Number(args.progressEvery || process.env.PROGRESS_EVERY || 25));
const OUT =
  args.out ||
  process.env.OUT ||
  path.join(process.cwd(), 'tmp', `tm-cdn-ip-scan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const FOUND_OUT =
  args.foundOut || process.env.FOUND_OUT || OUT.replace(/\.json$/i, '.found.jsonl');
const FOUND_IPS_OUT =
  args.foundIpsOut || process.env.FOUND_IPS_OUT || OUT.replace(/\.json$/i, '.found.txt');

const LOCAL_ADDRESS = String(args.local || process.env.LOCAL_ADDRESS || detectTetherLocalAddress() || '').trim();

const CLOUDFLARE_HOST = String(
  args.cloudflareHost || process.env.CLOUDFLARE_HOST || 'fr1.levospeed.online'
).trim();
const CLOUDFLARE_PATH = String(args.cloudflarePath || process.env.CLOUDFLARE_PATH || '/').trim();
const CLOUDFLARE_EDGE_LIST = String(
  args.cloudflareEdgeList || process.env.CLOUDFLARE_EDGE_LIST || ''
).trim();
const CLOUDFLARE_STRICT_EDGE_LIST = String(
  args.cloudflareStrictEdgeList || process.env.CLOUDFLARE_STRICT_EDGE_LIST || ''
).toLowerCase() === 'true';

const BUNNY_HOST = String(args.bunnyHost || process.env.BUNNY_HOST || 'levospeedfr2.b-cdn.net').trim();
const BUNNY_PATH = String(args.bunnyPath || process.env.BUNNY_PATH || '/media/v5/fr2/vless').trim();
const BUNNY_EDGE_LIST = String(args.bunnyEdgeList || process.env.BUNNY_EDGE_LIST || '').trim();
const BUNNY_APPLICATION_LIMIT = Number(
  args.bunnyApplicationLimit || process.env.BUNNY_APPLICATION_LIMIT || 220
);

const FASTLY_SNI = String(args.fastlySni || process.env.FASTLY_SNI || 'manage.fastly.com').trim();
const FASTLY_HOST = String(
  args.fastlyHost || process.env.FASTLY_HOST || 'painfully-super-puma.global.ssl.fastly.net'
).trim();
const FASTLY_PATH = String(args.fastlyPath || process.env.FASTLY_PATH || '/').trim();

const TENCENT_SNI = String(args.tencentSni || process.env.TENCENT_SNI || 'www.tencentwm.com').trim();
const TENCENT_HOST = String(
  args.tencentHost || process.env.TENCENT_HOST || 'daykoo-tencent-fr1.levospeed.click'
).trim();
const TENCENT_PATH = String(args.tencentPath || process.env.TENCENT_PATH || '/eo/v1/4bfa6f260da5').trim();
const TENCENT_EDGE_LIST = String(args.tencentEdgeList || process.env.TENCENT_EDGE_LIST || '').trim();
const TENCENT_APPLICATION_LIMIT = Number(
  args.tencentApplicationLimit || process.env.TENCENT_APPLICATION_LIMIT || 220
);

const ALIBABA_SNI = String(args.alibabaSni || process.env.ALIBABA_SNI || 'www.alibaba.com').trim();
const ALIBABA_MODE = String(args.alibabaMode || process.env.ALIBABA_MODE || 'xhttp').trim().toLowerCase();
const ALIBABA_HOST = String(
  args.alibabaHost || process.env.ALIBABA_HOST || 'cdn-a1.levospeed.click'
).trim();
const ALIBABA_PATH = String(args.alibabaPath || process.env.ALIBABA_PATH || '/media/v4/fr1/sync').trim();
const ALIBABA_EDGE_LIST = String(args.alibabaEdgeList || process.env.ALIBABA_EDGE_LIST || '').trim();
const ALIBABA_STRICT_EDGE_LIST = String(
  args.alibabaStrictEdgeList || process.env.ALIBABA_STRICT_EDGE_LIST || ''
).toLowerCase() === 'true';
const ALIBABA_DISCOVERY_HOSTS = [...new Set(
  String(
    args.alibabaDiscoveryHosts ||
      process.env.ALIBABA_DISCOVERY_HOSTS ||
      'cdn-a1.levospeed.click,cdn-a2.levospeed.click,cdn-a3.levospeed.click,cdn-a4.levospeed.click'
  ).split(/[\s,]+/).map((value) => value.trim()).filter(Boolean)
)];

const KNOWN_BUNNY_GOOD = [
  '138.199.37.232',
  '138.199.36.9',
  '89.187.188.228',
  '89.187.162.249',
  '84.17.59.119',
  '94.20.154.22',
];

const KNOWN_TENCENT_GOOD = [
  // Current / DNS discovered EdgeOne addresses.
  '43.159.99.106',
  '43.159.98.111',
  '43.159.109.61',
  // Previous TM Wi-Fi winners.
  '43.174.224.189',
  '43.174.224.133',
  '43.174.196.76',
];

const KNOWN_ALIBABA_GOOD = [
  // Previous ESA connect IP used by this project.
  '163.181.0.194',
];

let liveResults = null;

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.mkdirSync(path.dirname(FOUND_OUT), { recursive: true });
  fs.mkdirSync(path.dirname(FOUND_IPS_OUT), { recursive: true });

  liveResults = createLiveResultWriter(FOUND_OUT, FOUND_IPS_OUT);

  const startedAt = new Date().toISOString();
  const publicIp = await getPublicIp();
  console.log('=== TM CDN IP scan prepared probe ===');
  console.log(`provider: ${PROVIDER}`);
  console.log(`localAddress: ${LOCAL_ADDRESS || '(system default route)'}`);
  console.log(`publicIp: ${publicIp}`);
  console.log(`out: ${OUT}`);
  console.log(`live results: ${FOUND_OUT}`);
  console.log(`live IPs: ${FOUND_IPS_OUT}`);
  console.log('');

  const report = {
    ok: true,
    startedAt,
    finishedAt: null,
    localAddress: LOCAL_ADDRESS || null,
    publicIp,
    settings: {
      provider: PROVIDER,
      limit: LIMIT,
      concurrency: CONCURRENCY,
      timeoutMs: TIMEOUT_MS,
      cloudflare: { host: CLOUDFLARE_HOST, path: CLOUDFLARE_PATH },
      bunny: { host: BUNNY_HOST, path: BUNNY_PATH },
      fastly: { sni: FASTLY_SNI, host: FASTLY_HOST, path: FASTLY_PATH },
      tencent: { sni: TENCENT_SNI, host: TENCENT_HOST, path: TENCENT_PATH },
      alibaba: { mode: ALIBABA_MODE, sni: ALIBABA_SNI, host: ALIBABA_HOST, path: ALIBABA_PATH },
    },
    cloudflare: null,
    bunny: null,
    fastly: null,
    tencent: null,
    alibaba: null,
  };

  if (PROVIDER === 'all' || PROVIDER === 'cloudflare' || PROVIDER === 'cf') {
    report.cloudflare = await scanCloudflare();
  }

  if (PROVIDER === 'all' || PROVIDER === 'bunny') {
    report.bunny = await scanBunny();
  }

  if (PROVIDER === 'all' || PROVIDER === 'fastly') {
    report.fastly = await scanFastly();
  }

  if (PROVIDER === 'all' || PROVIDER === 'tencent' || PROVIDER === 'edgeone') {
    report.tencent = await scanTencent();
  }

  if (PROVIDER === 'all' || PROVIDER === 'alibaba' || PROVIDER === 'esa') {
    report.alibaba = await scanAlibaba();
  }

  if (PROVIDER === 'asia') {
    report.tencent = await scanTencent();
    report.alibaba = await scanAlibaba();
  }

  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  writeCsv(report);

  console.log('');
  console.log(`Saved JSON: ${OUT}`);
  console.log(`Saved CSV:  ${OUT.replace(/\.json$/i, '.csv')}`);
  console.log(`Live JSONL: ${FOUND_OUT}`);
  console.log(`Live IPs:   ${FOUND_IPS_OUT}`);
}

async function scanCloudflare() {
  console.log('--- Cloudflare candidates ---');
  const listedIps = await readIpList(CLOUDFLARE_EDGE_LIST);
  const ips = unique(
    CLOUDFLARE_STRICT_EDGE_LIST
      ? listedIps
      : [...listedIps, ...(await resolveMany([CLOUDFLARE_HOST]))]
  ).slice(0, LIMIT);
  console.log(`candidates: ${ips.length}`);

  const tcpRows = await mapPoolWithProgress(
    ips,
    CONCURRENCY,
    (ip) => tcpProbe(ip, 443),
    'Cloudflare TCP',
    PROGRESS_EVERY
  );
  const tcpOk = tcpRows.filter((row) => row.ok).sort((left, right) => left.ms - right.ms);
  console.log(`tcp ok: ${tcpOk.length}/${ips.length}`);

  const tlsRows = await mapPoolWithProgress(
    tcpOk.map((row) => row.ip),
    CONCURRENCY,
    (ip) => tlsProbe(ip, { sni: CLOUDFLARE_HOST, alpn: ['http/1.1'] }),
    'Cloudflare TLS',
    PROGRESS_EVERY
  );
  const tlsOk = tlsRows
    .filter((row) => row.ok && row.certValidForSni === true && row.certDateValid === true && row.alpn === 'http/1.1')
    .sort((left, right) => left.ms - right.ms);
  console.log(`tls identity/date/http1.1 ok: ${tlsOk.length}/${tcpOk.length}`);

  const tcpByIp = new Map(tcpRows.map((row) => [row.ip, row]));
  const tlsByIp = new Map(tlsRows.map((row) => [row.ip, row]));
  const wsRows = await mapPoolWithProgress(
    tlsOk.map((row) => row.ip),
    Math.min(CONCURRENCY, 20),
    async (ip) => {
      const ws = await http11Probe(ip, {
        sni: CLOUDFLARE_HOST,
        host: CLOUDFLARE_HOST,
        path: CLOUDFLARE_PATH,
        websocket: true,
      });
      if (ws.ok && ws.status === 101) {
        liveResults.write({
          provider: 'cloudflare',
          ip,
          protocol: 'vless-ws-tls',
          tcpMs: tcpByIp.get(ip)?.ms ?? null,
          tlsMs: tlsByIp.get(ip)?.ms ?? null,
          wsStatus: ws.status,
          wsMs: ws.ms,
          alpn: tlsByIp.get(ip)?.alpn || null,
          server: ws.server || null,
        });
      }
      return ws;
    },
    'Cloudflare WS',
    PROGRESS_EVERY
  );

  const ranked = rankRows(ips, tcpRows, tlsRows, [], wsRows, {
    goodStatus: (status) => status === 101,
  }).map((row) => ({
    ...row,
    ok: Boolean(
      row.tcpMs != null &&
      row.tlsMs != null &&
      row.certValidForSni === true &&
      row.certDateValid === true &&
      row.alpn === 'http/1.1' &&
      row.wsStatus === 101
    ),
  })).sort((left, right) => {
    if (left.ok !== right.ok) return left.ok ? -1 : 1;
    return right.score - left.score;
  });

  printTop('Cloudflare top', ranked);
  return { candidates: ips.length, top: ranked.slice(0, TOP), rows: ranked };
}

async function scanBunny() {
  console.log('--- Bunny candidates ---');
  const ips = unique([...(await fetchBunnyEdges()), ...(await resolveMany([BUNNY_HOST])), ...KNOWN_BUNNY_GOOD]).slice(
    0,
    LIMIT
  );
  console.log(`candidates: ${ips.length}`);

  const tcpRows = await mapPool(ips, CONCURRENCY, (ip) => tcpProbe(ip, 443));
  const tcpOk = tcpRows.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
  console.log(`tcp ok: ${tcpOk.length}/${ips.length}`);

  const tlsRows = await mapPool(tcpOk.map((r) => r.ip), CONCURRENCY, (ip) =>
    tlsProbe(ip, { sni: BUNNY_HOST, alpn: ['http/1.1'] })
  );
  const tlsOk = tlsRows
    .filter((r) => r.ok && r.certValidForSni === true && r.certDateValid === true && r.alpn === 'http/1.1')
    .sort((a, b) => a.ms - b.ms);
  console.log(`tls identity/date/http1.1 ok: ${tlsOk.length}/${tcpOk.length}`);

  const tcpByIp = new Map(tcpRows.map((row) => [row.ip, row]));
  const tlsByIp = new Map(tlsRows.map((row) => [row.ip, row]));
  const applicationIps = tlsOk.slice(0, Math.min(LIMIT, BUNNY_APPLICATION_LIMIT)).map((r) => r.ip);
  const httpRows = await mapPoolWithProgress(
    applicationIps,
    Math.min(CONCURRENCY, 20),
    async (ip) => {
      const probe = await http11Probe(ip, {
        sni: BUNNY_HOST,
        host: BUNNY_HOST,
        path: BUNNY_PATH,
        websocket: false,
      });
      if (probe.ok && [200, 301, 302, 307, 308, 400, 404].includes(Number(probe.status))) {
        liveResults.write({
          provider: 'bunny',
          ip,
          protocol: 'https-edge',
          tcpMs: tcpByIp.get(ip)?.ms ?? null,
          tlsMs: tlsByIp.get(ip)?.ms ?? null,
          httpStatus: probe.status,
          httpMs: probe.ms,
          alpn: tlsByIp.get(ip)?.alpn || null,
          server: probe.server || null,
        });
      }
      return probe;
    },
    'Bunny HTTPS'
  );

  const wsRows = await mapPool(applicationIps, Math.min(CONCURRENCY, 20), (ip) =>
    http11Probe(ip, { sni: BUNNY_HOST, host: BUNNY_HOST, path: BUNNY_PATH, websocket: true })
  );

  const ranked = rankRows(ips, tcpRows, tlsRows, httpRows, wsRows, {
    goodStatus: (status) => status === 101 || status === 400 || status === 404 || status === 200,
  });

  printTop('Bunny top', ranked);
  return { candidates: ips.length, top: ranked.slice(0, TOP), rows: ranked };
}

async function scanFastly() {
  console.log('--- Fastly candidates ---');
  const ips = unique([...(await resolveMany([FASTLY_SNI, FASTLY_HOST])), ...fastlyCandidateIps()]).slice(0, LIMIT);
  console.log(`candidates: ${ips.length}`);

  const tcpRows = await mapPool(ips, CONCURRENCY, (ip) => tcpProbe(ip, 443));
  const tcpOk = tcpRows.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
  console.log(`tcp ok: ${tcpOk.length}/${ips.length}`);

  const tlsRows = await mapPool(tcpOk.map((r) => r.ip), CONCURRENCY, (ip) =>
    tlsProbe(ip, { sni: FASTLY_SNI, alpn: ['h2', 'http/1.1'] })
  );
  const tlsOk = tlsRows.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
  console.log(`tls ok: ${tlsOk.length}/${tcpOk.length}`);

  const httpRows = await mapPool(tlsOk.slice(0, Math.min(LIMIT, 160)).map((r) => r.ip), Math.min(CONCURRENCY, 20), (ip) =>
    http11Probe(ip, { sni: FASTLY_SNI, host: FASTLY_HOST, path: FASTLY_PATH, websocket: false })
  );

  const ranked = rankRows(ips, tcpRows, tlsRows, httpRows, [], {
    goodStatus: (status) => status && status !== 421 && status !== 403,
  });

  printTop('Fastly top', ranked);
  return { candidates: ips.length, top: ranked.slice(0, TOP), rows: ranked };
}

async function scanTencent() {
  console.log('--- Tencent EdgeOne candidates ---');
  const ips = unique([
    ...(await readIpList(TENCENT_EDGE_LIST)),
    ...(await resolveMany([TENCENT_HOST, TENCENT_SNI])),
    ...KNOWN_TENCENT_GOOD,
    ...tencentCandidateIps(),
  ]).slice(0, LIMIT);
  console.log(`candidates: ${ips.length}`);

  const tcpRows = await mapPoolWithProgress(ips, CONCURRENCY, (ip) => tcpProbe(ip, 443), 'Tencent TCP');
  const tcpOk = tcpRows.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
  console.log(`tcp ok: ${tcpOk.length}/${ips.length}`);

  const tlsRows = await mapPoolWithProgress(
    tcpOk.map((r) => r.ip),
    CONCURRENCY,
    (ip) => tlsProbe(ip, { sni: TENCENT_SNI, alpn: ['http/1.1'] }),
    'Tencent TLS'
  );
  const tlsOk = tlsRows
    .filter((r) => (
      r.ok &&
      r.certValidForSni === true &&
      r.certDateValid === true &&
      r.alpn === 'http/1.1'
    ))
    .sort((a, b) => a.ms - b.ms);
  console.log(`tls identity/date/http1.1 ok: ${tlsOk.length}/${tcpOk.length}`);

  const tcpByIp = new Map(tcpRows.map((row) => [row.ip, row]));
  const tlsByIp = new Map(tlsRows.map((row) => [row.ip, row]));

  const wsRows = await mapPoolWithProgress(
    tlsOk.slice(0, Math.min(LIMIT, TENCENT_APPLICATION_LIMIT)).map((r) => r.ip),
    Math.min(CONCURRENCY, 20),
    async (ip) => {
      const ws = await http11Probe(ip, {
        sni: TENCENT_SNI,
        host: TENCENT_HOST,
        path: TENCENT_PATH,
        websocket: true,
      });
      if (ws.ok && ws.status === 101) {
        liveResults.write({
          provider: 'tencent',
          ip,
          protocol: 'websocket',
          tcpMs: tcpByIp.get(ip)?.ms ?? null,
          tlsMs: tlsByIp.get(ip)?.ms ?? null,
          wsStatus: ws.status,
          wsMs: ws.ms,
          alpn: tlsByIp.get(ip)?.alpn || null,
          server: ws.server || null,
          country: ws.requestCountry || null,
          isNew: !KNOWN_TENCENT_GOOD.includes(ip),
        });
      }
      return ws;
    },
    'Tencent WS'
  );

  const ranked = rankRows(ips, tcpRows, tlsRows, [], wsRows, {
    goodStatus: (status) => status === 101,
  }).map((row) => ({
    ...row,
    ok: Boolean(
      row.tcpMs != null &&
      row.tlsMs != null &&
      row.certValidForSni === true &&
      row.certDateValid === true &&
      row.alpn === 'http/1.1' &&
      row.wsStatus === 101
    ),
  })).sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return b.score - a.score;
  });

  printTop('Tencent EdgeOne top', ranked);
  return { candidates: ips.length, top: ranked.slice(0, TOP), rows: ranked };
}

async function scanAlibaba() {
  console.log('--- Alibaba ESA candidates ---');
  if (!['xhttp', 'ws'].includes(ALIBABA_MODE)) {
    throw new Error(`Unsupported Alibaba mode: ${ALIBABA_MODE}. Use xhttp or ws.`);
  }
  const discovered = unique([
    ...(await readIpList(ALIBABA_EDGE_LIST)),
    ...(await resolveMany([ALIBABA_HOST, ...ALIBABA_DISCOVERY_HOSTS])),
    ...KNOWN_ALIBABA_GOOD,
  ]);
  const ips = unique(
    ALIBABA_STRICT_EDGE_LIST
      ? discovered
      : [...discovered, ...alibabaCandidateIps(discovered)]
  ).slice(0, LIMIT);
  console.log(`candidates: ${ips.length}`);

  const tcpRows = await mapPool(ips, CONCURRENCY, (ip) => tcpProbe(ip, 443));
  const tcpOk = tcpRows.filter((row) => row.ok).sort((a, b) => a.ms - b.ms);
  console.log(`tcp ok: ${tcpOk.length}/${ips.length}`);

  const expectedAlpn = ALIBABA_MODE === 'ws' ? 'http/1.1' : 'h2';
  const tlsRows = await mapPool(tcpOk.map((row) => row.ip), CONCURRENCY, (ip) =>
    tlsProbe(ip, { sni: ALIBABA_SNI, alpn: ALIBABA_MODE === 'ws' ? ['http/1.1'] : ['h2', 'http/1.1'] })
  );
  const tlsOk = tlsRows
    .filter((row) => row.ok && row.alpn === expectedAlpn)
    .sort((left, right) => left.ms - right.ms);
  console.log(`tls ${expectedAlpn} ok: ${tlsOk.length}/${tcpOk.length}`);

  const tcpByIp = new Map(tcpRows.map((row) => [row.ip, row]));
  const tlsByIp = new Map(tlsRows.map((row) => [row.ip, row]));
  const applicationRows = await mapPool(
    tlsOk.slice(0, Math.min(LIMIT, 220)).map((row) => row.ip),
    Math.min(CONCURRENCY, 20),
    async (ip) => {
      const probe = ALIBABA_MODE === 'ws'
        ? await http11Probe(ip, {
            sni: ALIBABA_SNI,
            host: ALIBABA_HOST,
            path: ALIBABA_PATH,
            websocket: true,
          })
        : await http2Probe(ip, {
            sni: ALIBABA_SNI,
            host: ALIBABA_HOST,
            path: ALIBABA_PATH,
          });
      const accepted = ALIBABA_MODE === 'ws' ? probe.status === 101 : isAlibabaStatus(probe.status);
      if (probe.ok && accepted && tlsByIp.get(ip)?.certValidForSni === true) {
        liveResults.write({
          provider: 'alibaba',
          ip,
          protocol: ALIBABA_MODE === 'ws' ? 'vless-ws-tls' : 'h2-xhttp',
          tcpMs: tcpByIp.get(ip)?.ms ?? null,
          tlsMs: tlsByIp.get(ip)?.ms ?? null,
          httpStatus: probe.status,
          httpMs: probe.ms,
          alpn: tlsByIp.get(ip)?.alpn || null,
          server: probe.server || null,
          isNew: !KNOWN_ALIBABA_GOOD.includes(ip),
        });
      }
      return probe;
    }
  );

  const httpRows = ALIBABA_MODE === 'ws' ? [] : applicationRows;
  const wsRows = ALIBABA_MODE === 'ws' ? applicationRows : [];
  const goodStatus = ALIBABA_MODE === 'ws' ? (status) => Number(status) === 101 : isAlibabaStatus;
  const ranked = rankRows(ips, tcpRows, tlsRows, httpRows, wsRows, {
    goodStatus,
  }).map((row) => ({
    ...row,
    ok: Boolean(
      row.tcpMs != null &&
      row.tlsMs != null &&
      row.certValidForSni === true &&
      row.alpn === expectedAlpn &&
      (ALIBABA_MODE === 'ws' ? row.wsStatus === 101 : isAlibabaStatus(row.httpStatus))
    ),
  })).sort((left, right) => {
    if (left.ok !== right.ok) return left.ok ? -1 : 1;
    return right.score - left.score;
  });

  printTop('Alibaba ESA top', ranked);
  return { mode: ALIBABA_MODE, candidates: ips.length, top: ranked.slice(0, TOP), rows: ranked };
}

function isAlibabaStatus(status) {
  return Number(status) >= 200 && Number(status) < 600 && Number(status) !== 421;
}

function parseArgs(argv) {
  const out = {};
  for (const item of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(item);
    if (m) out[toCamel(m[1])] = m[2];
    else if (item.startsWith('--')) out[toCamel(item.slice(2))] = true;
  }
  return out;
}

function toCamel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function unique(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const ip = String(item || '').trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
    if (seen.has(ip)) continue;
    seen.add(ip);
    out.push(ip);
  }
  return out;
}

function powershell(script) {
  if (process.platform !== 'win32') return '';
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function detectTetherLocalAddress() {
  if (process.platform !== 'win32') return '';
  const json = powershell(`
    Get-NetIPConfiguration |
      Where-Object {
        $_.IPv4DefaultGateway -and (
          $_.InterfaceDescription -match 'Apple Mobile|iPhone|Remote NDIS|Mobile|USB|Android|RNDIS' -or
          $_.InterfaceAlias -match 'iPhone|Mobile|USB|Android|RNDIS'
        )
      } |
      Select-Object -First 1 @{n='IP';e={$_.IPv4Address[0].IPAddress}} |
      ConvertTo-Json -Compress
  `);
  try {
    return JSON.parse(json)?.IP || '';
  } catch {
    return '';
  }
}

function socketOptions(host, port) {
  return {
    host,
    port,
    family: 4,
    localAddress: LOCAL_ADDRESS || undefined,
    timeout: TIMEOUT_MS,
  };
}

function tcpProbe(ip, port) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect(socketOptions(ip, port));
    let done = false;
    const finish = (ok, err = null) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ip, ok, ms: Date.now() - started, err });
    };
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false, 'timeout'));
    socket.on('error', (e) => finish(false, e.code || e.message));
  });
}

function tlsProbe(ip, { sni, alpn }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = tls.connect({
      ...socketOptions(ip, 443),
      servername: sni,
      ALPNProtocols: alpn,
      rejectUnauthorized: false,
    });
    let done = false;
    const finish = (ok, err = null, extra = {}) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ip, ok, ms: Date.now() - started, err, ...extra });
    };
    socket.on('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const identityError = sni ? tls.checkServerIdentity(sni, cert) : null;
      const validFromMs = Date.parse(cert?.valid_from || '');
      const validToMs = Date.parse(cert?.valid_to || '');
      const nowMs = Date.now();
      finish(true, null, {
        alpn: socket.alpnProtocol || null,
        cn: cert?.subject?.CN || null,
        issuer: cert?.issuer?.O || cert?.issuer?.CN || null,
        certValidForSni: !identityError,
        certIdentityError: identityError?.message || null,
        certValidFrom: cert?.valid_from || null,
        certValidTo: cert?.valid_to || null,
        certDateValid: (
          Number.isFinite(validFromMs) &&
          Number.isFinite(validToMs) &&
          nowMs >= validFromMs &&
          nowMs <= validToMs
        ),
      });
    });
    socket.on('timeout', () => finish(false, 'timeout'));
    socket.on('error', (e) => finish(false, e.code || e.message));
  });
}

function http11Probe(ip, { sni, host, path: requestPath, websocket }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = tls.connect({
      ...socketOptions(ip, 443),
      servername: sni,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: false,
    });
    let data = '';
    let done = false;
    const finish = (ok, err = null, extra = {}) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ip, ok, ms: Date.now() - started, err, ...extra });
    };
    socket.on('secureConnect', () => {
      const headers = [
        `GET ${requestPath || '/'} HTTP/1.1`,
        `Host: ${host}`,
        'User-Agent: tm-cdn-ip-scan/1.0',
        'Accept: */*',
        'Cache-Control: no-cache',
      ];
      if (websocket) {
        headers.push('Connection: Upgrade');
        headers.push('Upgrade: websocket');
        headers.push('Sec-WebSocket-Version: 13');
        headers.push('Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==');
      } else {
        headers.push('Connection: close');
      }
      socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1');
      if (data.includes('\r\n\r\n')) {
        const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d+)/.exec(data)?.[1] || 0);
        const server = /^server:\s*(.+)$/im.exec(data)?.[1]?.trim() || null;
        const cdnStatus = /^cdn-status:\s*(.+)$/im.exec(data)?.[1]?.trim() || null;
        const requestCountry = /^cdn-requestcountrycode:\s*(.+)$/im.exec(data)?.[1]?.trim() || null;
        finish(true, null, { status, server, cdnStatus, requestCountry });
      }
    });
    socket.on('timeout', () => finish(false, 'timeout'));
    socket.on('error', (e) => finish(false, e.code || e.message));
    socket.on('end', () => {
      if (!done) {
        const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d+)/.exec(data)?.[1] || 0);
        finish(Boolean(status), status ? null : 'no_http_status', { status });
      }
    });
  });
}

function http2Probe(ip, { sni, host, path: requestPath }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    let request = null;
    let session = null;
    const timer = setTimeout(() => finish(false, 'timeout'), TIMEOUT_MS);

    const finish = (ok, err = null, extra = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        request?.close();
      } catch {}
      try {
        session?.destroy();
      } catch {}
      resolve({ ip, ok, ms: Date.now() - started, err, ...extra });
    };

    try {
      session = http2.connect(`https://${host}`, {
        createConnection: () =>
          tls.connect({
            ...socketOptions(ip, 443),
            servername: sni,
            ALPNProtocols: ['h2'],
            rejectUnauthorized: false,
          }),
      });
      session.on('error', (err) => finish(false, err.code || err.message));
      request = session.request({
        [http2.constants.HTTP2_HEADER_METHOD]: 'GET',
        [http2.constants.HTTP2_HEADER_SCHEME]: 'https',
        [http2.constants.HTTP2_HEADER_AUTHORITY]: host,
        [http2.constants.HTTP2_HEADER_PATH]: requestPath || '/',
        'user-agent': 'tm-cdn-ip-scan/1.0',
        'cache-control': 'no-cache',
      });
      request.on('response', (headers) => {
        const status = Number(headers[http2.constants.HTTP2_HEADER_STATUS] || 0);
        const server = headers.server ? String(headers.server) : null;
        finish(Boolean(status), status ? null : 'no_http_status', { status, server });
      });
      request.on('error', (err) => finish(false, err.code || err.message));
      request.end();
    } catch (err) {
      finish(false, err.code || err.message);
    }
  });
}

async function fetchBunnyEdges() {
  if (BUNNY_EDGE_LIST) {
    try {
      const text = fs.readFileSync(BUNNY_EDGE_LIST, 'utf8');
      return text
        .split(/\s+/)
        .map((x) => x.trim())
        .filter(Boolean);
    } catch (err) {
      console.warn(`Could not read BUNNY_EDGE_LIST=${BUNNY_EDGE_LIST}: ${err.message}`);
    }
  }

  const text = await fetchText('https://bunnycdn.com/api/system/edgeserverlist/plain').catch(() => '');
  return text
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

async function readIpList(filePath) {
  if (!filePath) return [];
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\s+/).filter(Boolean);
  } catch (err) {
    console.warn(`Could not read IP list=${filePath}: ${err.message}`);
    return [];
  }
}

async function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 12000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

async function resolveMany(hosts) {
  const out = [];
  for (const host of hosts) {
    try {
      out.push(...(await dns.resolve4(host)));
    } catch {}
  }
  return out;
}

function fastlyCandidateIps() {
  const ips = [];
  const add = (ip) => ips.push(ip);

  for (const b of [1, 2, 65, 66, 129, 130, 193, 194]) {
    for (const last of [36, 140, 141, 142, 143, 194]) add(`151.101.${b}.${last}`);
  }

  for (const b of [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
    64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79,
    96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111,
    128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143,
    160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175,
    192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207,
    224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239,
    247,
  ]) {
    for (const last of [36, 140, 141, 142, 143, 194]) add(`199.232.${b}.${last}`);
    for (const last of [36, 140, 141, 142, 143, 194]) add(`146.75.${b}.${last}`);
  }

  return ips;
}

function tencentCandidateIps() {
  const hotPrefixes = [
    // Around current EdgeOne DNS for the Daykoo host/front SNI.
    '43.159.98',
    '43.159.99',
    '43.159.109',
    // Around previous TM Wi-Fi winners.
    '43.174.224',
    '43.174.196',
    // AS139341 ACE prefixes seen in current BGP announcements, biased toward
    // 43.159 / 43.174 EdgeOne ranges that worked before.
    '43.159.64',
    '43.159.65',
    '43.159.72',
    '43.159.74',
    '43.159.79',
    '43.159.80',
    '43.159.87',
    '43.159.90',
    '43.159.97',
    '43.159.106',
    '43.159.112',
    '43.159.113',
    '43.159.117',
    '43.159.118',
    '43.159.119',
    '43.174.193',
    '43.174.197',
    '43.174.220',
    '43.174.225',
    '43.174.228',
    '43.174.232',
  ];

  const preferredLastOctets = [
    61,
    76,
    106,
    111,
    133,
    189,
    194,
    2,
    4,
    8,
    11,
    20,
    24,
    31,
    36,
    42,
    50,
    64,
    80,
    88,
    99,
    100,
    120,
    128,
    140,
    150,
    160,
    180,
    200,
    220,
    240,
    250,
  ];
  const ips = [];
  for (const last of preferredLastOctets) {
    for (const prefix of hotPrefixes) {
      ips.push(`${prefix}.${last}`);
    }
  }
  for (let last = 1; last <= 254; last += 1) {
    for (const prefix of hotPrefixes) {
      ips.push(`${prefix}.${last}`);
    }
  }
  return ips;
}

function alibabaCandidateIps(seedIps) {
  const prefixes = new Set(['155.102.45', '163.181.0']);
  const seedLastOctets = [];
  for (const ip of seedIps) {
    const parts = String(ip).split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) continue;
    prefixes.add(parts.slice(0, 3).join('.'));
    seedLastOctets.push(parts[3]);
  }

  const preferredLastOctets = uniqueNumbers([
    ...seedLastOctets,
    194, 2, 5, 8, 13, 20, 24, 31, 33, 36, 45, 50, 61, 64, 76, 80, 88, 99, 100, 106, 111, 120, 128,
    133, 140, 150, 160, 180, 189, 200, 220, 240, 250,
  ]);
  const ips = [];
  for (const last of preferredLastOctets) {
    for (const prefix of prefixes) ips.push(`${prefix}.${last}`);
  }
  for (let last = 1; last <= 254; last += 1) {
    for (const prefix of prefixes) ips.push(`${prefix}.${last}`);
  }
  return ips;
}

function uniqueNumbers(values) {
  return [...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value >= 1 && value <= 254))];
}

function createLiveResultWriter(jsonlPath, ipsPath) {
  fs.writeFileSync(jsonlPath, '');
  fs.writeFileSync(ipsPath, '');
  const seen = new Set();

  return {
    write(row) {
      const key = `${row.provider}:${row.ip}`;
      if (seen.has(key)) return;
      seen.add(key);
      const saved = { discoveredAt: new Date().toISOString(), ...row };
      appendDurable(jsonlPath, `${JSON.stringify(saved)}${os.EOL}`);
      appendDurable(ipsPath, `${row.ip}${os.EOL}`);
      console.log(`[FOUND] ${row.provider} ${row.ip} saved immediately`);
    },
  };
}

function appendDurable(filePath, content) {
  const fd = fs.openSync(filePath, 'a');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

async function getPublicIp() {
  return new Promise((resolve) => {
    const req = https.get(
      {
        host: 'ifconfig.me',
        path: '/ip',
        family: 4,
        timeout: 10000,
        localAddress: LOCAL_ADDRESS || undefined,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data.trim()));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve('timeout');
    });
    req.on('error', (e) => resolve(`err:${e.code || e.message}`));
  });
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      out[i] = await fn(items[i]).catch((e) => ({ ip: items[i], ok: false, err: e.message || String(e) }));
    }
  });
  await Promise.all(workers);
  return out;
}

async function mapPoolWithProgress(items, concurrency, fn, label, every = 250) {
  let completed = 0;
  const started = Date.now();
  return mapPool(items, concurrency, async (item, index) => {
    const result = await fn(item, index);
    completed += 1;
    if (completed === items.length || completed % every === 0) {
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - started) / 1000));
      const rate = (completed / elapsedSeconds).toFixed(1);
      console.log(`[progress] ${label}: ${completed}/${items.length} (${rate}/s)`);
    }
    return result;
  });
}

function rankRows(ips, tcpRows, tlsRows, httpRows, wsRows, { goodStatus }) {
  const by = (rows) => new Map(rows.map((r) => [r.ip, r]));
  const tcp = by(tcpRows);
  const tlsMap = by(tlsRows);
  const http = by(httpRows);
  const ws = by(wsRows);

  return ips
    .map((ip) => {
      const t = tcp.get(ip);
      const l = tlsMap.get(ip);
      const h = http.get(ip);
      const w = ws.get(ip);
      const goodHttp = h?.ok && goodStatus(h.status);
      const goodWs = w?.ok && goodStatus(w.status);
      const score =
        (t?.ok ? 100000 : 0) +
        (l?.ok ? 100000 : 0) +
        (goodHttp ? 100000 : 0) +
        (goodWs ? 100000 : 0) -
        (t?.ms || 9999) -
        (l?.ms || 9999) -
        (h?.ms || 9999) -
        (w?.ms || 9999);
      return {
        ip,
        score,
        ok: Boolean(t?.ok && l?.ok && (goodHttp || goodWs || !httpRows.length)),
        tcpMs: t?.ok ? t.ms : null,
        tlsMs: l?.ok ? l.ms : null,
        alpn: l?.alpn || null,
        certCn: l?.cn || null,
        certValidForSni: l?.certValidForSni === true,
        certIdentityError: l?.certIdentityError || null,
        certValidFrom: l?.certValidFrom || null,
        certValidTo: l?.certValidTo || null,
        certDateValid: l?.certDateValid === true,
        httpStatus: h?.status || null,
        httpMs: h?.ok ? h.ms : null,
        wsStatus: w?.status || null,
        wsMs: w?.ok ? w.ms : null,
        server: h?.server || w?.server || null,
        country: h?.requestCountry || w?.requestCountry || null,
        err: t?.err || l?.err || h?.err || w?.err || null,
      };
    })
    .sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      return b.score - a.score;
    });
}

function printTop(title, rows) {
  console.log('');
  console.log(`=== ${title} ===`);
  for (const r of rows.slice(0, TOP)) {
    console.log(
      `${r.ok ? 'OK ' : '-- '} ${r.ip} tcp=${r.tcpMs ?? '-'} tls=${r.tlsMs ?? '-'} http=${r.httpStatus ?? '-'} ws=${
        r.wsStatus ?? '-'
      } country=${r.country || '-'} ${r.err ? `err=${r.err}` : ''}`
    );
  }
}

function writeCsv(report) {
  const rows = [];
  for (const provider of ['cloudflare', 'bunny', 'fastly', 'tencent', 'alibaba']) {
    for (const r of report[provider]?.rows || []) {
      rows.push({
        provider,
        ip: r.ip,
        ok: r.ok,
        tcpMs: r.tcpMs ?? '',
        tlsMs: r.tlsMs ?? '',
        httpStatus: r.httpStatus ?? '',
        httpMs: r.httpMs ?? '',
        wsStatus: r.wsStatus ?? '',
        wsMs: r.wsMs ?? '',
        alpn: r.alpn ?? '',
        country: r.country ?? '',
        server: r.server ?? '',
        err: r.err ?? '',
      });
    }
  }
  const headers = Object.keys(rows[0] || { provider: '', ip: '' });
  const csv = [
    headers.join(','),
    ...rows.map((row) => headers.map((h) => csvCell(row[h])).join(',')),
  ].join(os.EOL);
  fs.writeFileSync(OUT.replace(/\.json$/i, '.csv'), csv);
}

function csvCell(value) {
  const s = String(value ?? '');
  if (!/[",\r\n]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}
