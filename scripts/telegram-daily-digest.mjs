#!/usr/bin/env node
/**
 * Daily Telegram digest — users, nodes, sync, cost.
 * Run: docker exec vpn-panel-api-vps node /app/scripts/telegram-daily-digest.mjs
 */
import { getSystemHealthSummary } from '../lib/system-health.js';
import { sendTelegramAlert, telegramAlertsEnabled } from '../lib/telegram-alert.js';

function fmtUsd(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `$${Number(n).toFixed(2)}`;
}

async function main() {
  if (!telegramAlertsEnabled()) {
    console.log(JSON.stringify({ ok: false, skipped: true, reason: 'telegram not configured' }));
    process.exit(0);
  }

  const h = await getSystemHealthSummary({ includeCost: true });
  const warm = (h.nodes.warmNames || []).join(', ') || '—';
  const syncLine = h.sync.inProgress
    ? 'синхронизация выполняется'
    : h.sync.queued
      ? 'синхронизация в очереди'
      : h.sync.lastError
        ? `ошибка: ${h.sync.lastError}`
        : h.sync.lastSuccessAt
          ? `OK ${h.sync.lastSuccessAt}`
          : 'ожидание';

  const lines = [
    '📊 Ежедневный дайджест VPN-панели',
    '',
    `Пользователи: ${h.users.total} · активных ${h.users.active} · истекают <7д ${h.users.expiringSoon} · просрочено ${h.users.expired}`,
    `Ноды: ${h.nodes.enabled} вкл · warm ${h.nodes.warm} · cold ${h.nodes.cold}`,
    `Warm: ${warm}`,
    `Синхронизация: ${syncLine}`,
  ];

  if (h.scalingDrift) {
    lines.push(`⚠️ Scaling drift: ${h.scalingDrift} soppy-нод с max>2`);
  }
  if (h.cost?.theoreticalDailyUsd != null) {
    lines.push(`Warm простой (теория): ${h.cost.warmInstances ?? '?'} инст. · ~${fmtUsd(h.cost.theoreticalDailyUsd)}/сутки · ~${fmtUsd(h.cost.theoreticalMonthlyUsd)}/мес`);
  }
  if (h.cost?.monthlyUsd != null) {
    const low = h.cost.monitoringLikelyLow ? ' (monitoring занижен)' : '';
    lines.push(`GCP факт (24ч): ${fmtUsd(h.cost.totalUsd)} · ~${fmtUsd(h.cost.monthlyUsd)}/мес${low}`);
  } else if (h.cost?.error) {
    lines.push(`GCP: ошибка (${h.cost.error})`);
  }

  lines.push('', h.ok ? '✅ Система в норме' : '⚠️ Есть проблемы — проверьте панель');

  const text = lines.join('\n');
  const result = await sendTelegramAlert(text, { parseMode: null });
  console.log(JSON.stringify({ ok: Boolean(result.ok), messageId: result.messageId || null, checkedAt: h.checkedAt }));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message || String(err) }));
  process.exit(1);
});
