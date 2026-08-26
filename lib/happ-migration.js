import { getFileByLinkedUserId } from './files.js';
import { updateUser } from './db-store.js';
import { nowIso } from './dates.js';
import {
  resolveHappEncryptedSubscription,
  resolveHappProviderId,
} from './happ-subscription-controls.js';
import { buildUserSubscriptionUrls } from './user-urls.js';

export { resolveHappProviderId };

export function buildProviderIdBodyLine(providerId) {
  const id = String(providerId || '').trim();
  if (!id) return null;
  return `#providerid ${id}`;
}

export function buildNewUrlBodyLine(newUrl) {
  const url = String(newUrl || '').trim();
  if (!url) return null;
  return `#new-url: ${url}`;
}

export function ensureProviderIdInPlainBody(plainBody, providerId) {
  const body = String(plainBody || '');
  const id = String(providerId || '').trim();
  if (!id || body.includes('#providerid')) return body;
  const lines = body.split('\n');
  const profileIdx = lines.findIndex((line) => line.startsWith('#profile-title:'));
  if (profileIdx >= 0) {
    lines.splice(profileIdx, 0, `#providerid ${id}`);
    return `${lines.join('\n').trim()}\n`;
  }
  return `#providerid ${id}\n${body.trim()}\n`;
}

export function ensureNewUrlInPlainBody(plainBody, newUrl) {
  const body = String(plainBody || '');
  const url = String(newUrl || '').trim();
  if (!url || body.includes('#new-url:')) return body;
  const lines = body.split('\n');
  const hideIdx = lines.findIndex((line) => line.startsWith('#hide-settings:'));
  const insertAt = hideIdx >= 0 ? hideIdx + 1 : 0;
  lines.splice(insertAt, 0, `#new-url: ${url}`);
  return `${lines.join('\n').trim()}\n`;
}

export function applyHappProviderIdHeaders(res, providerId) {
  const id = String(providerId || '').trim();
  if (!res || !id) return;
  try {
    res.set('providerid', id);
  } catch (err) {
    console.warn('providerid header:', err.message);
  }
}

export function applyHappNewUrlHeaders(res, newUrl) {
  const url = String(newUrl || '').trim();
  if (!res || !url) return;
  try {
    res.set('new-url', url);
  } catch (err) {
    console.warn('new-url header:', err.message);
  }
}

/** Cached happ://crypt4/… per user (panel import only). */
export async function ensureUserHappEncryptedUrl(user, panelSettings) {
  const cached = String(user?.happEncryptedUrl || '').trim();
  if (cached.startsWith('happ://')) return cached;

  const panel = panelSettings || {};
  if (!resolveHappEncryptedSubscription(panel)) return null;

  const token = String(user.subscriptionToken || '').trim() || null;
  const subscriptionFile = await getFileByLinkedUserId(user.id);
  const urls = await buildUserSubscriptionUrls({
    userId: user.id,
    token,
    subscriptionFile,
    panelSettings: panel,
  });
  const link = String(urls.happEncryptedUrl || '').trim();
  if (!link.startsWith('happ://')) return null;

  if (user.id && link !== cached) {
    await updateUser(user.id, { happEncryptedUrl: link, updatedAt: nowIso() });
  }
  return link;
}

export async function applyHappSubscriptionMigration(res, user, panel, plainBody) {
  let body = String(plainBody || '');
  const providerId = resolveHappProviderId(panel);

  if (providerId) {
    applyHappProviderIdHeaders(res, providerId);
    body = ensureProviderIdInPlainBody(body, providerId);
  }

  // Не шлём new-url в ответе подписки — ломает обновление у старых клиентов с https-ссылкой.
  return body;
}
