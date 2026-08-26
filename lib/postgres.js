import { randomBytes } from 'crypto';
import pg from 'pg';
import { nowIso } from './dates.js';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL || '';
const useSsl = process.env.POSTGRES_SSL === 'true';

let pool = null;
let schemaReady = false;
let schemaPromise = null;

export function isPostgresEnabled() {
  return Boolean(connectionString);
}

export function getPool() {
  if (!isPostgresEnabled()) {
    throw new Error('DATABASE_URL is not configured');
  }
  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

export function createId(prefix = '') {
  const id = randomBytes(12).toString('base64url');
  return prefix ? `${prefix}_${id}` : id;
}

export async function ensureSchema() {
  if (!isPostgresEnabled() || schemaReady) return;
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    await getPool().query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      sort_order INTEGER,
      enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE,
      linked_user_id TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      content TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS secrets (
      name TEXT PRIMARY KEY,
      encrypted_value TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS traffic_usage (
      user_id TEXT PRIMARY KEY CONSTRAINT traffic_usage_user_fk REFERENCES users(id) ON DELETE CASCADE,
      upload_bytes BIGINT NOT NULL DEFAULT 0,
      download_bytes BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS traffic_usage_nodes (
      user_id TEXT NOT NULL CONSTRAINT traffic_usage_nodes_user_fk REFERENCES users(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      upload_bytes BIGINT NOT NULL DEFAULT 0,
      download_bytes BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ,
      PRIMARY KEY (user_id, node_id)
    );

    CREATE TABLE IF NOT EXISTS user_devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_fingerprint TEXT NOT NULL,
      device_name TEXT,
      first_seen_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'active',
      UNIQUE (user_id, device_fingerprint)
    );

    CREATE TABLE IF NOT EXISTS mobile_activation_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL CONSTRAINT mobile_activation_codes_user_fk REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      used_by_session_id TEXT,
      revoked_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS mobile_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT CONSTRAINT mobile_sessions_user_fk REFERENCES users(id) ON DELETE CASCADE,
      access_mode TEXT NOT NULL DEFAULT 'user',
      installation_hash TEXT NOT NULL,
      refresh_token_hash TEXT NOT NULL UNIQUE,
      device_name TEXT,
      platform_version TEXT,
      app_version TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revoke_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS mobile_refresh_token_history (
      token_hash TEXT PRIMARY KEY,
      session_id TEXT NOT NULL CONSTRAINT mobile_refresh_history_session_fk REFERENCES mobile_sessions(id) ON DELETE CASCADE,
      rotated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mobile_activation_attempts (
      key_hash TEXT PRIMARY KEY,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      window_started_at TIMESTAMPTZ NOT NULL,
      blocked_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mobile_diagnostics (
      id TEXT PRIMARY KEY,
      session_id TEXT CONSTRAINT mobile_diagnostics_session_fk REFERENCES mobile_sessions(id) ON DELETE SET NULL,
      user_id TEXT CONSTRAINT mobile_diagnostics_user_fk REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS managed_servers (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      ssh_port INTEGER NOT NULL DEFAULT 22,
      name TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT '',
      auth_type TEXT NOT NULL DEFAULT 'password',
      encrypted_credential TEXT,
      ssh_fingerprint TEXT,
      os TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_inventory_at TIMESTAMPTZ,
      last_error TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS managed_services (
      id TEXT PRIMARY KEY,
      managed_server_id TEXT NOT NULL REFERENCES managed_servers(id) ON DELETE CASCADE,
      service_type TEXT NOT NULL,
      service_name TEXT NOT NULL,
      config_path TEXT,
      ports JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'unknown',
      version TEXT,
      last_health_at TIMESTAMPTZ,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (managed_server_id, service_type, service_name)
    );

    CREATE TABLE IF NOT EXISTS outline_instances (
      managed_server_id TEXT PRIMARY KEY REFERENCES managed_servers(id) ON DELETE CASCADE,
      encrypted_api_url TEXT NOT NULL,
      certificate_fingerprint TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_checked_at TIMESTAMPTZ,
      last_error TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outline_keys (
      id TEXT PRIMARY KEY,
      managed_server_id TEXT NOT NULL REFERENCES managed_servers(id) ON DELETE CASCADE,
      outline_key_id TEXT NOT NULL,
      encrypted_access_url TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      traffic_limit_bytes BIGINT,
      traffic_used_bytes BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (managed_server_id, outline_key_id)
    );

    CREATE TABLE IF NOT EXISTS managed_xray_tunnels (
      id TEXT PRIMARY KEY,
      managed_server_id TEXT NOT NULL REFERENCES managed_servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      template TEXT NOT NULL,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      service_name TEXT NOT NULL,
      config_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (managed_server_id, service_name)
    );

    ALTER TABLE mobile_sessions ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE mobile_sessions ADD COLUMN IF NOT EXISTS access_mode TEXT NOT NULL DEFAULT 'user';
    ALTER TABLE mobile_diagnostics ALTER COLUMN user_id DROP NOT NULL;

    CREATE TABLE IF NOT EXISTS dealers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      client_limit INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      dealer_id TEXT,
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS dealer_audit_log (
      id TEXT PRIMARY KEY,
      actor_admin_id TEXT,
      dealer_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      data JSONB,
      created_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_servers_sort_order ON servers (sort_order);
    CREATE INDEX IF NOT EXISTS idx_files_updated_at ON files (updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_files_linked_user_id ON files (linked_user_id);
    CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices (user_id);
    CREATE INDEX IF NOT EXISTS idx_mobile_activation_codes_user ON mobile_activation_codes (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mobile_sessions_user ON mobile_sessions (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mobile_sessions_installation ON mobile_sessions (user_id, installation_hash);
    CREATE INDEX IF NOT EXISTS idx_mobile_sessions_active ON mobile_sessions (user_id, revoked_at, expires_at);
    CREATE INDEX IF NOT EXISTS idx_mobile_diagnostics_user ON mobile_diagnostics (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_managed_services_server ON managed_services (managed_server_id);
    CREATE INDEX IF NOT EXISTS idx_outline_keys_server ON outline_keys (managed_server_id);
    CREATE INDEX IF NOT EXISTS idx_managed_xray_tunnels_server ON managed_xray_tunnels (managed_server_id);
    CREATE INDEX IF NOT EXISTS idx_dealer_audit_dealer ON dealer_audit_log (dealer_id, created_at DESC);
    `);
    schemaReady = true;
  })();

  try {
    await schemaPromise;
  } catch (error) {
    schemaPromise = null;
    throw error;
  }
}

export async function query(text, params = []) {
  await ensureSchema();
  return getPool().query(text, params);
}

export async function getSetting(key) {
  const result = await query('SELECT data FROM settings WHERE key = $1', [key]);
  return result.rows[0]?.data || null;
}

export async function setSetting(key, data) {
  await query(
    `INSERT INTO settings (key, data, updated_at)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key)
     DO UPDATE SET data = settings.data || EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(data || {}), nowIso()]
  );
}
