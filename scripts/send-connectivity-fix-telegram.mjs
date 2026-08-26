import { sendTelegramAlert } from '../lib/telegram-alert.js';

const msg = `VPN connectivity fix (euphoric EU, VPS):
• Root cause: CLOUD_RUN_CPU_THROTTLING=true → cpuIdle throttles long WebSocket tunnels (ping OK, connect fail)
• Fix: .env.vps CLOUD_RUN_CPU_THROTTLING=false; container recreated; startup-cpu-boost when throttling off
• Ran fix-connectivity-euphoric: traffic LATEST×11, syncVpnEdgeClientsPhased, reconcile (germany8 min=1 max=1, others min=0 max=1), 47 subscriptions refreshed
• Before: diagnose 11/11 failed (container HTTP probe); Cloud Run UUIDs matched (46), no revision drift
• After: host WS probe ~400 on nodes; germany12 may 429 on cold start; edge cpuIdle=false on new revisions
• Re-import subscription: not required (same hosts/UUIDs); refresh sub URL in Happ if connect still fails after cold start`;

const r = await sendTelegramAlert(msg);
console.log(JSON.stringify(r));
process.exit(r.ok ? 0 : 1);