/** Relay VPS edge registry for agent sync (panel777-style). */

export const RELAY_EDGE_AGENT_PORT = Number(process.env.RELAY_EDGE_AGENT_PORT || 19222);

export const RELAY_EU_EDGES = [
  { id: 'relay-eu-nl', ip: '194.127.178.70', jump: true, sshPort: 22, edgePort: 8081 },
  { id: 'relay-eu-de', ip: '2.26.231.130', jump: true, sshPort: 22, edgePort: 8082 },
  { id: 'relay-eu-am', ip: '194.127.179.178', jump: false, sshPort: 22, edgePort: 8083 },
  { id: 'relay-eu-gb', ip: '185.169.234.182', jump: true, sshPort: 22, edgePort: 8084 },
  { id: 'relay-eu-de2', ip: '45.133.251.146', jump: false, sshPort: 22, edgePort: 8085 },
  { id: 'relay-eu-fr1', ip: '185.209.230.14', jump: false, sshPort: 22, edgePort: 8088 },
  { id: 'relay-eu-fr2', ip: '185.209.230.46', jump: false, sshPort: 22, edgePort: 8089 },
];

export const TAMPA_EDGE = {
  id: 'glb-vps-1',
  ip: '74.115.172.101',
  jump: false,
  sshPort: 22,
  edgePort: 8080,
};

export function listRelayAgentEdges() {
  const disabled = new Set(
    String(process.env.RELAY_EDGE_AGENT_DISABLED || 'relay-eu-lv,relay-eu-de3,relay-eu-pl')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const pilotOnly = String(process.env.RELAY_EDGE_AGENT_PILOT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const pilotSet = pilotOnly.length ? new Set(pilotOnly) : null;

  const edges = [...RELAY_EU_EDGES, TAMPA_EDGE].filter((e) => !disabled.has(e.id));
  if (pilotSet) return edges.filter((e) => pilotSet.has(e.id));
  return edges;
}

export function agentUrlForEdge(edge) {
  const override = process.env[`RELAY_AGENT_URL_${String(edge.id).toUpperCase().replace(/-/g, '_')}`];
  if (override) return String(override).replace(/\/+$/, '');
  return `http://${edge.ip}:${RELAY_EDGE_AGENT_PORT}`;
}

export function resolveRelayEdgeSyncMode() {
  const mode = String(process.env.RELAY_EDGE_SYNC_MODE || 'pilot').trim().toLowerCase();
  if (mode === 'ssh' && process.env.EMERGENCY_MANUAL_SYNC === '1') return 'ssh';
  if (mode === 'ssh') return 'pilot';
  if (mode === 'agent' || mode === 'pilot') return mode;
  return 'pilot';
}

export function pilotEdgeIds() {
  return String(process.env.RELAY_EDGE_AGENT_PILOT_IDS || 'relay-eu-am')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
