import { randomInt } from 'crypto';
import jwt from 'jsonwebtoken';
import { sha256, randomToken } from './crypto.js';
import { addDays, nowIso } from './dates.js';
import { getUserById } from './db-store.js';
import { createId, getPool, isPostgresEnabled, query } from './postgres.js';
import { enforceUserLimits } from './user-enforcement.js';

const ACTIVATION_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ACCESS_TOKEN_MINUTES = Number(process.env.MOBILE_ACCESS_TOKEN_MINUTES || 15);
const REFRESH_TOKEN_DAYS = Number(process.env.MOBILE_REFRESH_TOKEN_DAYS || 30);
const ACTIVATION_WINDOW_SECONDS = Number(process.env.MOBILE_ACTIVATION_RATE_WINDOW_SECONDS || 900);
const ACTIVATION_MAX_ATTEMPTS = Number(process.env.MOBILE_ACTIVATION_RATE_MAX || 8);
const PUBLIC_BOOTSTRAP_WINDOW_SECONDS = Number(process.env.MOBILE_PUBLIC_RATE_WINDOW_SECONDS || 3600);
const PUBLIC_BOOTSTRAP_MAX_PER_IP = Number(process.env.MOBILE_PUBLIC_RATE_MAX_PER_IP || 120);
const PUBLIC_SUBJECT = '__dada_public__';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class MobileAuthError extends Error {
  constructor(code, status = 400, message = code) {
    super(message);
    this.name = 'MobileAuthError';
    this.code = code;
    this.status = status;
  }
}

function mobileJwtSecret() {
  return process.env.MOBILE_JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-mobile-secret-change-me');
}

export function mobilePublicAccessConfig() {
  const uuid = String(process.env.MOBILE_PUBLIC_UUID || '').trim().toLowerCase();
  return {
    enabled: process.env.MOBILE_PUBLIC_ACCESS === 'true',
    uuid: UUID_PATTERN.test(uuid) ? uuid : '',
  };
}

export function hiddifyAndroidPublicAccessConfig() {
  const uuid = String(process.env.HIDDIFY_ANDROID_PUBLIC_UUID || process.env.MOBILE_PUBLIC_UUID || '')
    .trim()
    .toLowerCase();
  return {
    enabled: process.env.HIDDIFY_ANDROID_PUBLIC_ACCESS !== 'false',
    uuid: UUID_PATTERN.test(uuid) ? uuid : '',
  };
}

export function mobilePublicConfigurationError() {
  const common = mobileAuthConfigurationError();
  if (common) return common;
  const config = mobilePublicAccessConfig();
  if (!config.enabled) return 'MOBILE_PUBLIC_ACCESS is not enabled';
  if (!config.uuid) return 'MOBILE_PUBLIC_UUID is not configured';
  return '';
}

export function hiddifyAndroidPublicConfigurationError() {
  const common = mobileAuthConfigurationError();
  if (common) return common;
  const config = hiddifyAndroidPublicAccessConfig();
  if (!config.enabled) return 'HIDDIFY_ANDROID_PUBLIC_ACCESS is disabled';
  if (!config.uuid) return 'HIDDIFY_ANDROID_PUBLIC_UUID or MOBILE_PUBLIC_UUID is not configured';
  return '';
}

function publicModeConfigurationError(accessMode) {
  return accessMode === 'hiddify-android'
    ? hiddifyAndroidPublicConfigurationError()
    : mobilePublicConfigurationError();
}

export function mobileAuthConfigurationError() {
  if (!isPostgresEnabled()) return 'Mobile clients require PostgreSQL';
  if (!mobileJwtSecret()) return 'MOBILE_JWT_SECRET is not configured';
  return '';
}

export function normalizeActivationCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function generateActivationCode(length = 8) {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += ACTIVATION_ALPHABET[randomInt(ACTIVATION_ALPHABET.length)];
  }
  return value;
}

function sanitizeText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function publicSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    accessMode: row.access_mode || 'user',
    deviceName: row.device_name || '',
    platformVersion: row.platform_version || '',
    appVersion: row.app_version || '',
    createdAt: row.created_at?.toISOString?.() || row.created_at || null,
    lastSeenAt: row.last_seen_at?.toISOString?.() || row.last_seen_at || null,
    expiresAt: row.expires_at?.toISOString?.() || row.expires_at || null,
    revokedAt: row.revoked_at?.toISOString?.() || row.revoked_at || null,
    revokeReason: row.revoke_reason || null,
    active: !row.revoked_at && new Date(row.expires_at).getTime() > Date.now(),
  };
}

function signAccessToken(session) {
  const secret = mobileJwtSecret();
  if (!secret) throw new MobileAuthError('MOBILE_NOT_CONFIGURED', 503);
  return jwt.sign(
    {
      sub: session.user_id || PUBLIC_SUBJECT,
      sid: session.id,
      type: 'mobile-access',
    },
    secret,
    { expiresIn: `${ACCESS_TOKEN_MINUTES}m`, issuer: 'dada-vpn-panel', audience: 'dada-vpn-android' }
  );
}

async function registerPublicBootstrap(ip, accessMode = 'public') {
  const keyHash = sha256(`public-bootstrap:${accessMode}:ip:${ip || 'unknown'}`);
  const result = await query(
    `INSERT INTO mobile_activation_attempts
      (key_hash, attempt_count, window_started_at, blocked_until, updated_at)
     VALUES ($1, 1, NOW(), NULL, NOW())
     ON CONFLICT (key_hash) DO UPDATE SET
       attempt_count = CASE
         WHEN mobile_activation_attempts.window_started_at < NOW() - ($3 * INTERVAL '1 second') THEN 1
         ELSE mobile_activation_attempts.attempt_count + 1
       END,
       window_started_at = CASE
         WHEN mobile_activation_attempts.window_started_at < NOW() - ($3 * INTERVAL '1 second') THEN NOW()
         ELSE mobile_activation_attempts.window_started_at
       END,
       blocked_until = CASE
         WHEN mobile_activation_attempts.blocked_until > NOW() THEN mobile_activation_attempts.blocked_until
         WHEN mobile_activation_attempts.attempt_count + 1 > $2 THEN NOW() + ($3 * INTERVAL '1 second')
         ELSE NULL
       END,
       updated_at = NOW()
     RETURNING blocked_until`,
    [keyHash, PUBLIC_BOOTSTRAP_MAX_PER_IP, PUBLIC_BOOTSTRAP_WINDOW_SECONDS]
  );
  const blockedUntil = result.rows[0]?.blocked_until;
  if (blockedUntil && new Date(blockedUntil).getTime() > Date.now()) {
    const error = new MobileAuthError('PUBLIC_BOOTSTRAP_RATE_LIMITED', 429);
    error.retryAfter = Math.max(1, Math.ceil((new Date(blockedUntil).getTime() - Date.now()) / 1000));
    throw error;
  }
}

export async function createPublicMobileSession({
  installationId,
  deviceName,
  platformVersion,
  appVersion,
  ip,
  accessMode = 'public',
} = {}) {
  const normalizedAccessMode = accessMode === 'hiddify-android' ? 'hiddify-android' : 'public';
  const configError = publicModeConfigurationError(normalizedAccessMode);
  if (configError) throw new MobileAuthError('MOBILE_PUBLIC_NOT_CONFIGURED', 503, configError);
  const normalizedInstallation = sanitizeText(installationId, 200);
  if (!normalizedInstallation) throw new MobileAuthError('INVALID_INSTALLATION', 400);
  await registerPublicBootstrap(ip, normalizedAccessMode);

  const installationHash = sha256(normalizedInstallation);
  const client = await getPool().connect();
  let session;
  let refreshToken;
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE mobile_sessions
       SET revoked_at = COALESCE(revoked_at, NOW()), revoke_reason = COALESCE(revoke_reason, 'public-session-replaced')
       WHERE access_mode = $2 AND installation_hash = $1 AND revoked_at IS NULL`,
      [installationHash, normalizedAccessMode]
    );
    refreshToken = randomToken();
    const now = new Date();
    const expiresAt = addDays(now, REFRESH_TOKEN_DAYS);
    session = {
      id: createId('msp'),
      user_id: null,
      access_mode: normalizedAccessMode,
      device_name: sanitizeText(deviceName, 120),
      platform_version: sanitizeText(platformVersion, 40),
      app_version: sanitizeText(appVersion, 40),
      created_at: now,
      last_seen_at: now,
      expires_at: expiresAt,
      revoked_at: null,
      revoke_reason: null,
    };
    await client.query(
      `INSERT INTO mobile_sessions
        (id, user_id, access_mode, installation_hash, refresh_token_hash, device_name,
         platform_version, app_version, created_at, last_seen_at, expires_at)
       VALUES ($1, NULL, $9, $2, $3, $4, $5, $6, $7, $7, $8)`,
      [
        session.id,
        installationHash,
        sha256(refreshToken),
        session.device_name,
        session.platform_version,
        session.app_version,
        now.toISOString(),
        expiresAt.toISOString(),
        normalizedAccessMode,
      ]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return {
    accessToken: signAccessToken(session),
    accessTokenExpiresIn: ACCESS_TOKEN_MINUTES * 60,
    refreshToken,
    refreshTokenExpiresAt: session.expires_at.toISOString(),
    session: publicSession(session),
  };
}

export async function createHiddifyAndroidSession(input = {}) {
  return createPublicMobileSession({ ...input, accessMode: 'hiddify-android' });
}

export function verifyMobileAccessToken(token) {
  const secret = mobileJwtSecret();
  if (!token || !secret) return null;
  try {
    const payload = jwt.verify(token, secret, {
      issuer: 'dada-vpn-panel',
      audience: 'dada-vpn-android',
    });
    if (payload.type !== 'mobile-access' || !payload.sid || !payload.sub) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function createMobileActivationCode(userId, { validDays = 7 } = {}) {
  const configError = mobileAuthConfigurationError();
  if (configError) throw new MobileAuthError('MOBILE_NOT_CONFIGURED', 503, configError);
  const user = await getUserById(userId);
  if (!user) throw new MobileAuthError('USER_NOT_FOUND', 404);

  await query(
    `UPDATE mobile_activation_codes
     SET revoked_at = NOW()
     WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
    [userId]
  );

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateActivationCode();
    try {
      const id = createId('mac');
      const expiresAt = addDays(new Date(), Math.max(1, Math.min(30, Number(validDays || 7))));
      await query(
        `INSERT INTO mobile_activation_codes
          (id, user_id, code_hash, created_at, expires_at)
         VALUES ($1, $2, $3, NOW(), $4)`,
        [id, userId, sha256(code), expiresAt.toISOString()]
      );
      return { id, code, userId, expiresAt: expiresAt.toISOString() };
    } catch (err) {
      if (err?.code !== '23505') throw err;
    }
  }
  throw new Error('Unable to generate a unique activation code');
}

async function registerActivationAttempt(ip, codeHash) {
  const keys = [sha256(`ip:${ip || 'unknown'}`), sha256(`code:${codeHash}`)];
  let blockedUntil = null;
  for (const keyHash of keys) {
    const result = await query(
      `INSERT INTO mobile_activation_attempts
        (key_hash, attempt_count, window_started_at, blocked_until, updated_at)
       VALUES ($1, 1, NOW(), NULL, NOW())
       ON CONFLICT (key_hash) DO UPDATE SET
         attempt_count = CASE
           WHEN mobile_activation_attempts.window_started_at < NOW() - ($3 * INTERVAL '1 second') THEN 1
           ELSE mobile_activation_attempts.attempt_count + 1
         END,
         window_started_at = CASE
           WHEN mobile_activation_attempts.window_started_at < NOW() - ($3 * INTERVAL '1 second') THEN NOW()
           ELSE mobile_activation_attempts.window_started_at
         END,
         blocked_until = CASE
           WHEN mobile_activation_attempts.blocked_until > NOW() THEN mobile_activation_attempts.blocked_until
           WHEN (
             CASE
               WHEN mobile_activation_attempts.window_started_at < NOW() - ($3 * INTERVAL '1 second') THEN 1
               ELSE mobile_activation_attempts.attempt_count + 1
             END
           ) >= $2 THEN NOW() + ($3 * INTERVAL '1 second')
           ELSE NULL
         END,
         updated_at = NOW()
       RETURNING blocked_until`,
      [keyHash, ACTIVATION_MAX_ATTEMPTS, ACTIVATION_WINDOW_SECONDS]
    );
    const value = result.rows[0]?.blocked_until;
    if (value && new Date(value).getTime() > Date.now()) blockedUntil = value;
  }
  return blockedUntil;
}

async function clearActivationAttempts(ip, codeHash) {
  const keys = [sha256(`ip:${ip || 'unknown'}`), sha256(`code:${codeHash}`)];
  await query('DELETE FROM mobile_activation_attempts WHERE key_hash = ANY($1::text[])', [keys]);
}

async function assertUserMayUseMobile(userId) {
  await enforceUserLimits(userId);
  const user = await getUserById(userId);
  if (!user) throw new MobileAuthError('INVALID_ACTIVATION_CODE', 401);
  if (user.mobileAccessEnabled === false) throw new MobileAuthError('MOBILE_ACCESS_DISABLED', 403);
  if (user.status !== 'active') {
    const reason = user.disabledReason === 'expired' ? 'SUBSCRIPTION_EXPIRED' : 'SUBSCRIPTION_DISABLED';
    throw new MobileAuthError(reason, 403);
  }
  return user;
}

export async function activateMobileSession({
  code,
  installationId,
  deviceName,
  platformVersion,
  appVersion,
  ip,
} = {}) {
  const configError = mobileAuthConfigurationError();
  if (configError) throw new MobileAuthError('MOBILE_NOT_CONFIGURED', 503, configError);

  const normalizedCode = normalizeActivationCode(code);
  const normalizedInstallation = sanitizeText(installationId, 200);
  if (normalizedCode.length !== 8 || !normalizedInstallation) {
    throw new MobileAuthError('INVALID_ACTIVATION_CODE', 401);
  }

  const codeHash = sha256(normalizedCode);
  const blockedUntil = await registerActivationAttempt(ip, codeHash);
  if (blockedUntil) {
    const error = new MobileAuthError('ACTIVATION_RATE_LIMITED', 429);
    error.retryAfter = Math.max(1, Math.ceil((new Date(blockedUntil).getTime() - Date.now()) / 1000));
    throw error;
  }

  const found = await query(
    `SELECT id, user_id, expires_at, used_at, revoked_at
     FROM mobile_activation_codes
     WHERE code_hash = $1
     LIMIT 1`,
    [codeHash]
  );
  const activation = found.rows[0];
  if (activation && !activation.used_at && !activation.revoked_at && new Date(activation.expires_at).getTime() <= Date.now()) {
    throw new MobileAuthError('ACTIVATION_CODE_EXPIRED', 401);
  }
  if (
    !activation ||
    activation.used_at ||
    activation.revoked_at ||
    new Date(activation.expires_at).getTime() <= Date.now()
  ) {
    throw new MobileAuthError('INVALID_ACTIVATION_CODE', 401);
  }

  await assertUserMayUseMobile(activation.user_id);
  await query('SELECT 1');
  const client = await getPool().connect();
  let session;
  let refreshToken;
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT id, user_id, expires_at, used_at, revoked_at
       FROM mobile_activation_codes
       WHERE id = $1
       FOR UPDATE`,
      [activation.id]
    );
    const row = locked.rows[0];
    if (row && !row.used_at && !row.revoked_at && new Date(row.expires_at).getTime() <= Date.now()) {
      throw new MobileAuthError('ACTIVATION_CODE_EXPIRED', 401);
    }
    if (!row || row.used_at || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) {
      throw new MobileAuthError('INVALID_ACTIVATION_CODE', 401);
    }

    refreshToken = randomToken();
    const now = new Date();
    const expiresAt = addDays(now, REFRESH_TOKEN_DAYS);
    session = {
      id: createId('msn'),
      user_id: row.user_id,
      device_name: sanitizeText(deviceName, 120),
      platform_version: sanitizeText(platformVersion, 40),
      app_version: sanitizeText(appVersion, 40),
      created_at: now,
      last_seen_at: now,
      expires_at: expiresAt,
      revoked_at: null,
      revoke_reason: null,
    };
    await client.query(
      `INSERT INTO mobile_sessions
        (id, user_id, installation_hash, refresh_token_hash, device_name, platform_version,
         app_version, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)`,
      [
        session.id,
        session.user_id,
        sha256(normalizedInstallation),
        sha256(refreshToken),
        session.device_name,
        session.platform_version,
        session.app_version,
        now.toISOString(),
        expiresAt.toISOString(),
      ]
    );
    await client.query(
      'UPDATE mobile_activation_codes SET used_at = NOW(), used_by_session_id = $2 WHERE id = $1',
      [row.id, session.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await clearActivationAttempts(ip, codeHash);
  return {
    accessToken: signAccessToken(session),
    accessTokenExpiresIn: ACCESS_TOKEN_MINUTES * 60,
    refreshToken,
    refreshTokenExpiresAt: session.expires_at.toISOString(),
    session: publicSession(session),
  };
}

export async function refreshMobileSession({
  refreshToken,
  appVersion,
  platformVersion,
  expectedAccessMode,
  allowedAccessModes,
} = {}) {
  const configError = mobileAuthConfigurationError();
  if (configError) throw new MobileAuthError('MOBILE_NOT_CONFIGURED', 503, configError);
  const token = sanitizeText(refreshToken, 256);
  if (!token) throw new MobileAuthError('INVALID_REFRESH_TOKEN', 401);
  const tokenHash = sha256(token);

  await query('SELECT 1');
  const client = await getPool().connect();
  let session;
  let nextToken;
  try {
    await client.query('BEGIN');
    const active = await client.query(
      'SELECT * FROM mobile_sessions WHERE refresh_token_hash = $1 FOR UPDATE',
      [tokenHash]
    );
    session = active.rows[0];
    if (!session) {
      const reused = await client.query(
        'SELECT session_id FROM mobile_refresh_token_history WHERE token_hash = $1 LIMIT 1',
        [tokenHash]
      );
      if (reused.rows[0]) {
        await client.query(
          `UPDATE mobile_sessions
           SET revoked_at = COALESCE(revoked_at, NOW()), revoke_reason = 'refresh-token-reuse'
           WHERE id = $1`,
          [reused.rows[0].session_id]
        );
        await client.query('COMMIT');
        throw new MobileAuthError('REFRESH_TOKEN_REUSED', 401);
      }
      throw new MobileAuthError('INVALID_REFRESH_TOKEN', 401);
    }
    if (session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
      throw new MobileAuthError('SESSION_EXPIRED', 401);
    }
    if (expectedAccessMode && session.access_mode !== expectedAccessMode) {
      throw new MobileAuthError('INVALID_REFRESH_TOKEN', 401);
    }
    if (Array.isArray(allowedAccessModes) && !allowedAccessModes.includes(session.access_mode || 'user')) {
      throw new MobileAuthError('INVALID_REFRESH_TOKEN', 401);
    }

    nextToken = randomToken();
    await client.query(
      `INSERT INTO mobile_refresh_token_history (token_hash, session_id, rotated_at)
       VALUES ($1, $2, NOW())`,
      [tokenHash, session.id]
    );
    await client.query(
      `UPDATE mobile_sessions
       SET refresh_token_hash = $2,
           last_seen_at = NOW(),
           app_version = COALESCE(NULLIF($3, ''), app_version),
           platform_version = COALESCE(NULLIF($4, ''), platform_version)
       WHERE id = $1`,
      [session.id, sha256(nextToken), sanitizeText(appVersion, 40), sanitizeText(platformVersion, 40)]
    );
    session.refresh_token_hash = sha256(nextToken);
    session.last_seen_at = new Date();
    session.app_version = sanitizeText(appVersion, 40) || session.app_version;
    session.platform_version = sanitizeText(platformVersion, 40) || session.platform_version;
    await client.query('COMMIT');
  } catch (err) {
    if (err instanceof MobileAuthError && err.code === 'REFRESH_TOKEN_REUSED') throw err;
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (['public', 'hiddify-android'].includes(session.access_mode || 'user')) {
    const configError = publicModeConfigurationError(session.access_mode || 'public');
    if (configError) {
      await revokeMobileSession(null, session.id, 'public-access-disabled');
      throw new MobileAuthError('MOBILE_PUBLIC_ACCESS_DISABLED', 403);
    }
    return {
      accessToken: signAccessToken(session),
      accessTokenExpiresIn: ACCESS_TOKEN_MINUTES * 60,
      refreshToken: nextToken,
      refreshTokenExpiresAt: new Date(session.expires_at).toISOString(),
      session: publicSession(session),
    };
  }

  const user = await getUserById(session.user_id);
  if (!user) throw new MobileAuthError('INVALID_REFRESH_TOKEN', 401);
  if (user.mobileAccessEnabled === false) {
    await revokeMobileSession(session.user_id, session.id, 'mobile-access-disabled');
    throw new MobileAuthError('MOBILE_ACCESS_DISABLED', 403);
  }
  return {
    accessToken: signAccessToken(session),
    accessTokenExpiresIn: ACCESS_TOKEN_MINUTES * 60,
    refreshToken: nextToken,
    refreshTokenExpiresAt: new Date(session.expires_at).toISOString(),
    session: publicSession(session),
  };
}

export async function authenticateMobileAccess(token) {
  const payload = verifyMobileAccessToken(token);
  if (!payload) return null;
  const userId = payload.sub === PUBLIC_SUBJECT ? null : payload.sub;
  const result = await query(
    `SELECT * FROM mobile_sessions
     WHERE id = $1 AND user_id IS NOT DISTINCT FROM $2 AND revoked_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    [payload.sid, userId]
  );
  const session = result.rows[0];
  if (!session) return null;
  await query('UPDATE mobile_sessions SET last_seen_at = NOW() WHERE id = $1', [session.id]);
  return { payload, session, publicSession: publicSession(session) };
}

export async function listMobileSessions(userId) {
  const result = await query(
    'SELECT * FROM mobile_sessions WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return result.rows.map(publicSession);
}

export async function revokeMobileSession(userId, sessionId, reason = 'admin') {
  const result = await query(
    `UPDATE mobile_sessions
     SET revoked_at = COALESCE(revoked_at, NOW()), revoke_reason = COALESCE(revoke_reason, $3)
     WHERE id = $1 AND user_id IS NOT DISTINCT FROM $2
     RETURNING id`,
    [sessionId, userId, sanitizeText(reason, 80)]
  );
  return result.rowCount > 0;
}

export async function revokeAllMobileSessions(userId, reason = 'admin') {
  const result = await query(
    `UPDATE mobile_sessions
     SET revoked_at = COALESCE(revoked_at, NOW()), revoke_reason = COALESCE(revoke_reason, $2)
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, sanitizeText(reason, 80)]
  );
  return result.rowCount;
}

export async function revokeAllPublicMobileSessions(reason = 'admin') {
  const result = await query(
    `UPDATE mobile_sessions
     SET revoked_at = COALESCE(revoked_at, NOW()), revoke_reason = COALESCE(revoke_reason, $1)
     WHERE access_mode = 'public' AND revoked_at IS NULL`,
    [sanitizeText(reason, 80)]
  );
  return result.rowCount;
}

export async function saveMobileDiagnostic(userId, sessionId, data) {
  const id = createId('mdg');
  await query(
    `INSERT INTO mobile_diagnostics (id, session_id, user_id, data, created_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW())`,
    [id, sessionId, userId, JSON.stringify(data || {})]
  );
  return id;
}

export function mobileAuthSummary() {
  const publicAccess = mobilePublicAccessConfig();
  return {
    configured: !mobileAuthConfigurationError(),
    accessTokenMinutes: ACCESS_TOKEN_MINUTES,
    refreshTokenDays: REFRESH_TOKEN_DAYS,
    activationCodeDays: 7,
    publicAccessEnabled: publicAccess.enabled && Boolean(publicAccess.uuid),
    generatedAt: nowIso(),
  };
}
