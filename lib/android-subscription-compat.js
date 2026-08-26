export function isHappAndroidCompatibilityRequest(user, userAgent = '') {
  const ua = String(userAgent || '');
  // Happ Android often sends bare okhttp/... without the word "Happ".
  if (/okhttp/i.test(ua) || /dalvik/i.test(ua)) return true;
  if (/happ/i.test(ua) && /android/i.test(ua)) return true;
  return user?.happAndroidCompatibility === true && /android|okhttp|dalvik|happ/i.test(ua);
}

export function applyHappXhttpCompatibility(plainBody) {
  return String(plainBody || '')
    .split(/\r?\n/)
    .map((line) => {
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

      const host = String(parsed.searchParams.get('host') || '').toLowerCase();
      const type = String(parsed.searchParams.get('type') || '').toLowerCase();
      const path = String(parsed.searchParams.get('path') || '/').replace(/\?ed=\d+$/i, '');
      const isBunny = host.endsWith('.b-cdn.net');
      const remarkText = (() => {
        try {
          return decodeURIComponent(remark.slice(1)).toLowerCase();
        } catch {
          return remark.toLowerCase();
        }
      })();
      const isExplicitBunnyWs =
        isBunny &&
        type === 'ws' &&
        (
          path.includes('/media/v3/') ||
          remarkText.includes('ios ws') ||
          remarkText.includes('bn ws')
        );

      // Bunny iOS test profiles are intentionally plain WS/TLS. Keep them as
      // WS; otherwise Happ iOS imports them as xHTTP and immediately times out.
      if (isExplicitBunnyWs) {
        parsed.searchParams.set('type', 'ws');
        parsed.searchParams.set('path', path);
        parsed.searchParams.delete('mode');
        parsed.searchParams.delete('xhttpMode');
        parsed.searchParams.delete('fm');
        parsed.searchParams.delete('fragment');
        parsed.searchParams.delete('noises');
        return `${parsed.toString()}${remark}`;
      }

      // Bunny / xHTTP: keep Milan (or other) IP as authority — TM needs it.
      // Strip Happ WS-only params (`fm`, fragment) that make Android hide xHTTP rows.
      if (isBunny || type === 'xhttp') {
        parsed.searchParams.set('type', 'xhttp');
        parsed.searchParams.set('mode', 'auto');
        parsed.searchParams.set('encryption', 'none');
        parsed.searchParams.set('path', path);
        parsed.searchParams.delete('xudpProxyUDP443');
        parsed.searchParams.delete('headerType');
        parsed.searchParams.delete('fm');
        parsed.searchParams.delete('fragment');
        parsed.searchParams.delete('noises');
        parsed.searchParams.delete('allowInsecure');
        if (isBunny) parsed.searchParams.set('alpn', 'h2');
        if (host) {
          parsed.searchParams.set('host', host);
          if (!parsed.searchParams.get('sni')) parsed.searchParams.set('sni', host);
        }
        if (!parsed.searchParams.get('fp')) parsed.searchParams.set('fp', 'chrome');
        if (!parsed.searchParams.get('security')) parsed.searchParams.set('security', 'tls');
        return `${parsed.toString()}${remark}`;
      }

      return line;
    })
    .join('\n');
}

export function applyHappAndroidCompatibility(plainBody) {
  return applyHappXhttpCompatibility(plainBody);
}
