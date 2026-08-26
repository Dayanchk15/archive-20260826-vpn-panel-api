import { Router } from 'express';
import {
  MobileAuthError,
  activateMobileSession,
  authenticateMobileAccess,
  createPublicMobileSession,
  mobilePublicAccessConfig,
  mobilePublicConfigurationError,
  refreshMobileSession,
  revokeMobileSession,
  saveMobileDiagnostic,
} from '../lib/mobile-auth.js';
import { getUserById } from '../lib/db-store.js';
import { buildMobileProfile, buildMobileReleaseInfo, buildPublicMobileProfile } from '../lib/mobile-profile.js';
import { getPanelSettings } from '../lib/settings.js';
import { enforceUserLimits } from '../lib/user-enforcement.js';

const router = Router();

function bearerToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function requireMobile(req, res, next) {
  try {
    const auth = await authenticateMobileAccess(bearerToken(req));
    if (!auth || !['user', 'public'].includes(auth.session.access_mode || 'user')) {
      return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }
    req.mobile = auth;
    next();
  } catch (err) {
    next(err);
  }
}

function sendMobileError(res, err) {
  if (err instanceof MobileAuthError) {
    if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error('DADA VPN mobile API error:', err);
  return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
}

async function requireMobileAppEnabled() {
  const panel = await getPanelSettings();
  if (panel.mobileAppEnabled === false) {
    throw new MobileAuthError('MOBILE_APP_DISABLED', 403, 'DADA VPN is disabled');
  }
  return panel;
}

router.post('/activate', async (req, res) => {
  try {
    await requireMobileAppEnabled();
    const result = await activateMobileSession({
      code: req.body?.code,
      installationId: req.body?.installationId,
      deviceName: req.body?.deviceName,
      platformVersion: req.body?.platformVersion,
      appVersion: req.body?.appVersion,
      ip: req.mobileClientIp || req.ip,
    });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (err) {
    sendMobileError(res, err);
  }
});

router.post('/bootstrap', async (req, res) => {
  try {
    await requireMobileAppEnabled();
    const result = await createPublicMobileSession({
      installationId: req.body?.installationId,
      deviceName: req.body?.deviceName,
      platformVersion: req.body?.platformVersion,
      appVersion: req.body?.appVersion,
      ip: req.mobileClientIp || req.ip,
    });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (err) {
    sendMobileError(res, err);
  }
});

router.post('/session/refresh', async (req, res) => {
  try {
    await requireMobileAppEnabled();
    const result = await refreshMobileSession({
      refreshToken: req.body?.refreshToken,
      appVersion: req.body?.appVersion,
      platformVersion: req.body?.platformVersion,
      allowedAccessModes: ['user', 'public'],
    });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (err) {
    sendMobileError(res, err);
  }
});

router.delete('/session', requireMobile, async (req, res) => {
  try {
    await revokeMobileSession(req.mobile.session.user_id, req.mobile.session.id, 'user-logout');
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true });
  } catch (err) {
    sendMobileError(res, err);
  }
});

router.get('/profile', requireMobile, async (req, res) => {
  try {
    await requireMobileAppEnabled();
    const appVersionCode = Math.max(1, Number(req.get('x-app-version-code') || req.query.appVersionCode || 1));
    let profile;
    if ((req.mobile.session.access_mode || 'user') === 'public') {
      const configError = mobilePublicConfigurationError();
      if (configError) throw new MobileAuthError('MOBILE_PUBLIC_ACCESS_DISABLED', 403);
      profile = await buildPublicMobileProfile(appVersionCode, mobilePublicAccessConfig().uuid);
    } else {
      const userId = req.mobile.session.user_id;
      await enforceUserLimits(userId);
      const user = await getUserById(userId);
      if (!user) return res.status(401).json({ error: 'Unauthorized', code: 'USER_NOT_FOUND' });
      profile = await buildMobileProfile(user, appVersionCode);
    }
    if (req.get('if-none-match') === `"${profile.revision}"`) {
      return res.status(304).end();
    }
    res.set('Cache-Control', 'private, no-cache');
    res.set('ETag', `"${profile.revision}"`);
    res.json(profile);
  } catch (err) {
    sendMobileError(res, err);
  }
});

router.post('/diagnostics', requireMobile, async (req, res) => {
  try {
    const panel = await requireMobileAppEnabled();
    if (panel.mobileDiagnosticsEnabled === false) {
      throw new MobileAuthError('DIAGNOSTICS_DISABLED', 403, 'Diagnostics are disabled');
    }
    if (req.body?.consent !== true) {
      return res.status(400).json({ error: 'Consent is required', code: 'CONSENT_REQUIRED' });
    }
    const source = req.body?.data || {};
    const allowed = {
      appVersion: String(source.appVersion || '').slice(0, 40),
      androidVersion: String(source.androidVersion || '').slice(0, 40),
      deviceModel: String(source.deviceModel || '').slice(0, 120),
      locationId: String(source.locationId || '').slice(0, 120),
      stage: String(source.stage || '').slice(0, 80),
      errorCode: String(source.errorCode || '').slice(0, 120),
      connectionDurationMs: Math.max(0, Math.min(7 * 86400000, Number(source.connectionDurationMs || 0))),
      latencyMs: Math.max(0, Math.min(600000, Number(source.latencyMs || 0))),
      networkType: String(source.networkType || '').slice(0, 40),
    };
    const id = await saveMobileDiagnostic(
      req.mobile.session.user_id,
      req.mobile.session.id,
      allowed
    );
    res.status(202).json({ ok: true, id });
  } catch (err) {
    sendMobileError(res, err);
  }
});

router.get('/releases/latest', async (_req, res) => {
  try {
    const panel = await getPanelSettings();
    res.set('Cache-Control', 'public, max-age=300');
    res.json(buildMobileReleaseInfo(panel));
  } catch (err) {
    sendMobileError(res, err);
  }
});

router.use((err, _req, res, _next) => sendMobileError(res, err));

export default router;
