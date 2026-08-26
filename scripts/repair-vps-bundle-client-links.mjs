#!/usr/bin/env node
import { listUsers, updateUser } from '/app/lib/db-store.js';
import { getPanelSettings, updatePanelSettings } from '/app/lib/settings.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';

const target = String(process.env.TARGET_SERVER_IP || '').trim();
if (!target) throw new Error('TARGET_SERVER_IP is required');
const users = await listUsers(10000);
const active = users.filter((u) => u.status !== 'disabled');
const plainParams = 'encryption=none&security=none&type=tcp&headerType=none';
function repair(line) {
  const value = String(line || '');
  if (!value.startsWith('vless://') || !value.includes(`@${target}:`)) return value;
  const hash = value.indexOf('#');
  const label = hash >= 0 ? value.slice(hash) : '';
  const base = hash >= 0 ? value.slice(0, hash) : value;
  const question = base.indexOf('?');
  return `${question >= 0 ? base.slice(0, question) : base}?${plainParams}${label}`;
}

let changedUsers = 0;
let changedLines = 0;
for (const user of active) {
  const old = Array.isArray(user.extraSubscriptionLines) ? user.extraSubscriptionLines.map(String) : [];
  const next = old.map((line) => {
    const repaired = repair(line);
    if (repaired !== line) changedLines += 1;
    return repaired;
  });
  if (JSON.stringify(old) !== JSON.stringify(next)) {
    await updateUser(user.id, { extraSubscriptionLines: next, updatedAt: new Date().toISOString() });
    changedUsers += 1;
  }
  await upsertUserSubscriptionFile({ ...user, extraSubscriptionLines: next, updatedAt: new Date().toISOString() });
}

const panel = await getPanelSettings();
const oldGlobal = Array.isArray(panel.globalExtraSubscriptionLines) ? panel.globalExtraSubscriptionLines.map(String) : [];
const newGlobal = oldGlobal.map(repair);
if (JSON.stringify(oldGlobal) !== JSON.stringify(newGlobal)) await updatePanelSettings({ globalExtraSubscriptionLines: newGlobal });
console.log(JSON.stringify({ ok: true, target, activeUsers: active.length, changedUsers, changedLines, changedGlobalLines: newGlobal.filter((x, i) => x !== oldGlobal[i]).length }, null, 2));
