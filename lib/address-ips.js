import { createHash } from 'crypto';

export function normalizeAddressIps(addressIps) {
  return (Array.isArray(addressIps) ? addressIps : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

export function userUsesCustomAddressIps(user) {
  return normalizeAddressIps(user?.addressIps).length > 0;
}

export function resolveUserServerAddressIp(user, server) {
  const serverId = String(server?.id || '').trim();
  if (!serverId || !user?.serverAddressIps || typeof user.serverAddressIps !== 'object') return '';
  const value = String(user.serverAddressIps[serverId] || '').trim();
  return value;
}

export function userUsesServerAddressIp(user, server) {
  return Boolean(resolveUserServerAddressIp(user, server));
}

export function resolveConnectAddressIp(user, server, serverIndex, panel) {
  const perServerIp = resolveUserServerAddressIp(user, server);
  if (perServerIp) return perServerIp;

  const userIps = normalizeAddressIps(user?.addressIps);
  if (userIps.length) {
    return userIps[serverIndex % userIps.length];
  }

  const serverIp = String(server?.addressIp || '').trim();
  if (serverIp) return serverIp;

  const panelIps = normalizeAddressIps(panel?.addressIps);
  if (panelIps.length) {
    const serverId = String(server?.id || '').trim();
    const stableIndex = serverId
      ? createHash('sha256').update(serverId).digest()[0] % panelIps.length
      : serverIndex % panelIps.length;
    return panelIps[stableIndex];
  }

  return '';
}
