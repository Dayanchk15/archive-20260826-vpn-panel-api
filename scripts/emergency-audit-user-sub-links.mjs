#!/usr/bin/env node
import { listUsers } from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
import { getFileByLinkedUserId } from '/app/lib/files.js';

function plainContent(value) {
  const text = String(value || '');
  if (text.includes('vless://')) return text;
  try { return Buffer.from(text, 'base64').toString('utf8'); } catch { return ''; }
}

function summarize(body) {
  return String(body || '').split('\n').filter((line) => line.startsWith('vless://')).map((line, index) => {
    try {
      const url = new URL(line);
      return {
        index: index + 1,
        address: url.hostname,
        port: url.port,
        type: url.searchParams.get('type'),
        security: url.searchParams.get('security'),
        host: url.searchParams.get('host'),
        path: url.searchParams.get('path'),
        sni: url.searchParams.get('sni'),
        alpn: url.searchParams.get('alpn'),
        xudpProxyUDP443: url.searchParams.get('xudpProxyUDP443'),
        fragment: url.searchParams.get('fragment'),
        remark: decodeURIComponent(line.split('#')[1] || ''),
      };
    } catch (error) {
      return { index: index + 1, parseError: error.message };
    }
  });
}

const users = await listUsers(10000);
const selected = users.filter((user) => /dayanch vip|\bpon\b/i.test(String(user.name || '')));
const result = [];
for (const user of selected) {
  const generated = await buildUserSubscriptionBody(user);
  const stored = plainContent((await getFileByLinkedUserId(user.id))?.content);
  result.push({
    user: { id: user.id, name: user.name, status: user.status },
    generated: summarize(generated),
    stored: summarize(stored),
  });
}
console.log(JSON.stringify(result, null, 2));
