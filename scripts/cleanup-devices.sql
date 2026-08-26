DELETE FROM user_devices
WHERE device_name ~* 'TelegramBot|TwitterBot|facebookexternalhit|WhatsApp|Slackbot|Discordbot|LinkedInBot';

DELETE FROM user_devices d
USING (
  SELECT user_id, device_name, MAX(last_seen_at) AS max_seen
  FROM user_devices
  WHERE device_name LIKE 'Happ/%'
  GROUP BY user_id, device_name
  HAVING COUNT(*) > 1
) dup
WHERE d.user_id = dup.user_id
  AND d.device_name = dup.device_name
  AND d.last_seen_at < dup.max_seen;

SELECT user_id, device_name, left(device_fingerprint, 16) AS fp
FROM user_devices
ORDER BY last_seen_at DESC;
