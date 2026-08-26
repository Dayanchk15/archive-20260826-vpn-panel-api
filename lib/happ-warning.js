export const DEFAULT_HAPP_WARNING_TEXT = 'Ping kop gorkezyanem bolsa catylanson dusya';

/** Happ sub-info-color: only red | blue | green (see happ.su dev-docs). */
export const HAPP_SUB_INFO_COLORS = ['red', 'blue', 'green'];

const HAPP_WARNING_LINE_RES = [
  /^#sub-info-text:.*$/gm,
  /^#sub-info-color:.*$/gm,
  /^#announce:.*$/gm,
  /^# notice:.*$/gm,
];

export function resolveSubInfoColor(panelSettings = {}) {
  const raw = String(panelSettings.happWarningColor || 'green').toLowerCase();
  if (HAPP_SUB_INFO_COLORS.includes(raw)) return raw;
  return 'green';
}

/** Keep full text for body; strip only dangerous control chars. */
export function normalizeWarningText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim()
    .slice(0, 200);
}

/** Plain ASCII single-line for sub-info HTTP header (emoji breaks Node setHeader). */
export function headerSafeSubInfoText(text) {
  return normalizeWarningText(text)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export function formatHappAnnounceHeader(text) {
  const value = normalizeWarningText(text);
  if (!value) return '';
  return `base64:${Buffer.from(value, 'utf8').toString('base64')}`;
}

export function resolveHappWarning(panelSettings = {}) {
  if (panelSettings.happWarningEnabled === false) {
    return { enabled: false, text: '', color: 'green' };
  }
  const text = normalizeWarningText(
    panelSettings.happWarningText || DEFAULT_HAPP_WARNING_TEXT
  );
  return {
    enabled: Boolean(text),
    text,
    color: resolveSubInfoColor(panelSettings),
  };
}

export function stripHappWarningComments(body) {
  let result = String(body || '');
  for (const re of HAPP_WARNING_LINE_RES) {
    result = result.replace(re, '');
  }
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

export function buildHappWarningBodyLines(warning) {
  if (!warning?.enabled) return [];
  const announce = formatHappAnnounceHeader(warning.text);
  const lines = [];
  if (announce) lines.push(`#announce: ${announce}`);
  lines.push(`#sub-info-text: ${warning.text}`, `#sub-info-color: ${warning.color}`);
  return lines;
}

/** Hiddify reads plain `# comment` lines in the first lines of subscription body. */
export function buildHiddifyWarningBodyLines(warning) {
  if (!warning?.enabled) return [];
  const line = headerSafeSubInfoText(warning.text) || normalizeWarningText(warning.text).replace(/\n+/g, ' ');
  if (!line) return [];
  return [`# notice: ${line}`];
}

export function buildClientWarningBodyLines(warning) {
  return [...buildHappWarningBodyLines(warning), ...buildHiddifyWarningBodyLines(warning)];
}

export function mergeHappWarningIntoPlainBody(plainBody, warning) {
  const stripped = stripHappWarningComments(String(plainBody || ''));
  const warningLines = buildClientWarningBodyLines(warning);
  if (!warningLines.length) return stripped ? `${stripped}\n` : '';

  const lines = stripped.split('\n');
  const userInfoIdx = lines.findIndex((line) => line.startsWith('#subscription-userinfo:'));
  if (userInfoIdx >= 0) {
    lines.splice(userInfoIdx + 1, 0, ...warningLines);
    return `${lines.join('\n').trim()}\n`;
  }

  const profileIdx = lines.findIndex((line) => line.startsWith('#profile-update-interval:'));
  if (profileIdx >= 0) {
    lines.splice(profileIdx + 1, 0, ...warningLines);
    return `${lines.join('\n').trim()}\n`;
  }

  return `${[...warningLines, '', stripped].join('\n').trim()}\n`;
}

export function applyHappWarningHeaders(res, warning) {
  if (!res || !warning?.enabled) return;
  try {
    const announce = formatHappAnnounceHeader(warning.text);
    if (announce) res.set('announce', announce);
  } catch (err) {
    console.warn('happ announce header:', err.message);
  }
  try {
    const subInfo = headerSafeSubInfoText(warning.text);
    if (subInfo) res.set('sub-info-text', subInfo);
    res.set('sub-info-color', warning.color);
  } catch (err) {
    console.warn('happ sub-info header:', err.message);
  }
}

export const HAPP_WARNING_EXPOSE_HEADERS =
  'subscription-userinfo, profile-title, profile-update-interval, profile-web-page-url, support-url, announce, sub-info-text, sub-info-color, hide-settings, new-url, providerid';
