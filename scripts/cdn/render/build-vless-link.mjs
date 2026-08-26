#!/usr/bin/env node
import { randomUUID } from 'node:crypto';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : fallback;
}

const host = arg('host');
const uuid = arg('uuid', randomUUID());
const path = arg('path', '/render-fr1-ws');
const name = arg('name', '🇫🇷 Render FR1');
if (!host || !/^[-a-z0-9.]+$/i.test(host) || !host.includes('.')) {
  throw new Error('Use --host SERVICE.onrender.com (or your Render custom domain)');
}
if (!/^\/[A-Za-z0-9._~:/-]*$/.test(path)) throw new Error('Invalid --path');
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
  throw new Error('Invalid --uuid');
}
const params = new URLSearchParams({
  encryption: 'none',
  security: 'tls',
  type: 'ws',
  host,
  path,
  sni: host,
  alpn: 'http/1.1',
  fp: 'chrome',
});
console.log(`vless://${uuid}@${host}:443?${params.toString()}#${encodeURIComponent(name)}`);
