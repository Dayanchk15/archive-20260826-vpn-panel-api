#!/usr/bin/env node
import { getServerById } from '/app/lib/db-store.js';
import { probeMaskedTls } from '/app/lib/masked-tls-probe.js';
import { getPanelSettings } from '/app/lib/settings.js';

const s = await getServerById('gcp2-eu-fr1');
const ip = String((await getPanelSettings()).addressIps?.[0] || '216.58.198.50').trim();
const probe = await probeMaskedTls(s, ip, 25000);
console.log(
  JSON.stringify(
    {
      id: 'gcp2-eu-fr1',
      relayUpstreamMode: s?.relayUpstreamMode,
      relayUpstream: s?.relayUpstream,
      host: s?.host,
      probe,
    },
    null,
    2
  )
);
process.exitCode = probe.ok ? 0 : 1;
