import { db } from './db-store.js';
import { nowIso } from './dates.js';
import { deleteStorageFile, saveStorageFile } from './storage.js';
import { createId, isPostgresEnabled, query } from './postgres.js';
import {
  extractDriveFileId,
  isGoogleDriveUrl,
  syncGoogleDriveFile,
} from './google-drive.js';

const COLLECTION = 'files';

function sanitizeSlug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeStoragePath(storagePath, fileId) {
  const trimmed = String(storagePath || '').trim();
  if (trimmed) return trimmed.replace(/^\/+/, '');
  return `files/${fileId}.txt`;
}

async function safeSyncGoogleDriveFile(options) {
  try {
    return await syncGoogleDriveFile(options);
  } catch (error) {
    // Drive is an optional mirror. Never make a subscription refresh fail or
    // replace its stable URL just because OAuth/Drive is temporarily down.
    console.error('Google Drive sync failed:', error.message || String(error));
    return { synced: false, error: error.message || String(error) };
  }
}

function mapFileRecord(id, data) {
  return {
    id,
    name: data.name,
    slug: data.slug,
    storagePath: data.storagePath || data.gcsPath,
    description: data.description || '',
    type: data.type || 'subscription',
    enabled: data.enabled !== false,
    publicAccess: data.publicAccess !== false,
    linkedUserId: data.linkedUserId || null,
    contentLength: (data.content || '').length,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    storageDownloadToken: data.storageDownloadToken || null,
    publicStorageUrl: data.publicStorageUrl || null,
    driveFileId: data.driveFileId || extractDriveFileId(data.publicStorageUrl || data.storageUrl),
    publicUrl: data.slug ? `/f/${data.slug}` : null,
    storageUrlWithToken: null,
    storageUrl: data.storageUrl || null,
  };
}

function mapPgFile(row, { includeContent = false } = {}) {
  if (!row) return null;
  const data = {
    ...(row.data || {}),
    slug: row.slug || row.data?.slug,
    linkedUserId: row.linked_user_id || row.data?.linkedUserId || null,
    content: row.content || row.data?.content || '',
    createdAt: row.created_at?.toISOString?.() || row.data?.createdAt,
    updatedAt: row.updated_at?.toISOString?.() || row.data?.updatedAt,
  };
  const mapped = mapFileRecord(row.id, data);
  return includeContent ? { ...mapped, content: data.content } : mapped;
}

async function savePgFileRecord(fileId, record) {
  const now = record.updatedAt || nowIso();
  await query(
    `INSERT INTO files (id, slug, linked_user_id, data, content, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     ON CONFLICT (id)
     DO UPDATE SET slug = EXCLUDED.slug,
                   linked_user_id = EXCLUDED.linked_user_id,
                   data = EXCLUDED.data,
                   content = EXCLUDED.content,
                   updated_at = EXCLUDED.updated_at`,
    [
      fileId,
      record.slug,
      record.linkedUserId || null,
      JSON.stringify(record),
      record.content || '',
      record.createdAt || now,
      now,
    ]
  );
}

export async function listFiles() {
  if (isPostgresEnabled()) {
    const result = await query('SELECT * FROM files ORDER BY updated_at DESC NULLS LAST');
    return result.rows.map((row) => mapPgFile(row));
  }

  const snap = await db.collection(COLLECTION).orderBy('updatedAt', 'desc').get();
  return snap.docs.map((doc) => mapFileRecord(doc.id, doc.data()));
}

export async function getFileById(fileId, { includeContent = true } = {}) {
  if (isPostgresEnabled()) {
    const result = await query('SELECT * FROM files WHERE id = $1', [fileId]);
    return mapPgFile(result.rows[0], { includeContent });
  }

  const doc = await db.collection(COLLECTION).doc(fileId).get();
  if (!doc.exists) return null;
  const data = doc.data();
  const base = mapFileRecord(doc.id, data);
  if (!includeContent) return base;
  return { ...base, content: data.content || '' };
}

export async function getFileByLinkedUserId(userId) {
  if (isPostgresEnabled()) {
    const result = await query(
      'SELECT * FROM files WHERE linked_user_id = $1 ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1',
      [userId]
    );
    return mapPgFile(result.rows[0], { includeContent: true });
  }

  const snap = await db
    .collection(COLLECTION)
    .where('linkedUserId', '==', userId)
    .limit(1)
    .get();

  if (snap.empty) return null;
  const doc = snap.docs[0];
  const data = doc.data();
  return { ...mapFileRecord(doc.id, data), content: data.content || '' };
}

export async function getFileBySlug(slug) {
  if (isPostgresEnabled()) {
    const result = await query('SELECT * FROM files WHERE slug = $1 LIMIT 1', [slug]);
    return mapPgFile(result.rows[0], { includeContent: true });
  }

  const snap = await db
    .collection(COLLECTION)
    .where('slug', '==', slug)
    .limit(1)
    .get();

  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function assertUniqueSlug(slug, excludeId = null) {
  if (!slug) return;
  const existing = await getFileBySlug(slug);
  if (existing && existing.id !== excludeId) {
    throw new Error(`Slug "${slug}" already in use`);
  }
}

export async function createFile(input) {
  const fileId = isPostgresEnabled() ? createId('file') : null;
  const ref = isPostgresEnabled() ? null : db.collection(COLLECTION).doc();
  const id = fileId || ref.id;
  const now = nowIso();
  const slug = sanitizeSlug(input.slug || input.name || id);
  await assertUniqueSlug(slug);

  const storagePath = normalizeStoragePath(input.storagePath || input.gcsPath, id);
  const content = input.content || '';

  const doc = {
    name: input.name || slug,
    slug,
    storagePath,
    content,
    description: input.description || '',
    type: input.type || 'subscription',
    enabled: input.enabled !== false,
    publicAccess: input.publicAccess !== false,
    linkedUserId: input.linkedUserId || null,
    driveFileId: input.driveFileId || extractDriveFileId(input.publicStorageUrl || input.storageUrl),
    publicStorageUrl: input.publicStorageUrl || input.storageUrl || null,
    createdAt: now,
    updatedAt: now,
  };

  if (isPostgresEnabled()) await savePgFileRecord(id, doc);
  else await ref.set(doc);

  const storage = await saveStorageFile(storagePath, content);
  const driveRequested =
    Boolean(doc.driveFileId || isGoogleDriveUrl(doc.publicStorageUrl)) ||
    (process.env.GOOGLE_DRIVE_SUBSCRIPTIONS === 'true' && process.env.GOOGLE_DRIVE_CREATE_FILES === 'true');
  const drive = driveRequested
    ? await safeSyncGoogleDriveFile({
        fileId: doc.driveFileId,
        publicUrl: doc.publicStorageUrl,
        name: doc.name,
        content,
      })
    : null;
  if (storage.synced) {
    const storageUpdate = {
      storageDownloadToken: storage.storageDownloadToken || null,
      storageUrl: drive?.storageUrl || storage.storageUrl || null,
      publicStorageUrl: drive?.publicUrl || doc.publicStorageUrl || storage.publicStorageUrl || null,
      driveFileId: drive?.fileId || doc.driveFileId || null,
      updatedAt: nowIso(),
    };
    if (isPostgresEnabled()) {
      await savePgFileRecord(id, { ...doc, ...storageUpdate });
    } else {
      await ref.update(storageUpdate);
    }
  }

  return {
    ...(await getFileById(id)),
    storage,
    drive,
  };
}

export async function updateFile(fileId, input) {
  const existing = await getFileById(fileId);
  if (!existing) return null;

  const update = { updatedAt: nowIso() };

  if (input.name !== undefined) update.name = input.name;
  if (input.description !== undefined) update.description = input.description;
  if (input.type !== undefined) update.type = input.type;
  if (input.enabled !== undefined) update.enabled = input.enabled;
  if (input.publicAccess !== undefined) update.publicAccess = input.publicAccess;
  if (input.linkedUserId !== undefined) update.linkedUserId = input.linkedUserId;
  if (input.content !== undefined) update.content = input.content;
  if (input.driveFileId !== undefined) update.driveFileId = input.driveFileId || null;
  if (input.publicStorageUrl !== undefined) update.publicStorageUrl = input.publicStorageUrl || null;

  let slug = existing.slug;
  if (input.slug !== undefined) {
    slug = sanitizeSlug(input.slug);
    await assertUniqueSlug(slug, fileId);
    update.slug = slug;
  }

  let storagePath = existing.storagePath || existing.gcsPath;
  if (input.storagePath !== undefined || input.gcsPath !== undefined) {
    storagePath = normalizeStoragePath(input.storagePath || input.gcsPath, fileId);
    update.storagePath = storagePath;
  }

  if (isPostgresEnabled()) {
    await savePgFileRecord(fileId, { ...existing, ...update, slug, storagePath });
  } else {
    await db.collection(COLLECTION).doc(fileId).update(update);
  }

  const updated = await getFileById(fileId);
  const storage = await saveStorageFile(updated.storagePath || updated.gcsPath, updated.content || '', {
    downloadToken: updated.storageDownloadToken || undefined,
  });
  const driveFileId =
    updated.driveFileId || extractDriveFileId(updated.publicStorageUrl || updated.storageUrl);
  const driveRequested =
    Boolean(driveFileId || isGoogleDriveUrl(updated.publicStorageUrl || updated.storageUrl)) ||
    (process.env.GOOGLE_DRIVE_SUBSCRIPTIONS === 'true' && process.env.GOOGLE_DRIVE_CREATE_FILES === 'true');
  const drive = driveRequested
    ? await safeSyncGoogleDriveFile({
        fileId: driveFileId,
        publicUrl: updated.publicStorageUrl || updated.storageUrl,
        name: updated.name,
        content: updated.content || '',
      })
    : null;

  if (storage.synced) {
    const storageUpdate = {
      // A local write must never erase a pre-existing Drive URL. The URL is
      // the client's stable identity and only its remote content changes.
      storageDownloadToken: storage.storageDownloadToken || updated.storageDownloadToken || null,
      storageUrl: drive?.storageUrl || updated.storageUrl || storage.storageUrl || null,
      publicStorageUrl:
        drive?.publicUrl || updated.publicStorageUrl || updated.storageUrl || storage.publicStorageUrl || null,
      driveFileId: drive?.fileId || driveFileId || null,
      updatedAt: nowIso(),
    };
    if (isPostgresEnabled()) {
      await savePgFileRecord(fileId, { ...(await getFileById(fileId)), ...storageUpdate });
    } else {
      await db.collection(COLLECTION).doc(fileId).update(storageUpdate);
    }
  }

  return { ...(await getFileById(fileId)), storage, drive };
}

export async function refreshFileStorageUrl(fileId) {
  const file = await getFileById(fileId);
  if (!file) return null;

  const storage = await saveStorageFile(file.storagePath || file.gcsPath, file.content || '', {
    downloadToken: file.storageDownloadToken || undefined,
  });

  if (!storage.synced) {
    return { ...file, storage };
  }

  const storageUpdate = {
    storageDownloadToken: storage.storageDownloadToken,
    storageUrl: storage.storageUrl,
    publicStorageUrl: storage.publicStorageUrl || null,
    updatedAt: nowIso(),
  };
  if (isPostgresEnabled()) {
    await savePgFileRecord(fileId, { ...file, ...storageUpdate });
  } else {
    await db.collection(COLLECTION).doc(fileId).update(storageUpdate);
  }

  return {
    ...(await getFileById(fileId)),
    storage,
  };
}

export async function deleteFile(fileId) {
  const existing = await getFileById(fileId);
  if (!existing) return null;

  const storage = await deleteStorageFile(existing.storagePath || existing.gcsPath);
  if (isPostgresEnabled()) await query('DELETE FROM files WHERE id = $1', [fileId]);
  else await db.collection(COLLECTION).doc(fileId).delete();

  return { ok: true, id: fileId, storage };
}
