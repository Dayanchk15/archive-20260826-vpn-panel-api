import { writeFile } from 'node:fs/promises';
import { buildEdgeClientList } from '/app/lib/edge-clients.js';

const clients = await buildEdgeClientList();
if (!clients.length) throw new Error('No active clients returned by panel');
const config = {
  log: { loglevel: 'warning' },
  inbounds: [{
    tag: 'fornex-ws-7865',
    listen: '0.0.0.0',
    port: 7865,
    protocol: 'vless',
    settings: {
      clients: clients.map((client) => ({
        id: String(client.uuid).toLowerCase(),
        email: client.email || `user-${client.userId || String(client.uuid).slice(0, 8)}`,
      })),
      decryption: 'none',
    },
    streamSettings: { network: 'ws', security: 'none', wsSettings: { path: '/' } },
    sniffing: { enabled: false },
  }],
  outbounds: [{ protocol: 'freedom', tag: 'direct' }, { protocol: 'blackhole', tag: 'block' }],
};
const output = '/data/files/render-fr1-origin-config.json';
await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ok: true, output, clientCount: clients.length, uuids: clients.map((c) => c.uuid) }, null, 2));
