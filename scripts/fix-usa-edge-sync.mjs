#!/usr/bin/env node
import { syncRelayVpsEdges } from '/app/lib/relay-edge-sync.js';
const r = await syncRelayVpsEdges({ force: true, onlyIds: ['glb-vps-1'] });
console.log(JSON.stringify(r, null, 2));
