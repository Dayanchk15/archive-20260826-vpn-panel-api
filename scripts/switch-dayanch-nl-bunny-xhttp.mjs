#!/usr/bin/env node
import {
  getServerById,
  getUserById,
  listUsers,
  upsertServer,
} from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { getFileByLinkedUserId } from '/app/lib/files.js';
import { nowIso } from '/app/lib/dates.js';

const APPLY = process.argv.includes('--apply');
const SERVER_ID = 'bunny-eu-nl-dayanch';
const USER_ID = 'usr_bnjXUy4O1NZufeqW';
const EDGE_IP = '84.17.59.119';
const EDGE_HOST = 'levospeedfr2.b-cdn.net';
const EDGE_PATH = '/media/v6/nl/sync';

function includesServer(user, serverId) {
  return ['serverIds', 'bonusServerIds', 'pinnedServerIds'].some((field) =>
    (Array.isArray(user?.[field]) ? user[field] : []).map(String).includes(serverId)
  );
}

function plainContent(value) {
  const text = String(value || '');
  if (text.includes('vless://')) return text;
  try {
    return Buffer.from(text, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

const [server, user, users] = await Promise.all([
  getServerById(SERVER_ID),
  getUserById(USER_ID),
  listUsers(10000),
]);

if (!server) throw new Error(`${SERVER_ID} not found`);
if (!user?.uuid) throw new Error('Dayanch VIP not found or UUID is missing');

const consumers = users.filter((item) => includesServer(item, SERVER_ID)).map((item) => ({
  id: item.id,
  name: item.name,
}));
if (consumers.some((item) => String(item.id) !== USER_ID)) {
  throw new Error(`Test server is referenced by other users: ${JSON.stringify(consumers)}`);
}

const patch = {
  ...server,
  id: SERVER_ID,
  addressIp: EDGE_IP,
  addressIps: [EDGE_IP],
  forceAddressIp: true,
  port: 443,
  protocol: 'vless',
  network: 'xhttp',
  security: 'tls',
  host: EDGE_HOST,
  sni: EDGE_HOST,
  path: EDGE_PATH,
  xhttpMode: 'auto',
  alpn: 'h2',
  fingerprint: 'chrome',
  allowInsecure: false,
  fragmentation: { enabled: false },
  updatedAt: nowIso(),
};

if (!APPLY) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    serverId: SERVER_ID,
    consumers,
    before: {
      network: server.network,
      host: server.host,
      path: server.path,
      addressIp: server.addressIp,
    },
    after: {
      network: patch.network,
      host: patch.host,
      path: patch.path,
      addressIp: patch.addressIp,
    },
  }, null, 2));
  process.exit(0);
}

try {
  await upsertServer(SERVER_ID, patch);
  const refreshedUser = await getUserById(USER_ID);
  await upsertUserSubscriptionFile(refreshedUser);

  const stored = await getFileByLinkedUserId(USER_ID);
  const body = plainContent(stored?.content);
  const line = body
    .split(/\r?\n/)
    .find((item) =>
      item.startsWith(`vless://${refreshedUser.uuid}@${EDGE_IP}:443`) &&
      item.includes(`path=${encodeURIComponent(EDGE_PATH)}`)
    );
  if (
    !line ||
    !line.includes('type=xhttp') ||
    !line.includes(`host=${EDGE_HOST}`) ||
    !line.includes(`sni=${EDGE_HOST}`) ||
    !line.includes('alpn=h2') ||
    !line.includes('mode=auto')
  ) {
    throw new Error('Generated Dayanch subscription does not contain the expected XHTTP line');
  }

  const built = await buildUserSubscriptionBody(refreshedUser);
  const lineCount = String(built).split(/\r?\n/).filter((item) => item.startsWith('vless://')).length;
  console.log(JSON.stringify({
    ok: true,
    serverId: SERVER_ID,
    userId: USER_ID,
    consumers,
    lineCount,
    line,
  }, null, 2));
} catch (error) {
  await upsertServer(SERVER_ID, server);
  await upsertUserSubscriptionFile(user).catch(() => {});
  throw new Error(`${error.message}; server and Dayanch subscription rolled back`);
}
