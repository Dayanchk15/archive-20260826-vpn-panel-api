#!/usr/bin/env node
import { writeFileSync } from 'fs';
import { buildEdgeClientList } from '/app/lib/edge-clients.js';
const c = await buildEdgeClientList();
writeFileSync('/data/files/usa-clients.json', JSON.stringify(c));
console.log(JSON.stringify({ ok: true, clients: c.length }));
