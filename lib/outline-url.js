// URL helpers shared by the Outline API and the admin response serializer.
export function toHappShadowsocksUrl(accessUrl, name = '') {
  const raw = String(accessUrl || '').trim();
  if (!raw.startsWith('ss://')) return raw;
  try {
    const parsed = new URL(raw);
    const user = parsed.username || '';
    const authority = parsed.host || '';
    if (!user || !authority) return raw;
    const fragment = parsed.hash || (String(name || '').trim() ? `#${encodeURIComponent(String(name).trim())}` : '');
    return `ss://${user}@${authority}${fragment}`;
  } catch {
    return raw.replace(/\/?\?(?:outline=1|[^#]*)$/i, '');
  }
}
