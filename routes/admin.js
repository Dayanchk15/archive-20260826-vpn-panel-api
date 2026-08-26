import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveUserUuid } from '../lib/resolve-user-uuid.js';
import { requireAdmin } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { addDays, nowIso } from '../lib/dates.js';
import {
  buildAutoSubscription,
  buildGlobalSubscriptionBody,
  buildUserSubscriptionBody,
  sortServersForSubscription,
} from '../lib/subscription.js';
import { getGlobalSubscription, getPanelSettings, updateGlobalSubscription, updatePanelSettings } from '../lib/settings.js';
import { refreshUserSubscriptionAndEdge, upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import {
  listAssignableServerIds,
  normalizeAssignableServerIds,
  resolveEffectiveServerIdsForUser,
} from '../lib/server-assignment.js';
import { applyRelayUserDefaults, listEnabledRelayServerIds } from '../lib/relay-subscription.js';
import { buildMetaForUser } from '../lib/subscription-meta.js';
import {
  buildPublicStorageUrl,
  getBucketName,
  getGlobalSubscriptionPath,
  resolveStorageUrl,
  syncGlobalSubscriptionToStorage,
} from '../lib/storage.js';
import {
  createFile,
  deleteFile,
  getFileById,
  getFileByLinkedUserId,
  listFiles,
  updateFile,
} from '../lib/files.js';
import {
  bulkUpsertServers,
  createUser,
  deleteServer,
  getEnabledServerIds,
  getEnabledServers,
  getServerById,
  getUserById,
  getUsersUsingServer,
  listServers,
  listUsers,
  updateServer,
  updateUser,
  upsertServer,
} from '../lib/db-store.js';
import { getClientRegistry, syncVpnEdgeClients, syncVpnEdgeClientsPhased, resolveWarmServerIds } from '../lib/vpn-edge-sync.js';
import {
  applyDynamicServerChangeEffects,
  enrichServerUpdateFields,
  summarizeServerForPanel,
} from '../lib/dynamic-server-ops.js';
import { getBackgroundSyncState, scheduleVpnEdgeSync } from '../lib/background-sync.js';
import { scheduleRelayEdgeSync, getRelayEdgeBackgroundSyncState } from '../lib/relay-edge-background-sync.js';
import { getRelayEdgeSyncStatusSummary } from '../lib/relay-edge-sync-status.js';
import { getRelayAgentSyncState } from '../lib/relay-edge-agent-sync.js';
import { getSetting, query } from '../lib/postgres.js';
import { telegramAlertsEnabled } from '../lib/telegram-alert.js';
import { telegramCursorBotConfigured } from '../lib/telegram-cursor-bot.js';
import { enforceAllUserLimits, enforceUserLimits } from '../lib/user-enforcement.js';
import { deleteUserWithData } from '../lib/user-delete.js';
import { buildUserSubscriptionUrls, buildUrlsForUser } from '../lib/user-urls.js';
import { issueSubscriptionTokenIfMissing } from '../lib/subscription-token.js';
import {
  countDealerUsers,
  createDealer,
  deleteDealer,
  getDealerById,
  listDealers,
  loginAdmin,
  signSession,
  updateDealer,
} from '../lib/auth-store.js';
import { normalizeAddressIps, userUsesCustomAddressIps } from '../lib/address-ips.js';
import {
  createManagedServer,
  deleteManagedServer,
  getManagedServer,
  getOutlineInstance,
  listManagedServers,
  listManagedServices,
  listOutlineKeys,
  replaceManagedServices,
  saveOutlineInstance,
  setManagedServerStatus,
  syncManagedServersFromRegistry,
  updateManagedServer,
} from '../lib/managed-servers.js';
import {
  createOutlineKey,
  deleteOutlineKey,
  getOutlineStatus,
  registerOutlineAccessFile,
} from '../lib/outline-management.js';
import {
  createManagedXrayTunnel,
  deleteManagedXrayTunnel,
  listManagedXrayTunnels,
  restartManagedXrayTunnel,
  updateManagedXrayTunnel,
  validateManagedXrayTunnel,
} from '../lib/managed-xray.js';
import { ensureManagedXrayRuntime, installOutlineOnServer, inventoryManagedServer, probeManagedServer, removeManagedService, sshCommand } from '../lib/managed-server-ssh.js';
import { publishManagedOutlineServer, publishManagedXrayServer } from '../lib/managed-server-registry.js';
import {
  applyCdnAddressOverrides,
  buildCdnServicesSummary,
  classifyCdnServer,
  CDN_PROVIDER_ALIBABA,
  CDN_PROVIDER_BUNNY,
  CDN_PROVIDER_CLOUDFLARE,
  CDN_PROVIDER_LABELS,
  CDN_PROVIDER_TENCENT,
  CDN_PROVIDERS,
  normalizeOptionalCdnHostname,
  normalizeOptionalCdnIp,
  normalizeOptionalCdnPort,
  summarizeCdnAddressOverrides,
} from '../lib/cdn-address-ips.js';
import { isUserActive } from '../lib/active-users.js';
import { buildVlessLink } from '../lib/vless.js';
import {
  mergeExtraSubscriptionLines,
  normalizeExtraSubscriptionLines,
  removeExtraSubscriptionLine,
  renameExtraSubscriptionLine,
  syncExtraSubscriptionFiles,
} from '../lib/extra-subscription-lines.js';
import { fetchExternalSubscription } from '../lib/external-subscription-import.js';
import { listAuditLogs, writeAuditLog } from '../lib/audit-log.js';
import { getSystemHealthSummary } from '../lib/system-health.js';
import { auditRepositoryJunk } from '../lib/repository-maintenance-audit.js';
import { auditRelayServerMaintenance } from '../lib/server-maintenance-audit.js';
import {
  listMaintenanceQuarantines,
  quarantineMaintenanceCandidates,
  restoreMaintenanceQuarantine,
} from '../lib/maintenance-quarantine.js';
import {
  createMobileActivationCode,
  hiddifyAndroidPublicAccessConfig,
  listMobileSessions,
  mobileAuthSummary,
  revokeAllMobileSessions,
  revokeAllPublicMobileSessions,
  revokeMobileSession,
} from '../lib/mobile-auth.js';
import {
  buildMobileReleaseInfo,
  countryCodeForServer,
  isMobileServerSupported,
} from '../lib/mobile-profile.js';
import {
  buildHiddifyAndroidReleaseInfo,
  hiddifyAndroidCountryCode,
  isHiddifyAndroidMembershipEnabled,
  isHiddifyAndroidServerSupported,
  isHiddifyAndroidTransportSupported,
} from '../lib/hiddify-android-profile.js';

const router = Router();

// Rebuilding every client's subscription file may involve Google Drive and
// can take longer than the reverse-proxy request timeout. Keep the write to
// panel settings synchronous, but serialize the slower file rebuilds in the
// background so the admin action gets an immediate response.
let extraLinksSyncChain = Promise.resolve();
function queueExtraLinksSubscriptionSync() {
  const job = extraLinksSyncChain.then(async () => {
    const users = await listUsers(10000);
    const result = await syncExtraSubscriptionFiles(users, {
      reloadUser: getUserById,
      upsertSubscriptionFile: upsertUserSubscriptionFile,
      concurrency: Number(process.env.EXTRA_LINK_SYNC_CONCURRENCY || 4),
    });
    console.info(`RAW subscription sync: ${result.refreshed}/${result.requested} updated` +
      (result.failed ? `, ${result.failed} failed` : ''));
    return result;
  });
  // Keep the chain alive after a failed job so the next admin action can run.
  extraLinksSyncChain = job.catch((error) => {
    console.error('RAW subscription sync failed:', error?.message || error);
  });
  void job.catch(() => {});
  return { queued: true };
}

// These panel areas were retired from the UI. Keep the public subscription,
// edge-sync, traffic-reporting and mobile compatibility routes intact, but do
// not leave an undocumented administrative write surface behind.
const RETIRED_ADMIN_ROUTES = [
  { methods: new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), test: (path) => /^\/gcp(?:\/|$)/i.test(path) },
  { methods: new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), test: (path) => /^\/settings\/cloud-run-profiles(?:\/|$)/i.test(path) },
  { methods: new Set(['POST']), test: (path) => /^\/servers\/(?:deploy|redeploy-all|repair-cloudrun|reconcile-cloudrun)$/i.test(path) },
  { methods: new Set(['GET', 'POST']), test: (path) => path === '/system/scaling-policy' },
  { methods: new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']), test: (path) => /^\/dealers(?:\/|$)/.test(path) },
  { methods: new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']), test: (path) => /^\/settings\/(?:mobile|hiddify-android)(?:\/|$)/.test(path) },
  { methods: new Set(['GET', 'PUT']), test: (path) => path === '/subscription/global' },
  { methods: new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), test: (path) => path !== '/files/resync-all' && (path === '/files' || /^\/files\/[^/]+$/.test(path)) },
  { methods: new Set(['POST']), test: (path) => path === '/servers' || path === '/servers/bulk' },
];

router.use((req, res, next) => {
  const retired = RETIRED_ADMIN_ROUTES.find((rule) => rule.methods.has(req.method) && rule.test(req.path));
  if (retired) {
    return res.status(410).json({ error: 'This administrative panel section has been removed' });
  }
  return next();
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const SUBSCRIPTION_BASE_URL = process.env.SUBSCRIPTION_BASE_URL || '';

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeHttpsUrl(value, { allowEmpty = true, originOnly = false } = {}) {
  const input = String(value || '').trim();
  if (!input && allowEmpty) return '';
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('URL must be a valid HTTPS address');
  }
  if (parsed.protocol !== 'https:') throw new Error('URL must use HTTPS');
  if (originOnly) return parsed.origin;
  return input.replace(/\/+$/, '');
}

function normalizeXrayRange(value, name, { minimum = 0, maximum = 2000 } = {}) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) throw new Error(`${name} must be an integer or range`);
  const from = Number(match[1]);
  const to = Number(match[2] ?? match[1]);
  if (from < minimum || to > maximum || from > to) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return from === to ? String(from) : `${from}-${to}`;
}

async function buildMobileAdminPayload(panel = null) {
  const settings = panel || await getPanelSettings();
  const servers = await listServers();
  let activePublicSessions = 0;
  try {
    const sessions = await query(
      `SELECT COUNT(*)::int AS count
       FROM mobile_sessions
       WHERE access_mode = 'public' AND revoked_at IS NULL AND expires_at > NOW()`
    );
    activePublicSessions = Number(sessions.rows[0]?.count || 0);
  } catch {
    activePublicSessions = 0;
  }
  const auth = mobileAuthSummary();
  const mobileServers = servers.filter((server) =>
    server.enabled !== false &&
    server.mobileEnabled === true &&
    server.mobileMaintenance !== true
  ).length;
  return {
    settings: {
      enabled: settings.mobileAppEnabled !== false,
      diagnosticsEnabled: settings.mobileDiagnosticsEnabled !== false,
      apiBaseUrl: String(settings.mobileApiBaseUrl || 'https://levospeed.it.com'),
      profileRefreshHours: Number(settings.mobileProfileRefreshHours ?? 12),
      fragmentationEnabled: settings.mobileFragmentationEnabled !== false,
      fragmentationPackets: String(settings.mobileFragmentationPackets || 'tlshello'),
      fragmentationLength: String(settings.mobileFragmentationLength || '2'),
      fragmentationInterval: String(settings.mobileFragmentationInterval || '0-1'),
      fragmentationMaxSplit: String(settings.mobileFragmentationMaxSplit || '3-6'),
      latestVersionCode: Number(settings.mobileLatestVersion || 1),
      latestVersionName: String(settings.mobileLatestVersionName || '1.0.0'),
      minimumVersionCode: Number(settings.mobileMinimumVersion || 1),
      apkUrl: String(settings.mobileApkUrl || ''),
      apkSha256: String(settings.mobileApkSha256 || ''),
      releaseSignature: String(settings.mobileReleaseSignature || ''),
      changelog: String(settings.mobileChangelog || ''),
    },
    status: {
      backendConfigured: auth.configured,
      publicAccessConfigured: auth.publicAccessEnabled,
      mobileServers,
      activePublicSessions,
    },
    release: buildMobileReleaseInfo(settings),
  };
}

function isMobileTransportSupported(server) {
  return (
    String(server?.host || '').trim().length > 0 &&
    String(server?.protocol || 'vless').toLowerCase() === 'vless' &&
    String(server?.network || 'ws').toLowerCase() === 'ws' &&
    String(server?.security || 'tls').toLowerCase() === 'tls'
  );
}

function mobileServerAdminView(server, panel = {}) {
  const latestVersion = Math.max(1, Number(panel.mobileLatestVersion || 1));
  const transportSupported = isMobileTransportSupported(server);
  const eligible = server?.enabled !== false && transportSupported;
  let unavailableReason = null;
  if (server?.enabled === false) unavailableReason = 'Сервер отключён в основной панели';
  else if (!String(server?.host || '').trim()) unavailableReason = 'У сервера не настроен host';
  else if (!transportSupported) unavailableReason = 'DADA v1 поддерживает только VLESS + WebSocket + TLS';

  return {
    id: String(server?.id || ''),
    name: String(server?.name || server?.id || ''),
    country: String(server?.country || ''),
    flag: String(server?.flag || ''),
    enabled: server?.enabled !== false,
    mobileEnabled: server?.mobileEnabled === true,
    mobileDisplayName: String(server?.mobileDisplayName || server?.country || server?.name || ''),
    mobileCountryCode: countryCodeForServer(server),
    mobilePriority: Number(server?.mobilePriority ?? server?.sortOrder ?? 0),
    mobileMinVersion: Math.max(1, Number(server?.mobileMinVersion || 1)),
    mobileMaintenance: server?.mobileMaintenance === true,
    transportSupported,
    eligible,
    unavailableReason,
    visibleInCurrentVersion: isMobileServerSupported(server, latestVersion),
  };
}

async function buildHiddifyAndroidAdminPayload(panel = null) {
  const settings = panel || await getPanelSettings();
  const servers = await listServers();
  let activeSessions = 0;
  try {
    const sessions = await query(
      `SELECT COUNT(*)::int AS count FROM mobile_sessions
       WHERE access_mode = 'hiddify-android' AND revoked_at IS NULL AND expires_at > NOW()`
    );
    activeSessions = Number(sessions.rows[0]?.count || 0);
  } catch {
    activeSessions = 0;
  }
  const publicAccess = hiddifyAndroidPublicAccessConfig();
  const managedServers = servers.filter((server) =>
    server.enabled !== false &&
    isHiddifyAndroidMembershipEnabled(server) &&
    server.hiddifyAndroidMaintenance !== true
  ).length;
  return {
    settings: {
      enabled: settings.hiddifyAndroidEnabled !== false,
      apiBaseUrl: String(settings.hiddifyAndroidApiBaseUrl || 'https://levospeed.it.com'),
      profileRefreshHours: Number(settings.hiddifyAndroidProfileRefreshHours ?? 12),
      fragmentationEnabled: settings.hiddifyAndroidFragmentationEnabled !== false,
      latestVersionCode: Number(settings.hiddifyAndroidLatestVersion || 1),
      latestVersionName: String(settings.hiddifyAndroidLatestVersionName || '0.1.0'),
      minimumVersionCode: Number(settings.hiddifyAndroidMinimumVersion || 1),
      apkUrl: String(settings.hiddifyAndroidApkUrl || ''),
      apkSha256: String(settings.hiddifyAndroidApkSha256 || ''),
      changelog: String(settings.hiddifyAndroidChangelog || ''),
    },
    status: {
      publicAccessConfigured: publicAccess.enabled && Boolean(publicAccess.uuid),
      managedServers,
      activeSessions,
    },
    release: buildHiddifyAndroidReleaseInfo(settings),
  };
}

function hiddifyAndroidServerAdminView(server, panel = {}) {
  const latestVersion = Math.max(1, Number(panel.hiddifyAndroidLatestVersion || 1));
  const transportSupported = isHiddifyAndroidTransportSupported(server);
  const eligible = server?.enabled !== false && transportSupported;
  let unavailableReason = null;
  if (server?.enabled === false) unavailableReason = 'Сервер отключён в основной панели';
  else if (!String(server?.host || '').trim()) unavailableReason = 'У сервера не настроен host';
  else if (!transportSupported) unavailableReason = 'Первая версия поддерживает VLESS + WebSocket + TLS';
  return {
    id: String(server?.id || ''),
    name: String(server?.name || server?.id || ''),
    country: String(server?.country || ''),
    flag: String(server?.flag || ''),
    enabled: server?.enabled !== false,
    hiddifyAndroidEnabled: isHiddifyAndroidMembershipEnabled(server),
    hiddifyAndroidInherited: typeof server?.hiddifyAndroidEnabled !== 'boolean',
    hiddifyAndroidDisplayName: String(
      server?.hiddifyAndroidDisplayName || server?.country || server?.name || ''
    ),
    hiddifyAndroidCountryCode: hiddifyAndroidCountryCode(server),
    hiddifyAndroidPriority: Number(server?.hiddifyAndroidPriority ?? server?.sortOrder ?? 0),
    hiddifyAndroidMinVersion: Math.max(1, Number(server?.hiddifyAndroidMinVersion || 1)),
    hiddifyAndroidMaintenance: server?.hiddifyAndroidMaintenance === true,
    transportSupported,
    eligible,
    unavailableReason,
    visibleInCurrentVersion: isHiddifyAndroidServerSupported(server, latestVersion),
  };
}

function getSubscriptionBaseUrl(settings = {}) {
  return trimTrailingSlash(settings.subscriptionBaseUrl || SUBSCRIPTION_BASE_URL || PUBLIC_BASE_URL);
}

function isOwner(req) {
  return req.admin?.role === 'owner';
}

function assertOwner(req, res) {
  if (isOwner(req)) return true;
  res.status(403).json({ error: 'Owner access required' });
  return false;
}

function scopeUsersForRequest(req, users) {
  if (isOwner(req)) return users;
  if (req.admin?.role === 'dealer') {
    return users.filter((user) => user.dealerId === req.admin.dealerId);
  }
  return [];
}

async function getScopedUser(req, userId) {
  const user = await getUserById(userId);
  if (!user) return null;
  if (isOwner(req)) return user;
  if (req.admin?.role === 'dealer' && user.dealerId === req.admin.dealerId) return user;
  return null;
}

async function buildGlobalSubscriptionUrls(global) {
  const panel = await getPanelSettings();
  const subscriptionBaseUrl = getSubscriptionBaseUrl(panel);
  const storagePath = getGlobalSubscriptionPath();
  const publicStorageUrl = global.publicStorageUrl || buildPublicStorageUrl(storagePath);
  const storageUrl =
    publicStorageUrl ||
    global.storageUrl ||
    (await resolveStorageUrl(storagePath, global.storageDownloadToken));
  const panelUrl = subscriptionBaseUrl ? `${subscriptionBaseUrl}/sub/global` : `${PUBLIC_BASE_URL}/sub/global`;
  return {
    publicStorageUrl,
    storageUrl,
    subscriptionUrl: storageUrl || panelUrl,
    panelUrl,
    storagePath,
  };
}

async function applyAddressIpsToServers(addressIps) {
  const normalized = Array.from(new Set(normalizeAddressIps(addressIps))).slice(0, 3);
  if (!normalized.length) {
    throw new Error('At least one IP/address is required');
  }

  const servers = await listServers();
  const updated = [];

  for (const [index, server] of servers.entries()) {
    const addressIp = normalized[index % normalized.length];
    // This action is deliberately IP-only.  The SNI, Host, path, transport
    // and TLS fingerprint are independent settings and must not be silently
    // replaced when an operator rotates an edge address.
    const update = { addressIp, updatedAt: nowIso() };
    if (server.addressIp === update.addressIp) {
      continue;
    }
    await updateServer(server.id, {
      ...update,
    });
    updated.push({ id: server.id, name: server.name, addressIp });
  }

  return { addressIps: normalized, serversTotal: servers.length, updated };
}

router.post(
  '/auth/login',
  createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.LOGIN_RATE_LIMIT_MAX || 8),
    message: 'Too many login attempts. Try again in 15 minutes.',
  }),
  async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const admin = await loginAdmin(username, password);
    if (!admin) return res.status(401).json({ error: 'Invalid username or password' });
    const token = signSession(admin);
    res.cookie('panel_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure || req.get('x-forwarded-proto') === 'https',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true, admin, token });
  } catch (err) {
    console.error('POST /admin/auth/login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
  }
);

router.post('/auth/logout', (req, res) => {
  res.clearCookie('panel_session');
  res.json({ ok: true });
});

router.get('/panel-i18n.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, '..', 'public', 'panel-i18n.js'));
});

router.use(requireAdmin);

function assertManagedServerOwner(req, res) {
  if (req.admin?.role === 'owner' || req.admin?.id === 'admin-key') return true;
  res.status(403).json({ error: 'Owner access required' });
  return false;
}

function managedServerError(res, error) {
  const message = error?.message || String(error);
  const status = /not found/i.test(message) ? 404 : /required|invalid|fingerprint|timeout/i.test(message) ? 400 : 500;
  return res.status(status).json({ error: message });
}

router.get('/managed-servers', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try {
    const servers = await listManagedServers();
    const withServices = await Promise.all(servers.map(async (server) => ({
      ...server,
      services: await listManagedServices(server.id),
      outline: await getOutlineInstance(server.id),
    })));
    res.json({ servers: withServices });
  } catch (error) { managedServerError(res, error); }
});

router.post('/managed-servers/sync', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try {
    const result = await syncManagedServersFromRegistry(await listServers());
    res.json({ ok: true, ...result });
  } catch (error) { managedServerError(res, error); }
});

router.post('/managed-servers', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try {
    const server = await createManagedServer(req.body || {});
    try {
      const xrayRuntime = await ensureManagedXrayRuntime(server.id);
      const inventory = await inventoryManagedServer(server.id);
      res.status(201).json({ ok: true, server: await getManagedServer(server.id), xrayRuntime: { ready: true, version: String(xrayRuntime.stdout || '').trim() }, ...inventory });
    } catch (error) {
      await setManagedServerStatus(server.id, { status: 'error', lastError: error.message });
      res.status(422).json({ error: error.message, server: await getManagedServer(server.id) });
    }
  } catch (error) { managedServerError(res, error); }
});

// UUIDs are authoritative in the main users table.  This endpoint deliberately
// returns only the fields needed by the Xray client selector; subscription
// tokens and other client secrets never leave the server.
router.get('/managed-servers/client-options', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try {
    const clients = (await listUsers(10000))
      .filter((user) => isUserActive(user) && /^[0-9a-f-]{36}$/i.test(String(user.uuid || '')))
      .map((user) => ({
        id: user.id,
        name: user.name || user.id,
        uuid: user.uuid,
        expiresAt: user.expiresAt || null,
      }));
    res.json({ clients });
  } catch (error) { managedServerError(res, error); }
});

function inventoryXrayPort(services = []) {
  const ports = new Set(services.flatMap((service) => Array.isArray(service.ports) ? service.ports : [])
    .map((port) => Number(port)).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535));
  // Inventory reports listening ports globally, so prefer the conventional
  // Xray ingress ports and never select SSH/health/reporter ports.
  const excluded = new Set([22, 80, 18108, 18109, 18080, 18088, 18089, 18091, 10050, 5020]);
  return [443, 8443, 10443, 7865, 18444, 2053, 2083, 2087, 2096]
    .find((port) => ports.has(port) && !excluded.has(port))
    || [...ports].find((port) => !excluded.has(port))
    || null;
}

async function listManagedXrayOutboundTargets(excludeServerId = '') {
  const servers = await listManagedServers();
  const publishedServers = await listServers();
  const activeUsers = (await listUsers(10000))
    .filter((user) => isUserActive(user) && /^[0-9a-f-]{36}$/i.test(String(user.uuid || '')));
  const defaultUuid = String(activeUsers[0]?.uuid || '').trim();
  const targets = [];
  for (const server of servers) {
    if (String(server.id) === String(excludeServerId || '')) continue;
    const tunnels = await listManagedXrayTunnels(server.id);
    for (const tunnel of tunnels) {
      const inbound = tunnel.config?.inbounds?.[0] || {};
      const stream = inbound.streamSettings || {};
      const client = inbound.settings?.clients?.[0] || {};
      const port = Number(inbound.port || 0);
      const uuid = String(client.id || '').trim();
      if (!server.address || !Number.isInteger(port) || port < 1 || !/^[0-9a-f-]{36}$/i.test(uuid)) continue;
      const ws = stream.wsSettings || {};
      targets.push({
        id: `${server.id}:${tunnel.id}`,
        serverId: server.id,
        tunnelId: tunnel.id,
        serverName: server.name || server.address,
        address: server.address,
        country: server.country || '',
        port,
        uuid,
        network: stream.network || 'tcp',
        security: stream.security || 'none',
        sni: stream.tlsSettings?.serverName || '',
        host: ws.headers?.Host || '',
        path: ws.path || '/',
        tunnelName: tunnel.name || tunnel.id,
        status: tunnel.status || 'unknown',
        source: 'managed-tunnel',
        configured: true,
      });
    }

    // Prefer the panel's authoritative public server definition when the VPS
    // predates managed-tunnel registration.  The physical origin usually only
    // listens on localhost; the published address/SNI/Host/WS path is the
    // actual endpoint that clients use through the CDN/front door.
    if (!tunnels.length) {
      const candidates = publishedServers
        .filter((item) => String(item.originAddress || '') === String(server.address || '')
          && String(item.protocol || '').toLowerCase() === 'vless'
          && String(item.addressIp || '').trim()
          && String(item.addressIp || '').trim() !== '127.0.0.1'
          && Number.isInteger(Number(item.port))
          && Number(item.port) > 0
          && item.network)
        .sort((a, b) => Number(Boolean(b.enabled && !b.subscriptionHidden)) - Number(Boolean(a.enabled && !a.subscriptionHidden)));
      const published = candidates[0];
      if (published && defaultUuid) {
        targets.push({
          id: `${server.id}:registry:${published.id}`,
          serverId: server.id,
          tunnelId: null,
          serverName: server.name || server.address,
          address: published.addressIp,
          country: published.country || server.country || '',
          port: Number(published.port),
          uuid: defaultUuid,
          network: published.network || 'tcp',
          security: published.security || 'none',
          sni: published.sni || '',
          host: published.host || '',
          path: published.path || published.wsPath || '/',
          tunnelName: published.name || published.id,
          status: published.enabled === false ? 'published-disabled' : 'published',
          source: 'server-registry',
          configured: true,
        });
      }
    }

    // Older VPSs were inventoried before the panel's managed-tunnel table was
    // introduced.  They still have a real Xray systemd service, but therefore
    // had no option in the outbound selector.  Expose one safe, deterministic
    // target for those servers too.  The UUID is taken from the authoritative
    // clients table and is replaced with the selected client's UUID on create.
    if (!tunnels.length && !targets.some((target) => target.serverId === server.id) && defaultUuid) {
      const services = await listManagedServices(server.id);
      const xrayServices = services.filter((service) => {
        const name = `${service.serviceName || ''} ${service.data?.description || ''}`.toLowerCase();
        return /xray/.test(name) && !/(traffic|reporter|relay|routing)/.test(name) && !/inactive|exited/.test(String(service.status || '').toLowerCase());
      });
      const port = inventoryXrayPort(xrayServices);
      if (server.address && port) {
        const primary = xrayServices[0];
        const serviceName = primary?.serviceName || 'Xray service';
        const looksWs = /(?:ws|websocket)/i.test(`${serviceName} ${primary?.data?.description || ''}`);
        targets.push({
          id: `${server.id}:inventory-xray`,
          serverId: server.id,
          tunnelId: null,
          serverName: server.name || server.address,
          address: server.address,
          country: server.country || '',
          port,
          uuid: defaultUuid,
          network: looksWs ? 'ws' : 'tcp',
          security: looksWs ? 'tls' : 'none',
          sni: '',
          host: '',
          path: '/',
          tunnelName: `${serviceName} (инвентаризация)`,
          status: primary?.status || 'unknown',
          source: 'inventory',
          configured: false,
        });
      }
    }
  }
  return targets;
}

router.get('/managed-servers/xray/outbound-targets', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try { res.json({ targets: await listManagedXrayOutboundTargets(String(req.query.excludeServerId || '')) }); }
  catch (error) { managedServerError(res, error); }
});

router.get('/managed-servers/:id', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try {
    const server = await getManagedServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Managed server not found' });
    res.json({ server, services: await listManagedServices(server.id), outline: await getOutlineInstance(server.id), xray: await listManagedXrayTunnels(server.id), outboundTargets: await listManagedXrayOutboundTargets(server.id) });
  } catch (error) { managedServerError(res, error); }
});

router.patch('/managed-servers/:id', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try { res.json({ ok: true, server: await updateManagedServer(req.params.id, req.body || {}) }); }
  catch (error) { managedServerError(res, error); }
});

router.delete('/managed-servers/:id', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try {
    // Removing a managed server only removes its panel registry/inventory
    // records. It must never connect to the VPS or stop remote services.
    await deleteManagedServer(req.params.id);
    res.json({ ok: true, removedFromPanel: true, remoteServerUntouched: true });
  } catch (error) { managedServerError(res, error); }
});

router.post('/managed-servers/:id/inventory', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try { res.json({ ok: true, inventory: await inventoryManagedServer(req.params.id) }); }
  catch (error) { await setManagedServerStatus(req.params.id, { status: 'error', lastError: error.message }).catch(() => {}); managedServerError(res, error); }
});

router.post('/managed-servers/:id/probe', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try { res.json({ ok: true, availability: await probeManagedServer(req.params.id) }); }
  catch (error) { managedServerError(res, error); }
});

router.get('/managed-servers/:id/services', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try { res.json({ services: await listManagedServices(req.params.id) }); }
  catch (error) { managedServerError(res, error); }
});

router.delete('/managed-servers/:id/services/:type/:name', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try { res.json({ ok: true, inventory: await removeManagedService(req.params.id, req.params.name, req.params.type) }); }
  catch (error) { managedServerError(res, error); }
});

router.post('/managed-servers/:id/outline/install', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try {
    const result = await installOutlineOnServer(req.params.id);
    const registered = await registerOutlineAccessFile(req.params.id, result.stdout);
    await inventoryManagedServer(req.params.id);
    const managedServer = await getManagedServer(req.params.id);
    const serverRegistry = managedServer ? await publishManagedOutlineServer(managedServer) : null;
    res.json({ ok: true, outline: { status: 'ready', keyCount: registered.keyCount, certificateFingerprint: registered.certSha256 }, serverRegistry: serverRegistry ? { id: serverRegistry.id, visible: true } : null });
  } catch (error) { managedServerError(res, error); }
});

router.get('/managed-servers/:id/outline/status', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try { res.json({ outline: await getOutlineStatus(req.params.id) }); }
  catch (error) { managedServerError(res, error); }
});

router.post('/managed-servers/:id/outline/keys', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try {
    const key = await createOutlineKey(req.params.id, { name: req.body?.name || '', limitBytes: req.body?.limitBytes ?? null });
    const managedServer = await getManagedServer(req.params.id);
    let port = null;
    try { port = Number(new URL(key.accessUrl || '').port) || null; } catch {}
    const serverRegistry = managedServer ? await publishManagedOutlineServer(managedServer, { port }) : null;
    res.status(201).json({ ok: true, key, serverRegistry: serverRegistry ? { id: serverRegistry.id, visible: true } : null });
  } catch (error) { managedServerError(res, error); }
});

router.get('/managed-servers/:id/outline/keys', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try { res.json({ keys: await listOutlineKeys(req.params.id) }); }
  catch (error) { managedServerError(res, error); }
});

router.delete('/managed-servers/:id/outline/keys/:keyId', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try { await deleteOutlineKey(req.params.id, req.params.keyId); res.json({ ok: true }); }
  catch (error) { managedServerError(res, error); }
});

router.get('/managed-servers/:id/xray/tunnels', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try { res.json({ tunnels: await listManagedXrayTunnels(req.params.id) }); }
  catch (error) { managedServerError(res, error); }
});

router.post('/managed-servers/:id/xray/tunnels', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try {
    const xrayRuntime = await ensureManagedXrayRuntime(req.params.id);
    const input = { ...(req.body || {}) };
    let outboundTarget = null;
    if (input.outbound?.protocol === 'vless') {
      const targetId = String(input.outbound.targetId || '').trim();
      outboundTarget = (await listManagedXrayOutboundTargets(req.params.id)).find((item) => item.id === targetId) || null;
      if (!outboundTarget) throw new Error('Выберите существующий Xray-сервис из раздела «Реальные серверы»');
    }
    const clientMode = String(input.clientMode || 'none');
    const users = await listUsers(10000);
    const activeUsers = users.filter((user) => isUserActive(user) && /^[0-9a-f-]{36}$/i.test(String(user.uuid || '')));
    let targetUsers = [];
    if (clientMode === 'all') {
      targetUsers = activeUsers;
      if (!targetUsers.length) return res.status(400).json({ error: 'В базе нет активных клиентов с UUID' });
    } else if (clientMode === 'selected') {
      const target = activeUsers.find((user) => String(user.id) === String(input.clientId || ''));
      if (!target) return res.status(400).json({ error: 'Выбранный клиент не найден или неактивен' });
      targetUsers = [target];
    } else if (clientMode !== 'none') {
      return res.status(400).json({ error: 'Неизвестный режим назначения UUID' });
    }
    if (targetUsers.length) input.clientUuids = targetUsers.map((user) => user.uuid);
    if (outboundTarget) {
      input.outbound = {
        protocol: 'vless',
        address: outboundTarget.address,
        port: outboundTarget.port,
        // For inventory-only services use the selected client's UUID.  These
        // older Xray services are synchronized from the same authoritative
        // client table, while managed tunnels retain their registered UUID.
        uuid: targetUsers[0]?.uuid || outboundTarget.uuid,
        network: outboundTarget.network,
        security: outboundTarget.security,
        sni: outboundTarget.sni,
        host: outboundTarget.host,
        path: outboundTarget.path,
      };
    }
    delete input.clientMode;
    delete input.clientId;

    const tunnel = await createManagedXrayTunnel(req.params.id, input);
    const managedServer = await getManagedServer(req.params.id);
    let serverRegistry = null;
    try {
      serverRegistry = managedServer ? await publishManagedXrayServer(managedServer, tunnel) : null;
    } catch (error) {
      // The tunnel is already applied; registry publication must not interrupt it.
      console.error('Managed Xray server registry sync failed:', error?.message || error);
    }
    let clientsAdded = 0;
    const clientFailures = [];
    const subscriptionSyncUsers = [];
    if (targetUsers.length) {
      const inbound = tunnel.config?.inbounds?.[0] || {};
      const stream = inbound.streamSettings || {};
      const wsSettings = stream.wsSettings || {};
      const shareServer = {
        id: `managed-xray-${tunnel.id}`,
        name: tunnel.name || managedServer?.name || managedServer?.address,
        country: managedServer?.country || 'Server',
        flag: managedServer?.flag || '',
        addressIp: managedServer?.address || '',
        port: inbound.port,
        network: stream.network || (tunnel.template === 'vless-ws-tls' ? 'ws' : 'tcp'),
        security: stream.security || (tunnel.template === 'vless-ws-tls' ? 'tls' : 'none'),
        host: wsSettings.headers?.Host || stream.tlsSettings?.serverName || managedServer?.address || '',
        sni: stream.tlsSettings?.serverName || '',
        path: wsSettings.path || '/',
        fingerprint: 'chrome',
        alpn: 'http/1.1',
      };
      for (const user of targetUsers) {
        try {
          const latest = (await getUserById(user.id)) || user;
          const link = buildVlessLink(latest, shareServer, { subscriptionRemark: tunnel.name || shareServer.name });
          const nextLines = mergeExtraSubscriptionLines(latest.extraSubscriptionLines, [link]);
          await updateUser(latest.id, { extraSubscriptionLines: nextLines, updatedAt: nowIso() });
          clientsAdded += 1;
          subscriptionSyncUsers.push({ ...latest, extraSubscriptionLines: nextLines });
        } catch (error) {
          clientFailures.push({ userId: user.id, name: user.name || user.id, error: error.message || String(error) });
        }
      }
    }
    // Rebuilding Drive/storage files is slow and must not make the admin request
    // time out after the first client. Database assignments above are complete;
    // refresh all affected files in the background with bounded concurrency.
    const subscriptionSync = { queued: subscriptionSyncUsers.length > 0, requested: subscriptionSyncUsers.length };
    if (subscriptionSyncUsers.length) {
      void syncExtraSubscriptionFiles(subscriptionSyncUsers, {
        reloadUser: getUserById,
        upsertSubscriptionFile: upsertUserSubscriptionFile,
        concurrency: Number(process.env.EXTRA_LINK_SYNC_CONCURRENCY || 4),
      }).then((result) => {
        console.info(`Managed Xray subscription sync: ${result.refreshed}/${result.requested} updated` + (result.failed ? `, ${result.failed} failed` : ''));
      }).catch((error) => console.error('Managed Xray subscription sync failed:', error?.message || error));
    }
    res.status(201).json({ ok: true, tunnel, clientMode, clientsAdded, clientFailures, subscriptionSync, serverRegistry: serverRegistry ? { id: serverRegistry.id, visible: true } : null, xrayRuntime: { ready: true, version: String(xrayRuntime.stdout || '').trim() } });
  }
  catch (error) { managedServerError(res, error); }
});

router.patch('/managed-servers/:id/xray/tunnels/:tunnelId', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try { res.json({ ok: true, tunnel: await updateManagedXrayTunnel(req.params.id, req.params.tunnelId, req.body || {}) }); }
  catch (error) { managedServerError(res, error); }
});

router.post('/managed-servers/:id/xray/tunnels/:tunnelId/validate', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try { res.json(await validateManagedXrayTunnel(req.params.id, req.params.tunnelId)); }
  catch (error) { managedServerError(res, error); }
});

router.post('/managed-servers/:id/xray/tunnels/:tunnelId/restart', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try { res.json({ ok: true, tunnel: await restartManagedXrayTunnel(req.params.id, req.params.tunnelId) }); }
  catch (error) { managedServerError(res, error); }
});

router.delete('/managed-servers/:id/xray/tunnels/:tunnelId', async (req, res) => {
  if (!assertManagedServerOwner(req, res)) return;
  try { await deleteManagedXrayTunnel(req.params.id, req.params.tunnelId); res.json({ ok: true }); }
  catch (error) { managedServerError(res, error); }
});

router.get('/auth/me', (req, res) => {
  res.json({ admin: req.admin });
});

router.get('/dealers', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const dealers = await listDealers();
    res.json({ dealers });
  } catch (err) {
    console.error('GET /admin/dealers error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/dealers', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const { name, username, password, clientLimit = 0, status = 'active' } = req.body || {};
    if (!name || !username || !password) {
      return res.status(400).json({ error: 'name, username and password are required' });
    }
    const dealer = await createDealer({ name, username, password, clientLimit, status });
    await writeAuditLog({
      actor: req.admin,
      action: 'dealer.created',
      targetType: 'dealer',
      targetId: dealer.id,
      dealerId: dealer.id,
      data: { name: dealer.name, username: dealer.username, clientLimit: dealer.clientLimit, status: dealer.status },
    });
    res.json({ ok: true, dealer });
  } catch (err) {
    console.error('POST /admin/dealers error:', err);
    await writeAuditLog({
      actor: req.admin,
      action: 'dealer.create_failed',
      targetType: 'dealer',
      data: { error: err.message || String(err), username: req.body?.username || '' },
    }).catch(() => {});
    res.status(400).json({ error: err.message || 'Internal server error' });
  }
});

router.patch('/dealers/:id', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const { name, clientLimit, status, password } = req.body || {};
    const update = {};
    if (name !== undefined) update.name = name;
    if (clientLimit !== undefined) update.clientLimit = clientLimit;
    if (status !== undefined) update.status = status;
    if (password) update.password = password;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const dealer = await updateDealer(req.params.id, update);
    if (!dealer) return res.status(404).json({ error: 'Dealer not found' });

    await writeAuditLog({
      actor: req.admin,
      action: 'dealer.updated',
      targetType: 'dealer',
      targetId: dealer.id,
      dealerId: dealer.id,
      data: {
        name: dealer.name,
        clientLimit: dealer.clientLimit,
        status: dealer.status,
        passwordChanged: Boolean(password),
      },
    });

    res.json({ ok: true, dealer });
  } catch (err) {
    console.error('PATCH /admin/dealers/:id error:', err);
    res.status(400).json({ error: err.message || 'Internal server error' });
  }
});

router.delete('/dealers/:id', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const { id } = req.params;
    const dealer = await getDealerById(id);
    if (!dealer) return res.status(404).json({ error: 'Dealer not found' });

    const userCount = await countDealerUsers(id);
    if (userCount && !req.query.force) {
      return res.status(409).json({
        error: 'Dealer has clients',
        userCount,
        hint: 'Remove clients first or use ?force=true to unlink them',
      });
    }

    const result = await deleteDealer(id, { force: req.query.force === 'true' });

    await writeAuditLog({
      actor: req.admin,
      action: 'dealer.deleted',
      targetType: 'dealer',
      targetId: id,
      dealerId: id,
      data: { name: dealer.name, username: dealer.username, unlinkedUsers: result.unlinkedUsers || 0 },
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('DELETE /admin/dealers/:id error:', err);
    if (err.code === 'DEALER_HAS_CLIENTS') {
      return res.status(409).json({
        error: err.message,
        userCount: err.userCount,
        hint: 'Use ?force=true to unlink clients and delete dealer',
      });
    }
    res.status(400).json({ error: err.message || 'Internal server error' });
  }
});

router.post('/users', async (req, res) => {
  try {
    const {
      name,
      email,
      days = 30,
      trafficLimitGB = 50,
      serverIds,
      uuid: customUuid,
      note = '',
      status: requestedStatus,
      subscriptionMode = 'auto',
      customSubscriptionContent = '',
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    let dealer = null;
    if (req.admin?.role === 'dealer') {
      dealer = await getDealerById(req.admin.dealerId);
      if (!dealer || dealer.status !== 'active') return res.status(403).json({ error: 'Dealer disabled' });
      const currentCount = await countDealerUsers(dealer.id);
      if (dealer.clientLimit > 0 && currentCount >= dealer.clientLimit) {
        return res.status(403).json({ error: 'Dealer client limit exceeded' });
      }
    }

    const panel = await getPanelSettings();
    const relayServerIds = panel.subscriptionRelayOnly ? await listEnabledRelayServerIds() : [];

    const resolvedServerIds = req.admin?.role === 'dealer'
      ? await getEnabledServerIds({ forNewUser: true })
      : Array.isArray(serverIds) && serverIds.length
      ? serverIds
      : await getEnabledServerIds({ forNewUser: true });

    if (!resolvedServerIds.length && !relayServerIds.length) {
      return res.status(400).json({ error: 'No servers available. Add servers first.' });
    }

    const token = randomToken();
    const tokenHash = sha256(token);
    const userUuid = resolveUserUuid(customUuid);
    const existingUsers = await listUsers();
    if (existingUsers.some((u) => String(u.uuid).toLowerCase() === userUuid)) {
      return res.status(409).json({ error: 'UUID already used by another user' });
    }
    const now = new Date();
    const expiresAt = addDays(now, days);

    const userStatus = requestedStatus === 'disabled' ? 'disabled' : 'active';

    const userDoc = {
      name,
      email: email || null,
      uuid: userUuid,
      tokenHash,
      subscriptionToken: token,
      status: userStatus,
      createdAt: now.toISOString(),
      periodStartedAt: now.toISOString(),
      subscriptionPeriodDays: Math.max(1, Math.floor(Number(days) || 30)),
      updatedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      trafficLimitGB: Number(trafficLimitGB),
      trafficUsedGB: 0,
      uploadUsedGB: 0,
      downloadUsedGB: 0,
      mobileAccessEnabled: true,
      serverIds: resolvedServerIds,
      subscriptionMode: req.admin?.role === 'dealer' ? 'auto' : subscriptionMode,
      customSubscriptionContent: req.admin?.role === 'dealer' ? '' : customSubscriptionContent,
      note,
      extraSubscriptionLines: normalizeExtraSubscriptionLines(panel.globalExtraSubscriptionLines),
      ownerType: req.admin?.role === 'dealer' ? 'dealer' : 'owner',
      dealerId: req.admin?.role === 'dealer' ? req.admin.dealerId : req.body.dealerId || null,
    };

    if (userStatus === 'disabled') {
      userDoc.disabledReason = req.body.disabledReason || 'manual';
      userDoc.disabledAt = now.toISOString();
    }

    Object.assign(userDoc, await applyRelayUserDefaults(userDoc, panel));

    const userId = await createUser(userDoc);
    const userRecord = { id: userId, ...userDoc };
    let subscriptionFile = null;
    try {
      subscriptionFile = await upsertUserSubscriptionFile(userRecord);
      if (
        subscriptionFile?.id &&
        !subscriptionFile.publicStorageUrl &&
        !subscriptionFile.storage?.publicStorageUrl
      ) {
        const { refreshFileStorageUrl } = await import('../lib/files.js');
        subscriptionFile = await refreshFileStorageUrl(subscriptionFile.id);
      }
    } catch (fileErr) {
      console.error('Subscription file upsert after create user:', fileErr);
    }

    const meta = await buildMetaForUser(userRecord);
    const fileForUrls = subscriptionFile
      ? {
          ...subscriptionFile,
          publicStorageUrl:
            subscriptionFile.publicStorageUrl || subscriptionFile.storage?.publicStorageUrl,
          storageUrl: subscriptionFile.storageUrl || subscriptionFile.storage?.storageUrl,
          storageUrlWithToken:
            subscriptionFile.storageUrlWithToken ||
            subscriptionFile.storage?.storageUrlWithToken ||
            subscriptionFile.storage?.storageUrl,
          storageDownloadToken:
            subscriptionFile.storageDownloadToken || subscriptionFile.storage?.storageDownloadToken,
        }
      : null;
    const urls = await buildUserSubscriptionUrls({
      userId,
      token,
      subscriptionFile: fileForUrls,
    });

    let vpnEdgeSync;
    let relayEdgeSync = null;
    if (userStatus === 'active') {
      if (panel.subscriptionRelayOnly) {
        relayEdgeSync = scheduleRelayEdgeSync({ immediate: true });
        vpnEdgeSync = {
          ok: true,
          skipped: true,
          message: 'Синхронизация реестра VPS выполнена через relay-агенты',
        };
      } else {
        try {
          const edgeServerIds = userDoc.bonusServerIds?.length
            ? userDoc.bonusServerIds.map(String)
            : resolvedServerIds;
          const warmIds = await resolveWarmServerIds(edgeServerIds);
          vpnEdgeSync = await syncVpnEdgeClientsPhased({
            serverIds: edgeServerIds,
            priorityServerIds: warmIds,
          });
        } catch (syncErr) {
          console.error('VPN edge sync after create user:', syncErr);
          vpnEdgeSync = { ok: false, error: syncErr.message || String(syncErr) };
        }
      }
    } else {
      vpnEdgeSync = { ok: true, skipped: true, message: 'Edge sync skipped for disabled user' };
    }
    await writeAuditLog({
      actor: req.admin,
      action: 'client.created',
      targetType: 'user',
      targetId: userId,
      dealerId: userDoc.dealerId,
      data: {
        name,
        role: req.admin?.role || 'owner',
        days: Number(days),
        trafficLimitGB: Number(trafficLimitGB),
        serverCount: resolvedServerIds.length,
      },
    });

    res.json({
      userId,
      uuid: userUuid,
      uuidMode: customUuid ? 'custom' : 'unique',
      subscriptionUrl: urls.subscriptionUrl,
      panelProxyUrl: urls.panelProxyUrl || urls.panelSubscriptionUrl || urls.panelFileUrl,
      panelSubscriptionUrl: urls.panelSubscriptionUrl,
      subscriptionBaseUrl: urls.subscriptionBaseUrl,
      panelBlockedInTm: urls.panelBlockedInTm,
      publicStorageUrl: urls.publicStorageUrl || null,
      googleDriveUrl: urls.googleDriveUrl || null,
      storageUrlWithToken: urls.storageUrlWithToken || null,
      fileUrl: urls.fileUrl,
      storageUrl: urls.storageUrl || subscriptionFile?.storageUrl || null,
      publicAccessNote: subscriptionFile?.storage?.publicAccessNote || null,
      subscriptionToken: token,
      expiresAt: expiresAt.toISOString(),
      serverIds: resolvedServerIds,
      daysRemaining: meta.daysRemaining,
      trafficLimitGB: meta.trafficLimitGB,
      trafficUsedGB: meta.trafficUsedGB,
      profileTitle: meta.profileTitle,
      vpnEdgeSync,
      relayEdgeSync,
      subscriptionFile,
      importNote: urls.importNote,
      importLinks: {
        import: urls.subscriptionUrl,
        ...(isOwner(req)
          ? {
              panelFile: urls.panelFileUrl || urls.fileUrl,
              storageWithToken: urls.storageUrlWithToken || null,
              publicStorage: urls.publicStorageUrl || null,
              googleDrive: urls.googleDriveUrl || null,
              panelSubscription: urls.panelSubscriptionUrl,
              subscriptionBaseUrl: urls.subscriptionBaseUrl,
              storage: urls.storageUrl || subscriptionFile?.storageUrl || null,
            }
          : {}),
      },
    });
  } catch (err) {
    console.error('POST /admin/users error:', err);
    await writeAuditLog({
      actor: req.admin,
      action: 'client.create_failed',
      targetType: 'user',
      dealerId: req.admin?.dealerId || req.body?.dealerId || null,
      data: { error: err.message || String(err), name: req.body?.name || '' },
    }).catch(() => {});
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/users', async (req, res) => {
  try {
    const users = scopeUsersForRequest(req, await listUsers());
    const files = await listFiles();
    const fileByUserId = new Map(
      files.filter((file) => file.linkedUserId).map((file) => [file.linkedUserId, file])
    );

    const panelSettings = await getPanelSettings();
    const usersWithUrls = await Promise.all(
      users.map(async (user) => {
        let record = user;
        if ((panelSettings.importUrlMode || 'api') === 'api' && !String(user.subscriptionToken || '').trim()) {
          const issued = await issueSubscriptionTokenIfMissing(user);
          record = issued.user;
        }
        const file = fileByUserId.get(record.id);
        const urls = await buildUrlsForUser(record, file, panelSettings);
        return {
          ...record,
          subscriptionUrl: urls.panelSubscriptionUrl || urls.subscriptionUrl,
          panelSubscriptionUrl: urls.panelSubscriptionUrl,
          publicStorageUrl: urls.publicStorageUrl,
          googleDriveUrl: urls.googleDriveUrl,
          fileUrl: urls.fileUrl,
          storageUrl: urls.storageUrl,
          storageUrlWithToken: urls.storageUrlWithToken,
          disabledReason: record.disabledReason || null,
        };
      })
    );

    res.json({ users: usersWithUrls, syncState: getBackgroundSyncState() });
  } catch (err) {
    console.error('GET /admin/users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/users/:id/mobile/activation-code', async (req, res) => {
  try {
    const user = await getScopedUser(req, req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.mobileAccessEnabled === false) {
      return res.status(409).json({ error: 'DADA VPN access is disabled for this user' });
    }
    const activation = await createMobileActivationCode(user.id, { validDays: 7 });
    await writeAuditLog({
      actor: req.admin,
      action: 'mobile.activation_created',
      targetType: 'user',
      targetId: user.id,
      dealerId: user.dealerId || null,
      data: { expiresAt: activation.expiresAt },
    });
    res.json({
      ok: true,
      code: activation.code,
      expiresAt: activation.expiresAt,
      note: 'The code is shown once and is not stored in plaintext.',
    });
  } catch (err) {
    console.error('POST /admin/users/:id/mobile/activation-code error:', err);
    res.status(err?.status || 500).json({ error: err?.message || 'Internal server error', code: err?.code });
  }
});

router.get('/users/:id/mobile/sessions', async (req, res) => {
  try {
    const user = await getScopedUser(req, req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const sessions = await listMobileSessions(user.id);
    res.json({
      mobileAccessEnabled: user.mobileAccessEnabled !== false,
      sessions,
      auth: mobileAuthSummary(),
    });
  } catch (err) {
    console.error('GET /admin/users/:id/mobile/sessions error:', err);
    res.status(err?.status || 500).json({ error: err?.message || 'Internal server error', code: err?.code });
  }
});

router.delete('/users/:id/mobile/sessions/:sessionId', async (req, res) => {
  try {
    const user = await getScopedUser(req, req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const revoked = await revokeMobileSession(user.id, req.params.sessionId, 'admin');
    if (!revoked) return res.status(404).json({ error: 'Mobile session not found' });
    await writeAuditLog({
      actor: req.admin,
      action: 'mobile.session_revoked',
      targetType: 'user',
      targetId: user.id,
      dealerId: user.dealerId || null,
      data: { sessionId: req.params.sessionId },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /admin/users/:id/mobile/sessions/:sessionId error:', err);
    res.status(err?.status || 500).json({ error: err?.message || 'Internal server error', code: err?.code });
  }
});

router.patch('/users/:id/mobile-access', async (req, res) => {
  try {
    const user = await getScopedUser(req, req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const enabled = req.body?.enabled === true;
    await updateUser(user.id, { mobileAccessEnabled: enabled, updatedAt: nowIso() });
    const revokedSessions = enabled ? 0 : await revokeAllMobileSessions(user.id, 'mobile-access-disabled');
    await writeAuditLog({
      actor: req.admin,
      action: enabled ? 'mobile.access_enabled' : 'mobile.access_disabled',
      targetType: 'user',
      targetId: user.id,
      dealerId: user.dealerId || null,
      data: { revokedSessions },
    });
    res.json({ ok: true, enabled, revokedSessions });
  } catch (err) {
    console.error('PATCH /admin/users/:id/mobile-access error:', err);
    res.status(err?.status || 500).json({ error: err?.message || 'Internal server error', code: err?.code });
  }
});

router.patch('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const scopedUser = await getScopedUser(req, id);
    if (!scopedUser) return res.status(404).json({ error: 'User not found' });
    const allowedFields = [
      'name',
      'email',
      'uuid',
      'status',
      'expiresAt',
      'trafficLimitGB',
      'trafficUsedGB',
      'uploadUsedGB',
      'downloadUsedGB',
      'serverIds',
      'note',
      'subscriptionMode',
      'customSubscriptionContent',
      'addressIps',
      'mobileAccessEnabled',
    ];
    const update = {};

    const dealerAllowedFields = ['name', 'status', 'expiresAt', 'trafficLimitGB', 'note', 'serverIds', 'mobileAccessEnabled'];
    for (const field of allowedFields) {
      if (!isOwner(req) && !dealerAllowedFields.includes(field)) continue;
      if (!(field in req.body)) continue;
      if (field === 'addressIps') {
        update.addressIps = Array.from(new Set(normalizeAddressIps(req.body.addressIps))).slice(0, 3);
        continue;
      }
      if (field === 'serverIds') {
        const resolvedServerIds = await normalizeAssignableServerIds(req.body.serverIds);
        if (!resolvedServerIds) {
          return res.status(400).json({ error: 'Select at least one enabled server' });
        }
        update.serverIds = resolvedServerIds;
        continue;
      }
      update[field] = req.body[field];
    }

    if (req.body.status === 'active') {
      update.disabledReason = null;
      update.disabledAt = null;
    } else if (req.body.status === 'disabled') {
      update.disabledReason = req.body.disabledReason || 'manual';
      update.disabledAt = nowIso();
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    update.updatedAt = nowIso();
    await updateUser(id, update);
    const revokedMobileSessions = update.mobileAccessEnabled === false
      ? await revokeAllMobileSessions(id, 'mobile-access-disabled')
      : 0;

    let enforcement = null;
    if (
      'trafficUsedGB' in req.body ||
      'uploadUsedGB' in req.body ||
      'downloadUsedGB' in req.body ||
      'expiresAt' in req.body
    ) {
      enforcement = await enforceUserLimits(id);
    }

    const shouldRefreshSubscription =
      ['status', 'expiresAt', 'trafficLimitGB', 'trafficUsedGB', 'uploadUsedGB', 'downloadUsedGB', 'uuid'].some(
        (field) => field in req.body
      ) ||
      enforcement?.changed ||
      ['name', 'serverIds', 'subscriptionMode', 'customSubscriptionContent', 'addressIps'].some((f) => f in req.body);

    let vpnEdgeSync = null;
    let subscriptionFile = null;
    let relayEdgeSync = null;
    if (shouldRefreshSubscription) {
      try {
        const user = await getUserById(id);
        if (user) {
          const refreshed = await refreshUserSubscriptionAndEdge(user);
          subscriptionFile = refreshed.subscriptionFile;
          vpnEdgeSync = refreshed.vpnEdgeSync;
          relayEdgeSync = refreshed.relayEdgeSync;
        }
      } catch (fileErr) {
        console.error('Subscription file upsert after patch user:', fileErr);
      }
    } else {
      const panel = await getPanelSettings();
      if (panel.subscriptionRelayOnly && ('status' in req.body || 'serverIds' in req.body)) {
        try {
          relayEdgeSync = scheduleRelayEdgeSync({ immediate: true });
        } catch (relayErr) {
          console.error('Relay edge sync after patch user:', relayErr);
          relayEdgeSync = { ok: false, error: relayErr.message || String(relayErr) };
        }
      }
    }

    await writeAuditLog({
      actor: req.admin,
      action: 'client.updated',
      targetType: 'user',
      targetId: id,
      dealerId: scopedUser.dealerId || null,
      data: { fields: Object.keys(update), name: scopedUser.name || '' },
    });

    res.json({
      ok: true,
      vpnEdgeSync,
      relayEdgeSync,
      subscriptionFile,
      enforcement,
      revokedMobileSessions,
      linkUnchanged: true,
    });
  } catch (err) {
    console.error('PATCH /admin/users/:id error:', err);
    await writeAuditLog({
      actor: req.admin,
      action: 'client.update_failed',
      targetType: 'user',
      targetId: req.params.id,
      data: { error: err.message || String(err) },
    }).catch(() => {});
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/users/reset-usage-all', async (req, res) => {
  try {
    const users = scopeUsersForRequest(req, await listUsers());
    if (!users.length) {
      return res.json({ ok: true, resetCount: 0, results: [] });
    }

    const { resetUserUsage } = await import('../lib/reset-user-usage.js');
    const days = req.body?.days;
    const results = [];

    for (const user of users) {
      try {
        const result = await resetUserUsage(user, { days });
        results.push({
          ok: true,
          userId: user.id,
          name: user.name || '',
          periodDays: result.periodDays,
          remainingDays: result.remainingDays,
          expiresAtUnchanged: result.expiresAtUnchanged,
        });
      } catch (err) {
        results.push({ ok: false, userId: user.id, name: user.name || '', error: err.message || String(err) });
      }
    }

    await writeAuditLog({
      actor: req.admin,
      action: 'client.reset_usage_all',
      targetType: 'user',
      dealerId: req.admin?.dealerId || null,
      data: { resetCount: results.filter((item) => item.ok).length, total: users.length },
    });

    res.json({
      ok: results.every((item) => item.ok),
      resetCount: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok),
      results,
    });
  } catch (err) {
    console.error('POST /admin/users/reset-usage-all error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/users/:id/reset-usage', async (req, res) => {
  try {
    const { id } = req.params;
    const scopedUser = await getScopedUser(req, id);
    if (!scopedUser) return res.status(404).json({ error: 'User not found' });

    const { resetUserUsage } = await import('../lib/reset-user-usage.js');
    const result = await resetUserUsage(scopedUser, { days: req.body?.days });

    await writeAuditLog({
      actor: req.admin,
      action: 'client.reset_usage',
      targetType: 'user',
      targetId: id,
      dealerId: scopedUser.dealerId || null,
      data: {
        name: scopedUser.name || '',
        periodDays: result.periodDays,
        remainingDays: result.remainingDays,
        expiresAtUnchanged: result.expiresAtUnchanged,
      },
    });

    res.json({
      ok: true,
      user: result.user,
      periodDays: result.periodDays,
      remainingDays: result.remainingDays,
      expiresAtUnchanged: result.expiresAtUnchanged,
      vpnEdgeSync: result.vpnEdgeSync,
      subscriptionFile: result.subscriptionFile,
    });
  } catch (err) {
    console.error('POST /admin/users/:id/reset-usage error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const scopedUser = await getScopedUser(req, id);
    if (!scopedUser) return res.status(404).json({ error: 'User not found' });
    const result = await deleteUserWithData(id);
    if (!result) {
      return res.status(404).json({ error: 'User not found' });
    }

    const vpnEdgeSync = scheduleVpnEdgeSync({ immediate: true });
    const panel = await getPanelSettings();
    let relayEdgeSync = null;
    if (panel.subscriptionRelayOnly) {
      try {
        relayEdgeSync = scheduleRelayEdgeSync({ immediate: true });
      } catch (relayErr) {
        console.error('Relay edge sync after delete user:', relayErr);
        relayEdgeSync = { ok: false, error: relayErr.message || String(relayErr) };
      }
    }
    await writeAuditLog({
      actor: req.admin,
      action: 'client.deleted',
      targetType: 'user',
      targetId: id,
      dealerId: scopedUser.dealerId || null,
      data: { name: scopedUser.name || '', result },
    });

    res.json({ ...result, vpnEdgeSync, relayEdgeSync });
  } catch (err) {
    console.error('DELETE /admin/users/:id error:', err);
    await writeAuditLog({
      actor: req.admin,
      action: 'client.delete_failed',
      targetType: 'user',
      targetId: req.params.id,
      data: { error: err.message || String(err) },
    }).catch(() => {});
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/users/:id/sync', async (req, res) => {
  try {
    const user = await getScopedUser(req, req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const subscriptionFile = await upsertUserSubscriptionFile(user);
    const urls = await buildUserSubscriptionUrls({
      userId: user.id,
      token: null,
      subscriptionFile,
    });
    const serverIds = user.serverIds?.length ? user.serverIds : null;
    let vpnEdgeSync;
    try {
      vpnEdgeSync = await syncVpnEdgeClients(serverIds ? { serverIds } : {});
    } catch (syncErr) {
      console.error('VPN edge sync after user sync:', syncErr);
      vpnEdgeSync = { ok: false, error: syncErr.message || String(syncErr) };
    }

    res.json({
      ok: true,
      userId: user.id,
      uuid: user.uuid,
      subscriptionUrl: urls.subscriptionUrl,
      fileUrl: urls.fileUrl,
      storageUrl: urls.storageUrl,
      storageUrlWithToken: urls.storageUrlWithToken,
      googleDriveUrl: urls.googleDriveUrl || null,
      importNote: urls.importNote,
      vpnEdgeSync,
      message: vpnEdgeSync?.ok
        ? 'File updated, UUID synced to edge nodes'
        : 'File updated, UUID edge sync failed',
    });
  } catch (err) {
    console.error('POST /admin/users/:id/sync error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

router.get('/users/:id/links', async (req, res) => {
  try {
    let user = await getScopedUser(req, req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const panelSettings = await getPanelSettings();
    const importUrlMode = panelSettings.importUrlMode || 'api';
    if (importUrlMode === 'api' && !String(user.subscriptionToken || '').trim()) {
      const issued = await issueSubscriptionTokenIfMissing(user);
      user = issued.user;
    }

    const subscriptionFile = await getFileByLinkedUserId(user.id);
    const urls = await buildUrlsForUser(user, subscriptionFile, panelSettings);

    res.json({
      userId: user.id,
      uuid: user.uuid,
      subscriptionToken: user.subscriptionToken || null,
      panelProxyUrl: urls.panelProxyUrl || urls.panelSubscriptionUrl || urls.panelFileUrl,
      panelSubscriptionUrl: urls.panelSubscriptionUrl,
      subscriptionUrl: urls.panelSubscriptionUrl || urls.subscriptionUrl,
      plainSubscriptionUrl: urls.plainSubscriptionUrl || urls.panelSubscriptionUrl,
      happEncryptedUrl: urls.happEncryptedUrl || null,
      subscriptionBaseUrl: urls.subscriptionBaseUrl,
      panelBlockedInTm: urls.panelBlockedInTm,
      publicStorageUrl: urls.publicStorageUrl,
      googleDriveUrl: urls.googleDriveUrl,
      fileUrl: urls.fileUrl,
      storageUrl: urls.storageUrl,
      storageUrlWithToken: urls.storageUrlWithToken,
      importNote: urls.importNote,
      note: 'Ссылки из готового файла. Для обновления нажмите Синхр.',
      importLinks: {
        import: urls.panelSubscriptionUrl || urls.subscriptionUrl,
        plain: urls.plainSubscriptionUrl || urls.panelSubscriptionUrl,
        encrypted: urls.happEncryptedUrl,
        panelFile: urls.panelFileUrl || urls.fileUrl,
        storageWithToken: urls.storageUrlWithToken,
        publicStorage: urls.publicStorageUrl,
        googleDrive: urls.googleDriveUrl,
        panelSubscription: urls.panelSubscriptionUrl,
        subscriptionBaseUrl: urls.subscriptionBaseUrl,
        storage: urls.storageUrl,
      },
    });
  } catch (err) {
    console.error('GET /admin/users/:id/links error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

router.get('/users/:id/subscription', async (req, res) => {
  try {
    const user = await getScopedUser(req, req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const preview = await buildUserSubscriptionBody(user);
    const panel = await getPanelSettings();
    const subscriptionBaseUrl = getSubscriptionBaseUrl(panel);
    res.json({
      userId: user.id,
      subscriptionMode: user.subscriptionMode || 'auto',
      customSubscriptionContent: user.customSubscriptionContent || '',
      serverIds: user.serverIds || [],
      uuid: user.uuid,
      preview,
      subscriptionUrl: `${subscriptionBaseUrl || PUBLIC_BASE_URL}/sub/TOKEN_HIDDEN`,
    });
  } catch (err) {
    console.error('GET /admin/users/:id/subscription error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/users/:id/subscription', async (req, res) => {
  try {
    const { id } = req.params;
    const user = await getScopedUser(req, id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!isOwner(req)) {
      return res.status(403).json({ error: 'Owner access required' });
    }

    const {
      subscriptionMode,
      customSubscriptionContent,
      serverIds,
      syncToStorage = false,
    } = req.body;

    const update = { updatedAt: nowIso() };

    if (subscriptionMode !== undefined) update.subscriptionMode = subscriptionMode;
    if (customSubscriptionContent !== undefined) {
      update.customSubscriptionContent = customSubscriptionContent;
    }
    if (serverIds !== undefined) {
      const resolvedServerIds = await normalizeAssignableServerIds(serverIds);
      if (!resolvedServerIds) {
        return res.status(400).json({ error: 'Select at least one enabled server' });
      }
      update.serverIds = resolvedServerIds;
    }

    await updateUser(id, update);

    const updated = await getUserById(id);
    const preview = await buildUserSubscriptionBody(updated);

    let storage = null;
    let vpnEdgeSync = null;
    if (syncToStorage || serverIds !== undefined) {
      const refreshed = await refreshUserSubscriptionAndEdge(updated);
      storage = refreshed.subscriptionFile;
      vpnEdgeSync = refreshed.vpnEdgeSync;
    }

    res.json({
      ok: true,
      preview,
      storage,
      vpnEdgeSync,
      subscriptionMode: updated.subscriptionMode || 'auto',
      linkUnchanged: true,
    });
  } catch (err) {
    console.error('PUT /admin/users/:id/subscription error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/users/:id/subscription/regenerate', async (req, res) => {
  try {
    const user = await getScopedUser(req, req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!isOwner(req)) {
      return res.status(403).json({ error: 'Owner access required' });
    }

    const preview = await buildAutoSubscription(user);
    await updateUser(req.params.id, {
      subscriptionMode: 'auto',
      customSubscriptionContent: '',
      updatedAt: nowIso(),
    });

    res.json({ ok: true, preview });
  } catch (err) {
    console.error('POST /admin/users/:id/subscription/regenerate error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/users/:id', async (req, res) => {
  try {
    const user = await getScopedUser(req, req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (err) {
    console.error('GET /admin/users/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function getAssignedCdnServers(user) {
  const effectiveServerIds = await resolveEffectiveServerIdsForUser(user);
  const assignedIds = new Set([
    ...effectiveServerIds,
    ...(user.bonusServerIds || []),
    ...(user.pinnedServerIds || []),
  ].map(String));
  return (await listServers()).filter((server) => (
    server.enabled !== false
    && assignedIds.has(String(server.id))
    && Boolean(classifyCdnServer(server))
  ));
}

router.get('/cdn-services', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const servers = await listServers();
    res.json({
      ok: true,
      providers: CDN_PROVIDERS.map((id) => ({
        id,
        label: CDN_PROVIDER_LABELS[id] || id,
      })),
      services: buildCdnServicesSummary(servers),
    });
  } catch (err) {
    console.error('GET /admin/cdn-services error:', err);
    res.status(err?.status || 500).json({ error: err?.message || 'Internal server error' });
  }
});

function normalizeCloudflareDomainCatalog(value) {
  const items = Array.isArray(value) ? value : [];
  const seen = new Set();
  return items
    .map((item) => {
      const domain = typeof item === 'string' ? item : item?.domain;
      if (!domain) return null;
      const normalized = normalizeOptionalCdnHostname(domain, 'domain');
      if (!normalized || seen.has(normalized)) return null;
      seen.add(normalized);
      return {
        domain: normalized,
        createdAt: typeof item === 'object' ? item.createdAt || null : null,
        updatedAt: typeof item === 'object' ? item.updatedAt || null : null,
      };
    })
    .filter(Boolean);
}

router.get('/cdn-services/cloudflare/domains', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const [settings, servers] = await Promise.all([getPanelSettings(), listServers()]);
    const catalog = normalizeCloudflareDomainCatalog(settings.cloudflareDomains);
    const current = servers
      .filter((server) => server?.enabled !== false && classifyCdnServer(server) === CDN_PROVIDER_CLOUDFLARE)
      .flatMap((server) => [server.host, server.sni])
      .filter(Boolean)
      .map((domain) => normalizeOptionalCdnHostname(domain, 'domain'));
    const merged = normalizeCloudflareDomainCatalog([
      ...catalog,
      ...current.map((domain) => ({ domain })),
    ]);
    res.json({
      ok: true,
      domains: merged,
      serverCount: servers.filter((server) => (
        server?.enabled !== false && classifyCdnServer(server) === CDN_PROVIDER_CLOUDFLARE
      )).length,
    });
  } catch (err) {
    console.error('GET /admin/cdn-services/cloudflare/domains error:', err);
    res.status(err?.status || 400).json({ error: err?.message || 'Internal server error' });
  }
});

router.post('/cdn-services/cloudflare/domains', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const body = req.body || {};
    const domain = normalizeOptionalCdnHostname(body.domain, 'domain');
    if (!domain) return res.status(400).json({ error: 'domain is required' });
    const applyToAll = body.applyToAll === true;
    const refreshSubscriptions = body.refreshSubscriptions !== false;
    const now = nowIso();
    const settings = await getPanelSettings();
    const catalog = normalizeCloudflareDomainCatalog(settings.cloudflareDomains);
    const nextCatalog = normalizeCloudflareDomainCatalog([
      ...catalog,
      { domain, createdAt: now, updatedAt: now },
    ]).map((item) => item.domain === domain
      ? { ...item, createdAt: item.createdAt || now, updatedAt: now }
      : item);
    await updatePanelSettings({ cloudflareDomains: nextCatalog });

    let targets = (await listServers()).filter((server) => (
      server?.enabled !== false && classifyCdnServer(server) === CDN_PROVIDER_CLOUDFLARE
    ));
    if (Array.isArray(body.serverIds) && body.serverIds.length) {
      const wanted = new Set(body.serverIds.map((id) => String(id)));
      targets = targets.filter((server) => wanted.has(String(server.id)));
    } else if (!applyToAll) {
      targets = [];
    }

    const updated = [];
    for (const server of targets) {
      await upsertServer(server.id, { ...server, host: domain, sni: domain, updatedAt: now });
      updated.push({ id: server.id, name: server.name || server.id, host: domain, sni: domain });
    }

    let refreshed = 0;
    if (refreshSubscriptions && updated.length) {
      for (const user of await listUsers()) {
        await upsertUserSubscriptionFile(user);
        refreshed += 1;
      }
    }

    await writeAuditLog({
      actor: req.admin,
      action: 'cdn_service.cloudflare_domain_added',
      targetType: 'cdn_provider',
      targetId: CDN_PROVIDER_CLOUDFLARE,
      data: { domain, applyToAll, updated, refreshed },
    });
    res.json({
      ok: true,
      domain,
      domains: nextCatalog,
      updated,
      refreshed,
      message: updated.length
        ? `Cloudflare: домен добавлен и применён к ${updated.length} серверам; подписки обновлены для ${refreshed} клиентов.`
        : 'Cloudflare: домен добавлен в список. Серверы не изменялись.',
    });
  } catch (err) {
    console.error('POST /admin/cdn-services/cloudflare/domains error:', err);
    res.status(err?.status || 400).json({ error: err?.message || 'Internal server error' });
  }
});

router.delete('/cdn-services/cloudflare/domains/:domain', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const domain = normalizeOptionalCdnHostname(decodeURIComponent(req.params.domain || ''), 'domain');
    const settings = await getPanelSettings();
    const nextCatalog = normalizeCloudflareDomainCatalog(settings.cloudflareDomains)
      .filter((item) => item.domain !== domain);
    await updatePanelSettings({ cloudflareDomains: nextCatalog });
    await writeAuditLog({
      actor: req.admin,
      action: 'cdn_service.cloudflare_domain_removed',
      targetType: 'cdn_provider',
      targetId: CDN_PROVIDER_CLOUDFLARE,
      data: { domain },
    });
    res.json({ ok: true, domain, domains: nextCatalog, message: 'Домен удалён из списка; текущие настройки серверов не изменены.' });
  } catch (err) {
    console.error('DELETE /admin/cdn-services/cloudflare/domains error:', err);
    res.status(err?.status || 400).json({ error: err?.message || 'Internal server error' });
  }
});

router.put('/cdn-services/:provider/address-ips', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const provider = String(req.params.provider || '').trim().toLowerCase();
    if (!CDN_PROVIDERS.includes(provider)) {
      return res.status(400).json({
        error: `Unknown CDN provider. Use one of: ${CDN_PROVIDERS.join(', ')}`,
      });
    }

    const body = req.body || {};
    const updateClients = body.updateClients !== false;
    const refreshSubscriptions = body.refreshSubscriptions !== false;
    const now = nowIso();

    const ipByServerId = new Map();
    if (Array.isArray(body.servers)) {
      for (const row of body.servers) {
        const id = String(row?.id || '').trim();
        if (!id) continue;
        const ip = normalizeOptionalCdnIp(row.addressIp, `IP for ${id}`);
        if (!ip) {
          return res.status(400).json({ error: `IP for ${id} is required` });
        }
        ipByServerId.set(id, ip);
      }
    }

    const sharedIp = Object.prototype.hasOwnProperty.call(body, 'addressIp')
      ? normalizeOptionalCdnIp(body.addressIp, 'addressIp')
      : '';

    if (!ipByServerId.size && !sharedIp) {
      return res.status(400).json({
        error: 'Provide addressIp (batch) and/or servers:[{id,addressIp}]',
      });
    }

    const allServers = await listServers();
    let targets = allServers.filter((server) => (
      server?.enabled !== false
      && classifyCdnServer(server) === provider
    ));

    if (Array.isArray(body.serverIds) && body.serverIds.length) {
      const want = new Set(body.serverIds.map((id) => String(id)));
      targets = targets.filter((server) => want.has(String(server.id)));
    }

    if (ipByServerId.size) {
      targets = targets.filter((server) => ipByServerId.has(String(server.id)));
    }

    if (!targets.length) {
      return res.status(404).json({ error: `No ${provider} servers matched` });
    }

    const updated = [];
    for (const server of targets) {
      const ip = ipByServerId.get(String(server.id)) || sharedIp;
      if (!ip) continue;
      await upsertServer(server.id, {
        ...server,
        addressIp: ip,
        addressIps: [ip],
        forceAddressIp: true,
        updatedAt: now,
      });
      updated.push({ id: server.id, name: server.name || server.id, addressIp: ip });
    }

    let clientsPatched = 0;
    if (updateClients && updated.length) {
      const idToIp = Object.fromEntries(updated.map((row) => [row.id, row.addressIp]));
      const users = await listUsers();
      for (const user of users) {
        if (!isUserActive(user)) continue;
        const prev = user.serverAddressIps && typeof user.serverAddressIps === 'object'
          ? { ...user.serverAddressIps }
          : {};
        let changed = false;
        for (const [id, ip] of Object.entries(idToIp)) {
          if (prev[id] === ip) continue;
          prev[id] = ip;
          changed = true;
        }
        if (!changed) continue;
        await updateUser(user.id, { serverAddressIps: prev, updatedAt: now });
        clientsPatched += 1;
      }
    }

    let refreshed = 0;
    if (refreshSubscriptions) {
      for (const user of await listUsers()) {
        await upsertUserSubscriptionFile(user);
        refreshed += 1;
      }
    }

    await writeAuditLog({
      actor: req.admin,
      action: 'cdn_service.address_ips_updated',
      targetType: 'cdn_provider',
      targetId: provider,
      data: {
        label: CDN_PROVIDER_LABELS[provider] || provider,
        updated,
        clientsPatched,
        refreshed,
        updateClients,
      },
    });

    const services = buildCdnServicesSummary(await listServers());
    const service = services.find((row) => row.id === provider) || null;
    res.json({
      ok: true,
      provider,
      label: CDN_PROVIDER_LABELS[provider] || provider,
      updated,
      clientsPatched,
      refreshed,
      service,
      services,
      message: `${CDN_PROVIDER_LABELS[provider] || provider}: обновлено серверов ${updated.length}, клиентов ${clientsPatched}.`,
    });
  } catch (err) {
    console.error('PUT /admin/cdn-services/:provider/address-ips error:', err);
    res.status(err?.status || 400).json({ error: err?.message || 'Internal server error' });
  }
});

router.put('/cdn-services/:provider/sni-hosts', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const provider = String(req.params.provider || '').trim().toLowerCase();
    if (!CDN_PROVIDERS.includes(provider)) {
      return res.status(400).json({
        error: `Unknown CDN provider. Use one of: ${CDN_PROVIDERS.join(', ')}`,
      });
    }

    const body = req.body || {};
    const refreshSubscriptions = body.refreshSubscriptions !== false;
    const hostByServerId = new Map();
    const sniByServerId = new Map();
    if (Array.isArray(body.servers)) {
      for (const row of body.servers) {
        const id = String(row?.id || '').trim();
        if (!id) continue;
        if (Object.prototype.hasOwnProperty.call(row, 'host')) {
          hostByServerId.set(id, normalizeOptionalCdnHostname(row.host, `Host for ${id}`));
        }
        if (Object.prototype.hasOwnProperty.call(row, 'sni')) {
          sniByServerId.set(id, normalizeOptionalCdnHostname(row.sni, `SNI for ${id}`));
        }
      }
    }

    const domain = Object.prototype.hasOwnProperty.call(body, 'domain')
      ? normalizeOptionalCdnHostname(body.domain, 'domain')
      : '';
    const sharedHost = Object.prototype.hasOwnProperty.call(body, 'host')
      ? normalizeOptionalCdnHostname(body.host, 'host')
      : domain;
    const sharedSni = Object.prototype.hasOwnProperty.call(body, 'sni')
      ? normalizeOptionalCdnHostname(body.sni, 'sni')
      : domain;

    if (!hostByServerId.size && !sniByServerId.size && !sharedHost && !sharedSni) {
      return res.status(400).json({
        error: 'Provide domain (both SNI and Host), host, sni and/or servers:[{id,host,sni}]',
      });
    }

    const allServers = await listServers();
    let targets = allServers.filter((server) => (
      server?.enabled !== false
      && classifyCdnServer(server) === provider
    ));
    if (Array.isArray(body.serverIds) && body.serverIds.length) {
      const want = new Set(body.serverIds.map((id) => String(id)));
      targets = targets.filter((server) => want.has(String(server.id)));
    }
    if (hostByServerId.size || sniByServerId.size) {
      const want = new Set([...hostByServerId.keys(), ...sniByServerId.keys()]);
      targets = targets.filter((server) => want.has(String(server.id)));
    }
    if (!targets.length) {
      return res.status(404).json({ error: `No ${provider} servers matched` });
    }

    const now = nowIso();
    const updated = [];
    for (const server of targets) {
      const id = String(server.id);
      const host = hostByServerId.get(id) || sharedHost || String(server.host || '').trim();
      const sni = sniByServerId.get(id) || sharedSni || String(server.sni || '').trim();
      if (!host && !sni) continue;
      const next = { ...server, updatedAt: now };
      if (host) next.host = host;
      if (sni) next.sni = sni;
      await upsertServer(id, next);
      updated.push({ id, name: server.name || id, host: next.host || '', sni: next.sni || '' });
    }

    let refreshed = 0;
    if (refreshSubscriptions) {
      for (const user of await listUsers()) {
        await upsertUserSubscriptionFile(user);
        refreshed += 1;
      }
    }

    await writeAuditLog({
      actor: req.admin,
      action: 'cdn_service.sni_hosts_updated',
      targetType: 'cdn_provider',
      targetId: provider,
      data: {
        label: CDN_PROVIDER_LABELS[provider] || provider,
        updated,
        refreshed,
        refreshSubscriptions,
      },
    });

    const services = buildCdnServicesSummary(await listServers());
    const service = services.find((row) => row.id === provider) || null;
    res.json({
      ok: true,
      provider,
      label: CDN_PROVIDER_LABELS[provider] || provider,
      updated,
      refreshed,
      service,
      services,
      message: `${CDN_PROVIDER_LABELS[provider] || provider}: SNI/HOST обновлены для ${updated.length} серверов, подписки обновлены для ${refreshed} клиентов.`,
    });
  } catch (err) {
    console.error('PUT /admin/cdn-services/:provider/sni-hosts error:', err);
    res.status(err?.status || 400).json({ error: err?.message || 'Internal server error' });
  }
});

router.put('/cdn-services/:provider/ports', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const provider = String(req.params.provider || '').trim().toLowerCase();
    if (!CDN_PROVIDERS.includes(provider)) {
      return res.status(400).json({
        error: `Unknown CDN provider. Use one of: ${CDN_PROVIDERS.join(', ')}`,
      });
    }

    const body = req.body || {};
    const refreshSubscriptions = body.refreshSubscriptions !== false;
    const portByServerId = new Map();
    if (Array.isArray(body.servers)) {
      for (const row of body.servers) {
        const id = String(row?.id || '').trim();
        if (!id) continue;
        const port = normalizeOptionalCdnPort(row.port, `Port for ${id}`);
        if (!port) return res.status(400).json({ error: `Port for ${id} is required` });
        portByServerId.set(id, port);
      }
    }
    const sharedPort = Object.prototype.hasOwnProperty.call(body, 'port')
      ? normalizeOptionalCdnPort(body.port, 'port')
      : '';
    if (!portByServerId.size && !sharedPort) {
      return res.status(400).json({
        error: 'Provide port (batch) and/or servers:[{id,port}]',
      });
    }

    const allServers = await listServers();
    let targets = allServers.filter((server) => (
      server?.enabled !== false && classifyCdnServer(server) === provider
    ));
    if (Array.isArray(body.serverIds) && body.serverIds.length) {
      const want = new Set(body.serverIds.map((id) => String(id)));
      targets = targets.filter((server) => want.has(String(server.id)));
    }
    if (portByServerId.size) {
      targets = targets.filter((server) => portByServerId.has(String(server.id)));
    }
    if (!targets.length) return res.status(404).json({ error: `No ${provider} servers matched` });

    const now = nowIso();
    const updated = [];
    for (const server of targets) {
      const port = portByServerId.get(String(server.id)) || sharedPort;
      if (!port) continue;
      const next = { ...server, port, updatedAt: now };
      await upsertServer(server.id, next);
      updated.push({ id: server.id, name: server.name || server.id, port });
    }

    let refreshed = 0;
    if (refreshSubscriptions) {
      for (const user of await listUsers()) {
        await upsertUserSubscriptionFile(user);
        refreshed += 1;
      }
    }
    await writeAuditLog({
      actor: req.admin,
      action: 'cdn_service.ports_updated',
      targetType: 'cdn_provider',
      targetId: provider,
      data: { label: CDN_PROVIDER_LABELS[provider] || provider, updated, refreshed, refreshSubscriptions },
    });

    const services = buildCdnServicesSummary(await listServers());
    const service = services.find((row) => row.id === provider) || null;
    res.json({
      ok: true,
      provider,
      label: CDN_PROVIDER_LABELS[provider] || provider,
      updated,
      refreshed,
      service,
      services,
      message: `${CDN_PROVIDER_LABELS[provider] || provider}: порт обновлён для ${updated.length} серверов, подписки обновлены для ${refreshed} клиентов.`,
    });
  } catch (err) {
    console.error('PUT /admin/cdn-services/:provider/ports error:', err);
    res.status(err?.status || 400).json({ error: err?.message || 'Internal server error' });
  }
});

router.get('/users/:id/cdn-address-ips', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const user = await getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const servers = await getAssignedCdnServers(user);
    res.json({
      ok: true,
      user: { id: user.id, name: user.name || user.id },
      ...summarizeCdnAddressOverrides(user, servers),
    });
  } catch (err) {
    console.error('GET /admin/users/:id/cdn-address-ips error:', err);
    res.status(err?.status || 500).json({ error: err?.message || 'Internal server error' });
  }
});

router.put('/users/:id/cdn-address-ips', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const user = await getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const updates = {};
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'bunnyIp')) {
      updates[CDN_PROVIDER_BUNNY] = normalizeOptionalCdnIp(req.body.bunnyIp, 'Bunny IP');
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'cloudflareIp')) {
      updates[CDN_PROVIDER_CLOUDFLARE] = normalizeOptionalCdnIp(req.body.cloudflareIp, 'Cloudflare IP');
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'tencentIp')) {
      updates[CDN_PROVIDER_TENCENT] = normalizeOptionalCdnIp(req.body.tencentIp, 'Tencent IP');
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'alibabaIp')) {
      updates[CDN_PROVIDER_ALIBABA] = normalizeOptionalCdnIp(req.body.alibabaIp, 'Alibaba IP');
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({
        error: 'Provide bunnyIp, cloudflareIp, tencentIp and/or alibabaIp',
      });
    }

    const servers = await getAssignedCdnServers(user);
    const applied = applyCdnAddressOverrides(user.serverAddressIps, servers, updates);
    const patch = { serverAddressIps: applied.serverAddressIps, updatedAt: nowIso() };
    await updateUser(user.id, patch);
    const updatedUser = { ...user, ...patch };
    const subscriptionFile = await upsertUserSubscriptionFile(updatedUser);
    const summary = summarizeCdnAddressOverrides(updatedUser, servers);

    await writeAuditLog({
      actor: req.admin,
      action: 'client.cdn_ips_updated',
      targetType: 'user',
      targetId: user.id,
      dealerId: user.dealerId || null,
      data: {
        name: user.name || '',
        providers: Object.keys(updates),
        changedServerIds: applied.changedServerIds,
      },
    });

    res.json({
      ok: true,
      user: { id: user.id, name: user.name || user.id },
      changedServerIds: applied.changedServerIds,
      subscriptionFile,
      ...summary,
      linkUnchanged: true,
      message: `CDN IP updated for ${user.name || user.id}. Subscription link is unchanged.`,
    });
  } catch (err) {
    console.error('PUT /admin/users/:id/cdn-address-ips error:', err);
    res.status(err?.status || 400).json({ error: err?.message || 'Internal server error' });
  }
});

router.get('/users/:id/servers', async (req, res) => {
  try {
    const user = await getScopedUser(req, req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const enabledServers = await getEnabledServers();
    const assignableIds = new Set(await listAssignableServerIds());
    const effectiveServerIds = await resolveEffectiveServerIdsForUser(user);

    const assignable = enabledServers.filter((server) => assignableIds.has(server.id));
    const sorted = sortServersForSubscription(assignable);

    res.json({
      userId: user.id,
      explicitServerIds: user.serverIds || [],
      usesAllDefaultServers: !user.serverIds?.length,
      effectiveServerIds,
      servers: sorted.map((server) => ({
          id: server.id,
          name: server.name,
          flag: server.flag || '',
          country: server.country || '',
          enabled: server.enabled !== false,
          newUsersOnly: server.newUsersOnly === true,
          minInstances: Number(server.minInstances ?? 0),
          assigned: effectiveServerIds.includes(server.id),
        })),
      linkUnchanged: true,
    });
  } catch (err) {
    console.error('GET /admin/users/:id/servers error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/users/:id/servers', async (req, res) => {
  try {
    const { id } = req.params;
    const user = await getScopedUser(req, id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { serverIds } = req.body;
    const resolvedServerIds = await normalizeAssignableServerIds(serverIds);
    if (!resolvedServerIds) {
      return res.status(400).json({ error: 'Select at least one enabled server' });
    }

    await updateUser(id, { serverIds: resolvedServerIds, updatedAt: nowIso() });
    const updated = await getUserById(id);
    const refreshed = await refreshUserSubscriptionAndEdge(updated);
    const preview = await buildUserSubscriptionBody(updated);

    await writeAuditLog({
      actor: req.admin,
      action: 'client.servers_updated',
      targetType: 'user',
      targetId: id,
      dealerId: user.dealerId || null,
      data: { serverIds: resolvedServerIds, name: user.name || '' },
    });

    res.json({
      ok: true,
      serverIds: resolvedServerIds,
      preview,
      subscriptionFile: refreshed.subscriptionFile,
      vpnEdgeSync: refreshed.vpnEdgeSync,
      linkUnchanged: true,
      message: 'Servers updated. Subscription link unchanged — client should refresh in Happ.',
    });
  } catch (err) {
    console.error('PATCH /admin/users/:id/servers error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/servers', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const {
      id,
      name,
      country,
      flag,
      host,
      service,
      region,
      addressIp,
      fingerprint,
      alpn,
      port = 443,
      protocol = 'vless',
      network = 'ws',
      path = '/',
      security = 'tls',
      sni,
      enabled = true,
      remark = '',
      sortOrder = 0,
      cpu = 1,
      memory = '1Gi',
      minInstances = 0,
      maxInstances = 1,
      timeoutSeconds = 3600,
      autoDeploy = false,
      newUsersOnly = false,
      grpcServiceName = '',
      grpcAuthority = '',
      xhttpMode = 'packet-up',
      xhttpExtra = '',
      rejectUdp443 = false,
      externalVps = false,
      subscriptionHidden = false,
      mobileEnabled = false,
      mobileDisplayName = '',
      mobileCountryCode = '',
      mobilePriority = null,
      mobileMinVersion = 1,
      mobileMaintenance = false,
    } = req.body;

    if (!id || !name) {
      return res.status(400).json({ error: 'id and name are required' });
    }
    if (!autoDeploy && !host) {
      return res.status(400).json({ error: 'host is required (or enable autoDeploy)' });
    }

    const existing = await getServerById(id);
    const now = nowIso();

    await upsertServer(id, {
      name,
      country: country || '',
      flag: flag || '',
      host: host || '',
      service: service || id,
      region: region || '',
      addressIp: addressIp || '',
      fingerprint: fingerprint || 'chrome',
      alpn: alpn || 'http/1.1',
      port,
      protocol,
      network,
      path,
      security,
      sni: sni || 'www.google.com',
      enabled,
      remark,
      sortOrder: Number(sortOrder),
      cpu: Number(cpu || 1),
      memory: memory || '1Gi',
      minInstances: Number(minInstances ?? 0),
      maxInstances: Number(maxInstances ?? 1),
      timeoutSeconds: Number(timeoutSeconds || 3600),
      newUsersOnly: newUsersOnly === true,
      grpcServiceName: String(grpcServiceName || '').trim(),
      grpcAuthority: String(grpcAuthority || '').trim(),
      xhttpMode: String(xhttpMode || 'packet-up').trim() || 'packet-up',
      xhttpExtra: typeof xhttpExtra === 'string' ? xhttpExtra.trim() : (xhttpExtra || ''),
      rejectUdp443: rejectUdp443 === true,
      externalVps: externalVps === true,
      subscriptionHidden: subscriptionHidden === true,
      mobileEnabled: mobileEnabled === true,
      mobileDisplayName: String(mobileDisplayName || '').trim(),
      mobileCountryCode: String(mobileCountryCode || '').trim().toUpperCase().slice(0, 2),
      mobilePriority: Number(mobilePriority ?? sortOrder ?? 0),
      mobileMinVersion: Math.max(1, Number(mobileMinVersion || 1)),
      mobileMaintenance: mobileMaintenance === true,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });

    const created = await getServerById(id);
    const deploy = autoDeploy
      ? { ok: false, disabled: true, error: 'Automatic deployment is disabled; use Real Servers.' }
      : null;
    const serverForEffects = created;
    const effects = serverForEffects
      ? await applyDynamicServerChangeEffects(id, {
          enabled,
          minInstances,
          maxInstances,
          host: serverForEffects.host,
          service: service || id,
          region,
        })
      : null;

    res.json({ ok: true, id, effects, deploy });
  } catch (err) {
    console.error('POST /admin/servers error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/servers/bulk', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const { servers } = req.body;
    if (!Array.isArray(servers) || !servers.length) {
      return res.status(400).json({ error: 'servers array is required' });
    }

    const now = nowIso();
    const prepared = [];

    for (const [index, server] of servers.entries()) {
      if (!server.id || !server.name || !server.host) {
        return res.status(400).json({
          error: `Server at index ${index} must have id, name, host`,
        });
      }

      prepared.push({
        id: server.id,
        name: server.name,
        country: server.country || '',
        flag: server.flag || '',
        host: server.host,
        service: server.service || server.id,
        region: server.region || '',
        addressIp: server.addressIp || '',
        fingerprint: server.fingerprint || 'chrome',
        alpn: server.alpn || 'http/1.1',
        port: server.port ?? 443,
        protocol: server.protocol || 'vless',
        network: server.network || 'ws',
        path: server.path || '/',
        security: server.security || 'tls',
        sni: server.sni || 'www.google.com',
        xhttpMode: String(server.xhttpMode || server.mode || 'packet-up').trim() || 'packet-up',
        xhttpExtra: typeof server.xhttpExtra === 'string' ? server.xhttpExtra.trim() : (server.xhttpExtra || ''),
        enabled: server.enabled !== false,
        remark: server.remark || '',
        sortOrder: Number(server.sortOrder ?? index + 1),
        mobileEnabled: server.mobileEnabled === true,
        mobileDisplayName: String(server.mobileDisplayName || '').trim(),
        mobileCountryCode: String(server.mobileCountryCode || '').trim().toUpperCase().slice(0, 2),
        mobilePriority: Number(server.mobilePriority ?? server.sortOrder ?? index + 1),
        mobileMinVersion: Math.max(1, Number(server.mobileMinVersion || 1)),
        mobileMaintenance: server.mobileMaintenance === true,
        createdAt: now,
        updatedAt: now,
      });
    }

    await bulkUpsertServers(prepared);
    res.json({ ok: true, count: prepared.length });
  } catch (err) {
    console.error('POST /admin/servers/bulk error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/servers', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const servers = await listServers();
    res.json({
      servers: servers.map((server) => ({
        ...server,
        dynamic: summarizeServerForPanel(server),
      })),
    });
  } catch (err) {
    console.error('GET /admin/servers error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/servers/:id', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const server = await getServerById(req.params.id);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }
    res.json({ server });
  } catch (err) {
    console.error('GET /admin/servers/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/servers/:id', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const { id } = req.params;
    const allowedFields = [
      'name',
      'country',
      'flag',
      'host',
      'port',
      'protocol',
      'network',
      'path',
      'security',
      'sni',
      'enabled',
      'remark',
      'sortOrder',
      'service',
      'region',
      'addressIp',
      'fingerprint',
      'alpn',
      'cpu',
      'memory',
      'minInstances',
      'maxInstances',
      'timeoutSeconds',
      'newUsersOnly',
      'grpcServiceName',
      'grpcAuthority',
      'xhttpMode',
      'xhttpExtra',
      'rejectUdp443',
      'externalVps',
      'subscriptionHidden',
      'mobileEnabled',
      'mobileDisplayName',
      'mobileCountryCode',
      'mobilePriority',
      'mobileMinVersion',
      'mobileMaintenance',
    ];
    const update = {};

    for (const field of allowedFields) {
      if (field in req.body) update[field] = req.body[field];
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const enrichedUpdate = enrichServerUpdateFields(update);
    enrichedUpdate.updatedAt = nowIso();
    await updateServer(id, enrichedUpdate);

    const effects = await applyDynamicServerChangeEffects(id, enrichedUpdate);

    res.json({ ok: true, effects });
  } catch (err) {
    console.error('PATCH /admin/servers/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/servers/:id', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const { id } = req.params;
    const server = await getServerById(id);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const users = await getUsersUsingServer(id);
    if (users.length && !req.query.force) {
      return res.status(409).json({
        error: 'Server is used by users',
        users: users.map((u) => ({ id: u.id, name: u.name })),
        hint: 'Remove server from users first or use ?force=true',
      });
    }

    if (users.length && req.query.force) {
      for (const user of users) {
        const serverIds = (user.serverIds || []).filter((sid) => sid !== id);
        await updateUser(user.id, { serverIds, updatedAt: nowIso() });
      }
    }

    await deleteServer(id);
    res.json({ ok: true, removedFromUsers: users.length });
  } catch (err) {
    console.error('DELETE /admin/servers/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/subscription/global', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const global = await getGlobalSubscription();
    const previewResult = await buildGlobalSubscriptionBody();
    const urls = await buildGlobalSubscriptionUrls(global);

    res.json({
      ...global,
      ...urls,
      publicUrl: urls.subscriptionUrl,
      preview: previewResult.ok ? previewResult.body : '',
    });
  } catch (err) {
    console.error('GET /admin/subscription/global error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/settings/mobile', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await buildMobileAdminPayload());
  } catch (err) {
    console.error('GET /admin/settings/mobile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/settings/mobile/servers', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const [servers, panel] = await Promise.all([listServers(), getPanelSettings()]);
    const mobileServers = servers
      .map((server) => mobileServerAdminView(server, panel))
      .sort((a, b) => {
        if (a.mobileEnabled !== b.mobileEnabled) return a.mobileEnabled ? -1 : 1;
        if (a.mobilePriority !== b.mobilePriority) return a.mobilePriority - b.mobilePriority;
        return a.name.localeCompare(b.name, 'ru');
      });
    res.set('Cache-Control', 'no-store');
    res.json({
      servers: mobileServers,
      updatedAt: panel.mobileServersUpdatedAt || null,
      latestVersionCode: Number(panel.mobileLatestVersion || 1),
    });
  } catch (err) {
    console.error('GET /admin/settings/mobile/servers error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/settings/mobile/servers/:id', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const server = await getServerById(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const input = req.body || {};
    const update = {};

    if (input.mobileEnabled !== undefined) {
      if (typeof input.mobileEnabled !== 'boolean') {
        return res.status(400).json({ error: 'mobileEnabled must be boolean' });
      }
      update.mobileEnabled = input.mobileEnabled;
    }
    if (input.mobileDisplayName !== undefined) {
      const value = String(input.mobileDisplayName || '').trim();
      if (value.length > 80) return res.status(400).json({ error: 'mobileDisplayName is too long' });
      update.mobileDisplayName = value;
    }
    if (input.mobileCountryCode !== undefined) {
      const value = String(input.mobileCountryCode || '').trim().toUpperCase();
      if (value && !/^[A-Z]{2}$/.test(value)) {
        return res.status(400).json({ error: 'mobileCountryCode must contain two Latin letters' });
      }
      update.mobileCountryCode = value;
    }
    if (input.mobilePriority !== undefined) {
      const value = Number(input.mobilePriority);
      if (!Number.isInteger(value) || value < -100000 || value > 100000) {
        return res.status(400).json({ error: 'mobilePriority must be an integer between -100000 and 100000' });
      }
      update.mobilePriority = value;
    }
    if (input.mobileMinVersion !== undefined) {
      const value = Number(input.mobileMinVersion);
      if (!Number.isInteger(value) || value < 1 || value > 1000000) {
        return res.status(400).json({ error: 'mobileMinVersion must be a positive integer' });
      }
      update.mobileMinVersion = value;
    }
    if (input.mobileMaintenance !== undefined) {
      if (typeof input.mobileMaintenance !== 'boolean') {
        return res.status(400).json({ error: 'mobileMaintenance must be boolean' });
      }
      update.mobileMaintenance = input.mobileMaintenance;
    }

    if (!Object.keys(update).length) {
      return res.status(400).json({ error: 'No valid DADA VPN fields to update' });
    }

    const nextServer = { ...server, ...update };
    if (nextServer.mobileEnabled === true) {
      if (nextServer.enabled === false) {
        return res.status(409).json({ error: 'Enable the server in the main panel first' });
      }
      if (!isMobileTransportSupported(nextServer)) {
        return res.status(409).json({ error: 'DADA VPN v1 requires VLESS + WebSocket + TLS and a configured host' });
      }
    }

    const changedAt = nowIso();
    await updateServer(req.params.id, { ...update, updatedAt: changedAt });
    const panel = await updatePanelSettings({
      mobileProfileRevisionNonce: changedAt,
      mobileServersUpdatedAt: changedAt,
    });

    let vpnSync = null;
    let relaySync = null;
    const addedToMobile = update.mobileEnabled === true && server.mobileEnabled !== true;
    if (addedToMobile) {
      vpnSync = scheduleVpnEdgeSync({ immediate: true, serverIds: [req.params.id] });
      relaySync = scheduleRelayEdgeSync({ immediate: true });
    }

    await writeAuditLog({
      actor: req.admin,
      action: 'mobile.server_updated',
      targetType: 'server',
      targetId: req.params.id,
      data: {
        fields: Object.keys(update),
        mobileEnabled: nextServer.mobileEnabled === true,
      },
    });

    const saved = await getServerById(req.params.id);
    res.json({
      ok: true,
      server: mobileServerAdminView(saved, panel),
      updatedAt: changedAt,
      vpnSync,
      relaySync,
    });
  } catch (err) {
    console.error('PATCH /admin/settings/mobile/servers/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/settings/mobile/servers/refresh', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const changedAt = nowIso();
    await updatePanelSettings({
      mobileProfileRevisionNonce: changedAt,
      mobileServersUpdatedAt: changedAt,
    });
    await writeAuditLog({
      actor: req.admin,
      action: 'mobile.servers_refresh_requested',
      targetType: 'mobile-app',
      targetId: 'dada-vpn',
      data: { updatedAt: changedAt },
    });
    res.json({ ok: true, updatedAt: changedAt, profileRefresh: true });
  } catch (err) {
    console.error('POST /admin/settings/mobile/servers/refresh error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/settings/mobile', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const current = await getPanelSettings();
    const input = req.body || {};
    const update = {};

    if (input.enabled !== undefined) update.mobileAppEnabled = input.enabled === true;
    if (input.diagnosticsEnabled !== undefined) {
      update.mobileDiagnosticsEnabled = input.diagnosticsEnabled === true;
    }
    if (input.apiBaseUrl !== undefined) {
      update.mobileApiBaseUrl = normalizeHttpsUrl(input.apiBaseUrl, { allowEmpty: false, originOnly: true });
    }
    if (input.profileRefreshHours !== undefined) {
      const hours = Number(input.profileRefreshHours);
      if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
        return res.status(400).json({ error: 'profileRefreshHours must be between 1 and 168' });
      }
      update.mobileProfileRefreshHours = hours;
    }
    if (input.fragmentationEnabled !== undefined) {
      update.mobileFragmentationEnabled = input.fragmentationEnabled === true;
    }
    if (input.fragmentationPackets !== undefined) {
      const packets = String(input.fragmentationPackets || '').trim().toLowerCase();
      if (packets !== 'tlshello') {
        return res.status(400).json({ error: 'fragmentationPackets must be tlshello' });
      }
      update.mobileFragmentationPackets = packets;
    }
    if (input.fragmentationLength !== undefined) {
      update.mobileFragmentationLength = normalizeXrayRange(
        input.fragmentationLength,
        'fragmentationLength',
        { minimum: 1, maximum: 1024 }
      );
    }
    if (input.fragmentationInterval !== undefined) {
      update.mobileFragmentationInterval = normalizeXrayRange(
        input.fragmentationInterval,
        'fragmentationInterval',
        { minimum: 0, maximum: 2000 }
      );
    }
    if (input.fragmentationMaxSplit !== undefined) {
      update.mobileFragmentationMaxSplit = normalizeXrayRange(
        input.fragmentationMaxSplit,
        'fragmentationMaxSplit',
        { minimum: 1, maximum: 256 }
      );
    }
    if (Object.keys(update).some((field) => field.startsWith('mobileFragmentation'))) {
      update.mobileProfileRevisionNonce = nowIso();
    }

    const latestVersion = input.latestVersionCode === undefined
      ? Number(current.mobileLatestVersion || 1)
      : Number(input.latestVersionCode);
    const minimumVersion = input.minimumVersionCode === undefined
      ? Number(current.mobileMinimumVersion || 1)
      : Number(input.minimumVersionCode);
    if (!Number.isInteger(latestVersion) || latestVersion < 1) {
      return res.status(400).json({ error: 'latestVersionCode must be a positive integer' });
    }
    if (!Number.isInteger(minimumVersion) || minimumVersion < 1 || minimumVersion > latestVersion) {
      return res.status(400).json({ error: 'minimumVersionCode must be between 1 and latestVersionCode' });
    }
    if (input.latestVersionCode !== undefined) update.mobileLatestVersion = latestVersion;
    if (input.minimumVersionCode !== undefined) update.mobileMinimumVersion = minimumVersion;
    if (input.latestVersionName !== undefined) {
      const versionName = String(input.latestVersionName || '').trim().slice(0, 40);
      if (!versionName) return res.status(400).json({ error: 'latestVersionName is required' });
      update.mobileLatestVersionName = versionName;
    }
    if (input.apkUrl !== undefined) {
      update.mobileApkUrl = normalizeHttpsUrl(input.apkUrl, { allowEmpty: true });
    }
    if (input.apkSha256 !== undefined) {
      const sha256Value = String(input.apkSha256 || '').trim().toLowerCase();
      if (sha256Value && !/^[0-9a-f]{64}$/.test(sha256Value)) {
        return res.status(400).json({ error: 'apkSha256 must contain 64 hexadecimal characters' });
      }
      update.mobileApkSha256 = sha256Value;
    }
    if (input.releaseSignature !== undefined) {
      const signature = String(input.releaseSignature || '').trim();
      if (signature.length > 8192) return res.status(400).json({ error: 'releaseSignature is too long' });
      update.mobileReleaseSignature = signature;
    }
    if (input.changelog !== undefined) {
      update.mobileChangelog = String(input.changelog || '').trim().slice(0, 2000);
    }

    const settings = await updatePanelSettings(update);
    let revokedSessions = 0;
    if (current.mobileAppEnabled !== false && settings.mobileAppEnabled === false) {
      revokedSessions = await revokeAllPublicMobileSessions('mobile-app-disabled');
    }
    if (update.mobileAppEnabled !== undefined) {
      scheduleVpnEdgeSync({ immediate: true });
      scheduleRelayEdgeSync({ immediate: true });
    }
    await writeAuditLog({
      actor: req.admin,
      action: 'mobile.settings_updated',
      targetType: 'mobile-app',
      targetId: 'dada-vpn',
      data: {
        fields: Object.keys(update),
        enabled: settings.mobileAppEnabled !== false,
        revokedSessions,
      },
    });
    res.json({ ok: true, revokedSessions, ...(await buildMobileAdminPayload(settings)) });
  } catch (err) {
    console.error('PUT /admin/settings/mobile error:', err);
    const validationMessage = String(err?.message || '');
    const message = /^(URL must|fragmentation[A-Za-z]+ must)/.test(validationMessage)
      ? validationMessage
      : 'Internal server error';
    res.status(message === 'Internal server error' ? 500 : 400).json({ error: message });
  }
});

router.get('/settings/hiddify-android', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await buildHiddifyAndroidAdminPayload());
  } catch (err) {
    console.error('GET /admin/settings/hiddify-android error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/settings/hiddify-android/servers', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const [servers, panel] = await Promise.all([listServers(), getPanelSettings()]);
    const managedServers = servers
      .map((server) => hiddifyAndroidServerAdminView(server, panel))
      .sort((a, b) => {
        if (a.hiddifyAndroidEnabled !== b.hiddifyAndroidEnabled) return a.hiddifyAndroidEnabled ? -1 : 1;
        if (a.hiddifyAndroidPriority !== b.hiddifyAndroidPriority) {
          return a.hiddifyAndroidPriority - b.hiddifyAndroidPriority;
        }
        return a.name.localeCompare(b.name, 'ru');
      });
    res.set('Cache-Control', 'no-store');
    res.json({
      servers: managedServers,
      updatedAt: panel.hiddifyAndroidServersUpdatedAt || null,
      latestVersionCode: Number(panel.hiddifyAndroidLatestVersion || 1),
    });
  } catch (err) {
    console.error('GET /admin/settings/hiddify-android/servers error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/settings/hiddify-android/servers/:id', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const server = await getServerById(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const input = req.body || {};
    const update = {};
    if (input.hiddifyAndroidEnabled !== undefined) {
      if (typeof input.hiddifyAndroidEnabled !== 'boolean') {
        return res.status(400).json({ error: 'hiddifyAndroidEnabled must be boolean' });
      }
      update.hiddifyAndroidEnabled = input.hiddifyAndroidEnabled;
    }
    if (input.hiddifyAndroidDisplayName !== undefined) {
      const value = String(input.hiddifyAndroidDisplayName || '').trim();
      if (value.length > 80) return res.status(400).json({ error: 'Display name is too long' });
      update.hiddifyAndroidDisplayName = value;
    }
    if (input.hiddifyAndroidCountryCode !== undefined) {
      const value = String(input.hiddifyAndroidCountryCode || '').trim().toUpperCase();
      if (value && !/^[A-Z]{2}$/.test(value)) {
        return res.status(400).json({ error: 'Country code must contain two Latin letters' });
      }
      update.hiddifyAndroidCountryCode = value;
    }
    if (input.hiddifyAndroidPriority !== undefined) {
      const value = Number(input.hiddifyAndroidPriority);
      if (!Number.isInteger(value) || value < -100000 || value > 100000) {
        return res.status(400).json({ error: 'Priority must be an integer between -100000 and 100000' });
      }
      update.hiddifyAndroidPriority = value;
    }
    if (input.hiddifyAndroidMinVersion !== undefined) {
      const value = Number(input.hiddifyAndroidMinVersion);
      if (!Number.isInteger(value) || value < 1 || value > 1000000) {
        return res.status(400).json({ error: 'Minimum version must be a positive integer' });
      }
      update.hiddifyAndroidMinVersion = value;
    }
    if (input.hiddifyAndroidMaintenance !== undefined) {
      if (typeof input.hiddifyAndroidMaintenance !== 'boolean') {
        return res.status(400).json({ error: 'Maintenance must be boolean' });
      }
      update.hiddifyAndroidMaintenance = input.hiddifyAndroidMaintenance;
    }
    if (!Object.keys(update).length) return res.status(400).json({ error: 'No valid fields to update' });

    const nextServer = { ...server, ...update };
    if (nextServer.hiddifyAndroidEnabled === true) {
      if (nextServer.enabled === false) {
        return res.status(409).json({ error: 'Enable the server in the main panel first' });
      }
      if (!isHiddifyAndroidTransportSupported(nextServer)) {
        return res.status(409).json({ error: 'VLESS + WebSocket + TLS and host are required' });
      }
    }
    const changedAt = nowIso();
    await updateServer(req.params.id, { ...update, updatedAt: changedAt });
    const panel = await updatePanelSettings({
      hiddifyAndroidProfileRevisionNonce: changedAt,
      hiddifyAndroidServersUpdatedAt: changedAt,
    });
    const membershipChanged =
      typeof update.hiddifyAndroidEnabled === 'boolean' &&
      update.hiddifyAndroidEnabled !== isHiddifyAndroidMembershipEnabled(server);
    const vpnSync = membershipChanged
      ? scheduleVpnEdgeSync({ immediate: true, serverIds: [req.params.id] })
      : null;
    const relaySync = membershipChanged ? scheduleRelayEdgeSync({ immediate: true }) : null;
    await writeAuditLog({
      actor: req.admin,
      action: 'hiddify_android.server_updated',
      targetType: 'server',
      targetId: req.params.id,
      data: { fields: Object.keys(update), enabled: isHiddifyAndroidMembershipEnabled(nextServer) },
    });
    const saved = await getServerById(req.params.id);
    res.json({
      ok: true,
      server: hiddifyAndroidServerAdminView(saved, panel),
      updatedAt: changedAt,
      vpnSync,
      relaySync,
    });
  } catch (err) {
    console.error('PATCH /admin/settings/hiddify-android/servers/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/settings/hiddify-android/servers/refresh', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const changedAt = nowIso();
    await updatePanelSettings({
      hiddifyAndroidProfileRevisionNonce: changedAt,
      hiddifyAndroidServersUpdatedAt: changedAt,
    });
    await writeAuditLog({
      actor: req.admin,
      action: 'hiddify_android.servers_refresh_requested',
      targetType: 'mobile-app',
      targetId: 'dada-connect',
      data: { updatedAt: changedAt },
    });
    res.json({ ok: true, updatedAt: changedAt, profileRefresh: true });
  } catch (err) {
    console.error('POST /admin/settings/hiddify-android/servers/refresh error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/settings/hiddify-android', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const current = await getPanelSettings();
    const input = req.body || {};
    const update = {};
    if (input.enabled !== undefined) update.hiddifyAndroidEnabled = input.enabled === true;
    if (input.apiBaseUrl !== undefined) {
      update.hiddifyAndroidApiBaseUrl = normalizeHttpsUrl(input.apiBaseUrl, { allowEmpty: false, originOnly: true });
    }
    if (input.profileRefreshHours !== undefined) {
      const hours = Number(input.profileRefreshHours);
      if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
        return res.status(400).json({ error: 'profileRefreshHours must be between 1 and 168' });
      }
      update.hiddifyAndroidProfileRefreshHours = hours;
    }
    if (input.fragmentationEnabled !== undefined) {
      update.hiddifyAndroidFragmentationEnabled = input.fragmentationEnabled === true;
      update.hiddifyAndroidProfileRevisionNonce = nowIso();
    }
    const latestVersion = input.latestVersionCode === undefined
      ? Number(current.hiddifyAndroidLatestVersion || 1)
      : Number(input.latestVersionCode);
    const minimumVersion = input.minimumVersionCode === undefined
      ? Number(current.hiddifyAndroidMinimumVersion || 1)
      : Number(input.minimumVersionCode);
    if (!Number.isInteger(latestVersion) || latestVersion < 1) {
      return res.status(400).json({ error: 'latestVersionCode must be a positive integer' });
    }
    if (!Number.isInteger(minimumVersion) || minimumVersion < 1 || minimumVersion > latestVersion) {
      return res.status(400).json({ error: 'minimumVersionCode must be between 1 and latestVersionCode' });
    }
    if (input.latestVersionCode !== undefined) update.hiddifyAndroidLatestVersion = latestVersion;
    if (input.minimumVersionCode !== undefined) update.hiddifyAndroidMinimumVersion = minimumVersion;
    if (input.latestVersionName !== undefined) {
      const versionName = String(input.latestVersionName || '').trim().slice(0, 40);
      if (!versionName) return res.status(400).json({ error: 'latestVersionName is required' });
      update.hiddifyAndroidLatestVersionName = versionName;
    }
    if (input.apkUrl !== undefined) {
      update.hiddifyAndroidApkUrl = normalizeHttpsUrl(input.apkUrl, { allowEmpty: true });
    }
    if (input.apkSha256 !== undefined) {
      const value = String(input.apkSha256 || '').trim().toLowerCase();
      if (value && !/^[0-9a-f]{64}$/.test(value)) {
        return res.status(400).json({ error: 'apkSha256 must contain 64 hexadecimal characters' });
      }
      update.hiddifyAndroidApkSha256 = value;
    }
    if (input.changelog !== undefined) {
      update.hiddifyAndroidChangelog = String(input.changelog || '').trim().slice(0, 2000);
    }
    const settings = await updatePanelSettings(update);
    let revokedSessions = 0;
    if (current.hiddifyAndroidEnabled !== false && settings.hiddifyAndroidEnabled === false) {
      const revoked = await query(
        `UPDATE mobile_sessions SET revoked_at = COALESCE(revoked_at, NOW()),
         revoke_reason = COALESCE(revoke_reason, 'hiddify-android-disabled')
         WHERE access_mode = 'hiddify-android' AND revoked_at IS NULL`
      );
      revokedSessions = Number(revoked.rowCount || 0);
    }
    if (update.hiddifyAndroidEnabled !== undefined) {
      scheduleVpnEdgeSync({ immediate: true });
      scheduleRelayEdgeSync({ immediate: true });
    }
    await writeAuditLog({
      actor: req.admin,
      action: 'hiddify_android.settings_updated',
      targetType: 'mobile-app',
      targetId: 'dada-connect',
      data: { fields: Object.keys(update), enabled: settings.hiddifyAndroidEnabled !== false, revokedSessions },
    });
    res.json({ ok: true, revokedSessions, ...(await buildHiddifyAndroidAdminPayload(settings)) });
  } catch (err) {
    console.error('PUT /admin/settings/hiddify-android error:', err);
    const validationMessage = String(err?.message || '');
    const message = validationMessage.startsWith('URL must') ? validationMessage : 'Internal server error';
    res.status(message === 'Internal server error' ? 500 : 400).json({ error: message });
  }
});

router.get('/settings/panel', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const settings = await getPanelSettings();
    res.json({ settings });
  } catch (err) {
    console.error('GET /admin/settings/panel error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/settings/panel', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const {
      brandName,
      updateIntervalHours,
      connectionMode,
      importUrlMode,
      subscriptionBaseUrl,
      happWarningEnabled,
      happWarningText,
      happHideSettings,
      happEncryptedSubscription,
      happServerDescription,
      happProviderId,
      supportUrl,
    } = req.body;
    const update = {};
    if (brandName !== undefined) update.brandName = brandName;
    if (updateIntervalHours !== undefined) update.updateIntervalHours = Number(updateIntervalHours);
    if (happWarningEnabled !== undefined) update.happWarningEnabled = Boolean(happWarningEnabled);
    if (happWarningText !== undefined) {
      update.happWarningText = String(happWarningText).trim().slice(0, 200);
    }
    if (happHideSettings !== undefined) update.happHideSettings = Boolean(happHideSettings);
    if (happEncryptedSubscription !== undefined) {
      update.happEncryptedSubscription = Boolean(happEncryptedSubscription);
    }
    if (happServerDescription !== undefined) {
      update.happServerDescription = String(happServerDescription).trim().slice(0, 30) || 'Secure';
    }
    if (happProviderId !== undefined) {
      update.happProviderId = String(happProviderId).trim().slice(0, 128);
    }
    if (supportUrl !== undefined) {
      update.supportUrl = String(supportUrl).trim().slice(0, 512);
    }
    if (connectionMode !== undefined) {
      if (!['masked', 'direct'].includes(connectionMode)) {
        return res.status(400).json({ error: 'connectionMode must be masked or direct' });
      }
      update.connectionMode = connectionMode;
    }
    if (importUrlMode !== undefined) {
      if (!['panel', 'api'].includes(importUrlMode)) {
        return res.status(400).json({ error: 'importUrlMode must be panel or api' });
      }
      update.importUrlMode = importUrlMode;
    }
    if (subscriptionBaseUrl !== undefined) {
      update.subscriptionBaseUrl = trimTrailingSlash(subscriptionBaseUrl);
    }
    const settings = await updatePanelSettings(update);

    res.json({ ok: true, settings });
  } catch (err) {
    console.error('PUT /admin/settings/panel error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/settings/address-ips', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const settings = await getPanelSettings();
    const servers = await listServers();
    const currentIps = Array.from(
      new Set(
        normalizeAddressIps(
          settings.addressIps?.length ? settings.addressIps : servers.map((server) => server.addressIp)
        )
      )
    ).slice(0, 3);
    const users = await listUsers();

    res.json({
      addressIps: currentIps,
      servers: servers.map((server) => ({
        id: server.id,
        name: server.name,
        host: server.host,
        addressIp: server.addressIp || '',
        sortOrder: server.sortOrder ?? null,
      })),
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email || '',
        dealerId: user.dealerId || null,
        addressIps: normalizeAddressIps(user.addressIps),
        usesGlobal: !userUsesCustomAddressIps(user),
      })),
    });
  } catch (err) {
    console.error('GET /admin/settings/address-ips error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/settings/address-ips', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const addressIps = normalizeAddressIps(req.body.addressIps);
    const apply = await applyAddressIpsToServers(addressIps);
    const settings = await updatePanelSettings({ addressIps: apply.addressIps });

    const users = await listUsers();
    const files = [];
    for (const user of users) {
      try {
        const file = await upsertUserSubscriptionFile(user);
        files.push({ userId: user.id, ok: true, storageUrl: file?.storageUrl || file?.storage?.storageUrl });
      } catch (err) {
        files.push({ userId: user.id, ok: false, error: err.message || String(err) });
      }
    }

    const globalPreview = await buildGlobalSubscriptionBody();
    let globalStorage = null;
    if (globalPreview.ok && getBucketName()) {
      globalStorage = await syncGlobalSubscriptionToStorage(globalPreview.body);
      if (globalStorage.synced) {
        await updateGlobalSubscription({
          storageDownloadToken: globalStorage.storageDownloadToken,
          storageUrl: globalStorage.storageUrl,
          publicStorageUrl: globalStorage.publicStorageUrl || null,
        });
      }
    }

    const failedFiles = files.filter((file) => !file.ok);
    res.json({
      ok: failedFiles.length === 0,
      syncOk: failedFiles.length === 0,
      settings,
      addressIps: apply.addressIps,
      serversTotal: apply.serversTotal,
      updatedServers: apply.updated,
      userFiles: files,
      globalStorage,
      failedFiles,
      message: `IP updated. Rebuilt ${files.filter((file) => file.ok).length} user subscription file(s).${failedFiles.length ? ` Failed: ${failedFiles.length}.` : ''}`,
    });
  } catch (err) {
    console.error('PUT /admin/settings/address-ips error:', err);
    res.status(400).json({ error: err.message || 'Internal server error' });
  }
});

router.put('/settings/address-ips/users/:userId', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const user = await getUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const clear = req.body.clear === true || req.body.useGlobal === true;
    const addressIps = clear ? [] : Array.from(new Set(normalizeAddressIps(req.body.addressIps))).slice(0, 3);
    if (!clear && !addressIps.length) {
      return res.status(400).json({ error: 'At least one IP is required, or set useGlobal=true' });
    }

    await updateUser(user.id, { addressIps, updatedAt: nowIso() });
    const updatedUser = await getUserById(user.id);
    const subscriptionFile = await upsertUserSubscriptionFile(updatedUser);

    res.json({
      ok: true,
      user: {
        id: updatedUser.id,
        name: updatedUser.name,
        addressIps: normalizeAddressIps(updatedUser.addressIps),
        usesGlobal: !userUsesCustomAddressIps(updatedUser),
      },
      subscriptionFile,
      message: clear
        ? `Клиент ${updatedUser.name}: IP сброшены на общие`
        : `Клиент ${updatedUser.name}: применены индивидуальные IP`,
    });
  } catch (err) {
    console.error('PUT /admin/settings/address-ips/users/:userId error:', err);
    res.status(400).json({ error: err.message || 'Internal server error' });
  }
});

router.post('/files/resync-all', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const users = await listUsers();
    const results = [];
    for (const user of users) {
      try {
        const file = await upsertUserSubscriptionFile(user);
        results.push({ userId: user.id, ok: true, storageUrl: file?.storageUrl || file?.storage?.storageUrl });
      } catch (err) {
        results.push({ userId: user.id, ok: false, error: err.message });
      }
    }
    res.json({ ok: true, count: results.length, results });
  } catch (err) {
    console.error('POST /admin/files/resync-all error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/sync-edge', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const result = await syncVpnEdgeClients();
    await writeAuditLog({
      actor: req.admin,
      action: 'servers.synced',
      targetType: 'edge-registry',
      data: {
        registryCount: result.registryCount,
        attempted: result.registryCount || 0,
        message: result.message,
      },
    });
    res.json(result);
  } catch (err) {
    console.error('POST /admin/sync-edge error:', err);
    await writeAuditLog({
      actor: req.admin,
      action: 'servers.sync_failed',
      targetType: 'edge-registry',
      data: { error: err.message || String(err) },
    }).catch(() => {});
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

router.post('/servers/restart-all', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const result = await syncVpnEdgeClients();
    await writeAuditLog({
      actor: req.admin,
      action: 'servers.restart_all',
      targetType: 'edge-registry',
      data: {
        registryCount: result.registryCount,
        attempted: result.registryCount || 0,
        message: result.message,
      },
    });
    res.json({ ok: result.ok, restart: result });
  } catch (err) {
    console.error('POST /admin/servers/restart-all error:', err);
    await writeAuditLog({
      actor: req.admin,
      action: 'servers.restart_all_failed',
      targetType: 'edge-registry',
      data: { error: err.message || String(err) },
    }).catch(() => {});
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

router.get('/logs', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const logs = await listAuditLogs({ limit: req.query.limit || 200 });
    res.json({ logs });
  } catch (err) {
    console.error('GET /admin/logs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/sync-edge/start', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const state = scheduleVpnEdgeSync({ immediate: true });
    res.json({ ok: true, ...state });
  } catch (err) {
    console.error('POST /admin/sync-edge/start error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

router.get('/system/health', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const summary = await getSystemHealthSummary({ includeCost: true });
    res.json(summary);
  } catch (err) {
    console.error('GET /admin/system/health error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/system/maintenance-audit', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const report = await auditRepositoryJunk({ maxItems: 50 });
    res.set('Cache-Control', 'no-store');
    res.json(report);
  } catch (err) {
    console.error('GET /admin/system/maintenance-audit error:', err);
    res.status(500).json({ error: 'Maintenance audit failed' });
  }
});

router.get('/system/maintenance-servers', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const report = await auditRelayServerMaintenance();
    res.set('Cache-Control', 'no-store');
    res.json(report);
  } catch (err) {
    console.error('GET /admin/system/maintenance-servers error:', err);
    res.status(500).json({ error: 'Server maintenance audit failed' });
  }
});

router.get('/system/maintenance-quarantines', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, jobs: await listMaintenanceQuarantines() });
  } catch (err) {
    console.error('GET /admin/system/maintenance-quarantines error:', err);
    res.status(500).json({ error: 'Unable to list maintenance quarantines' });
  }
});

router.post('/system/maintenance-quarantines', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const job = await quarantineMaintenanceCandidates(req.body?.paths, { confirmPhrase: req.body?.confirmPhrase });
    await writeAuditLog({ actor: req.admin, action: 'maintenance.quarantined', targetType: 'panel-host', targetId: job.id, data: { files: job.files } });
    res.status(201).json({ ok: true, job });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Quarantine failed' });
  }
});

router.post('/system/maintenance-quarantines/:id/restore', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const job = await restoreMaintenanceQuarantine(req.params.id, { confirmPhrase: req.body?.confirmPhrase });
    await writeAuditLog({ actor: req.admin, action: 'maintenance.restored', targetType: 'panel-host', targetId: job.id, data: { files: job.files } });
    res.json({ ok: true, job });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Restore failed' });
  }
});

router.post('/users/bulk-extend', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const days = Number(req.body?.days);
    const group = String(req.body?.group || 'all').trim();
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      return res.status(400).json({ error: 'days must be between 1 and 3650' });
    }

    const [allUsers, dealers] = await Promise.all([listUsers(), listDealers()]);
    const dealerIds = new Set(dealers.map((d) => d.id));
    let targets = allUsers;
    if (group === 'owner') {
      targets = allUsers.filter((u) => !u.dealerId);
    } else if (group === 'unknown') {
      targets = allUsers.filter((u) => u.dealerId && !dealerIds.has(u.dealerId));
    } else if (group.startsWith('dealer:')) {
      const dealerId = group.slice(7);
      targets = allUsers.filter((u) => u.dealerId === dealerId);
    }

    const now = Date.now();
    const dayMs = 86400000;
    let updated = 0;
    for (const user of targets) {
      const baseMs = user.expiresAt ? new Date(user.expiresAt).getTime() : now;
      const startMs = Math.max(now, Number.isNaN(baseMs) ? now : baseMs);
      const expiresAt = new Date(startMs + days * dayMs).toISOString();
      await updateUser(user.id, {
        expiresAt,
        status: 'active',
        disabledReason: null,
        disabledAt: null,
        updatedAt: nowIso(),
      });
      updated += 1;
    }

    await writeAuditLog({
      actor: req.admin,
      action: 'users.bulk_extend',
      targetType: 'user',
      data: { group, days, updated },
    });

    res.json({ ok: true, updated, group, days });
  } catch (err) {
    console.error('POST /admin/users/bulk-extend error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

router.get('/system/reliability', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const [migration, servers, backgroundSync] = await Promise.all([
      getSetting('euphoricUserMigration'),
      listServers(),
      Promise.resolve(getBackgroundSyncState()),
    ]);
    const enabled = servers.filter((s) => s.enabled !== false);
    const warmNodes = enabled.filter((s) => Number(s.minInstances ?? 0) >= 1);
    const legacyDisabled = servers.filter((s) => s.enabled === false);
    res.json({
      backgroundSync,
      migration: migration || null,
      warmNodes: warmNodes.map((s) => ({ id: s.id, name: s.name, minInstances: s.minInstances })),
      enabledCount: enabled.length,
      legacyDisabledCount: legacyDisabled.length,
      telegram: {
        configured: telegramAlertsEnabled(),
        cursorChat: telegramCursorBotConfigured(),
        hint: 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env',
        cursorHint:
          'For Cursor chat: TELEGRAM_BOT_CHAT_ENABLED=true, CURSOR_API_KEY, TELEGRAM_ALLOWED_CHAT_IDS',
      },
      edgeReportKey: {
        configured: Boolean(process.env.EDGE_REPORT_KEY),
        distinctFromAdminKey:
          Boolean(process.env.EDGE_REPORT_KEY) &&
          process.env.EDGE_REPORT_KEY !== process.env.ADMIN_API_KEY,
      },
    });
  } catch (err) {
    console.error('GET /admin/system/reliability error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/relay-edge-sync/status', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const [edgeStatus, agentState, backgroundSync] = await Promise.all([
      getRelayEdgeSyncStatusSummary(),
      Promise.resolve(getRelayAgentSyncState()),
      Promise.resolve(getRelayEdgeBackgroundSyncState()),
    ]);
    res.json({
      ok: true,
      edgeStatus,
      agentState,
      backgroundSync,
      syncMode: agentState.mode,
      syncHealthy: backgroundSync.healthy && !backgroundSync.lastError,
    });
  } catch (err) {
    console.error('GET /admin/relay-edge-sync/status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/sync-edge/status', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const { buildEdgeClientList } = await import('../lib/edge-clients.js');
    const clients = await buildEdgeClientList();
    const registry = await getClientRegistry();
    const servers = await listServers();
    const edgeServers = [];
    const backgroundSync = getBackgroundSyncState();
    res.json({
      activeClients: clients.length,
      clients,
      serversTotal: servers.length,
      edgeServicesConfigured: edgeServers.length,
      backgroundSync,
      system: {
        edgeReportKeyConfigured: Boolean(process.env.EDGE_REPORT_KEY),
        edgeReportKeyDistinct:
          Boolean(process.env.EDGE_REPORT_KEY) &&
          process.env.EDGE_REPORT_KEY !== process.env.ADMIN_API_KEY,
        syncHealthy: backgroundSync.healthy && !backgroundSync.lastError,
        syncAlert: backgroundSync.lastError || null,
      },
      serversMissing: [],
      storageRoot: process.env.LOCAL_STORAGE_DIR || '/data/files',
      registry,
      syncEnabled: process.env.VPN_EDGE_SYNC_ENABLED !== 'false',
      projectId: null,
    });
  } catch (err) {
    console.error('GET /admin/sync-edge/status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/files', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const files = await listFiles();
    res.json({
      files,
      storageRoot: process.env.LOCAL_STORAGE_DIR || '/data/files',
    });
  } catch (err) {
    console.error('GET /admin/files error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/files', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const { name, slug, storagePath, gcsPath, content, description, type, enabled, publicAccess, linkedUserId } =
      req.body;

    if (!name && !slug) {
      return res.status(400).json({ error: 'name or slug is required' });
    }

    const file = await createFile({
      name,
      slug,
      storagePath: storagePath || gcsPath,
      content: content || '',
      description,
      type,
      enabled,
      publicAccess,
      linkedUserId,
    });

    res.json({
      ...file,
      subscriptionUrl: file.storageUrl || null,
      publicUrl: file.slug ? `${PUBLIC_BASE_URL}/f/${file.slug}` : null,
    });
  } catch (err) {
    console.error('POST /admin/files error:', err);
    res.status(400).json({ error: err.message || 'Internal server error' });
  }
});

router.get('/files/:id', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const file = await getFileById(req.params.id);
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.json({
      file: {
        ...file,
        publicUrl: file.slug ? `${PUBLIC_BASE_URL}/f/${file.slug}` : null,
      },
    });
  } catch (err) {
    console.error('GET /admin/files/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/files/:id', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const file = await updateFile(req.params.id, req.body);
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.json({
      ...file,
      subscriptionUrl: file.storageUrl || null,
      publicUrl: file.slug ? `${PUBLIC_BASE_URL}/f/${file.slug}` : null,
    });
  } catch (err) {
    console.error('PUT /admin/files/:id error:', err);
    res.status(400).json({ error: err.message || 'Internal server error' });
  }
});

router.delete('/files/:id', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const result = await deleteFile(req.params.id);
    if (!result) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.json(result);
  } catch (err) {
    console.error('DELETE /admin/files/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/subscription/global', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const {
      enabled,
      subscriptionMode,
      content,
      uuid,
      serverIds,
      profileTitle,
      trafficLimitGB,
      trafficUsedGB,
      expiresAt,
      updateIntervalHours,
      syncToStorage = false,
    } = req.body;

    const update = {};
    if (enabled !== undefined) update.enabled = enabled;
    if (subscriptionMode !== undefined) update.subscriptionMode = subscriptionMode;
    if (content !== undefined) update.content = content;
    if (uuid !== undefined) update.uuid = uuid;
    if (serverIds !== undefined) update.serverIds = serverIds;
    if (profileTitle !== undefined) update.profileTitle = profileTitle;
    if (trafficLimitGB !== undefined) update.trafficLimitGB = Number(trafficLimitGB);
    if (trafficUsedGB !== undefined) update.trafficUsedGB = Number(trafficUsedGB);
    if (expiresAt !== undefined) update.expiresAt = expiresAt;
    if (updateIntervalHours !== undefined) update.updateIntervalHours = Number(updateIntervalHours);

    const global = await updateGlobalSubscription(update);
    const previewResult = await buildGlobalSubscriptionBody();

    let storage = null;
    const bucketConfigured = Boolean(getBucketName());
    const shouldSync = bucketConfigured && previewResult.ok && syncToStorage !== false;
    if (shouldSync) {
      storage = await syncGlobalSubscriptionToStorage(previewResult.body);
      if (storage.synced) {
        await updateGlobalSubscription({
          storageDownloadToken: storage.storageDownloadToken,
          storageUrl: storage.storageUrl,
          publicStorageUrl: storage.publicStorageUrl || null,
        });
      }
    }

    const updatedGlobal = await getGlobalSubscription();
    const urls = await buildGlobalSubscriptionUrls(updatedGlobal);

    res.json({
      ok: true,
      global: updatedGlobal,
      preview: previewResult.ok ? previewResult.body : '',
      storage,
      ...urls,
      publicUrl: urls.subscriptionUrl,
    });
  } catch (err) {
    console.error('PUT /admin/subscription/global error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/batch/subscription-import', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const action = String(req.body?.action || 'preview').trim().toLowerCase();
    if (!['preview', 'apply'].includes(action)) {
      return res.status(400).json({ error: 'Unsupported action' });
    }

    const imported = await fetchExternalSubscription(req.body?.url);
    if (action === 'preview') {
      return res.json({
        ok: true,
        sourceUrl: imported.sourceUrl,
        total: imported.total,
        protocols: imported.protocols,
        links: imported.links,
      });
    }

    const users = await listUsers(10000);
    const panel = await getPanelSettings();
    // Per-user bundle keys are intentionally kept on the user record. Do not
    // flatten them into the global list: doing so makes every client's panel
    // view contain every other client's SS/VLESS credentials.
    const currentLinks = normalizeExtraSubscriptionLines(panel.globalExtraSubscriptionLines);
    const mergedLinks = mergeExtraSubscriptionLines(currentLinks, imported.links);
    const added = Math.max(0, mergedLinks.length - currentLinks.length);

    await updatePanelSettings({
      globalExtraSubscriptionLines: mergedLinks,
      externalSubscriptionImport: {
        hostname: new URL(imported.sourceUrl).hostname,
        importedAt: nowIso(),
        importedCount: imported.total,
        addedCount: added,
      },
    });
    const sync = await syncExtraSubscriptionFiles(users, {
      reloadUser: getUserById,
      upsertSubscriptionFile: upsertUserSubscriptionFile,
      concurrency: Number(process.env.EXTRA_LINK_SYNC_CONCURRENCY || 4),
    });
    await writeAuditLog({
      actor: req.admin,
      action: 'subscription.external_imported',
      targetType: 'subscription',
      data: {
        hostname: new URL(imported.sourceUrl).hostname,
        fetched: imported.total,
        added,
        protocols: imported.protocols,
        users: users.length,
        refreshed: sync.refreshed,
        failed: sync.failed,
      },
    }).catch(() => {});

    return res.json({
      ok: true,
      sourceUrl: imported.sourceUrl,
      fetched: imported.total,
      added,
      protocols: imported.protocols,
      links: mergedLinks,
      totalLinks: mergedLinks.length,
      total: users.length,
      sync,
      message: sync.failed
        ? `RAW links saved, but ${sync.failed} subscription file(s) failed to rebuild.`
        : `RAW links saved and synchronized to ${sync.refreshed} subscription file(s).`,
    });
  } catch (err) {
    console.error('POST /admin/batch/subscription-import error:', err?.message || err);
    return res.status(400).json({ error: err?.message || 'Could not import subscription' });
  }
});

router.post('/batch/extra-links', async (req, res) => {
  if (!assertOwner(req, res)) return;
  try {
    const { action, links, index } = req.body;
    const users = await listUsers(10000);
    const panel = await getPanelSettings();
    // Only global extras belong in this list. Per-user SS/VLESS keys stay
    // scoped to their owner and are still included when that user's file is built.
    let currentLinks = normalizeExtraSubscriptionLines(panel.globalExtraSubscriptionLines);

    if (action === 'list') {
      return res.json({ ok: true, links: currentLinks, total: users.length });
    }

    if (action === 'add') {
      const added = normalizeExtraSubscriptionLines(links);
      if (!added.length) return res.status(400).json({ error: 'No valid links provided' });
      currentLinks = mergeExtraSubscriptionLines(currentLinks, added);
    } else if (action === 'remove') {
      if (!Number.isInteger(Number(index)) || Number(index) < 0 || Number(index) >= currentLinks.length) {
        return res.status(400).json({ error: 'Link index is no longer valid; refresh the list' });
      }
      currentLinks = removeExtraSubscriptionLine(currentLinks, Number(index));
    } else if (action === 'rename' && typeof req.body.remark === 'string') {
      if (!Number.isInteger(Number(index)) || Number(index) < 0 || Number(index) >= currentLinks.length) {
        return res.status(400).json({ error: 'Link index is no longer valid; refresh the list' });
      }
      currentLinks = renameExtraSubscriptionLine(currentLinks, Number(index), req.body.remark);
    } else if (action !== 'refresh') {
      return res.status(400).json({ error: 'Unsupported action' });
    }

    // One authoritative list prevents per-client index drift and also makes
    // these links automatically available to clients created in the future.
    await updatePanelSettings({ globalExtraSubscriptionLines: currentLinks });
    // The settings write above is the authoritative commit. File rebuilds are
    // queued so a slow Drive/local-storage update cannot make the button look
    // broken or hit the proxy timeout.
    const sync = queueExtraLinksSubscriptionSync();
    return res.json({
      ok: true,
      syncOk: true,
      links: currentLinks,
      total: users.length,
      sync,
      message: `RAW links saved; subscription files queued for ${users.length} client(s).`,
    });
  } catch (err) {
    console.error('POST /admin/batch/extra-links error:', err);
    res.status(err?.status || 500).json({ error: err?.message || 'Internal server error' });
  }
});

export default router;
