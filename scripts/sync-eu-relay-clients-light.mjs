#!/usr/bin/env node
/**
 * Light-sync VLESS clients to 5 EU relay edges + Tampa (CLI wrapper).
 *   node scripts/sync-eu-relay-clients-light.mjs [tmp-edge-clients.json]
 */
import { readFileSync } from 'fs';
import { syncRelayVpsEdges } from '../lib/relay-edge-sync.js';

const file = process.argv[2];
const options = { force: true };
if (file) {
  options.clients = JSON.parse(readFileSync(file, 'utf8'));
}

const result = await syncRelayVpsEdges(options);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
