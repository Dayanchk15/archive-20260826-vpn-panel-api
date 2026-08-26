import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import { isIP } from 'node:net';
import path from 'path';
import { fileURLToPath } from 'url';
import adminRoutes from './routes/admin.js';
import internalRoutes from './routes/internal.js';
import fileRoutes from './routes/files.js';
import subscriptionRoutes from './routes/subscription.js';
import mobileRoutes from './routes/mobile.js';
import hiddifyAndroidRoutes from './routes/hiddify-android.js';
import { enforceAllUserLimits } from './lib/user-enforcement.js';
import { syncVpnEdgeClients } from './lib/vpn-edge-sync.js';
import { verifySessionToken } from './lib/auth-store.js';
import { writeAuditLog } from './lib/audit-log.js';
import { startTelegramCursorBot } from './lib/telegram-cursor-bot.js';
import { ensureProjectLogOnDataVolume } from './lib/project-log-memory.js';
import {
  getSubscriptionRefreshIntervalMs,
  refreshAllUserSubscriptionFiles,
  subscriptionBackgroundRefreshEnabled,
} from './lib/subscription-background-refresh.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const pathOnly = req.originalUrl.split('?')[0]
      .replace(/\/api\/sub\/[^/]+/, '/api/sub/:token')
      .replace(/\/sub\/[^/]+/, '/sub/:token')
      .replace(/\/api\/status\/[^/]+/, '/api/status/:token')
      .replace(/\/status\/[^/]+/, '/status/:token');
    const shouldLog =
      pathOnly.startsWith('/admin') ||
      pathOnly.startsWith('/internal') ||
      pathOnly.startsWith('/api/sub') ||
      pathOnly.startsWith('/sub') ||
      pathOnly.startsWith('/f/') ||
      pathOnly.startsWith('/api/status') ||
      pathOnly.startsWith('/status') ||
      pathOnly === '/' ||
      pathOnly === '/login' ||
      pathOnly === '/panel';

    if (!shouldLog || pathOnly === '/admin/logs') return;

    writeAuditLog({
      actor: req.admin || null,
      action: `request.${req.method}`,
      targetType: 'http',
      targetId: pathOnly,
      dealerId: req.admin?.dealerId || null,
      data: {
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
        ip: req.ip,
        userAgent: req.get('user-agent') || '',
      },
    }).catch(() => {});
  });
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// Bunny currently reaches the Hostinger compatibility proxy, which only forwards
// a single alphanumeric segment below /api/status. Keep the public mobile API
// canonical, and expose narrow, method-checked gateways for both Android clients.
const mobileBunnyAliases = new Map([
  ['dadaactivate', { method: 'POST', path: '/activate', router: mobileRoutes }],
  ['dadabootstrap', { method: 'POST', path: '/bootstrap', router: mobileRoutes }],
  ['dadarefresh', { method: 'POST', path: '/session/refresh', router: mobileRoutes }],
  ['dadasession', { method: 'DELETE', path: '/session', router: mobileRoutes }],
  ['dadaprofile', { method: 'GET', path: '/profile', router: mobileRoutes }],
  ['dadadiagnostics', { method: 'POST', path: '/diagnostics', router: mobileRoutes }],
  ['dadarelease', { method: 'GET', path: '/releases/latest', router: mobileRoutes }],
  ['hidbootstrap', { method: 'POST', path: '/bootstrap', router: hiddifyAndroidRoutes }],
  ['hidrefresh', { method: 'POST', path: '/session/refresh', router: hiddifyAndroidRoutes }],
  ['hidsession', { method: 'DELETE', path: '/session', router: hiddifyAndroidRoutes }],
  ['hidprofile', { method: 'GET', path: '/profile', router: hiddifyAndroidRoutes }],
  ['hidrelease', { method: 'GET', path: '/releases/latest', router: hiddifyAndroidRoutes }],
]);
const parseMobileBunnyBody = express.text({ type: () => true, limit: '64kb' });

app.use('/api/status/:mobileAlias', (req, res, next) => {
  const target = mobileBunnyAliases.get(String(req.params.mobileAlias || '').toLowerCase());
  if (!target) return next();
  if (req.method !== target.method) {
    res.set('Allow', target.method);
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const forwardedAuthorization = req.get('x-dada-authorization') || req.get('x-hiddify-authorization');
  if (!req.headers.authorization && forwardedAuthorization) {
    req.headers.authorization = forwardedAuthorization;
  }
  const configuredRelaySecret = String(process.env.MOBILE_RELAY_SECRET || '');
  if (configuredRelaySecret && req.get('x-dada-relay-secret') === configuredRelaySecret) {
    const forwardedIp = String(req.get('x-dada-client-ip') || '').split(',')[0].trim();
    if (isIP(forwardedIp)) req.mobileClientIp = forwardedIp;
  }

  const dispatch = () => {
    const queryIndex = req.originalUrl.indexOf('?');
    const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
    req.url = `${target.path}${query}`;
    target.router(req, res, next);
  };

  if (!['POST', 'PUT', 'PATCH'].includes(req.method) || (req.body && typeof req.body === 'object')) {
    return dispatch();
  }

  return parseMobileBunnyBody(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'Invalid request body', code: 'INVALID_BODY' });
    try {
      req.body = req.body ? JSON.parse(req.body) : {};
    } catch {
      return res.status(400).json({ error: 'Invalid JSON', code: 'INVALID_JSON' });
    }
    return dispatch();
  });
});

app.use('/', subscriptionRoutes);
app.use('/', fileRoutes);
app.use('/api/mobile/v1', mobileRoutes);
app.use('/api/hiddify-android/v1', hiddifyAndroidRoutes);
app.use('/admin', adminRoutes);
app.use('/internal', internalRoutes);

app.get('/', (req, res) => {
  res.redirect(302, '/login');
});

app.get('/login', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/panel', async (req, res) => {
  const admin = await verifySessionToken(req.cookies?.panel_session);
  if (!admin) return res.redirect(302, '/login');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Limits must be enforced shortly after a traffic reporter update or expiry.
// Keep this configurable, but never allow an accidental multi-hour default.
const configuredEnforceInterval = Number(process.env.USER_ENFORCE_INTERVAL_MS || 60 * 1000);
const ENFORCE_INTERVAL_MS = Number.isFinite(configuredEnforceInterval)
  ? Math.max(30 * 1000, configuredEnforceInterval)
  : 60 * 1000;
const SUBSCRIPTION_REFRESH_INTERVAL_MS = getSubscriptionRefreshIntervalMs();
let enforcementInProgress = false;

async function runPeriodicUserEnforcement() {
  if (enforcementInProgress) return;
  enforcementInProgress = true;
  try {
    const result = await enforceAllUserLimits();
    if (result.disabled > 0) {
      console.log(`Auto-disabled ${result.disabled} expired/over-limit user(s)`);
      // Publish the reduced active-UUID registry immediately.  Relay agents
      // pull it independently, while non-relay deployments use this registry
      // on their next reconciliation.
      await syncVpnEdgeClients({ fullSync: true });
    }
  } catch (err) {
    console.error('Periodic user enforcement error:', err);
  } finally {
    enforcementInProgress = false;
  }
}

async function runPeriodicSubscriptionRefresh() {
  if (!subscriptionBackgroundRefreshEnabled()) return;
  try {
    const result = await refreshAllUserSubscriptionFiles({ reason: 'scheduled' });
    if (result.skipped) return;
    console.log(
      `Subscription snapshot refresh: ${result.refreshed}/${result.total} updated` +
        (result.failed ? `, ${result.failed} failed` : '') +
        ` (${result.durationMs}ms)`
    );
    if (result.failures?.length) {
      console.warn('Subscription snapshot refresh failures:', result.failures);
    }
  } catch (err) {
    console.error('Periodic subscription snapshot refresh error:', err);
  }
}

app.listen(PORT, () => {
  const hasKey = Boolean(process.env.ADMIN_API_KEY);
  const hasEdgeKey = Boolean(process.env.EDGE_REPORT_KEY);
  const brand = process.env.PANEL_BRAND_NAME || 'VPN Panel';
  console.log(`${brand} panel API listening on port ${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/panel`);
  if (!hasKey) console.warn('WARNING: ADMIN_API_KEY is not set');
  if (!process.env.AUTH_JWT_SECRET && process.env.NODE_ENV === 'production') {
    console.warn('WARNING: AUTH_JWT_SECRET is not set — login sessions will not work');
  }
  if (!hasEdgeKey) {
    console.warn('WARNING: EDGE_REPORT_KEY is not set — traffic reports from managed VPS edges will fail');
  } else if (hasKey && process.env.EDGE_REPORT_KEY === process.env.ADMIN_API_KEY) {
    console.warn('WARNING: EDGE_REPORT_KEY equals ADMIN_API_KEY — use separate keys for security');
  }

  runPeriodicUserEnforcement();
  console.log(`User limit enforcement enabled every ${Math.round(ENFORCE_INTERVAL_MS / 1000)} second(s)`);
  setInterval(runPeriodicUserEnforcement, ENFORCE_INTERVAL_MS);

  if (subscriptionBackgroundRefreshEnabled()) {
    console.log(
      `Subscription snapshot refresh enabled every ${Math.round(
        SUBSCRIPTION_REFRESH_INTERVAL_MS / 60000
      )} minute(s)`
    );
    runPeriodicSubscriptionRefresh();
    setInterval(runPeriodicSubscriptionRefresh, SUBSCRIPTION_REFRESH_INTERVAL_MS);
  }

  ensureProjectLogOnDataVolume()
    .then((r) => console.log('PROJECT_LOG data volume:', r.action, r.path))
    .catch((err) => console.warn('PROJECT_LOG init warning:', err.message || err));

  startTelegramCursorBot().catch((err) => {
    console.error('Telegram Cursor bot failed:', err);
  });
});
