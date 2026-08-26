import { randomUUID } from 'crypto';
import { createId, query } from './postgres.js';
import { nowIso } from './dates.js';
import { sshCommand } from './managed-server-ssh.js';

const HOST_RE = /^[a-zA-Z0-9.-]+$/;

function validateTunnel(input = {}) {
  const template = String(input.template || 'vless-ws-tls');
  if (!['vless-tcp', 'vless-ws-tls'].includes(template)) throw new Error('Unsupported Xray template');
  const port = Number(input.port || 0);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Xray port must be 1-65535');
  const host = String(input.host || input.sni || '').trim();
  const sni = String(input.sni || host).trim();
  if (host && !HOST_RE.test(host)) throw new Error('Invalid Xray host');
  if (sni && !HOST_RE.test(sni)) throw new Error('Invalid Xray SNI');
  const path = String(input.path || '/');
  if (!path.startsWith('/') || /[\r\n]/.test(path)) throw new Error('Invalid Xray path');
  const requestedUuids = [
    ...(Array.isArray(input.clientUuids) ? input.clientUuids : []),
    ...(input.uuid ? [input.uuid] : []),
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const clientUuids = [...new Set(requestedUuids.length ? requestedUuids : [randomUUID()])];
  if (clientUuids.some((value) => !/^[0-9a-f-]{36}$/i.test(value))) throw new Error('Invalid Xray UUID');
  const outbound = input.outbound || { protocol: 'freedom' };
  if (!['freedom', 'vless'].includes(outbound.protocol)) throw new Error('Unsupported outbound protocol');
  if (outbound.protocol === 'vless') {
    if (!HOST_RE.test(String(outbound.address || ''))) throw new Error('Invalid outbound address');
    if (!Number.isInteger(Number(outbound.port)) || Number(outbound.port) < 1 || Number(outbound.port) > 65535) throw new Error('Invalid outbound port');
    if (!/^[0-9a-f-]{36}$/i.test(String(outbound.uuid || ''))) throw new Error('Invalid outbound UUID');
  }
  return { template, port, host, sni, path, uuid: clientUuids[0], clientUuids, name: String(input.name || ''), outbound };
}

function buildConfig(input) {
  const cfg = {
    log: { loglevel: 'warning' },
    inbounds: [{
      listen: '0.0.0.0', port: input.port, protocol: 'vless',
      settings: { clients: input.clientUuids.map((id, index) => ({ id, email: input.name ? `${input.name}-${index + 1}` : `managed-xray-${index + 1}` })), decryption: 'none' },
      sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
      streamSettings: input.template === 'vless-ws-tls'
        ? { network: 'ws', security: 'tls', tlsSettings: { serverName: input.sni || input.host, certificates: [] }, wsSettings: { path: input.path, headers: input.host ? { Host: input.host } : {} } }
        : { network: 'tcp', security: 'none' },
    }],
    outbounds: input.outbound.protocol === 'vless'
      ? [{ protocol: 'vless', settings: { vnext: [{ address: input.outbound.address, port: Number(input.outbound.port), users: [{ id: input.outbound.uuid, encryption: 'none' }] }] }, streamSettings: {
          network: input.outbound.network || 'tcp',
          security: input.outbound.security || 'none',
          ...(input.outbound.sni ? { tlsSettings: { serverName: input.outbound.sni } } : {}),
          ...(input.outbound.network === 'ws' ? { wsSettings: { path: input.outbound.path || '/', headers: input.outbound.host ? { Host: input.outbound.host } : {} } } : {}),
        } }]
      : [{ protocol: 'freedom', tag: 'direct' }],
  };
  if (input.template === 'vless-ws-tls') {
    // TLS certificates are installed separately on the VPS; this template is intentionally explicit.
    cfg.inbounds[0].streamSettings.tlsSettings.certificates = [{ certificateFile: '/etc/xray/tls/fullchain.pem', keyFile: '/etc/xray/tls/privkey.pem' }];
  }
  return cfg;
}

export function buildManagedXrayConfig(input) {
  const normalized = validateTunnel(input);
  return { normalized, config: buildConfig(normalized) };
}

async function getTunnel(serverId, tunnelId) {
  const result = await query('SELECT * FROM managed_xray_tunnels WHERE managed_server_id=$1 AND id=$2', [serverId, tunnelId]);
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, serverId: row.managed_server_id, name: row.name, template: row.template, config: row.config, serviceName: row.service_name, configPath: row.config_path, status: row.status, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function listManagedXrayTunnels(serverId) {
  const result = await query('SELECT * FROM managed_xray_tunnels WHERE managed_server_id=$1 ORDER BY created_at DESC', [serverId]);
  return result.rows.map((row) => ({ id: row.id, serverId: row.managed_server_id, name: row.name, template: row.template, config: row.config, serviceName: row.service_name, configPath: row.config_path, status: row.status, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at }));
}

function encoded(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function encodedText(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

async function applyRemoteTunnel(serverId, tunnel) {
  const payload = encoded(tunnel.config);
  const unit = tunnel.serviceName;
  const path = tunnel.configPath;
  const backup = `/var/backups/vpn-panel-xray/${tunnel.id}.json.bak`;
  // sshCommand intentionally accepts only one physical line. Encode both
  // JSON and the systemd unit so the remote command remains one line while
  // preserving newlines inside the files written on the VPS.
  const unitPayload = encodedText(`[Unit]\nDescription=Managed Xray ${tunnel.id}\nAfter=network-online.target\n[Service]\nExecStart=/usr/bin/env xray run -c ${path}\nRestart=on-failure\nRestartSec=2\n[Install]\nWantedBy=multi-user.target\n`);
  const tempPath = `${path}.tmp.json`;
  const port = Number(tunnel.config.inbounds?.[0]?.port || 0);
  const command = `set -eu; XRAY=$(command -v xray || true); [ -x "$XRAY" ] || XRAY=/usr/local/bin/xray; [ -x "$XRAY" ]; mkdir -p /etc/xray/managed /var/backups/vpn-panel-xray; if [ -f ${path} ]; then cp -f ${path} ${backup}; fi; echo ${payload} | base64 -d > ${tempPath}; "$XRAY" run -test -config ${tempPath}; mv ${tempPath} ${path}; echo ${unitPayload} | base64 -d > /etc/systemd/system/${unit}; sed -i "s#^ExecStart=.*#ExecStart=$XRAY run -c ${path}#" /etc/systemd/system/${unit}; systemctl daemon-reload; systemctl enable ${unit} >/dev/null; if ! systemctl restart ${unit}; then if [ -f ${backup} ]; then cp -f ${backup} ${path}; systemctl restart ${unit} || true; fi; journalctl -u ${unit} -n 30 --no-pager || true; exit 1; fi; ready=0; attempt=0; while [ "$attempt" -lt 20 ]; do if systemctl is-active --quiet ${unit} && ss -ltn 2>/dev/null | grep -E '[:.]${port}([[:space:]]|$)' >/dev/null 2>&1; then ready=1; break; fi; sleep 1; attempt=$((attempt + 1)); done; if [ "$ready" -ne 1 ]; then journalctl -u ${unit} -n 30 --no-pager || true; if [ -f ${backup} ]; then cp -f ${backup} ${path}; systemctl restart ${unit} || true; fi; exit 1; fi; ss -ltn | grep -E '[:.]${port}([[:space:]]|$)'`;
  return sshCommand(serverId, command, 180_000);
}

export async function createManagedXrayTunnel(serverId, input) {
  const { normalized, config } = buildManagedXrayConfig(input);
  const id = createId('xray');
  const serviceName = `xray-managed-${id}.service`;
  const configPath = `/etc/xray/managed/${id}.json`;
  const now = nowIso();
  await query(`INSERT INTO managed_xray_tunnels (id,managed_server_id,name,template,config,service_name,config_path,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,'pending',$8,$8)`, [id, serverId, normalized.name, normalized.template, JSON.stringify(config), serviceName, configPath, now]);
  try {
    await applyRemoteTunnel(serverId, { id, config, serviceName, configPath });
    await query('UPDATE managed_xray_tunnels SET status=$2,last_error=NULL,updated_at=$3 WHERE id=$1', [id, 'active', nowIso()]);
  } catch (error) {
    await query('UPDATE managed_xray_tunnels SET status=$2,last_error=$3,updated_at=$4 WHERE id=$1', [id, 'error', error.message, nowIso()]);
    throw error;
  }
  return getTunnel(serverId, id);
}

export async function validateManagedXrayTunnel(serverId, tunnelId) {
  const tunnel = await getTunnel(serverId, tunnelId);
  if (!tunnel) throw new Error('Xray tunnel not found');
  const result = await sshCommand(serverId, `set -eu; XRAY=$(command -v xray || true); [ -x "$XRAY" ] || XRAY=/usr/local/bin/xray; [ -x "$XRAY" ]; "$XRAY" run -test -config ${tunnel.configPath}; systemctl is-active --quiet ${tunnel.serviceName}`);
  return { ok: true, output: result.stdout.trim() };
}

export async function restartManagedXrayTunnel(serverId, tunnelId) {
  const tunnel = await getTunnel(serverId, tunnelId);
  if (!tunnel) throw new Error('Xray tunnel not found');
  const port = Number(tunnel.config.inbounds?.[0]?.port || 0);
  await sshCommand(serverId, `set -eu; if ! systemctl restart ${tunnel.serviceName}; then journalctl -u ${tunnel.serviceName} -n 30 --no-pager || true; exit 1; fi; ready=0; attempt=0; while [ "$attempt" -lt 20 ]; do if systemctl is-active --quiet ${tunnel.serviceName} && ss -ltn 2>/dev/null | grep -E '[:.]${port}([[:space:]]|$)' >/dev/null 2>&1; then ready=1; break; fi; sleep 1; attempt=$((attempt + 1)); done; if [ "$ready" -ne 1 ]; then journalctl -u ${tunnel.serviceName} -n 30 --no-pager || true; exit 1; fi; ss -ltn | grep -E '[:.]${port}([[:space:]]|$)'`);
  await query('UPDATE managed_xray_tunnels SET status=$3,last_error=NULL,updated_at=$4 WHERE managed_server_id=$1 AND id=$2', [serverId, tunnelId, 'active', nowIso()]);
  return getTunnel(serverId, tunnelId);
}

export async function updateManagedXrayTunnel(serverId, tunnelId, input) {
  const current = await getTunnel(serverId, tunnelId);
  if (!current) throw new Error('Xray tunnel not found');
  const inbound = current.config?.inbounds?.[0] || {};
  const stream = inbound.streamSettings || {};
  const clients = Array.isArray(inbound.settings?.clients) ? inbound.settings.clients : [];
  const client = clients[0] || {};
  const existing = {
    name: current.name,
    template: current.template,
    port: inbound.port,
    uuid: client.id,
    clientUuids: clients.map((entry) => entry?.id).filter(Boolean),
    host: stream.wsSettings?.headers?.Host || '',
    sni: stream.tlsSettings?.serverName || '',
    path: stream.wsSettings?.path || '/',
    outbound: current.config?.outbounds?.[0]?.protocol === 'vless'
      ? { protocol: 'vless', address: current.config.outbounds[0].settings?.vnext?.[0]?.address, port: current.config.outbounds[0].settings?.vnext?.[0]?.port, uuid: current.config.outbounds[0].settings?.vnext?.[0]?.users?.[0]?.id, network: current.config.outbounds[0].streamSettings?.network, security: current.config.outbounds[0].streamSettings?.security, sni: current.config.outbounds[0].streamSettings?.tlsSettings?.serverName }
      : { protocol: 'freedom' },
  };
  const { normalized, config } = buildManagedXrayConfig({ ...existing, ...input, outbound: input.outbound ?? existing.outbound });
  await applyRemoteTunnel(serverId, { id: current.id, config, serviceName: current.serviceName, configPath: current.configPath });
  await query('UPDATE managed_xray_tunnels SET name=$3,template=$4,config=$5::jsonb,status=$6,last_error=NULL,updated_at=$7 WHERE managed_server_id=$1 AND id=$2', [serverId, tunnelId, normalized.name, normalized.template, JSON.stringify(config), 'active', nowIso()]);
  return getTunnel(serverId, tunnelId);
}

export async function deleteManagedXrayTunnel(serverId, tunnelId) {
  const tunnel = await getTunnel(serverId, tunnelId);
  if (!tunnel) throw new Error('Xray tunnel not found');
  await sshCommand(serverId, `systemctl disable --now ${tunnel.serviceName} 2>/dev/null || true; rm -f ${tunnel.configPath} /etc/systemd/system/${tunnel.serviceName}; systemctl daemon-reload`);
  await query('DELETE FROM managed_xray_tunnels WHERE managed_server_id=$1 AND id=$2', [serverId, tunnelId]);
}
