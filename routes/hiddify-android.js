import { Router } from 'express';
import {
  MobileAuthError,
  authenticateMobileAccess,
  createHiddifyAndroidSession,
  hiddifyAndroidPublicAccessConfig,
  hiddifyAndroidPublicConfigurationError,
  refreshMobileSession,
  revokeMobileSession,
} from '../lib/mobile-auth.js';
import {
  buildHiddifyAndroidProfile,
  buildHiddifyAndroidReleaseInfo,
} from '../lib/hiddify-android-profile.js';
import { getPanelSettings } from '../lib/settings.js';

const router = Router();

function bearerToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function sendError(res, err) {
  if (err instanceof MobileAuthError) {
    if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error('DADA Connect Android API error:', err);
  return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
}

async function requireEnabled() {
  const panel = await getPanelSettings();
  if (panel.hiddifyAndroidEnabled === false) {
    throw new MobileAuthError('APP_DISABLED', 403, 'DADA Connect is disabled');
  }
  const configurationError = hiddifyAndroidPublicConfigurationError();
  if (configurationError) {
    throw new MobileAuthError('APP_NOT_CONFIGURED', 503, configurationError);
  }
  return panel;
}

async function requireManagedSession(req, res, next) {
  try {
    const auth = await authenticateMobileAccess(bearerToken(req));
    if (!auth || auth.session.access_mode !== 'hiddify-android') {
      return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
    req.hiddifyAndroid = auth;
    next();
  } catch (err) {
    next(err);
  }
}

router.post('/bootstrap', async (req, res) => {
  try {
    await requireEnabled();
    const result = await createHiddifyAndroidSession({
      installationId: req.body?.installationId,
      deviceName: req.body?.deviceName,
      platformVersion: req.body?.platformVersion,
      appVersion: req.body?.appVersion,
      ip: req.mobileClientIp || req.ip,
    });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/session/refresh', async (req, res) => {
  try {
    await requireEnabled();
    const result = await refreshMobileSession({
      refreshToken: req.body?.refreshToken,
      appVersion: req.body?.appVersion,
      platformVersion: req.body?.platformVersion,
      expectedAccessMode: 'hiddify-android',
    });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/session', requireManagedSession, async (req, res) => {
  try {
    await revokeMobileSession(null, req.hiddifyAndroid.session.id, 'user-logout');
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/profile', requireManagedSession, async (req, res) => {
  try {
    await requireEnabled();
    const versionCode = Math.max(1, Number(req.get('x-app-version-code') || req.query.appVersionCode || 1));
    const profile = await buildHiddifyAndroidProfile(
      versionCode,
      hiddifyAndroidPublicAccessConfig().uuid
    );
    if (req.get('if-none-match') === `"${profile.revision}"`) return res.status(304).end();
    res.set('Cache-Control', 'private, no-cache');
    res.set('ETag', `"${profile.revision}"`);
    res.json(profile);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/releases/latest', async (_req, res) => {
  try {
    const panel = await getPanelSettings();
    res.set('Cache-Control', 'public, max-age=300');
    res.json(buildHiddifyAndroidReleaseInfo(panel));
  } catch (err) {
    sendError(res, err);
  }
});

router.use((err, _req, res, _next) => sendError(res, err));

export default router;
