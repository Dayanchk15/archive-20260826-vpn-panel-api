import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_STATE_PATH =
  process.env.NODE_INTEGRITY_STATE_PATH || '/data/files/node-integrity-state.json';

function defaultState() {
  return { services: {}, updatedAt: null };
}

export function loadIntegrityState(filePath = DEFAULT_STATE_PATH) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.services) return parsed;
  } catch {
    /* fresh */
  }
  return defaultState();
}

export function saveIntegrityState(state, filePath = DEFAULT_STATE_PATH) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)
  );
}

function classifyIssues(issues = []) {
  const revisionDrift = issues.some((i) => /revision drift/i.test(i));
  const uuidMismatch = issues.some((i) => /uuid mismatch/i.test(i));
  return { revisionDrift, uuidMismatch };
}

/**
 * Alert on revision drift / UUID mismatch after N consecutive monitor failures.
 */
export function evaluateIntegrityAlerts(reports, options = {}) {
  const consecutiveRequired = Math.max(1, Number(options.consecutiveRequired || 1));
  const state = loadIntegrityState(options.statePath);
  const now = new Date().toISOString();
  const revisionDriftAlerts = [];
  const uuidMismatchAlerts = [];
  const recovered = [];

  for (const report of reports) {
    const service = report.service;
    if (!service) continue;

    const prev = state.services[service] || { failStreak: 0, ok: true, kinds: [] };
    const kinds = classifyIssues(report.issues || []);

    if (report.ok) {
      if ((prev.failStreak || 0) >= consecutiveRequired && !prev.ok) {
        recovered.push({ service, kinds: prev.kinds || [] });
      }
      state.services[service] = { ok: true, failStreak: 0, lastOkAt: now, kinds: [] };
      continue;
    }

    const activeKinds = [];
    if (kinds.revisionDrift) activeKinds.push('revision_drift');
    if (kinds.uuidMismatch) activeKinds.push('uuid_mismatch');
    if (!activeKinds.length) {
      state.services[service] = {
        ok: false,
        failStreak: (prev.failStreak || 0) + 1,
        lastFailAt: now,
        kinds: prev.kinds || [],
        issues: report.issues || [],
      };
      continue;
    }

    const failStreak = (prev.failStreak || 0) + 1;
    state.services[service] = {
      ok: false,
      failStreak,
      lastFailAt: now,
      kinds: activeKinds,
      issues: report.issues || [],
    };

    if (failStreak >= consecutiveRequired && failStreak === consecutiveRequired) {
      const item = { service, region: report.region, issues: report.issues || [] };
      if (kinds.revisionDrift) revisionDriftAlerts.push(item);
      if (kinds.uuidMismatch) uuidMismatchAlerts.push(item);
    }
  }

  saveIntegrityState(state, options.statePath);
  return {
    revisionDriftAlerts,
    uuidMismatchAlerts,
    recovered,
    consecutiveRequired,
    shouldAlert: revisionDriftAlerts.length > 0 || uuidMismatchAlerts.length > 0,
    shouldRecover: recovered.length > 0,
  };
}
