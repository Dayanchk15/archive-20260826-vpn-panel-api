import https from 'https';
import { createHash } from 'crypto';
import { getOutlineInstance, saveOutlineInstance, saveOutlineKey, deleteOutlineKeyRecord } from './managed-servers.js';
import { toHappShadowsocksUrl } from './outline-url.js';

// Outline installers have emitted certificate pins in several equivalent
// formats over time (raw hex, SHA256:/sha256/ prefixed base64, and base64url).
// Keep certificate pinning enabled, but compare canonical representations so
// a valid access.txt does not fail merely because its encoding differs.
function normalizePin(value) {
  return String(value || '')
    .trim()
    .replace(/^sha256\s*[/:]\s*/i, '')
    .replace(/[\s:=-]/g, '')
    .toLowerCase();
}

export function outlineCertificatePinMatches(expected, certificateRaw) {
  if (!expected || !certificateRaw) return true;
  const expectedPin = normalizePin(expected);
  if (!expectedPin) return true;
  const digest = createHash('sha256').update(certificateRaw).digest();
  const variants = new Set([
    digest.toString('hex').toLowerCase(),
    digest.toString('base64').replace(/=+$/g, '').toLowerCase(),
    digest.toString('base64url').replace(/=+$/g, '').toLowerCase(),
  ]);
  return variants.has(expectedPin);
}

export { toHappShadowsocksUrl } from './outline-url.js';

function parseAccessFile(text) {
  const raw = String(text || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* installer versions also emit key=value text */ }
  const apiUrl = parsed?.apiUrl || raw.match(/apiUrl\s*[:=]\s*["']?([^\s,"']+)/i)?.[1];
  const certSha256 = parsed?.certSha256 || raw.match(/certSha256\s*[:=]\s*["']?([^\s,"']+)/i)?.[1] || null;
  if (!apiUrl) throw new Error('Outline access.txt does not contain apiUrl');
  return { apiUrl, certSha256 };
}

function request(instance, method, path, body = null, contentType = 'application/json') {
  const url = new URL(`${instance.apiUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      rejectUnauthorized: false,
      headers: body ? { 'content-type': contentType } : undefined,
      timeout: 15_000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Outline API ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({ raw: data }); }
      });
    });
    req.on('socket', (socket) => socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate?.();
      if (instance.certificateFingerprint && cert?.raw) {
        if (!outlineCertificatePinMatches(instance.certificateFingerprint, cert.raw)) {
          req.destroy(new Error('Outline certificate fingerprint mismatch'));
        }
      }
    }));
    req.on('timeout', () => req.destroy(new Error('Outline API timeout')));
    req.on('error', reject);
    if (body) req.write(contentType === 'application/x-www-form-urlencoded' ? new URLSearchParams(body).toString() : JSON.stringify(body));
    req.end();
  });
}

export async function registerOutlineAccessFile(serverId, accessText) {
  const parsed = parseAccessFile(accessText);
  await saveOutlineInstance(serverId, {
    apiUrl: parsed.apiUrl,
    certificateFingerprint: parsed.certSha256,
    status: 'ready',
    lastCheckedAt: new Date().toISOString(),
  });
  const result = await request({ ...parsed, certificateFingerprint: parsed.certSha256 }, 'GET', '/access-keys');
  return { ...parsed, keyCount: Array.isArray(result.accessKeys) ? result.accessKeys.length : 0 };
}

export async function getOutlineStatus(serverId) {
  const instance = await getOutlineInstance(serverId, { includeSecret: true });
  if (!instance) return null;
  const result = await request(instance, 'GET', '/access-keys');
  return { serverId, status: 'ready', keyCount: Array.isArray(result.accessKeys) ? result.accessKeys.length : 0, lastCheckedAt: new Date().toISOString() };
}

export async function createOutlineKey(serverId, { name = '', limitBytes = null } = {}) {
  const instance = await getOutlineInstance(serverId, { includeSecret: true });
  if (!instance) throw new Error('Outline is not registered on this server');
  const created = await request(instance, 'POST', '/access-keys');
  if (!created.id || !created.accessUrl) throw new Error('Outline API returned an invalid access key');
  if (name) await request(instance, 'PUT', `/access-keys/${encodeURIComponent(created.id)}/name`, { name }, 'application/x-www-form-urlencoded');
  if (limitBytes != null) await request(instance, 'PUT', `/access-keys/${encodeURIComponent(created.id)}/data-limit`, { limit: { bytes: Number(limitBytes) } });
  return saveOutlineKey(serverId, { outlineKeyId: created.id, accessUrl: created.accessUrl, name, trafficLimitBytes: limitBytes });
}

export async function deleteOutlineKey(serverId, keyId) {
  const instance = await getOutlineInstance(serverId, { includeSecret: true });
  if (!instance) throw new Error('Outline is not registered on this server');
  await request(instance, 'DELETE', `/access-keys/${encodeURIComponent(keyId)}`);
  await deleteOutlineKeyRecord(serverId, keyId);
}
