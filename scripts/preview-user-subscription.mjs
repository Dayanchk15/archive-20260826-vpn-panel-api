import { getUserById } from '../lib/db-store.js';
import { getServerById } from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { getPanelSettings } from '../lib/settings.js';

const userId = process.argv[2] || 'usr_QKhedvPZ9OW0Re1_';
const user = await getUserById(userId);
if (!user) {
  console.error('User not found');
  process.exit(1);
}

const body = await buildUserSubscriptionBody(user);
const panel = await getPanelSettings();
const poland3 = await getServerById('server-13');
const lines = body.split('\n').filter((l) => l.includes('vless://'));
const poland3Line = lines.find((l) => l.includes(poland3.host) || l.includes(poland3.addressIp));

console.log(JSON.stringify({
  user: { id: user.id, name: user.name, uuid: user.uuid, serverIds: user.serverIds },
  connectionMode: panel.connectionMode,
  poland3Host: poland3.host,
  poland3AddressIp: poland3.addressIp,
  totalServerLines: lines.length,
  poland3Line: poland3Line || null,
  allRemarks: lines.map((l) => l.split('#').pop()),
}, null, 2));
