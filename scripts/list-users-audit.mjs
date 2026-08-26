#!/usr/bin/env node
import { listUsers } from '../lib/db-store.js';
import { query, isPostgresEnabled } from '../lib/postgres.js';

const users = await listUsers(2000);
console.log(JSON.stringify({
  count: users.length,
  listUsersCap: 500,
  users: users.map((u) => ({
    id: u.id,
    name: u.name,
    status: u.status,
    uuid: u.uuid,
    createdAt: u.createdAt,
    expiresAt: u.expiresAt,
    serverIds: u.serverIds?.length,
  })),
}, null, 2));

if (isPostgresEnabled()) {
  const total = await query('SELECT COUNT(*)::int AS n FROM users');
  const audit = await query(
    `SELECT id, action, target_id, data, created_at
     FROM audit_log
     WHERE action IN ('client.created', 'client.deleted', 'user.deleted')
     ORDER BY created_at DESC
     LIMIT 20`
  ).catch(() => ({ rows: [] }));
  console.log(JSON.stringify({
    dbTotal: total.rows[0]?.n,
    recentAudit: audit.rows,
  }, null, 2));
}
