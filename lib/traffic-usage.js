import { getPool, isPostgresEnabled, query } from './postgres.js';

export const BYTES_PER_GIB = 1024 ** 3;

function finiteNonNegative(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function bytesToGiB(value) {
  return finiteNonNegative(value) / BYTES_PER_GIB;
}

export function getUploadUsedGB(user) {
  return finiteNonNegative(user?.uploadUsedGB);
}

export function getDownloadUsedGB(user) {
  if (user?.downloadUsedGB !== undefined && user?.downloadUsedGB !== null) {
    return finiteNonNegative(user.downloadUsedGB);
  }
  return finiteNonNegative(user?.trafficUsedGB);
}

export function getTotalUsedGB(user) {
  const upload = getUploadUsedGB(user);
  const download = getDownloadUsedGB(user);
  if (upload > 0 || download > 0 || user?.uploadUsedGB !== undefined || user?.downloadUsedGB !== undefined) {
    return upload + download;
  }
  return finiteNonNegative(user?.trafficUsedGB);
}

function normalizeTrafficBytes(value) {
  return Math.max(0, Math.floor(finiteNonNegative(value)));
}

export async function setTrafficUsageBytes(userId, { uploadBytes = 0, downloadBytes = 0 } = {}) {
  if (!isPostgresEnabled()) return { ok: false, skipped: true };
  await query(
    `INSERT INTO traffic_usage (user_id, upload_bytes, download_bytes, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET upload_bytes = GREATEST(traffic_usage.upload_bytes, EXCLUDED.upload_bytes),
                   download_bytes = GREATEST(traffic_usage.download_bytes, EXCLUDED.download_bytes),
                   updated_at = NOW()`,
    [userId, Math.max(0, Math.floor(Number(uploadBytes || 0))), Math.max(0, Math.floor(Number(downloadBytes || 0)))]
  );
  return { ok: true };
}

export async function setNodeTrafficUsageBytes(userId, nodeId, { uploadBytes = 0, downloadBytes = 0 } = {}) {
  if (!isPostgresEnabled()) return { ok: false, skipped: true };

  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) return setTrafficUsageBytes(userId, { uploadBytes, downloadBytes });

  await query(
    `INSERT INTO traffic_usage_nodes (user_id, node_id, upload_bytes, download_bytes, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id, node_id)
     DO UPDATE SET upload_bytes = GREATEST(traffic_usage_nodes.upload_bytes, EXCLUDED.upload_bytes),
                   download_bytes = GREATEST(traffic_usage_nodes.download_bytes, EXCLUDED.download_bytes),
                   updated_at = NOW()`,
    [
      userId,
      normalizedNodeId,
      Math.max(0, Math.floor(Number(uploadBytes || 0))),
      Math.max(0, Math.floor(Number(downloadBytes || 0))),
    ]
  );

  await query(
    `INSERT INTO traffic_usage (user_id, upload_bytes, download_bytes, updated_at)
     SELECT user_id, COALESCE(SUM(upload_bytes), 0), COALESCE(SUM(download_bytes), 0), NOW()
     FROM traffic_usage_nodes
     WHERE user_id = $1
     GROUP BY user_id
     ON CONFLICT (user_id)
     DO UPDATE SET upload_bytes = GREATEST(traffic_usage.upload_bytes, EXCLUDED.upload_bytes),
                   download_bytes = GREATEST(traffic_usage.download_bytes, EXCLUDED.download_bytes),
                   updated_at = NOW()`,
    [userId]
  );

  return { ok: true };
}

export async function incrementTrafficUsageBytes(userId, { uploadBytes = 0, downloadBytes = 0 } = {}) {
  if (!isPostgresEnabled()) return { ok: false, skipped: true };
  await query(
    `INSERT INTO traffic_usage (user_id, upload_bytes, download_bytes, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET upload_bytes = traffic_usage.upload_bytes + EXCLUDED.upload_bytes,
                   download_bytes = traffic_usage.download_bytes + EXCLUDED.download_bytes,
                   updated_at = NOW()`,
    [userId, Math.max(0, Math.floor(Number(uploadBytes || 0))), Math.max(0, Math.floor(Number(downloadBytes || 0)))]
  );
  return { ok: true };
}

export async function incrementNodeTrafficUsageBytes(userId, nodeId, { uploadBytes = 0, downloadBytes = 0 } = {}) {
  if (!isPostgresEnabled()) return { ok: false, skipped: true };
  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) return incrementTrafficUsageBytes(userId, { uploadBytes, downloadBytes });

  const upload = normalizeTrafficBytes(uploadBytes);
  const download = normalizeTrafficBytes(downloadBytes);
  if (upload === 0 && download === 0) return { ok: true, skipped: true };

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO traffic_usage_nodes (user_id, node_id, upload_bytes, download_bytes, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, node_id)
       DO UPDATE SET upload_bytes = traffic_usage_nodes.upload_bytes + EXCLUDED.upload_bytes,
                     download_bytes = traffic_usage_nodes.download_bytes + EXCLUDED.download_bytes,
                     updated_at = NOW()`,
      [userId, normalizedNodeId, upload, download]
    );
    await client.query(
      `INSERT INTO traffic_usage (user_id, upload_bytes, download_bytes, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET upload_bytes = traffic_usage.upload_bytes + EXCLUDED.upload_bytes,
                     download_bytes = traffic_usage.download_bytes + EXCLUDED.download_bytes,
                     updated_at = NOW()`,
      [userId, upload, download]
    );
    await client.query('COMMIT');
    return { ok: true, nodeId: normalizedNodeId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function resetTrafficUsage(userId) {
  if (!isPostgresEnabled()) return { ok: false, skipped: true };
  await query('DELETE FROM traffic_usage_nodes WHERE user_id = $1', [userId]);
  await query('DELETE FROM traffic_usage WHERE user_id = $1', [userId]);
  return { ok: true };
}
