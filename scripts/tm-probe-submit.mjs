#!/usr/bin/env node
/**
 * Template: run on a real TM device (Happ) to report per-line ping to panel.
 * Usage:
 *   PANEL_URL=https://sub.twidu.com EDGE_REPORT_KEY=... node tm-probe-submit.mjs
 *
 * Expects env SUB_LINES as newline-separated vless URLs, or reads from stdin.
 */
import os from 'os';

const panelUrl = String(process.env.PANEL_URL || 'https://sub.twidu.com').replace(/\/+$/, '');
const key = String(process.env.EDGE_REPORT_KEY || process.env.ADMIN_API_KEY || '').trim();
const source = String(process.env.TM_PROBE_SOURCE || 'tm-device').trim();
const client = String(process.env.TM_PROBE_CLIENT || 'happ').trim();

if (!key) {
  console.error('Set EDGE_REPORT_KEY or ADMIN_API_KEY');
  process.exit(1);
}

const raw =
  String(process.env.SUB_LINES || '').trim() ||
  (await new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      buf += c;
    });
    process.stdin.on('end', () => resolve(buf));
    if (process.stdin.isTTY) resolve('');
  }));

const lines = raw
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.startsWith('vless://'));

const summary = {
  lineCount: lines.length,
  host: os.hostname(),
  ts: new Date().toISOString(),
};

const res = await fetch(`${panelUrl}/internal/tm-probe/report`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-edge-report-key': key,
  },
  body: JSON.stringify({ source, client, lines: lines.map((url) => ({ url })), summary }),
});

const body = await res.text();
console.log(res.status, body);
process.exit(res.ok ? 0 : 1);
