import { getServerById, listUsers } from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
const id = 'vless-tcp-fr1-relay-193233219173';
const server = await getServerById(id);
const users = await listUsers(10000);
const sample = users.find((u) => u.status !== 'disabled');
const body = sample ? await buildUserSubscriptionBody(sample) : '';
console.log(JSON.stringify({
  server: server && {
    id: server.id,
    name: server.name,
    host: server.host,
    addressIp: server.addressIp,
    port: server.port,
    protocol: server.protocol,
    network: server.network,
    security: server.security,
    enabled: server.enabled,
    subscriptionEligible: server.subscriptionEligible,
    subscriptionHidden: server.subscriptionHidden,
    addToNewClients: server.addToNewClients,
    trafficNodeId: server.trafficNodeId,
  },
  sampleUser: sample?.id || null,
  hasEndpoint: body.includes('@193.233.219.173:18443'),
  matchingLines: body.split('\n').filter((line) => line.includes('193.233.219.173')).slice(0, 3),
}, null, 2));
