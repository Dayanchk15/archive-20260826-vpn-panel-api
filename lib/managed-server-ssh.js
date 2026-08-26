import { Client } from 'ssh2';
import { createHash } from 'crypto';
import {
  getManagedServer,
  listManagedServices,
  replaceManagedServices,
  setManagedServerStatus,
} from './managed-servers.js';

const DEFAULT_TIMEOUT_MS = 30_000;

function fingerprintFromKey(key) {
  const raw = key?.getPublicSSH?.();
  if (!raw) return null;
  return `SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/g, '')}`;
}

function runClient(server, command, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let timer;
    let stdout = '';
    let stderr = '';
    let fingerprint = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      if (error) reject(error); else resolve(value);
    };
    timer = setTimeout(() => finish(new Error('SSH command timeout')), timeoutMs);
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finishAuth) => {
      finishAuth(prompts.map(() => server.credential));
    });
    client.on('error', (error) => finish(error));
    client.on('ready', () => {
      client.exec(command, (error, stream) => {
        if (error) return finish(error);
        stream.on('data', (chunk) => { stdout += chunk.toString(); });
        stream.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        stream.on('close', (code, signal) => finish(null, { code, signal, stdout, stderr, fingerprint }));
      });
    });
    client.connect({
      host: server.address,
      port: server.sshPort,
      username: 'root',
      password: server.authType === 'password' ? server.credential : undefined,
      privateKey: server.authType === 'key' ? server.credential : undefined,
      readyTimeout: timeoutMs,
      hostVerifier: (key) => {
        fingerprint = fingerprintFromKey(key);
        if (server.sshFingerprint && server.sshFingerprint !== fingerprint) {
          finish(new Error('SSH host fingerprint mismatch'));
          return false;
        }
        return true;
      },
    });
  });
}

export async function sshCommand(serverId, command, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const server = await getManagedServer(serverId, { includeCredential: true });
  if (!server) throw new Error('Managed server not found');
  if (!command || /[\r\n]/.test(command)) throw new Error('SSH command must be a single line');
  const result = await runClient(server, command, timeoutMs);
  if (result.code !== 0) {
    const detail = [result.stderr, result.stdout].map((value) => String(value || '').trim()).filter(Boolean).join('\n');
    throw new Error(detail || `SSH command failed with code ${result.code}`);
  }
  if (result.fingerprint && !server.sshFingerprint) {
    await setManagedServerStatus(serverId, { status: 'reachable', sshFingerprint: result.fingerprint });
  }
  return result;
}

/**
 * Prepare the small runtime needed by managed Xray templates. This is
 * deliberately idempotent: existing Xray installations and services are
 * preserved, while a newly installed package is left disabled until a
 * managed tunnel owns its unit.
 */
export async function ensureManagedXrayRuntime(serverId, timeoutMs = 180_000) {
  const command = [
    'set -eu',
    'export DEBIAN_FRONTEND=noninteractive',
    'if command -v apt-get >/dev/null 2>&1; then apt-get update -qq; apt-get install -y -qq bash ca-certificates curl tar unzip openssl; elif command -v apk >/dev/null 2>&1; then apk add --no-cache bash ca-certificates curl tar unzip openssl; elif command -v dnf >/dev/null 2>&1; then dnf install -y bash ca-certificates curl tar unzip openssl; elif command -v yum >/dev/null 2>&1; then yum install -y bash ca-certificates curl tar unzip openssl; fi',
    'installed=0',
    'if ! command -v xray >/dev/null 2>&1 && [ ! -x /usr/local/bin/xray ]; then tmp=$(mktemp); curl -fsSL https://raw.githubusercontent.com/XTLS/Xray-install/main/install-release.sh -o "$tmp"; bash "$tmp" install; rm -f "$tmp"; installed=1; fi',
    'if [ "$installed" = 1 ] && command -v systemctl >/dev/null 2>&1; then systemctl disable --now xray.service 2>/dev/null || true; fi',
    'XRAY=$(command -v xray || true)',
    '[ -x "$XRAY" ] || XRAY=/usr/local/bin/xray',
    '[ -x "$XRAY" ]',
    '"$XRAY" version | head -n 1',
  ].join('; ');
  return sshCommand(serverId, command, timeoutMs);
}

export async function probeManagedServer(serverId, timeoutMs = 8_000) {
  const server = await getManagedServer(serverId, { includeCredential: true });
  if (!server) throw new Error('Managed server not found');
  if (!server.credential) {
    const lastError = 'SSH-доступ не настроен';
    await setManagedServerStatus(serverId, { status: 'unconfigured', lastError });
    return { status: 'unconfigured', reachable: false, error: lastError };
  }
  try {
    await sshCommand(serverId, 'true', timeoutMs);
    const now = new Date().toISOString();
    await setManagedServerStatus(serverId, { status: 'reachable', lastInventoryAt: now, lastError: null });
    return { status: 'reachable', reachable: true, checkedAt: now };
  } catch (error) {
    const lastError = String(error?.message || error);
    await setManagedServerStatus(serverId, { status: 'unreachable', lastError });
    return { status: 'unreachable', reachable: false, error: lastError };
  }
}

function parseServices(stdout) {
  const services = [];
  for (const line of String(stdout || '').split('\n')) {
    const match = line.trim().match(/^([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+(.*)$/);
    if (!match) continue;
    const [, serviceName, load, active, rest] = match;
    if (!serviceName.endsWith('.service')) continue;
    services.push({
      serviceType: 'systemd',
      serviceName,
      status: `${load}/${active}`,
      data: { description: rest.trim() },
    });
  }
  return services;
}

function parseDocker(stdout) {
  return String(stdout || '').split('\n').filter(Boolean).map((line) => {
    const [serviceName, image, status, ports = ''] = line.split('|');
    return { serviceType: 'docker', serviceName, status, data: { image, ports } };
  }).filter((item) => item.serviceName);
}

function parsePorts(stdout) {
  return String(stdout || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = line.match(/(?:\*|0\.0\.0\.0|\[::\]|::):([0-9]+)/);
    return match ? Number(match[1]) : null;
  }).filter(Boolean).filter((value, index, values) => values.indexOf(value) === index);
}

export async function inventoryManagedServer(serverId) {
  const [os, services, docker, ports] = await Promise.all([
    sshCommand(serverId, 'cat /etc/os-release 2>/dev/null | head -5 || uname -a'),
    sshCommand(serverId, 'systemctl list-units --all --type=service --no-legend --no-pager 2>/dev/null || true'),
    sshCommand(serverId, 'docker ps --format "{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}" 2>/dev/null || true'),
    sshCommand(serverId, 'ss -lntup 2>/dev/null || netstat -lntup 2>/dev/null || true'),
  ]);
  const parsed = [
    ...parseServices(services.stdout),
    ...parseDocker(docker.stdout),
  ];
  const unique = parsed.filter((service, index, all) => all.findIndex((item) => item.serviceType === service.serviceType && item.serviceName === service.serviceName) === index);
  const portList = parsePorts(ports.stdout);
  unique.forEach((service) => { service.ports = portList; });
  const osName = String(os.stdout).match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] || String(os.stdout).trim().split('\n')[0];
  const now = new Date().toISOString();
  await replaceManagedServices(serverId, unique);
  await setManagedServerStatus(serverId, { status: 'reachable', os: osName, lastInventoryAt: now, lastError: null });
  return { os: osName, ports: portList, services: await listManagedServices(serverId) };
}

export async function installOutlineOnServer(serverId) {
  const server = await getManagedServer(serverId);
  if (!server) throw new Error('Managed server not found');
  // The upstream installer asks an interactive question when Docker is not
  // installed and otherwise tries to discover the public IP externally. Both
  // can hang an SSH request, so provide the known hostname and answer prompts
  // non-interactively while retaining Outline's persistent access.txt.
  const shellQuote = (value) => `'${String(value ?? '').replace(/'/g, "'\\''")}'`;
  const hostname = shellQuote(server.address);
  const command = [
    'set -eu',
    'export DEBIAN_FRONTEND=noninteractive',
    'if command -v apt-get >/dev/null 2>&1; then apt-get update -qq; apt-get install -y -qq curl ca-certificates; elif command -v apk >/dev/null 2>&1; then apk add --no-cache curl ca-certificates bash; elif command -v dnf >/dev/null 2>&1; then dnf install -y curl ca-certificates bash; elif command -v yum >/dev/null 2>&1; then yum install -y curl ca-certificates bash; fi',
    'mkdir -p /opt/outline',
    // A previous interrupted install can leave only certSha256 in access.txt.
    // Treat that as incomplete and let the official installer regenerate the
    // persisted API URL (it keeps its own .bak copy before resetting it).
    `if [ ! -s /opt/outline/access.txt ] || ! grep -q 'apiUrl' /opt/outline/access.txt; then tmp=$(mktemp); curl -fsSL --retry 3 --connect-timeout 15 https://raw.githubusercontent.com/OutlineFoundation/outline-apps/master/server_manager/install_scripts/install_server.sh -o "$tmp"; yes | bash "$tmp" --hostname ${hostname}; rm -f "$tmp"; fi`,
    'test -s /opt/outline/access.txt && grep -q "apiUrl" /opt/outline/access.txt',
    'cat /opt/outline/access.txt',
  ].join('; ');
  return sshCommand(serverId, command, 300_000);
}

export async function removeManagedService(serverId, serviceName, serviceType = 'systemd') {
  if (!/^[a-zA-Z0-9_.@:-]+$/.test(serviceName)) throw new Error('Invalid service name');
  if (serviceType === 'systemd') {
    await sshCommand(serverId, `systemctl disable --now ${serviceName} 2>/dev/null || true; rm -f /etc/systemd/system/${serviceName} /etc/systemd/system/${serviceName}.d/* 2>/dev/null || true; systemctl daemon-reload`);
  } else if (serviceType === 'docker') {
    await sshCommand(serverId, `docker rm -f ${serviceName}`);
  } else {
    throw new Error('Only systemd and docker service removal is supported');
  }
  return inventoryManagedServer(serverId);
}
