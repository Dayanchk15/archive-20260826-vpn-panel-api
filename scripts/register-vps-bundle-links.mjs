#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { listUsers, updateUser } from '/app/lib/db-store.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { nowIso } from '/app/lib/dates.js';
import { getPanelSettings, updatePanelSettings } from '/app/lib/settings.js';

const mapPath = process.env.MAP_PATH || '/app/scripts/vps-bundle-links.json';
const data = JSON.parse(await readFile(mapPath, 'utf8'));
const retiredServerIps = new Set([
  ...(Array.isArray(data.retiredServerIps) ? data.retiredServerIps : []),
  ...String(process.env.RETIRE_SERVER_IPS || '').split(',').map((x) => x.trim()).filter(Boolean),
]);
const users = await listUsers(10000);
const panel = await getPanelSettings();
const byUser = new Map((data.links || []).map((x) => [String(x.userId), x]));
const stamp = nowIso();
const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'backups');
await mkdir(backupRoot, { recursive: true });
const backupPath = path.join(backupRoot, `vps-bundle-${stamp.replace(/[:.]/g, '-')}.json`);
const active = users.filter((u) => u.status !== 'disabled');
await writeFile(backupPath, JSON.stringify({ createdAt: stamp, users: active.map((u) => ({ id: u.id, extraSubscriptionLines: u.extraSubscriptionLines || [] })) }, null, 2), { mode: 0o600 });
const changed = [];
const labelByEgress = {
  fr1: '🇫🇷 France 1 Fast',
  fr2: '🇫🇷 France 2 Fast',
  fornex: '🇩🇪 Germany Fast',
  tampa: '🇺🇸 USA Fast',
};
function relabel(link, label) {
  const value = String(link || '').split('#')[0];
  return `${value}#${encodeURIComponent(label)}`;
}
try {
  for (const user of active) {
    const row = byUser.get(String(user.id));
    if (!row) continue;
    const old = Array.isArray(user.extraSubscriptionLines) ? user.extraSubscriptionLines.map(String) : [];
    const next = old.filter((line) => {
      const value = String(line);
      if (value.includes(`@${data.server}:`)) return false;
      for (const ip of retiredServerIps) if (value.includes(`@${ip}:`)) return false;
      return true;
    });
    next.push(
      relabel(row.ssLink, '🇷🇺 Russia Moscow'),
      ...(row.vlessLinks || []).map((x) => relabel(x.link, labelByEgress[String(x.egress)] || String(x.egress)))
    );
    if (JSON.stringify(old) !== JSON.stringify(next)) {
      await updateUser(user.id, { extraSubscriptionLines: next, updatedAt: stamp });
      changed.push({ user, old, next });
    }
    await upsertUserSubscriptionFile({ ...user, extraSubscriptionLines: next, updatedAt: stamp });
  }
  const oldGlobal = Array.isArray(panel.globalExtraSubscriptionLines) ? panel.globalExtraSubscriptionLines.map(String) : [];
  const newGlobal = oldGlobal.filter((line) => {
    const value = String(line);
    if (value.includes('SS-2022-193.233.219.173') || value.includes('@193.233.219.173:443')) return false;
    for (const ip of retiredServerIps) if (value.includes(`@${ip}:`)) return false;
    return true;
  });
  if (JSON.stringify(oldGlobal) !== JSON.stringify(newGlobal)) await updatePanelSettings({ globalExtraSubscriptionLines: newGlobal });
  console.log(JSON.stringify({ ok: true, server: data.server, assignedUsers: active.length, changedUsers: changed.length, ssLinks: active.length, vlessLinks: active.length * (data.egresses || []).length, removedLegacySharedSs: oldGlobal.length !== newGlobal.length, backupPath }, null, 2));
} catch (error) {
  for (const row of changed.reverse()) {
    await updateUser(row.user.id, { extraSubscriptionLines: row.old, updatedAt: nowIso() }).catch(() => {});
    await upsertUserSubscriptionFile({ ...row.user, extraSubscriptionLines: row.old, updatedAt: nowIso() }).catch(() => {});
  }
  throw new Error(`${error.message}; panel changes rolled back; backup: ${backupPath}`);
}
