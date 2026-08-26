SELECT
  node_id,
  COUNT(*) AS users_counted,
  COALESCE(SUM(upload_bytes + download_bytes), 0) AS bytes_counted,
  MAX(updated_at) AS last_report
FROM traffic_usage_nodes
WHERE node_id IN (
  'fr1-cloudflare-ws',
  'fr2-cloudflare-ws',
  'fornex-cloudflare-ws',
  'tampa-cloudflare-ws'
)
GROUP BY node_id
ORDER BY node_id;
