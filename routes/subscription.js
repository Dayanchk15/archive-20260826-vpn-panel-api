import { Router } from 'express';
import { buildGlobalSubscriptionBody } from '../lib/subscription.js';
import {
  buildMetaForUser,
  buildSubscriptionMeta,
  sendSubscriptionResponse,
} from '../lib/subscription-meta.js';
import { getGlobalSubscription, getPanelSettings } from '../lib/settings.js';
import { getFileByLinkedUserId } from '../lib/files.js';
import { serveUserSubscription } from '../lib/subscription-serve.js';
import { prepareUserForSubscription } from '../lib/subscription-user.js';
import { isHiddifySubscriptionRequest } from '../lib/hiddify-subscription-compat.js';
import { updateUser } from '../lib/db-store.js';

function resolveSubscriptionFormat(req) {
  if (req.query.format) return String(req.query.format);
  // Hiddify parses plain text faster than base64 on weak phones / TM links.
  if (isHiddifySubscriptionRequest(req.get('user-agent'), req.query.client)) {
    return 'plain';
  }
  return 'base64';
}

const router = Router();

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

async function resolveProfileWebPageUrl(req) {
  const pathOnly = req.originalUrl.split('?')[0];
  const panel = await getPanelSettings();
  const customBase = trimTrailingSlash(
    panel.subscriptionBaseUrl || process.env.SUBSCRIPTION_BASE_URL || ''
  );
  if (customBase && !/\.run\.app/i.test(customBase)) {
    return `${customBase}${pathOnly}`;
  }
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}${pathOnly}`;
}

router.get('/sub/global', async (req, res) => {
  try {
    const format = req.query.format || 'base64';
    const result = await buildGlobalSubscriptionBody();

    if (!result.ok) {
      return res.status(result.reason === 'Global subscription disabled' ? 403 : 404)
        .type('text/plain')
        .send(result.reason);
    }

    const global = await getGlobalSubscription();
    const panel = await getPanelSettings();
    const meta = buildSubscriptionMeta(
      {
        name: global.profileTitle || panel.brandName,
        profileTitle: global.profileTitle || panel.brandName,
        trafficLimitGB: global.trafficLimitGB ?? 50,
        trafficUsedGB: global.trafficUsedGB ?? 0,
        expiresAt: global.expiresAt || null,
        updateIntervalHours: global.updateIntervalHours || panel.updateIntervalHours,
      },
      panel
    );

    sendSubscriptionResponse(res, result.body, meta, format, { panelSettings: panel });
  } catch (err) {
    console.error('GET /sub/global error:', err);
    res.status(500).type('text/plain').send('Internal server error');
  }
});

router.get('/sub/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const format = resolveSubscriptionFormat(req);
    const user = await prepareUserForSubscription(token);
    if (!user) {
      return res.status(404).type('text/plain').send('Subscription not found');
    }

    // Always render the panel URL from the current database state.  The linked
    // file is retained as a fallback/metadata record, but it must not become a
    // stale snapshot after an IP, SNI or RAW-key change.  This also keeps old
    // imported URLs working without requiring every client to re-import them.
    const file = await getFileByLinkedUserId(user.id);
    const useLive = true;
    const profileWebPageUrl = await resolveProfileWebPageUrl(req);
    const served = await serveUserSubscription(res, user, file, format, {
      live: useLive,
      profileWebPageUrl,
      client: req.query.client,
      userAgent: req.get('user-agent'),
    });
    if (served.ok) {
      updateUser(user.id, { lastTrafficAt: new Date().toISOString() }).catch(() => {});
      return;
    }
    return res.status(served.status).type('text/plain').send(served.message);
  } catch (err) {
    console.error('GET /sub/:token error:', err);
    res.status(500).type('text/plain').send('Internal server error');
  }
});

router.get('/api/sub/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const format = resolveSubscriptionFormat(req);
    const user = await prepareUserForSubscription(token);
    if (!user) {
      return res.status(404).type('text/plain').send('Subscription not found');
    }

    // `/api/sub` is the canonical import URL; serve the current body rather
    // than a previously persisted snapshot so administrative changes are
    // visible immediately.
    const file = await getFileByLinkedUserId(user.id);
    const useLive = true;
    const profileWebPageUrl = await resolveProfileWebPageUrl(req);
    const served = await serveUserSubscription(res, user, file, format, {
      live: useLive,
      inline: true,
      filenameExtension: 'txt',
      profileWebPageUrl,
      client: req.query.client,
      userAgent: req.get('user-agent'),
    });
    if (served.ok) {
      updateUser(user.id, { lastTrafficAt: new Date().toISOString() }).catch(() => {});
      return;
    }
    return res.status(served.status).type('text/plain').send(served.message);
  } catch (err) {
    console.error('GET /api/sub/:token error:', err);
    res.status(500).type('text/plain').send('Internal server error');
  }
});

router.get('/status/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const user = await prepareUserForSubscription(token);
    if (!user) {
      return res.status(404).json({ error: 'not found' });
    }

    const meta = await buildMetaForUser(user);
    const panel = await getPanelSettings();

    res.json({
      status: user.status,
      expiresAt: user.expiresAt,
      trafficLimitGB: user.trafficLimitGB,
      trafficUsedGB: user.trafficUsedGB || 0,
      uuid: user.uuid,
      subscriptionMode: user.subscriptionMode || 'auto',
      serverIds: user.serverIds || [],
      daysRemaining: meta.daysRemaining,
      subscriptionUserInfo: {
        upload: meta.upload,
        download: meta.download,
        total: meta.total,
        expire: meta.expire,
      },
      profileTitle: meta.profileTitle,
      brandName: panel.brandName,
    });
  } catch (err) {
    console.error('GET /status/:token error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/status/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const user = await prepareUserForSubscription(token);
    if (!user) {
      return res.status(404).json({ error: 'not found' });
    }

    const meta = await buildMetaForUser(user);
    const panel = await getPanelSettings();

    res.json({
      status: user.status,
      expiresAt: user.expiresAt,
      trafficLimitGB: user.trafficLimitGB,
      trafficUsedGB: user.trafficUsedGB || 0,
      uuid: user.uuid,
      subscriptionMode: user.subscriptionMode || 'auto',
      serverIds: user.serverIds || [],
      daysRemaining: meta.daysRemaining,
      subscriptionUserInfo: {
        upload: meta.upload,
        download: meta.download,
        total: meta.total,
        expire: meta.expire,
      },
      profileTitle: meta.profileTitle,
      brandName: panel.brandName,
    });
  } catch (err) {
    console.error('GET /api/status/:token error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
