#!/usr/bin/env node
import { listServers, listUsers } from '../lib/db-store.js';
import { isUserActive } from '../lib/active-users.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';

const hosts = [
  'fr1.levospeed.online',
  'fr2.levospeed.online',
  'fornex.levospeed.online',
  'tampa.levospeed.online',
];

const users = (await listUsers(10000)).filter((user) => isUserActive(user));
const servers = (await listServers()).filter((server) => hosts.includes(server.host));
const summary = {
  activeUsers: users.length,
  usersWithAllFour: 0,
  unexpectedFragmentLines: 0,
  noFragmentLines: 0,
  connectIps: {},
  sample: [],
  servers: servers.map((server) => ({
    id: server.id,
    host: server.host,
    addressIp: server.addressIp,
    path: server.path,
    fragmentation: server.fragmentation,
  })),
};

for (const user of users) {
  const body = await buildUserSubscriptionBody(user);
  const lines = body.split('\n').filter((line) => hosts.some((host) => line.includes(`host=${host}`)));
  if (lines.length === hosts.length) summary.usersWithAllFour += 1;
  for (const line of lines) {
    const connectIp = line.match(/^vless:\/\/[^@]+@([^:]+):443\?/)?.[1] || 'unknown';
    summary.connectIps[connectIp] = (summary.connectIps[connectIp] || 0) + 1;
    if (line.includes('fragment=')) summary.unexpectedFragmentLines += 1;
    else summary.noFragmentLines += 1;
  }
  if (!summary.sample.length && lines.length) {
    summary.sample = lines.map((line) => line.replace(/^vless:\/\/[^@]+@/, 'vless://UUID@'));
  }
}

console.log(JSON.stringify(summary, null, 2));
