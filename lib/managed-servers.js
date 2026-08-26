import { randomToken, encryptSecret, decryptSecret } from './crypto.js';
import { nowIso } from './dates.js';
import { createId, query } from './postgres.js';
import { toHappShadowsocksUrl } from './outline-url.js';

function safeServer(row) {
  if (!row) return null;
  return {
    id: row.id,
    address: row.address,
    sshPort: Number(row.ssh_port || 22),
    name: row.name || '',
    country: row.country || '',
    authType: row.auth_type || 'password',
    credentialConfigured: Boolean(row.encrypted_credential),
    sshFingerprint: row.ssh_fingerprint || null,
    os: row.os || null,
    status: row.status || 'unknown',
    lastInventoryAt: row.last_inventory_at ? new Date(row.last_inventory_at).toISOString() : null,
    lastError: row.last_error || null,
    data: row.data || {},
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function physicalAddressForRegistryServer(server = {}) {
  const origin = String(server.originAddress || '').trim();
  if (origin) return origin;
  if (server.externalVps === true) return String(server.addressIp || '').trim();
  return '';
}

/**
 * Make the real VPS registry visible in Managed Servers without inventing
 * credentials. CDN/service rows are grouped by their physical origin IP.
 * Existing SSH credentials and health state are never overwritten.
 */
export async function syncManagedServersFromRegistry(servers = []) {
  const grouped = new Map();
  for (const server of servers) {
    const address = physicalAddressForRegistryServer(server);
    if (!address || address === '127.0.0.1') continue;
    const item = grouped.get(address) || { address, names: [], countries: [], serverIds: [], services: [] };
    if (server.name) item.names.push(String(server.name));
    if (server.country) item.countries.push(String(server.country));
    if (server.id) item.serverIds.push(String(server.id));
    if (server.service) item.services.push(String(server.service));
    grouped.set(address, item);
  }

  let created = 0;
  let updated = 0;
  for (const item of grouped.values()) {
    const existing = await query('SELECT id,data FROM managed_servers WHERE address=$1', [item.address]);
    const data = {
      source: 'server-registry',
      registryServerIds: [...new Set(item.serverIds)],
      linkedServices: [...new Set(item.services)],
    };
    const name = item.names[0] || item.address;
    const country = item.countries[0] || '';
    if (existing.rows[0]) {
      await query(
        `UPDATE managed_servers
         SET name=CASE WHEN name='' THEN $2 ELSE name END,
             country=CASE WHEN country='' THEN $3 ELSE country END,
             data=COALESCE(data,'{}'::jsonb)||$4::jsonb,
             updated_at=$5
         WHERE address=$1`,
        [item.address, name, country, JSON.stringify(data), nowIso()],
      );
      updated += 1;
    } else {
      await query(
        `INSERT INTO managed_servers
          (id,address,ssh_port,name,country,auth_type,encrypted_credential,status,data,created_at,updated_at)
         VALUES ($1,$2,22,$3,$4,'password',NULL,'unconfigured',$5::jsonb,$6,$6)`,
        [createId('mvs'), item.address, name, country, JSON.stringify(data), nowIso()],
      );
      created += 1;
    }
  }
  return { created, updated, total: grouped.size };
}

export async function listManagedServers() {
  const result = await query('SELECT * FROM managed_servers ORDER BY address ASC');
  return result.rows.map(safeServer);
}

export async function getManagedServer(id, { includeCredential = false } = {}) {
  const result = await query('SELECT * FROM managed_servers WHERE id = $1', [id]);
  const row = result.rows[0];
  if (!row) return null;
  const server = safeServer(row);
  if (includeCredential) server.credential = row.encrypted_credential ? decryptSecret(row.encrypted_credential) : '';
  return server;
}

export async function createManagedServer(input = {}) {
  const address = String(input.address || '').trim();
  if (!address || address.length > 255) throw new Error('address is required');
  const sshPort = Number(input.sshPort ?? 22);
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) throw new Error('sshPort must be 1-65535');
  const authType = input.authType === 'key' ? 'key' : 'password';
  const credential = String(input.credential || '');
  if (!credential) throw new Error('credential is required');
  const id = createId('mvs');
  const now = nowIso();
  await query(
    `INSERT INTO managed_servers
      (id,address,ssh_port,name,country,auth_type,encrypted_credential,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$8)`,
    [id, address, sshPort, String(input.name || ''), String(input.country || ''), authType, encryptSecret(credential), now],
  );
  return getManagedServer(id);
}

export async function updateManagedServer(id, input = {}) {
  const current = await getManagedServer(id, { includeCredential: true });
  if (!current) return null;
  const address = input.address === undefined ? current.address : String(input.address).trim();
  const sshPort = input.sshPort === undefined ? current.sshPort : Number(input.sshPort);
  if (!address || !Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) throw new Error('Invalid server address or sshPort');
  const credential = input.credential === undefined ? current.credential : String(input.credential || '');
  await query(
    `UPDATE managed_servers SET address=$2,ssh_port=$3,name=$4,country=$5,auth_type=$6,
       encrypted_credential=$7,updated_at=$8 WHERE id=$1`,
    [id, address, sshPort, String(input.name ?? current.name), String(input.country ?? current.country), input.authType === 'key' ? 'key' : (input.authType || current.authType), credential ? encryptSecret(credential) : null, nowIso()],
  );
  return getManagedServer(id);
}

export async function setManagedServerStatus(id, patch = {}) {
  await query(
    `UPDATE managed_servers SET status=$2,os=COALESCE($3,os),ssh_fingerprint=COALESCE($4,ssh_fingerprint),
      last_inventory_at=COALESCE($5,last_inventory_at),last_error=$6,updated_at=$7 WHERE id=$1`,
    [id, String(patch.status || 'unknown'), patch.os || null, patch.sshFingerprint || null, patch.lastInventoryAt || null, patch.lastError || null, nowIso()],
  );
}

export async function deleteManagedServer(id) {
  await query('DELETE FROM managed_servers WHERE id = $1', [id]);
}

export async function replaceManagedServices(serverId, services = []) {
  await query('DELETE FROM managed_services WHERE managed_server_id = $1', [serverId]);
  for (const service of services) {
    await query(
      `INSERT INTO managed_services
        (id,managed_server_id,service_type,service_name,config_path,ports,status,version,last_health_at,data,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11,$11)`,
      [randomToken(), serverId, String(service.serviceType || 'systemd'), String(service.serviceName || ''), service.configPath || null, JSON.stringify(service.ports || []), String(service.status || 'unknown'), service.version || null, service.lastHealthAt || null, JSON.stringify(service.data || {}), nowIso()],
    );
  }
  return listManagedServices(serverId);
}

export async function listManagedServices(serverId) {
  const result = await query('SELECT * FROM managed_services WHERE managed_server_id=$1 ORDER BY service_type,service_name', [serverId]);
  return result.rows.map((row) => ({
    id: row.id,
    serverId: row.managed_server_id,
    serviceType: row.service_type,
    serviceName: row.service_name,
    configPath: row.config_path,
    ports: row.ports || [],
    status: row.status,
    version: row.version,
    lastHealthAt: row.last_health_at ? new Date(row.last_health_at).toISOString() : null,
    data: row.data || {},
  }));
}

export async function saveOutlineInstance(serverId, input = {}) {
  await query(
    `INSERT INTO outline_instances (managed_server_id,encrypted_api_url,certificate_fingerprint,status,last_checked_at,last_error,data,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
     ON CONFLICT (managed_server_id) DO UPDATE SET encrypted_api_url=EXCLUDED.encrypted_api_url,
       certificate_fingerprint=EXCLUDED.certificate_fingerprint,status=EXCLUDED.status,last_checked_at=EXCLUDED.last_checked_at,
       last_error=EXCLUDED.last_error,data=EXCLUDED.data,updated_at=EXCLUDED.updated_at`,
    [serverId, encryptSecret(input.apiUrl), input.certificateFingerprint || null, input.status || 'unknown', input.lastCheckedAt || null, input.lastError || null, JSON.stringify(input.data || {}), nowIso()],
  );
}

export async function getOutlineInstance(serverId, { includeSecret = false } = {}) {
  const result = await query('SELECT * FROM outline_instances WHERE managed_server_id=$1', [serverId]);
  const row = result.rows[0];
  if (!row) return null;
  const out = { serverId, certificateFingerprint: row.certificate_fingerprint, status: row.status, lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null, lastError: row.last_error, data: row.data || {} };
  if (includeSecret) out.apiUrl = decryptSecret(row.encrypted_api_url);
  return out;
}

export async function saveOutlineKey(serverId, input = {}) {
  const id = createId('osk');
  await query(
    `INSERT INTO outline_keys (id,managed_server_id,outline_key_id,encrypted_access_url,name,traffic_limit_bytes,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
     ON CONFLICT (managed_server_id,outline_key_id) DO UPDATE SET encrypted_access_url=EXCLUDED.encrypted_access_url,name=EXCLUDED.name,traffic_limit_bytes=EXCLUDED.traffic_limit_bytes,updated_at=EXCLUDED.updated_at`,
    [id, serverId, String(input.outlineKeyId), encryptSecret(input.accessUrl), String(input.name || ''), input.trafficLimitBytes ?? null, nowIso()],
  );
  return listOutlineKeys(serverId, { includeSecret: true }).then((rows) => rows.find((row) => row.outlineKeyId === String(input.outlineKeyId)));
}

export async function listOutlineKeys(serverId, { includeSecret = false } = {}) {
  const result = await query('SELECT * FROM outline_keys WHERE managed_server_id=$1 ORDER BY created_at DESC', [serverId]);
  return result.rows.map((row) => ({
    id: row.id,
    serverId: row.managed_server_id,
    outlineKeyId: row.outline_key_id,
    ...(includeSecret ? (() => {
      const accessUrl = decryptSecret(row.encrypted_access_url);
      return { accessUrl, happAccessUrl: toHappShadowsocksUrl(accessUrl, row.name) };
    })() : {}),
    name: row.name,
    trafficLimitBytes: row.traffic_limit_bytes == null ? null : Number(row.traffic_limit_bytes),
    trafficUsedBytes: Number(row.traffic_used_bytes || 0),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  }));
}

export async function deleteOutlineKeyRecord(serverId, keyId) {
  await query('DELETE FROM outline_keys WHERE managed_server_id=$1 AND outline_key_id=$2', [serverId, String(keyId)]);
}
