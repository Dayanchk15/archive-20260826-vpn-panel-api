#!/usr/bin/env node

const token = 'b108711509e16de214d24a67daee1911f75278c692cfa4fff07009b9b3a56c2b';
const urls = [
  `https://levospeed.it.com/api/sub/${token}`,
  `http://172.20.0.3:8080/api/sub/${token}`,
];
for (const url of urls) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const raw = (await res.text()).trim();
  let plain = raw;
  if (!raw.startsWith('vless://') && !raw.startsWith('#')) {
    plain = Buffer.from(raw, 'base64').toString('utf8');
  }
  const lines = plain.split('\n').filter((l) => l.startsWith('vless://'));
  const names = lines.map((l) => {
    try {
      return decodeURIComponent((l.split('#')[1] || '').split('?')[0]);
    } catch {
      return '?';
    }
  });
  console.log(JSON.stringify({ url, status: res.status, apiVlessCount: lines.length, names }, null, 2));
}
