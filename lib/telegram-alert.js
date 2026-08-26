/**
 * Telegram alerts for sync/monitor failures.
 * Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in env.
 */
const API_BASE = 'https://api.telegram.org';

export function telegramAlertsEnabled() {
  return Boolean(
    String(process.env.TELEGRAM_BOT_TOKEN || '').trim() &&
      String(process.env.TELEGRAM_CHAT_ID || '').trim()
  );
}

function formatAlertTime(iso) {
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      timeZone: process.env.PANEL_TIMEZONE || 'Asia/Ashgabat',
      dateStyle: 'short',
      timeStyle: 'medium',
    });
  } catch {
    return String(iso || new Date().toISOString());
  }
}

/** Перевод типовых сообщений мониторинга VPS/relay на русский. */
export function translateMonitorIssue(issue) {
  let text = String(issue || '').trim();
  if (!text) return 'неизвестная ошибка';

  const rules = [
    [/^profile:\s*/i, 'профиль: '],
    [/^revision drift \(deploy may be stuck\)$/i, 'расхождение ревизий (деплой может зависнуть)'],
    [/^revision drift$/i, 'расхождение ревизий'],
    [
      /^latest created revision differs from ready \(possible failed deploy\)$/i,
      'созданная ревизия не совпадает с готовой (возможен сбой деплоя)',
    ],
    [/^remote relay check failed$/i, 'проверка relay не удалась'],
    [/^empty VLESS_CLIENTS_JSON on ready revision$/i, 'пустой VLESS_CLIENTS_JSON на активной ревизии'],
    [
      /^UUID mismatch: run=(\d+) expected=(\d+)$/i,
      'несовпадение UUID: на ноде $1, ожидалось $2',
    ],
    [
      /^UUID mismatch run=(\d+) expected=(\d+)$/i,
      'несовпадение UUID: на ноде $1, ожидалось $2',
    ],
    [/^HTTP timeout \((\d+)ms\)$/i, 'таймаут HTTP ($1 мс)'],
    [/^HTTP error: fetch failed$/i, 'ошибка HTTP: нет соединения'],
    [/^HTTP error: (\d+)$/i, 'ошибка HTTP: код $1'],
    [/^slow cold start \((\d+)ms\)$/i, 'долгий холодный старт ($1 мс)'],
    [/PERMISSION_DENIED/i, 'нет доступа (PERMISSION_DENIED)'],
    [/billing must be enabled/i, 'служба недоступна'],
    [/Permission '([^']+)' denied/i, 'нет права: $1'],
    [/Rate exceeded/i, 'превышен лимит запросов (429)'],
    [/invalid VLESS_CLIENTS_JSON/i, 'некорректный VLESS_CLIENTS_JSON'],
    [/no ready revision or URI/i, 'нет готовой ревизии или URI сервиса'],
    [/VPN edge sync failed/i, 'синхронизация VPN edge не удалась'],
    [/timeout/i, 'таймаут'],
  ];

  for (const [pattern, replacement] of rules) {
    if (pattern.test(text)) {
      text = text.replace(pattern, replacement);
    }
  }
  return text;
}

export function translateSyncError(error) {
  return translateMonitorIssue(String(error || 'неизвестная ошибка'));
}

export async function sendTelegramAlert(text, options = {}) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) {
    return { ok: false, skipped: true, reason: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set' };
  }

  const message = String(text || '').slice(0, 4000);
  const url = `${API_BASE}/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true,
      parse_mode: options.parseMode || undefined,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    return {
      ok: false,
      error: data.description || `HTTP ${response.status}`,
    };
  }
  return { ok: true, messageId: data.result?.message_id };
}

export async function alertSyncFailure(context = {}) {
  const failed = context.failed || [];
  const lines = [
    '⚠️ VPN Panel: ошибка синхронизации VPS',
    `Время: ${formatAlertTime(new Date().toISOString())}`,
    `Обновлено: ${context.updated ?? '?'}`,
    `Сбоев: ${failed.length}`,
  ];
  for (const item of failed.slice(0, 8)) {
    const name = item.service || item.serverId || 'сервер';
    const err = translateSyncError(item.error || item.message || '');
    lines.push(`• ${name}: ${err.slice(0, 160)}`);
  }
  if (failed.length > 8) lines.push(`… ещё ${failed.length - 8}`);
  return sendTelegramAlert(lines.join('\n'));
}

export async function alertMonitorFailure(summary = {}) {
  const lines = [
    '⚠️ VPN Panel: мониторинг нод — обнаружены проблемы',
    `Время: ${formatAlertTime(summary.checkedAt || new Date().toISOString())}`,
    `Проблемных нод: ${summary.failed ?? '?'}`,
    `Проверено: ${summary.total ?? '?'}`,
  ];
  for (const item of (summary.reports || []).filter((r) => !r.ok).slice(0, 8)) {
    const name = item.service || item.name || 'нода';
    const issues = (item.issues || []).map(translateMonitorIssue).join('; ');
    lines.push(`• ${name}: ${issues || 'ошибка без описания'}`);
  }
  const hidden = (summary.reports || []).filter((r) => !r.ok).length - 8;
  if (hidden > 0) lines.push(`… ещё ${hidden} нод(ы)`);
  return sendTelegramAlert(lines.join('\n'));
}

export async function alertBackgroundSyncError(err) {
  const message = translateSyncError(err?.message || err);
  return sendTelegramAlert(`⚠️ VPN Panel: ошибка фоновой синхронизации\n${message}`);
}

export async function alertTlsProbeFailures(summary = {}) {
  const items = summary.alertItems || [];
  if (!items.length) return { ok: true, skipped: true };

  const lines = [
    '⚠️ VPN Panel: проблемы TLS-подключения (masked)',
    `Время: ${formatAlertTime(new Date().toISOString())}`,
    `Сбоев: ${items.length} (после ${summary.consecutiveRequired || 2} проверок подряд)`,
  ];
  for (const item of items.slice(0, 8)) {
    const warm = item.warm === false ? 'cold' : 'warm';
    lines.push(
      `• ${item.service} [${warm}]: ${item.label}${item.status ? ` (${item.status})` : ''}`
    );
    if (item.hint) lines.push(`  ↳ ${item.hint}`);
  }
  return sendTelegramAlert(lines.join('\n'));
}

export async function alertTlsProbeRecovered(summary = {}) {
  const items = summary.recovered || [];
  if (!items.length) return { ok: true, skipped: true };
  const names = items.map((i) => i.service).join(', ');
  return sendTelegramAlert(
    `✅ VPN Panel: TLS probe восстановлен\nВремя: ${formatAlertTime(new Date().toISOString())}\nНоды: ${names}`
  );
}

export async function alertRevisionDrift(items = []) {
  if (!items.length) return { ok: true, skipped: true };
  const lines = [
    '⚠️ VPN Panel: расхождение конфигурации VPS',
    `Время: ${formatAlertTime(new Date().toISOString())}`,
    `Нод: ${items.length}`,
  ];
  for (const item of items.slice(0, 8)) {
    lines.push(`• ${item.service}${item.region ? ` (${item.region})` : ''}`);
  }
  if (items.length > 8) lines.push(`… ещё ${items.length - 8}`);
    lines.push('↳ Проверьте инвентаризацию и состояние выбранной службы');
  return sendTelegramAlert(lines.join('\n'));
}

export async function alertUuidMismatch(items = []) {
  if (!items.length) return { ok: true, skipped: true };
  const lines = [
    '⚠️ VPN Panel: UUID mismatch на VPS',
    `Время: ${formatAlertTime(new Date().toISOString())}`,
    `Нод: ${items.length}`,
  ];
  for (const item of items.slice(0, 8)) {
    const detail = (item.issues || []).find((i) => /uuid mismatch/i.test(i)) || '';
    lines.push(`• ${item.service}: ${translateMonitorIssue(detail) || 'расхождение UUID'}`);
  }
  if (items.length > 8) lines.push(`… ещё ${items.length - 8}`);
  return sendTelegramAlert(lines.join('\n'));
}

export async function alertNodeIntegrityRecovered(recovered = []) {
  if (!recovered.length) return { ok: true, skipped: true };
  const names = recovered.map((r) => r.service).join(', ');
  return sendTelegramAlert(
    `✅ VPN Panel: drift/UUID восстановлены\nВремя: ${formatAlertTime(new Date().toISOString())}\nНоды: ${names}`
  );
}
