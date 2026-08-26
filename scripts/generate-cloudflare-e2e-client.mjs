#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { listUsers } from '../lib/db-store.js';
import { isUserActive } from '../lib/active-users.js';

const output = String(process.env.OUTPUT || '/data/files/cloudflare-e2e-client.json');
const users = (await listUsers(10000)).filter((user) => isUserActive(user) && user.uuid);
if (!users.length) throw new Error('No active user UUID available for E2E test');

const user = users[0];
const targets = [
  ['fr1', 'fr1.levospeed.click', 19101],
  ['fr2', 'fr2.levospeed.click', 19102],
  ['fornex', 'fornex.levospeed.click', 19103],
  ['tampa', 'tampa.levospeed.click', 19104],
];

const inbounds = targets.map(([id, _host, port]) => ({
  tag: `in-${id}`,
  listen: '127.0.0.1',
  port,
  protocol: 'socks',
  settings: { udp: false },
}));

const outbounds = targets.map(([id, host]) => ({
  tag: `out-${id}`,
  protocol: 'vless',
  settings: {
    vnext: [{
      address: '156.238.181.141',
      port: 443,
      users: [{ id: user.uuid, encryption: 'none' }],
    }],
  },
  streamSettings: {
    network: 'ws',
    security: 'tls',
    tlsSettings: { serverName: host, alpn: ['http/1.1'], fingerprint: 'chrome' },
    wsSettings: { path: '/', headers: { Host: host } },
  },
}));

const config = {
  log: { loglevel: 'warning' },
  inbounds,
  outbounds,
  routing: {
    rules: targets.map(([id]) => ({
      type: 'field',
      inboundTag: [`in-${id}`],
      outboundTag: `out-${id}`,
    })),
  },
};

writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  ok: true,
  output,
  userHash: createHash('sha256').update(String(user.uuid).toLowerCase()).digest('hex'),
  targets: targets.map(([id, host, port]) => ({ id, host, port })),
}));
