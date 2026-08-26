// Optional Google Drive backing for subscription files.
// The file id is deliberately treated as the stable identity: updates use
// Drive's media upload endpoint and never create a replacement file.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_FILES_URL = 'https://www.googleapis.com/upload/drive/v3/files';

let tokenCache = null;
let dbConfigCache = null;

async function dbSecret(name) {
  try {
    const { getSecret } = await import('./secrets.js');
    return await getSecret(name);
  } catch {
    return null;
  }
}

function env(name) {
  return String(process.env[name] || '').trim();
}

export function isGoogleDriveConfigured() {
  return Boolean(
    env('GOOGLE_DRIVE_CLIENT_ID') &&
      env('GOOGLE_DRIVE_CLIENT_SECRET') &&
      env('GOOGLE_DRIVE_REFRESH_TOKEN')
  );
}

async function driveConfig() {
  if (dbConfigCache && dbConfigCache.expiresAt > Date.now()) return dbConfigCache.value;
  const value = {
    clientId: env('GOOGLE_DRIVE_CLIENT_ID') || (await dbSecret('GOOGLE_DRIVE_CLIENT_ID')) || '',
    clientSecret: env('GOOGLE_DRIVE_CLIENT_SECRET') || (await dbSecret('GOOGLE_DRIVE_CLIENT_SECRET')) || '',
    refreshToken: env('GOOGLE_DRIVE_REFRESH_TOKEN') || (await dbSecret('GOOGLE_DRIVE_REFRESH_TOKEN')) || '',
    apiKey: env('GOOGLE_DRIVE_API_KEY') || (await dbSecret('GOOGLE_DRIVE_API_KEY')) || '',
  };
  dbConfigCache = { value, expiresAt: Date.now() + 60_000 };
  return value;
}

export function extractDriveFileId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(/\/files\/([A-Za-z0-9_-]+)/) || raw.match(/[?&]id=([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

export function isGoogleDriveUrl(value) {
  const raw = String(value || '').trim().toLowerCase();
  return (
    raw.includes('googleapis.com/drive/') ||
    raw.includes('drive.google.com/') ||
    raw.includes('drive.usercontent.google.com/')
  );
}

/**
 * Return the canonical Google Drive media URL for an existing file reference.
 * The file id stays unchanged; only the host/format is normalized so it can
 * be copied directly from the admin panel. Any existing API key is preserved.
 */
export function canonicalGoogleDriveUrl(value) {
  const id = extractDriveFileId(value);
  if (!id) return null;
  let apiKey = '';
  try {
    apiKey = new URL(String(value)).searchParams.get('key') || '';
  } catch {
    // A bare file id or a malformed legacy URL can still be normalized.
  }
  return buildGoogleDriveUrl(id, null, apiKey);
}

export function buildGoogleDriveUrl(fileId, originalUrl = null, apiKey = env('GOOGLE_DRIVE_API_KEY')) {
  const id = String(fileId || '').trim();
  if (!id) return originalUrl || null;
  // Preserve the exact URL (including its API key/query parameters) for an
  // existing client. This is what keeps already-imported links unchanged.
  if (originalUrl && isGoogleDriveUrl(originalUrl)) return String(originalUrl).trim();
  const key = String(apiKey || '').trim();
  return `${DRIVE_FILES_URL}/${encodeURIComponent(id)}?alt=media${key ? `&key=${encodeURIComponent(key)}` : ''}`;
}

export async function configuredGoogleDriveUrl(fileId, originalUrl = null) {
  const config = await driveConfig();
  return buildGoogleDriveUrl(fileId, originalUrl, config.apiKey);
}

async function accessToken() {
  const config = await driveConfig();
  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    throw new Error('Google Drive OAuth refresh token is not configured');
  }
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.value;

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: 'refresh_token',
  });
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(`Google OAuth token refresh failed (${response.status})`);
  }
  tokenCache = {
    value: payload.access_token,
    expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000,
  };
  return tokenCache.value;
}

function driveHeaders(token, contentType = null) {
  return {
    authorization: `Bearer ${token}`,
    ...(contentType ? { 'content-type': contentType } : {}),
  };
}

export async function updateGoogleDriveFile(fileId, content) {
  const token = await accessToken();
  const response = await fetch(
    `${DRIVE_UPLOAD_FILES_URL}/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true`,
    {
      method: 'PATCH',
      headers: driveHeaders(token, 'text/plain; charset=utf-8'),
      body: String(content || ''),
    }
  );
  if (!response.ok) throw new Error(`Google Drive file update failed (${response.status})`);
  return { fileId, updated: true };
}

async function createPermission(fileId, token) {
  const response = await fetch(
    `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}/permissions?sendNotificationEmail=false`,
    {
      method: 'POST',
      headers: driveHeaders(token, 'application/json'),
      body: JSON.stringify({ type: 'anyone', role: 'reader' }),
    }
  );
  // A pre-existing permission is harmless; the file can still be used if the
  // provider reports a duplicate permission.
  if (!response.ok && response.status !== 409) {
    throw new Error(`Google Drive public permission failed (${response.status})`);
  }
}

export async function createGoogleDriveFile({ name, content }) {
  const token = await accessToken();
  const metadata = {
    name: String(name || 'subscription.txt'),
    mimeType: 'text/plain',
  };
  // Create metadata first, then upload media. This is less error-prone than
  // constructing a multipart body and works with the drive.file scope.
  const response = await fetch(`${DRIVE_FILES_URL}?supportsAllDrives=true`, {
    method: 'POST',
    headers: driveHeaders(token, 'application/json'),
    body: JSON.stringify(metadata),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.id) {
    const detail = payload?.error?.message ? `: ${payload.error.message}` : '';
    throw new Error(`Google Drive file creation failed (${response.status})${detail}`);
  }
  await updateGoogleDriveFile(payload.id, content);
  await createPermission(payload.id, token);
  return { fileId: payload.id, created: true };
}

export async function listGoogleDriveFiles({ pageSize = 1000 } = {}) {
  const token = await accessToken();
  const files = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      pageSize: String(Math.min(Math.max(Number(pageSize) || 1000, 1), 1000)),
      spaces: 'drive',
      q: 'trashed = false',
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,trashed)',
      orderBy: 'modifiedTime desc',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetch(`${DRIVE_FILES_URL}?${params.toString()}`, {
      headers: driveHeaders(token),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Google Drive file listing failed (${response.status})`);
    files.push(...(Array.isArray(payload.files) ? payload.files : []));
    pageToken = payload.nextPageToken || '';
  } while (pageToken);
  return files;
}

export async function syncGoogleDriveFile({ fileId, publicUrl, name, content }) {
  const config = await driveConfig();
  const configured = Boolean(config.clientId && config.clientSecret && config.refreshToken);
  const existingId = String(fileId || '').trim() || extractDriveFileId(publicUrl);
  if (existingId) {
    if (!configured) {
      return {
        synced: false,
        skipped: true,
        reason: 'Google Drive file id preserved; OAuth refresh token is not configured',
        fileId: existingId,
        publicUrl: buildGoogleDriveUrl(existingId, publicUrl),
      };
    }
    await updateGoogleDriveFile(existingId, content);
    return {
      synced: true,
      fileId: existingId,
      publicUrl: buildGoogleDriveUrl(existingId, publicUrl),
      storageUrl: buildGoogleDriveUrl(existingId, publicUrl),
    };
  }

  if (!configured) return { synced: false, skipped: true, reason: 'Google Drive is not configured' };
  const created = await createGoogleDriveFile({ name, content });
  const url = buildGoogleDriveUrl(created.fileId, null, config.apiKey);
  return { synced: true, ...created, publicUrl: url, storageUrl: url };
}
