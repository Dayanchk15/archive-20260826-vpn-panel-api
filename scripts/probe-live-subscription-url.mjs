import { listUsers } from '/app/lib/db-store.js';
import { getFileByLinkedUserId } from '/app/lib/files.js';
import { buildUrlsForUser } from '/app/lib/user-urls.js';
import { getPanelSettings } from '/app/lib/settings.js';

const user = (await listUsers(1))[0];
if (!user) throw new Error('No users');
const urls = await buildUrlsForUser(user, await getFileByLinkedUserId(user.id), await getPanelSettings());
const url = urls.subscriptionUrl;
const response = await fetch(url, { redirect: 'manual' });
console.log(JSON.stringify({ ok: response.ok, status: response.status, location: response.headers.get('location'), base: new URL(url).origin, path: new URL(url).pathname }, null, 2));
