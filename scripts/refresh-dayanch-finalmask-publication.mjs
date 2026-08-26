#!/usr/bin/env node
import { getUserById } from '/app/lib/db-store.js';
import { DAYANCH_VIP_USER_ID } from '/app/lib/vip-users.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
import { getFileByLinkedUserId } from '/app/lib/files.js';

const user = await getUserById(DAYANCH_VIP_USER_ID);
if (!user) throw new Error('Dayanch VIP not found');
await upsertUserSubscriptionFile({ ...user, updatedAt: new Date().toISOString() });
const file = await getFileByLinkedUserId(user.id);
let body = String(file?.content || '');
if (!body.includes('vless://')) body = Buffer.from(body, 'base64').toString('utf8');
const links = body.split(/\r?\n/).filter((line) => line.startsWith('vless://'));
const target = links.find((line) => line.includes('fr2.levospeed.click')) || '';
if (!target || !target.includes('?fm=') || target.indexOf('?fm=') > target.indexOf('&type=ws')) {
  throw new Error('FinalMask profile was not published in Happ-compatible format');
}
console.log(JSON.stringify({
  ok: true,
  links: links.length,
  finalMaskProfile: true,
  position: links.indexOf(target) + 1,
  fmFirst: true,
}, null, 2));
