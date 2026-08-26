import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_STATE_PATH =
  process.env.TLS_PROBE_STATE_PATH || '/data/files/tls-probe-state.json';

export function classifyTlsProbeFailure(result = {}) {
  const status = Number(result.status || 0);
  const error = String(result.error || result.line || '').toLowerCase();

  if (status === 429 || error.includes('429')) {
    return {
      kind: 'quota',
      label: 'лимит upstream (429)',
      hint: 'Upstream временно ограничил запросы.',
    };
  }
  if (status === 503 || error.includes('503')) {
    return {
      kind: 'unavailable',
      label: 'сервис недоступен (503)',
      hint: 'Upstream временно не принимает соединения.',
    };
  }
  if (error.includes('timeout') || error.includes('timed out') || error.includes('etimedout')) {
    return {
      kind: 'timeout',
      label: 'таймаут',
      hint: 'Инстанс не успел подняться или сеть медленная.',
    };
  }
  if (error.includes('handshake') || error.includes('certificate') || error.includes('tls')) {
    return {
      kind: 'tls',
      label: 'TLS handshake',
      hint: 'Проверьте masked IP, SNI и подписку клиента.',
    };
  }
  if (status === 101) {
    return { kind: 'ok', label: 'OK', hint: '' };
  }
  return {
    kind: 'other',
    label: result.error || result.status || 'ошибка',
    hint: 'Проверьте логи выбранной VPS-службы.',
  };
}

function defaultState() {
  return { services: {}, updatedAt: null };
}

export function loadProbeState(filePath = DEFAULT_STATE_PATH) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.services) return parsed;
  } catch {
    /* fresh state */
  }
  return defaultState();
}

export function saveProbeState(state, filePath = DEFAULT_STATE_PATH) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)
  );
}

/**
 * Alert only after N consecutive failures per service; notify recovery once.
 */
export function evaluateProbeAlerts(results, options = {}) {
  const consecutiveRequired = Math.max(1, Number(options.consecutiveRequired || 2));
  const state = loadProbeState(options.statePath);
  const now = new Date().toISOString();
  const alertItems = [];
  const recovered = [];

  for (const result of results) {
    const service = result.service;
    if (!service) continue;
    const prev = state.services[service] || { failStreak: 0, ok: true };
    const classification = classifyTlsProbeFailure(result);

    if (result.ok) {
      if (prev.failStreak >= consecutiveRequired && !prev.ok) {
        recovered.push({ service, ms: result.ms });
      }
      state.services[service] = { ok: true, failStreak: 0, lastOkAt: now, kind: 'ok' };
      continue;
    }

    const failStreak = (prev.failStreak || 0) + 1;
    state.services[service] = {
      ok: false,
      failStreak,
      lastFailAt: now,
      kind: classification.kind,
      status: result.status || null,
      error: result.error || null,
    };

    if (failStreak >= consecutiveRequired && failStreak === consecutiveRequired) {
      alertItems.push({
        service,
        ip: result.ip,
        warm: result.warm,
        ms: result.ms,
        status: result.status,
        ...classification,
      });
    }
  }

  saveProbeState(state, options.statePath);
  return {
    shouldAlert: alertItems.length > 0,
    shouldRecover: recovered.length > 0,
    alertItems,
    recovered,
    consecutiveRequired,
  };
}
