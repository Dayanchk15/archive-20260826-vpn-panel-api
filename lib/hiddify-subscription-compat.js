/**
 * Stock Hiddify ignores Happ `#fragmentation-*` headers.
 *
 * For Turkmenistan this panel's working dialect is Xray/Happ:
 *   fragment=length,interval,tlshello  (e.g. 2,0-1,tlshello)
 *
 * The wiki "hellotls" form did not bring links up here; keep tlshello so
 * Hiddify (esp. with Xray core / HiddifyNextX) matches Happ.
 */

export function isHiddifySubscriptionRequest(userAgent = '', client = '') {
  if (String(client || '').trim().toLowerCase() === 'hiddify') return true;
  return /hiddify/i.test(String(userAgent || ''));
}

export function isHiddifyXrayCoreRequest(userAgent = '') {
  return /hiddifynextx/i.test(String(userAgent || ''));
}

export function resolveHiddifyFragmentation(panel = {}, _userAgent = '') {
  const length = String(
    panel.hiddifyFragmentationSize ||
      panel.happFragmentationLength ||
      panel.mobileFragmentationLength ||
      '2'
  ).trim() || '2';
  const interval = String(
    panel.hiddifyFragmentationSleep ||
      panel.happFragmentationInterval ||
      panel.mobileFragmentationInterval ||
      '0-1'
  ).trim() || '0-1';
  return {
    size: length,
    sleep: interval,
    packets: 'tlshello',
    dialect: 'xray',
  };
}

function buildHiddifyFragmentValue(panel = {}, userAgent = '') {
  const { size, sleep, packets } = resolveHiddifyFragmentation(panel, userAgent);
  return `${size},${sleep},${packets}`;
}

export function ensureHiddifyEnableFragmentInPlainBody(plainBody) {
  const body = String(plainBody || '');
  if (/#enable-fragment\s*:/i.test(body)) {
    return body.replace(/#enable-fragment\s*:\s*.*/i, '#enable-fragment: true');
  }
  if (body.startsWith('#')) {
    return `#enable-fragment: true\n${body}`;
  }
  return `#enable-fragment: true\n${body}`;
}

export function applyHiddifyFragmentCompatibility(plainBody, panel = {}, userAgent = '') {
  const fragmentValue = buildHiddifyFragmentValue(panel, userAgent);
  const lines = String(plainBody || '').split(/\r?\n/);
  const out = lines.map((line) => {
    if (!line.startsWith('vless://')) return line;
    const hashIndex = line.indexOf('#');
    const connection = hashIndex >= 0 ? line.slice(0, hashIndex) : line;
    const remark = hashIndex >= 0 ? line.slice(hashIndex) : '';
    let parsed;
    try {
      parsed = new URL(connection);
    } catch {
      return line;
    }

    const type = String(parsed.searchParams.get('type') || 'tcp').toLowerCase();
    const security = String(parsed.searchParams.get('security') || '').toLowerCase();
    if (type === 'xhttp') return line;
    if (security && security !== 'tls' && security !== 'reality') return line;

    parsed.searchParams.delete('fm');
    parsed.searchParams.set('fragment', fragmentValue);
    return `${parsed.toString()}${remark}`;
  });
  return ensureHiddifyEnableFragmentInPlainBody(out.join('\n'));
}
