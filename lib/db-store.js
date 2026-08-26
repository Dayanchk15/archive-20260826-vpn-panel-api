// Compatibility module name retained for existing imports. Production storage
// is PostgreSQL only; the former remote document-store fallback was removed.
import { createId, isPostgresEnabled, query } from './postgres.js';

export const db = null;
function requirePostgres() { if (!isPostgresEnabled()) throw new Error('DATABASE_URL is required; PostgreSQL is the only supported storage backend'); }
function stripTokenHash(record) { if (!record) return record; const { tokenHash, ...safe } = record; return safe; }
function mapUser(row, { safe = false } = {}) {
  if (!row) return null;
  const data = row.data || {}; const uploadBytes = Number(row.upload_bytes || 0); const downloadBytes = Number(row.download_bytes || 0);
  const record = { id: row.id, ...data, ...(uploadBytes || downloadBytes ? { uploadUsedGB: uploadBytes / 1024 / 1024 / 1024, downloadUsedGB: downloadBytes / 1024 / 1024 / 1024, trafficUsedGB: (uploadBytes + downloadBytes) / 1024 / 1024 / 1024 } : {}), ...(row.token_hash ? { tokenHash: row.token_hash } : {}) };
  if (row.traffic_updated_at) record.lastTrafficAt = new Date(row.traffic_updated_at).toISOString();
  return safe ? stripTokenHash(record) : record;
}
function mapServer(row) { return row ? { id: row.id, ...(row.data || {}) } : null; }

export async function findUserByTokenHash(tokenHash) { requirePostgres(); const r = await query('SELECT u.id,u.token_hash,u.data,t.upload_bytes,t.download_bytes,t.updated_at AS traffic_updated_at FROM users u LEFT JOIN traffic_usage t ON t.user_id=u.id WHERE u.token_hash=$1 LIMIT 1', [tokenHash]); return mapUser(r.rows[0]); }
export async function getServerById(serverId) { requirePostgres(); const r = await query('SELECT id,data FROM servers WHERE id=$1', [serverId]); return mapServer(r.rows[0]); }
export async function listUsers(limit = 5000) { requirePostgres(); const r = await query('SELECT u.id,u.token_hash,u.data,t.upload_bytes,t.download_bytes,t.updated_at AS traffic_updated_at FROM users u LEFT JOIN traffic_usage t ON t.user_id=u.id ORDER BY u.created_at DESC NULLS LAST LIMIT $1', [limit]); return r.rows.map((row) => mapUser(row, { safe: true })); }
export async function listServers() { requirePostgres(); const r = await query('SELECT id,data FROM servers ORDER BY sort_order ASC NULLS LAST,id ASC'); return r.rows.map(mapServer).sort((a, b) => Number(a.sortOrder ?? 9999) - Number(b.sortOrder ?? 9999) || String(a.name).localeCompare(String(b.name))); }
export async function getEnabledServers() { return (await listServers()).filter((s) => s.enabled !== false); }
export async function getEnabledServerIds(options = {}) { const servers = await getEnabledServers(); const tmPool = servers.filter((s) => s.tmPool === true); if (options.forNewUser && tmPool.length) return tmPool.map((s) => s.id); return (options.forNewUser ? servers : servers.filter((s) => s.newUsersOnly !== true)).map((s) => s.id); }
export async function createUser(userDoc) { requirePostgres(); const id = createId('usr'); const doc = { ...userDoc }; const tokenHash = doc.tokenHash || null; delete doc.maxDevices; await query('INSERT INTO users(id,token_hash,data,created_at,updated_at) VALUES($1,$2,$3::jsonb,$4,$5)', [id, tokenHash, JSON.stringify(doc), doc.createdAt || new Date().toISOString(), doc.updatedAt || new Date().toISOString()]); return id; }
export async function updateUser(userId, update) { requirePostgres(); const patch = { ...update }; const tokenHash = patch.tokenHash || null; delete patch.tokenHash; delete patch.id; await query("UPDATE users SET token_hash=COALESCE($2,token_hash),data=COALESCE(data,'{}'::jsonb)||$3::jsonb,updated_at=$4 WHERE id=$1", [userId, tokenHash, JSON.stringify(patch), update.updatedAt || new Date().toISOString()]); }
export async function deleteUser(userId) { requirePostgres(); await query('DELETE FROM user_devices WHERE user_id=$1', [userId]); await query('DELETE FROM traffic_usage_nodes WHERE user_id=$1', [userId]); await query('DELETE FROM traffic_usage WHERE user_id=$1', [userId]); await query('DELETE FROM users WHERE id=$1', [userId]); }
export async function getUserById(userId) { requirePostgres(); const r = await query('SELECT u.id,u.token_hash,u.data,t.upload_bytes,t.download_bytes,t.updated_at AS traffic_updated_at FROM users u LEFT JOIN traffic_usage t ON t.user_id=u.id WHERE u.id=$1', [userId]); return mapUser(r.rows[0], { safe: true }); }
export async function upsertServer(serverId, serverDoc) { requirePostgres(); const existing = await getServerById(serverId); const merged = { ...(existing || {}), ...serverDoc }; delete merged.id; await query('INSERT INTO servers(id,data,sort_order,enabled,created_at,updated_at) VALUES($1,$2::jsonb,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET data=servers.data||EXCLUDED.data,sort_order=EXCLUDED.sort_order,enabled=EXCLUDED.enabled,updated_at=EXCLUDED.updated_at', [serverId, JSON.stringify(merged), Number(merged.sortOrder ?? 9999), merged.enabled !== false, merged.createdAt || new Date().toISOString(), merged.updatedAt || new Date().toISOString()]); }
export async function bulkUpsertServers(servers) { requirePostgres(); for (const server of servers) { const { id, ...data } = server; await upsertServer(id, data); } }
export async function updateServer(serverId, update) { requirePostgres(); const existing = await getServerById(serverId); if (!existing) return; const merged = { ...existing, ...update }; delete merged.id; await query('UPDATE servers SET data=$2::jsonb,sort_order=$3,enabled=$4,updated_at=$5 WHERE id=$1', [serverId, JSON.stringify(merged), Number(merged.sortOrder ?? 9999), merged.enabled !== false, update.updatedAt || new Date().toISOString()]); }
export async function deleteServer(serverId) { requirePostgres(); await query('DELETE FROM servers WHERE id=$1', [serverId]); }
export async function getUsersUsingServer(serverId) { return (await listUsers()).filter((u) => (u.serverIds || []).includes(serverId)); }
