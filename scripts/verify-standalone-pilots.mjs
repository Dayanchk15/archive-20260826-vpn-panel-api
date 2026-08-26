#!/usr/bin/env node
import { getServerById, listUsers } from '../lib/db-store.js';
import { buildEdgeClientList } from '../lib/edge-clients.js';
import { applyRelayUserDefaults } from '../lib/relay-subscription.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { buildVlessLink } from '../lib/vless.js';
import { DAYANCH_VIP_USER_ID } from '../lib/vip-users.js';

const pilotIds = [
  'pilot-tampa-reality',
  'pilot-fornex-reality',
  'pilot-fr1-tcp',
];
const pilotAddresses = [
  '74.115.172.101:9443',
  '130.17.12.61:443',
  '185.209.230.14:18443',
];
const expectedDisplay = {
  'pilot-tampa-reality': { name: 'Tampa', flag: '🇺🇸 ⭐', country: 'USA, Tampa' },
  'pilot-fornex-reality': { name: 'Fornex', flag: '🇩🇪 ⭐', country: 'DE, Frankfurt' },
  'pilot-fr1-tcp': { name: 'FR1', flag: '🇫🇷 ⭐', country: 'FR1, Paris' },
};

const pilots = [];
for (const id of pilotIds) {
  const server = await getServerById(id);
  if (!server) throw new Error(`Pilot is missing from panel: ${id}`);
  if (
    server.enabled !== true ||
    server.newUsersOnly !== true ||
    server.subscriptionHidden !== true ||
    server.addToNewClients !== true
  ) {
    throw new Error(`Pilot safety flags are invalid: ${id}`);
  }
  const display = expectedDisplay[id];
  if (
    server.name !== display.name ||
    server.flag !== display.flag ||
    server.country !== display.country
  ) {
    throw new Error(`Pilot display fields are invalid: ${id}`);
  }
  pilots.push(server);
}

const users = await listUsers();
const retiredFr2 = await getServerById('pilot-fr2-tcp');
if (retiredFr2?.enabled !== false || retiredFr2?.addToNewClients !== false) {
  throw new Error('Retired FR2 pilot is still enabled for subscriptions');
}
const retiredFr2Assignments = users.filter((user) =>
  [...(user.serverIds || []), ...(user.bonusServerIds || [])]
    .map(String)
    .includes('pilot-fr2-tcp')
);
if (retiredFr2Assignments.length) {
  throw new Error(
    `Retired FR2 pilot is still assigned: ${retiredFr2Assignments
      .map((user) => user.id)
      .join(',')}`
  );
}
const assigned = users.filter((user) => {
  const ids = [...(user.serverIds || []), ...(user.bonusServerIds || [])].map(String);
  return pilotIds.some((id) => ids.includes(id));
});
const unexpectedlyAssigned = assigned.filter(
  (user) => user.id !== DAYANCH_VIP_USER_ID
);
if (unexpectedlyAssigned.length) {
  throw new Error(
    `Pilots are unexpectedly assigned to users: ${unexpectedlyAssigned
      .map((user) => user.id)
      .join(',')}`
  );
}

const lineCounts = new Map();
const leaked = [];
for (const user of users) {
  if (!user.uuid) continue;
  const body = await buildUserSubscriptionBody(user);
  const lines = body.split('\n').filter((line) => line.startsWith('vless://'));
  lineCounts.set(lines.length, (lineCounts.get(lines.length) || 0) + 1);
  if (
    user.id !== DAYANCH_VIP_USER_ID &&
    pilotAddresses.some((address) => body.includes(`@${address}`))
  ) {
    leaked.push(user.id);
  }
}
if (leaked.length) throw new Error(`Pilot link leaked into subscriptions: ${leaked.join(',')}`);

const sampleUser = users.find((user) => user.uuid);
const generatedLinks = pilots.map((server) => buildVlessLink(sampleUser, server, {
  connectionMode: 'direct',
  panelSettings: { happFragmentationEnabled: false },
}));

const simulatedNewUser = await applyRelayUserDefaults({
  id: 'verification-new-user',
  uuid: '11111111-1111-4111-8111-111111111111',
  status: 'active',
});
const simulatedNewBody = await buildUserSubscriptionBody(simulatedNewUser);
const simulatedNewLines = simulatedNewBody
  .split('\n')
  .filter((line) => line.startsWith('vless://'));
const missingNewPilotAddresses = pilotAddresses.filter(
  (address) => !simulatedNewBody.includes(`@${address}`)
);
if (missingNewPilotAddresses.length) {
  throw new Error(`New-client subscription is missing pilots: ${missingNewPilotAddresses.join(',')}`);
}

const activeClients = await buildEdgeClientList();
console.log(
  JSON.stringify(
    {
      ok: true,
      pilots: pilots.map((server) => ({
        id: server.id,
        enabled: server.enabled,
        newUsersOnly: server.newUsersOnly,
        subscriptionHidden: server.subscriptionHidden,
        addToNewClients: server.addToNewClients,
      })),
      activeClientCount: activeClients.length,
      assignedUserCount: assigned.length,
      assignedUserIds: assigned.map((user) => user.id),
      pilotLeaks: leaked.length,
      generatedPilotLinks: generatedLinks.length,
      simulatedNewClientLines: simulatedNewLines.length,
      subscriptionLineCounts: Object.fromEntries(
        [...lineCounts.entries()].sort((a, b) => a[0] - b[0])
      ),
    },
    null,
    2
  )
);
