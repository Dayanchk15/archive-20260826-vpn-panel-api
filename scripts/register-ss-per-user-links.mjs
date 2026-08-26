#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { listUsers, updateUser } from '/app/lib/db-store.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { getPanelSettings, updatePanelSettings } from '/app/lib/settings.js';
import { nowIso } from '/app/lib/dates.js';

const mapPath = process.env.MAP_PATH || '/app/scripts/ss-per-user-links.json';
const data = JSON.parse(await readFile(mapPath, 'utf8'));
const links = new Map((data.links || []).map((x) => [String(x.userId), x]));
const users = await listUsers(10000);
const panel = await getPanelSettings();
const backupRoot = path.join(process.env.LOCAL_STORAGE_DIR || '/data/files','backups');
await mkdir(backupRoot,{recursive:true});
const updatedAt=nowIso();
const stamp=updatedAt.replace(/[:.]/g,'-');
await writeFile(path.join(backupRoot,`ss-per-user-${stamp}.json`),JSON.stringify({users:users.map(u=>({id:u.id,extraSubscriptionLines:u.extraSubscriptionLines||[]})),globalExtraSubscriptionLines:panel.globalExtraSubscriptionLines||[]},null,2),{mode:0o600});
let changed=0;
for (const user of users.filter(u=>u.status!=='disabled')) {
  const row=links.get(String(user.id)); if (!row) continue;
  const marker='ss://';
  const old=Array.isArray(user.extraSubscriptionLines)?user.extraSubscriptionLines.map(String):[];
  const next=old.filter(line=>!(line.startsWith(marker)&&line.includes(`@${data.server}:`)));
  next.push(row.link);
  if (JSON.stringify(old)!==JSON.stringify(next)) { await updateUser(user.id,{extraSubscriptionLines:next,updatedAt}); changed++; }
  await upsertUserSubscriptionFile({...user,extraSubscriptionLines:next,updatedAt});
}
// Remove only the old shared line for this VPS after per-user lines are present.
const shared=(Array.isArray(panel.globalExtraSubscriptionLines)?panel.globalExtraSubscriptionLines:[]).map(String);
const filtered=shared.filter(line=>!(line.startsWith('ss://')&&line.includes(`@${data.server}:443`)));
if (filtered.length!==shared.length) await updatePanelSettings({globalExtraSubscriptionLines:filtered});
console.log(JSON.stringify({ok:true,server:data.server,updatedUsers:changed,removedSharedLine:filtered.length!==shared.length},null,2));
