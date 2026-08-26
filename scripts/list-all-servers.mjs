#!/usr/bin/env node
/**
 * List all servers (enabled + disabled) grouped by region.
 * Usage: node scripts/list-all-servers.mjs
 */
import { listServers } from '../lib/db-store.js';

const all = await listServers();
const enabled = all.filter((s) => s.enabled !== false);
const disabled = all.filter((s) => s.enabled === false);

const byRegion = {};
for (const s of enabled) {
  const region = s.region || 'unknown';
  if (!byRegion[region]) byRegion[region] = { count: 0, services: [] };
  byRegion[region].count += 1;
  byRegion[region].services.push(s.service);
}

console.log(
  JSON.stringify(
    {
      total: all.length,
      enabled: enabled.length,
      disabled: disabled.length,
      disabledList: disabled.map((s) => ({
        id: s.id,
        service: s.service,
        name: s.name,
        region: s.region,
        profile: s.cloudRunProfileId,
      })),
      byRegion: Object.fromEntries(
        Object.entries(byRegion)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([region, data]) => [region, { count: data.count, services: data.services.sort() }])
      ),
    },
    null,
    2
  )
);
