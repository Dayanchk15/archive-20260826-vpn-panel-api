#!/usr/bin/env node
import { query } from '../lib/postgres.js';

const nodeIds = [
  'fr1-cloudflare-ws',
  'fr2-cloudflare-ws',
  'fornex-cloudflare-ws',
  'tampa-cloudflare-ws',
];

const result = await query(
  `SELECT node_id,
          COUNT(*)::int AS users_counted,
          COALESCE(SUM(upload_bytes + download_bytes), 0)::bigint AS bytes_counted,
          MAX(updated_at) AS last_report
     FROM traffic_usage_nodes
    WHERE node_id = ANY($1::text[])
    GROUP BY node_id
    ORDER BY node_id`,
  [nodeIds]
);

console.log(JSON.stringify({
  ok: true,
  expectedNodeIds: nodeIds,
  reportersSeen: result.rows.map((row) => ({
    nodeId: row.node_id,
    usersCounted: Number(row.users_counted || 0),
    bytesCounted: Number(row.bytes_counted || 0),
    lastReport: row.last_report,
  })),
}, null, 2));
