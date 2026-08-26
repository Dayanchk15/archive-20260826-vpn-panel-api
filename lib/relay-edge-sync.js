import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { buildEdgeClientList } from './edge-clients.js';
import { getPanelSettings } from './settings.js';
import { pilotEdgeIds, resolveRelayEdgeSyncMode } from './relay-edge-registry.js';
import { syncRelayEdgesViaAgent } from './relay-edge-agent-sync.js';

const RELAY_EU_IDS = new Set([
  'relay-eu-nl',
  'relay-eu-de',
  'relay-eu-am',
  'relay-eu-gb',
  'relay-eu-de2',
  'relay-eu-fr1',
  'relay-eu-fr2',
  'relay-eu-lv',
  'relay-eu-de3',
  'relay-eu-pl',
]);

const EU_EDGES = [
  { id: 'relay-eu-nl', ip: '194.127.178.70', jump: true, sshPort: 22 },
  { id: 'relay-eu-de', ip: '2.26.231.130', jump: true, sshPort: 22 },
  { id: 'relay-eu-am', ip: '194.127.179.178', jump: false, sshPort: 22 },
  { id: 'relay-eu-gb', ip: '185.169.234.182', jump: true, sshPort: 22 },
  { id: 'relay-eu-de2', ip: '45.133.251.146', jump: false, sshPort: 22 },
  { id: 'relay-eu-fr1', ip: '185.209.230.14', jump: false, sshPort: 22 },
  { id: 'relay-eu-fr2', ip: '185.209.230.46', jump: false, sshPort: 22 },
  { id: 'relay-eu-lv', ip: '61.245.11.253', jump: true, sshPort: 22 },
  { id: 'relay-eu-de3', ip: '162.217.248.32', jump: false, sshPort: 2222 },
  { id: 'relay-eu-pl', ip: '91.224.75.102', jump: false, sshPort: 2222 },
];

const syncEnabled = process.env.RELAY_EDGE_SYNC_ENABLED !== 'false';
const edgePauseMs = Math.max(0, Number(process.env.RELAY_EDGE_SYNC_PAUSE_MS || 12000));
const sshKeyCandidates = [
  process.env.RELAY_EDGE_SSH_KEY,
  '/run/secrets/id_ed25519_edge',
  '/run/edge-ssh/id_ed25519',
].filter(Boolean);
const jumpHost = process.env.JUMP_HOST || 'root@194.127.179.178';
const tampaSsh = process.env.TAMPA_SSH || 'root@74.115.172.101';
const commandTimeoutMs = Math.max(30000, Number(process.env.RELAY_EDGE_SYNC_TIMEOUT_MS || 120000));

let lastFingerprint = null;
let lastSuccessAt = null;

function resolveSshKey() {
  for (const candidate of sshKeyCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  return sshKeyCandidates[0] || '/run/secrets/id_ed25519_edge';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clientsFingerprint(clients) {
  const uuids = clients
    .map((client) => String(client.uuid || '').trim().toLowerCase())
    .filter(Boolean)
    .sort();
  return createHash('sha256').update(uuids.join(',')).digest('hex');
}

export async function shouldSyncRelayEdges() {
  if (!syncEnabled) return false;
  const panel = await getPanelSettings();
  return panel.subscriptionRelayOnly === true;
}

function runProcess(command, args, input = '', timeoutMs = commandTimeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `exit ${code}`));
      }
    });

    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function sshArgsForEdge(edge) {
  const sshKey = resolveSshKey();
  const port = Number(edge.sshPort || 22);
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    '-i',
    sshKey,
  ];
  if (port !== 22) {
    args.push('-p', String(port));
  }
  if (edge.jump) {
    args.push(
      '-o',
      `ProxyCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i ${sshKey} -W %h:%p ${jumpHost}`
    );
  }
  args.push(`root@${edge.ip}`, 'bash', '-s');
  return args;
}

function buildEuEdgeScript(clientsJson) {
  const payload = Buffer.from(clientsJson, 'utf8').toString('base64');
  return `set -euo pipefail
EDGE_DIR=/opt/vpn-relay-edge
python3 <<'PY'
import base64, json, pathlib, re
clients = json.loads(base64.b64decode("${payload}").decode())
p = pathlib.Path("/opt/vpn-relay-edge/.env")
text = p.read_text() if p.exists() else ""
line = "VLESS_CLIENTS_JSON=" + json.dumps(clients, separators=(",", ":"))
if re.search(r"^VLESS_CLIENTS_JSON=", text, flags=re.M):
    text = re.sub(r"^VLESS_CLIENTS_JSON=.*$", line, text, flags=re.M)
else:
    text = (text.rstrip() + "\\n" + line + "\\n") if text else (line + "\\n")
p.write_text(text)
print("clients", len(clients))
PY
cd "$EDGE_DIR"
if [ "\${EMERGENCY_MANUAL_SYNC:-0}" = "1" ]; then
  docker compose -f docker-compose.edge.yml up -d --force-recreate
else
  echo "env updated only (no recreate — use emergency-ssh-sync.mjs for force-recreate)"
fi
`;
}

function buildTampaScript(clientsJson) {
  const payload = Buffer.from(clientsJson, 'utf8').toString('base64');
  return `set -euo pipefail
python3 <<'PY'
import base64, json, pathlib, re
clients = json.loads(base64.b64decode("${payload}").decode())
p = pathlib.Path("/opt/glb-vps-edge/docker-compose.yml")
text = p.read_text()
line = "      VLESS_CLIENTS_JSON: " + repr(json.dumps(clients))
text = re.sub(r"      VLESS_CLIENTS_JSON:.*", line, text)
p.write_text(text)
print("clients", len(clients))
PY
cd /opt/glb-vps-edge
if [ "\${EMERGENCY_MANUAL_SYNC:-0}" = "1" ]; then
  docker compose up -d --force-recreate
else
  echo "env updated only (no recreate — use emergency-ssh-sync.mjs for force-recreate)"
fi
`;
}

async function syncEuEdge(edge, clientsJson) {
  await runProcess('ssh', sshArgsForEdge(edge), buildEuEdgeScript(clientsJson));
  return { id: edge.id, ok: true };
}

async function syncTampa(clientsJson) {
  const sshKey = resolveSshKey();
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=15',
    '-i',
    sshKey,
    tampaSsh,
    'bash',
    '-s',
  ];
  await runProcess('ssh', args, buildTampaScript(clientsJson));
  return { id: 'glb-vps-1', ok: true };
}

function mergePilotResults(agentResult, sshResult) {
  const edges = [...(agentResult.edges || []), ...(sshResult.edges || [])];
  const failed = edges.filter((e) => !e.ok);
  const ok = failed.length === 0 && (agentResult.ok || agentResult.skipped) && (sshResult.ok || sshResult.skipped);
  return {
    ok,
    mode: 'pilot',
    applyMode: 'hot-diff+env-only',
    skipped: agentResult.skipped && sshResult.skipped,
    clientCount: agentResult.clientCount || sshResult.clientCount,
    fingerprint: agentResult.fingerprint || sshResult.fingerprint,
    edges,
    agent: agentResult,
    sshEnvOnly: sshResult,
    message: ok
      ? `Pilot sync ok (${edges.length} edges)`
      : `Pilot sync partial: ${failed.length} failed`,
  };
}

export async function syncRelayVpsEdges(options = {}) {
  const mode = resolveRelayEdgeSyncMode();
  if (mode === 'agent') {
    return syncRelayEdgesViaAgent(options);
  }
  if (mode === 'pilot') {
    const agentResult = await syncRelayEdgesViaAgent(options);
    // If panel push is disabled (pull-only), SSH env-only fallback causes timeouts
    // and is unnecessary because edge-agent persists VLESS_CLIENTS_JSON itself.
    const pushEnabled = String(process.env.RELAY_EDGE_AGENT_PUSH_ENABLED || 'false').toLowerCase() === 'true';
    const sshResult = pushEnabled ? await syncRelayVpsEdgesSshEnvOnly(options) : {
      ok: true,
      skipped: true,
      mode: 'ssh-env-only-skipped',
      clientCount: 0,
      fingerprint: null,
      edges: [],
      message: 'ssh-env-only skipped (pull-only agent)',
    };
    return mergePilotResults(agentResult, sshResult);
  }
  return syncRelayVpsEdgesSsh(options);
}

/** SSH updates .env only — never force-recreate (safe for live sessions). */
export async function syncRelayVpsEdgesSshEnvOnly(options = {}) {
  const pilotSet = new Set(pilotEdgeIds());
  const skipIds = new Set(options.skipEdgeIds || []);
  const edges = EU_EDGES.filter((edge) => RELAY_EU_IDS.has(edge.id) && !pilotSet.has(edge.id) && !skipIds.has(edge.id));

  const result = {
    ok: false,
    mode: 'ssh-env-only',
    skipped: false,
    clientCount: 0,
    fingerprint: null,
    edges: [],
    message: '',
  };

  if (!syncEnabled) {
    result.skipped = true;
    result.ok = true;
    result.message = 'Relay edge env-only sync disabled';
    return result;
  }

  if (!(await shouldSyncRelayEdges())) {
    result.skipped = true;
    result.ok = true;
    result.message = 'Relay edge env-only sync skipped (not relay-only mode)';
    return result;
  }

  const sshKey = resolveSshKey();
  if (!existsSync(sshKey)) {
    result.message = `Relay edge SSH key missing (tried: ${sshKeyCandidates.join(', ')})`;
    return result;
  }

  const clients = Array.isArray(options.clients) ? options.clients : await buildEdgeClientList();
  const clientsJson = JSON.stringify(clients);
  const fingerprint = clientsFingerprint(clients);
  result.clientCount = clients.length;
  result.fingerprint = fingerprint;

  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i];
    try {
      result.edges.push(await syncEuEdge(edge, clientsJson));
    } catch (err) {
      result.edges.push({ id: edge.id, ok: false, error: err.message || String(err) });
    }
    if (i < edges.length - 1 && edgePauseMs > 0) {
      await sleep(edgePauseMs);
    }
  }

  if (!pilotSet.has('glb-vps-1') && !skipIds.has('glb-vps-1')) {
    if (edgePauseMs > 0) await sleep(edgePauseMs);
    try {
      result.edges.push(await syncTampa(clientsJson));
    } catch (err) {
      result.edges.push({ id: 'glb-vps-1', ok: false, error: err.message || String(err) });
    }
  }

  const failed = result.edges.filter((edge) => !edge.ok);
  result.ok = failed.length === 0;
  result.message = result.ok
    ? `Env-only SSH sync ok (${clients.length} clients, ${result.edges.length} edges)`
    : `Env-only SSH sync partial: ${failed.length} failed`;
  return result;
}

export async function syncRelayVpsEdgesSsh(options = {}) {
  const result = {
    ok: false,
    mode: 'ssh',
    skipped: false,
    clientCount: 0,
    fingerprint: null,
    edges: [],
    message: '',
  };

  if (!syncEnabled) {
    result.skipped = true;
    result.ok = true;
    result.message = 'Relay edge sync disabled';
    return result;
  }

  if (resolveRelayEdgeSyncMode() === 'agent' && process.env.EMERGENCY_MANUAL_SYNC !== '1') {
    result.skipped = true;
    result.ok = true;
    result.message = 'SSH sync skipped (agent mode — use emergency-ssh-sync.mjs)';
    return result;
  }

  if (!(await shouldSyncRelayEdges())) {
    result.skipped = true;
    result.ok = true;
    result.message = 'Relay edge sync skipped (not relay-only mode)';
    return result;
  }

  const sshKey = resolveSshKey();
  if (!existsSync(sshKey)) {
    result.message = `Relay edge SSH key missing (tried: ${sshKeyCandidates.join(', ')})`;
    return result;
  }

  const clients = Array.isArray(options.clients) ? options.clients : await buildEdgeClientList();
  const clientsJson = JSON.stringify(clients);
  const fingerprint = clientsFingerprint(clients);
  result.clientCount = clients.length;
  result.fingerprint = fingerprint;

  if (
    !options.force &&
    fingerprint === lastFingerprint &&
    lastSuccessAt &&
    Date.now() - new Date(lastSuccessAt).getTime() < 5 * 60 * 1000
  ) {
    result.skipped = true;
    result.ok = true;
    result.message = 'Relay edge list unchanged';
    return result;
  }

  const edges = EU_EDGES.filter((edge) => RELAY_EU_IDS.has(edge.id));
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i];
    try {
      result.edges.push(await syncEuEdge(edge, clientsJson));
    } catch (err) {
      result.edges.push({ id: edge.id, ok: false, error: err.message || String(err) });
    }
    if (i < edges.length - 1 && edgePauseMs > 0) {
      await sleep(edgePauseMs);
    }
  }

  if (edgePauseMs > 0) await sleep(edgePauseMs);

  try {
    result.edges.push(await syncTampa(clientsJson));
  } catch (err) {
    result.edges.push({ id: 'glb-vps-1', ok: false, error: err.message || String(err) });
  }

  const failed = result.edges.filter((edge) => !edge.ok);
  result.ok = failed.length === 0;
  lastFingerprint = result.ok ? fingerprint : lastFingerprint;
  lastSuccessAt = result.ok ? new Date().toISOString() : lastSuccessAt;
  result.message = result.ok
    ? `Relay edges synced (${clients.length} clients)`
    : `Relay edge sync partial: ${failed.length} failed`;

  if (!result.ok) {
    console.error('Relay VPS edge sync partial failure:', JSON.stringify(result));
  } else {
    console.log('Relay VPS edge sync ok:', JSON.stringify({ clientCount: clients.length }));
  }

  return result;
}

export function getRelayEdgeSyncState() {
  const sshKey = resolveSshKey();
  return {
    enabled: syncEnabled,
    sshKey,
    sshKeyPresent: existsSync(sshKey),
    sshKeyCandidates,
    edgePauseMs,
    lastFingerprint,
    lastSuccessAt,
  };
}
