// Subscription file storage is local to the panel VPS. This keeps files
// private and removes the former external object-storage dependency.
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';

const localStorageDir = process.env.LOCAL_STORAGE_DIR || '/data/files';
const globalPath = process.env.LOCAL_GLOBAL_SUBSCRIPTION_PATH || 'subscription.txt';
const userPrefix = process.env.LOCAL_USER_SUBSCRIPTION_PREFIX || 'subscriptions/';

function localFilePath(filePath) {
  const clean = String(filePath || '').replace(/^\/+/, '');
  const root = path.resolve(localStorageDir); const resolved = path.resolve(root, clean);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('Invalid local storage path');
  return resolved;
}
export function getBucketName() { return ''; }
export function getGlobalSubscriptionPath() { return globalPath; }
export function buildFirebaseStorageUrl() { return null; }
export function buildGcsPublicUrl() { return null; }
export function buildPublicStorageUrl() { return null; }
export async function resolveStorageUrl() { return null; }
export async function saveStorageFile(filePath, content, options = {}) { const target = localFilePath(filePath); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content || '', 'utf8'); return { synced: true, storage: 'local', path: target, publicUrl: null, storageUrl: null, contentType: options.contentType || 'text/plain' }; }
export async function readStorageFile(filePath) { try { return { ok: true, content: await readFile(localFilePath(filePath), 'utf8') }; } catch { return { ok: false, reason: 'File not found in local storage' }; } }
export async function deleteStorageFile(filePath) { try { await rm(localFilePath(filePath), { force: true }); return { synced: true, deleted: true, storage: 'local' }; } catch (error) { return { synced: false, reason: error.message }; } }
export async function syncGlobalSubscriptionToStorage(content) { return saveStorageFile(globalPath, content); }
export async function syncUserSubscriptionToStorage(userId, content) { return saveStorageFile(`${userPrefix}${userId}.txt`, content); }
