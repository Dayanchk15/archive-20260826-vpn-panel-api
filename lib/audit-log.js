import { createId, isPostgresEnabled, query } from './postgres.js';

function publicLog(row) {
  return {
    id: row.id,
    actorAdminId: row.actor_admin_id || null,
    dealerId: row.dealer_id || null,
    action: row.action,
    targetType: row.target_type || '',
    targetId: row.target_id || '',
    data: row.data || {},
    createdAt: row.created_at?.toISOString?.() || null,
  };
}

export async function writeAuditLog({ actor = null, action, targetType = '', targetId = '', dealerId = null, data = {} }) {
  if (!isPostgresEnabled() || !action) return null;
  const result = await query(
    `INSERT INTO dealer_audit_log
      (id, actor_admin_id, dealer_id, action, target_type, target_id, data, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
     RETURNING *`,
    [
      createId('log'),
      actor?.id || null,
      dealerId || actor?.dealerId || null,
      action,
      targetType,
      targetId,
      JSON.stringify(data || {}),
    ]
  );
  return publicLog(result.rows[0]);
}

export async function listAuditLogs({ limit = 200 } = {}) {
  if (!isPostgresEnabled()) return [];
  const result = await query(
    `SELECT * FROM dealer_audit_log ORDER BY created_at DESC LIMIT $1`,
    [Math.min(500, Math.max(1, Number(limit || 200)))]
  );
  return result.rows.map(publicLog);
}
