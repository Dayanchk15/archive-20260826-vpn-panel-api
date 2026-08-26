import 'dotenv/config';
import { readFile } from 'fs/promises';
import { createId, ensureSchema, query, setSetting } from '../lib/postgres.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/import-postgres-json.js backup/firestore-export.json');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const backup = JSON.parse(await readFile(file, 'utf8'));
await ensureSchema();

for (const { id, data } of backup.users || []) {
  const doc = { ...data };
  delete doc.maxDevices;
  await query(
    `INSERT INTO users (id, token_hash, data, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (id)
     DO UPDATE SET token_hash = EXCLUDED.token_hash,
                   data = EXCLUDED.data,
                   updated_at = EXCLUDED.updated_at`,
    [
      id,
      doc.tokenHash || null,
      JSON.stringify(doc),
      doc.createdAt || new Date().toISOString(),
      doc.updatedAt || new Date().toISOString(),
    ]
  );
}

for (const { id, data } of backup.servers || []) {
  await query(
    `INSERT INTO servers (id, data, sort_order, enabled, created_at, updated_at)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6)
     ON CONFLICT (id)
     DO UPDATE SET data = EXCLUDED.data,
                   sort_order = EXCLUDED.sort_order,
                   enabled = EXCLUDED.enabled,
                   updated_at = EXCLUDED.updated_at`,
    [
      id,
      JSON.stringify(data),
      Number(data.sortOrder ?? 9999),
      data.enabled !== false,
      data.createdAt || new Date().toISOString(),
      data.updatedAt || new Date().toISOString(),
    ]
  );
}

for (const { id, data } of backup.files || []) {
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
      id,
      data.slug || id,
      data.linkedUserId || null,
      JSON.stringify(data),
      data.content || '',
      data.createdAt || new Date().toISOString(),
      data.updatedAt || new Date().toISOString(),
    ]
  );
}

for (const [key, data] of Object.entries(backup.settings || {})) {
  if (data) await setSetting(key, data);
}

const ownerUsername = process.env.OWNER_USERNAME || 'owner';
const ownerPassword = process.env.OWNER_PASSWORD || process.env.ADMIN_API_KEY || '';
if (ownerPassword) {
  const bcrypt = await import('bcryptjs');
  const passwordHash = await bcrypt.default.hash(ownerPassword, 12);
  await query(
    `INSERT INTO admins (id, username, password_hash, role, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', $4, $4)
     ON CONFLICT (username) DO NOTHING`,
    [createId('adm'), ownerUsername, passwordHash, new Date().toISOString()]
  );
}

console.log(JSON.stringify({
  ok: true,
  users: backup.users?.length || 0,
  servers: backup.servers?.length || 0,
  files: backup.files?.length || 0,
}, null, 2));
