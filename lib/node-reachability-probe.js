import { probeWsHost } from './ws-edge-probe.js';
import { probeMaskedTlsWithRetry } from './masked-tls-probe.js';
import { getPanelSettings } from './settings.js';

/**
 * Probe a managed VPS node the same way Happ clients connect.
 */
export async function probeServerReachability(server, options = {}) {
  const timeoutMs = Number(options.timeoutMs || process.env.NODE_DIAG_TIMEOUT_MS || 25000);
  const mode = String(options.mode || process.env.NODE_PROBE_MODE || 'auto').toLowerCase();
  const panel = options.panel || (await getPanelSettings());
  const panelIp = panel.addressIps?.[0] || '216.58.198.50';
  const addressIp = String(server.addressIp || panelIp).trim();
  const warm = Number(server.minInstances ?? 0) >= 1;

  if (mode === 'masked' || (mode === 'auto' && addressIp)) {
    const result = await probeMaskedTlsWithRetry(server, addressIp, {
      attempts: warm ? 2 : Number(options.attempts || 3),
      retryDelayMs: Number(options.retryDelayMs || 8000),
      timeoutMs,
    });
    return {
      ok: result.ok,
      ms: result.ms,
      status: result.status,
      error: result.error,
      mode: 'masked',
      addressIp,
    };
  }

  const host = String(server.host || '').replace(/^https?:\/\//, '');
  const result = await probeWsHost(host, timeoutMs);
  return {
    ok: result.ok,
    ms: result.ms,
    status: result.status,
    error: result.error,
    mode: 'dns',
    addressIp: null,
  };
}
