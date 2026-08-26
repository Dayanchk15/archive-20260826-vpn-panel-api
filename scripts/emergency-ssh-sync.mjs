#!/usr/bin/env node
/**
 * Emergency SSH relay edge sync — force-recreates containers (drops active sessions).
 * Requires explicit acknowledgement flag.
 *
 *   node scripts/emergency-ssh-sync.mjs --i-know-this-drops-sessions
 *   ONLY_EDGE=relay-eu-nl node scripts/emergency-ssh-sync.mjs --i-know-this-drops-sessions
 */
import { syncRelayVpsEdgesSsh } from '../lib/relay-edge-sync.js';

const ack = process.argv.includes('--i-know-this-drops-sessions');
if (!ack) {
  console.error('Refusing: pass --i-know-this-drops-sessions (this force-recreates edge containers)');
  process.exit(1);
}

process.env.EMERGENCY_MANUAL_SYNC = '1';

const result = await syncRelayVpsEdgesSsh({ force: true });
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok || result.skipped ? 0 : 1);
