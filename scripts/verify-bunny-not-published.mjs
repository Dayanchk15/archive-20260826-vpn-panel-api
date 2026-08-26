#!/usr/bin/env node
/** Verify the Bunny pilot is absent from panel servers and generated subscription files. */
import { listServers } from '/app/lib/db-store.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const needle = 'levospeedfr2.b-cdn.net';
const servers = await listServers();
const serverMatches = servers.filter((server) => JSON.stringify(server).toLowerCase().includes(needle));
let scannedFiles = 0;
let fileMatches = 0;

async function scan(directory) {
  let entries = [];
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (!entry.isFile() || entry.name === 'fr2-bunny-ws.json') continue;
    scannedFiles += 1;
    try {
      const text = await readFile(path, 'utf8');
      if (text.toLowerCase().includes(needle)) fileMatches += 1;
    } catch {}
  }
}

await scan('/data/files');
console.log(JSON.stringify({
  ok: serverMatches.length === 0 && fileMatches === 0,
  totalServers: servers.length,
  bunnyServerMatches: serverMatches.length,
  scannedFiles,
  bunnyFileMatches: fileMatches,
}));
