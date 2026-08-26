import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createId, isPostgresEnabled, query } from './postgres.js';
import { nowIso } from './dates.js';

const JWT_SECRET = process.env.AUTH_JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-secret-change-me');
const SESSION_DAYS = Number(process.env.AUTH_SESSION_DAYS || 7);

function publicAdmin(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    dealerId: row.dealer_id || null,
  };
}

function publicDealer(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    clientLimit: Number(row.client_limit || 0),
    status: row.status,
    createdAt: row.created_at?.toISOString?.() || null,
    updatedAt: row.updated_at?.toISOString?.() || null,
  };
}

export function signSession(admin) {
  return jwt.sign(
    {
      sub: admin.id,
      username: admin.username,
      role: admin.role,
      dealerId: admin.dealerId || null,
    },
    JWT_SECRET,
    { expiresIn: `${SESSION_DAYS}d` }
  );
}

export async function verifySessionToken(token) {
  if (!token || !isPostgresEnabled()) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const result = await query('SELECT * FROM admins WHERE id = $1', [payload.sub]);
    const admin = publicAdmin(result.rows[0]);
    if (!admin) return null;
    if (admin.role === 'dealer') {
      const dealer = await getDealerById(admin.dealerId);
      if (!dealer || dealer.status !== 'active') return null;
    }
    return admin;
  } catch {
    return null;
  }
}

export async function ensureDefaultOwner() {
  if (!isPostgresEnabled()) return null;
  const username = process.env.OWNER_USERNAME || 'owner';
  const password = process.env.OWNER_PASSWORD || process.env.ADMIN_API_KEY || '';
  const existing = await query("SELECT * FROM admins WHERE role = 'owner' LIMIT 1");
  if (existing.rows[0]) return publicAdmin(existing.rows[0]);
  if (!password) return null;
  const now = nowIso();
  const passwordHash = await bcrypt.hash(password, 12);
  const id = createId('adm');
  await query(
    `INSERT INTO admins (id, username, password_hash, role, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', $4, $4)`,
    [id, username, passwordHash, now]
  );
  return { id, username, role: 'owner', dealerId: null };
}

export async function loginAdmin(username, password) {
  if (!isPostgresEnabled()) return null;
  await ensureDefaultOwner();
  const result = await query('SELECT * FROM admins WHERE username = $1 LIMIT 1', [username]);
  const row = result.rows[0];
  if (!row) return null;
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return null;
  const admin = publicAdmin(row);
  if (admin.role === 'dealer') {
    const dealer = await getDealerById(admin.dealerId);
    if (!dealer || dealer.status !== 'active') return null;
  }
  return admin;
}

export async function createDealer({ name, username, password, clientLimit = 0, status = 'active' }) {
  const now = nowIso();
  const dealerId = createId('dealer');
  const adminId = createId('adm');
  const passwordHash = await bcrypt.hash(password, 12);
  await query(
    `INSERT INTO dealers (id, name, username, password_hash, client_limit, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [dealerId, name, username, passwordHash, Number(clientLimit || 0), status, now]
  );
  await query(
    `INSERT INTO admins (id, username, password_hash, role, dealer_id, created_at, updated_at)
     VALUES ($1, $2, $3, 'dealer', $4, $5, $5)`,
    [adminId, username, passwordHash, dealerId, now]
  );
  return getDealerById(dealerId);
}

export async function listDealers() {
  if (!isPostgresEnabled()) return [];
  const result = await query('SELECT * FROM dealers ORDER BY created_at DESC NULLS LAST');
  return result.rows.map(publicDealer);
}

export async function getDealerById(dealerId) {
  if (!dealerId || !isPostgresEnabled()) return null;
  const result = await query('SELECT * FROM dealers WHERE id = $1', [dealerId]);
  return publicDealer(result.rows[0]);
}

export async function updateDealer(dealerId, update = {}) {
  const existing = await getDealerById(dealerId);
  if (!existing) return null;

  const nextName = update.name !== undefined ? String(update.name).trim() : existing.name;
  const nextLimit = update.clientLimit !== undefined ? Number(update.clientLimit || 0) : existing.clientLimit;
  const nextStatus = update.status !== undefined ? update.status : existing.status;
  const password = update.password ? String(update.password) : '';
  const now = nowIso();

  if (password) {
    const passwordHash = await bcrypt.hash(password, 12);
    await query(
      `UPDATE dealers
       SET name = $2, client_limit = $3, status = $4, password_hash = $5, updated_at = $6
       WHERE id = $1`,
      [dealerId, nextName, nextLimit, nextStatus, passwordHash, now]
    );
    await query(
      `UPDATE admins SET password_hash = $2, updated_at = $3 WHERE dealer_id = $1`,
      [dealerId, passwordHash, now]
    );
  } else {
    await query(
      `UPDATE dealers
       SET name = $2, client_limit = $3, status = $4, updated_at = $5
       WHERE id = $1`,
      [dealerId, nextName, nextLimit, nextStatus, now]
    );
  }

  return getDealerById(dealerId);
}

export async function unlinkDealerUsers(dealerId) {
  if (!dealerId || !isPostgresEnabled()) return 0;
  const result = await query(
    `UPDATE users
     SET data = data - 'dealerId', updated_at = NOW()
     WHERE data->>'dealerId' = $1`,
    [dealerId]
  );
  return result.rowCount || 0;
}

export async function deleteDealer(dealerId, { force = false } = {}) {
  const existing = await getDealerById(dealerId);
  if (!existing) return null;

  const userCount = await countDealerUsers(dealerId);
  if (userCount && !force) {
    const err = new Error('Dealer has clients');
    err.code = 'DEALER_HAS_CLIENTS';
    err.userCount = userCount;
    throw err;
  }

  let unlinkedUsers = 0;
  if (userCount && force) {
    unlinkedUsers = await unlinkDealerUsers(dealerId);
  }

  await query('DELETE FROM admins WHERE dealer_id = $1', [dealerId]);
  await query('DELETE FROM dealers WHERE id = $1', [dealerId]);
  return { id: dealerId, unlinkedUsers };
}

export async function countDealerUsers(dealerId) {
  if (!isPostgresEnabled()) return 0;
  const result = await query(
    "SELECT COUNT(*)::int AS count FROM users WHERE data->>'dealerId' = $1",
    [dealerId]
  );
  return Number(result.rows[0]?.count || 0);
}
