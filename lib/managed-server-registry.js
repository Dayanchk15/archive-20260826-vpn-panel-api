import { getServerById, upsertServer } from './db-store.js';
import { nowIso } from './dates.js';

// Managed services are shown in the main «Сервера» registry as disabled,
// subscription-hidden rows. Their per-user links remain owned by the managed
// service workflow, so publishing a row never duplicates or changes a user's
// subscription automatically.
function baseManagedRow(managed, id, name, serviceType, serviceId) {
  const data = managed?.data && typeof managed.data === 'object' ? managed.data : {};
  return {
    id,
    name,
    country: managed?.country || '',
    flag: data.flag || '',
    service: `managed-${serviceType}`,
    region: managed?.address || '',
    addressIp: managed?.address || '',
    externalVps: true,
    source: 'managed-server',
    managedServerId: managed?.id || '',
    managedServiceType: serviceType,
    managedServiceId: serviceId,
    // Keep the row visible in the admin registry, but do not expose it to
    // subscriptions until the owner explicitly enables it there.
    enabled: existing?.enabled === true,
    subscriptionEligible: false,
    subscriptionHidden: true,
    addToNewClients: false,
    newUsersOnly: true,
    updatedAt: nowIso(),
  };
}

export async function publishManagedXrayServer(managed, tunnel) {
  const inbound = tunnel?.config?.inbounds?.[0] || {};
  const stream = inbound.streamSettings || {};
  const ws = stream.wsSettings || {};
  const id = `managed-xray-${tunnel.id}`;
  const existing = await getServerById(id);
  const row = {
    ...baseManagedRow(managed, id, tunnel.name || `${managed?.name || managed?.address || 'VPS'} Xray`, 'xray', tunnel.id),
    ...(existing || {}),
    name: tunnel.name || existing?.name || `${managed?.name || managed?.address || 'VPS'} Xray`,
    host: ws.headers?.Host || stream.tlsSettings?.serverName || managed?.address || '',
    sni: stream.tlsSettings?.serverName || '',
    path: ws.path || '/',
    port: Number(inbound.port || existing?.port || 443),
    protocol: 'vless',
    network: stream.network || (tunnel.template === 'vless-ws-tls' ? 'ws' : 'tcp'),
    security: stream.security || (tunnel.template === 'vless-ws-tls' ? 'tls' : 'none'),
    fingerprint: 'chrome',
    alpn: stream.network === 'grpc' ? 'h2' : 'http/1.1',
    // Managed links are already added per user by the Xray workflow.
    enabled: existing?.enabled === true,
    subscriptionEligible: false,
    subscriptionHidden: true,
    addToNewClients: false,
    updatedAt: nowIso(),
  };
  delete row.id;
  await upsertServer(id, row);
  return getServerById(id);
}

export async function publishManagedOutlineServer(managed, { port = null } = {}) {
  const id = `managed-outline-${managed.id}`;
  const existing = await getServerById(id);
  const row = {
    ...baseManagedRow(managed, id, `${managed?.name || managed?.address || 'VPS'} Outline`, 'outline', managed.id),
    ...(existing || {}),
    name: existing?.name || `${managed?.name || managed?.address || 'VPS'} Outline`,
    host: managed?.address || '',
    sni: '',
    path: '/',
    port: Number(port || existing?.port || 0),
    protocol: 'shadowsocks',
    network: 'tcp',
    security: 'none',
    enabled: existing?.enabled === true,
    subscriptionEligible: false,
    subscriptionHidden: true,
    addToNewClients: false,
    updatedAt: nowIso(),
  };
  delete row.id;
  await upsertServer(id, row);
  return getServerById(id);
}
