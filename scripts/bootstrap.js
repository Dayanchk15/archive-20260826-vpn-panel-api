import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { bulkUpsertServers, createUser, getEnabledServerIds } from '../lib/db-store.js';
import { createFile } from '../lib/files.js';
import { updateGlobalSubscription } from '../lib/settings.js';
import { nowIso } from '../lib/dates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

async function readJson(relativePath) {
  const raw = await readFile(path.join(root, relativePath), 'utf8');
  return JSON.parse(raw);
}

async function readText(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + Number(days));
  return copy;
}

async function main() {
  const config = await readJson('config/bootstrap.json');
  const serversPayload = await readJson(config.serversFile);
  const subscriptionContent = await readText(config.globalSubscription.contentFile);
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:8080';

  console.log('Importing servers...');
  const now = nowIso();
  const servers = serversPayload.servers.map((server) => ({
    ...server,
    protocol: 'vless',
    createdAt: now,
    updatedAt: now,
  }));
  await bulkUpsertServers(servers);
  console.log(`Servers imported: ${servers.length}`);

  console.log('Saving global subscription settings...');
  await updateGlobalSubscription({
    enabled: true,
    subscriptionMode: 'custom',
    content: subscriptionContent,
    uuid: config.vpn.sharedUuid,
    serverIds: servers.map((s) => s.id),
  });

  console.log('Creating global file record...');
  try {
    await createFile({
      name: config.globalFile.name,
      slug: config.globalFile.slug,
      storagePath: config.globalFile.storagePath,
      content: subscriptionContent,
      description: 'Global local subscription.txt',
      type: 'subscription',
      enabled: true,
      publicAccess: true,
    });
    console.log(`Global file ready: ${publicBaseUrl}/f/${config.globalFile.slug}`);
  } catch (err) {
    if (String(err.message || '').includes('already in use')) {
      console.log('Global file slug already exists, skipping create.');
    } else {
      throw err;
    }
  }

  console.log('Creating default user...');
  const token = randomToken();
  const tokenHash = sha256(token);
  const expiresAt = addDays(new Date(), config.defaultUser.days);
  const serverIds = await getEnabledServerIds();

  const userId = await createUser({
    name: config.defaultUser.name,
    email: null,
    uuid: config.defaultUser.uuid,
    tokenHash,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    expiresAt: expiresAt.toISOString(),
    trafficLimitGB: config.defaultUser.trafficLimitGB,
    trafficUsedGB: 0,
    serverIds,
    subscriptionMode: 'auto',
    customSubscriptionContent: '',
    note: config.defaultUser.note,
  });

  console.log('\nBootstrap complete.\n');
  console.log('Default user id:', userId);
  console.log('Default user subscription URL:', `${publicBaseUrl}/sub/${token}`);
  console.log('SAVE THIS TOKEN NOW:', token);
  console.log('Global subscription URL:', `${publicBaseUrl}/sub/global`);
  console.log('Global file URL:', `${publicBaseUrl}/f/${config.globalFile.slug}`);
}

main().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
