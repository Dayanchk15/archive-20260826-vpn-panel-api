import { listUsers } from '../lib/db-store.js';
import { buildUserSubscriptionBody } from '../lib/subscription.js';
import { getPanelSettings } from '../lib/settings.js';
import { wrapSubscriptionBody } from '../lib/subscription-meta.js';
import { buildMetaForUser } from '../lib/subscription-meta.js';

const panel = await getPanelSettings();
const user = (await listUsers())[0];
const body = await buildUserSubscriptionBody({ ...user, serverIds: [] });
const meta = await buildMetaForUser(user);
const wrapped = wrapSubscriptionBody(body, meta, { panelSettings: panel });
const vless = body.split('\n').filter((l) => l.startsWith('vless://'));

console.log(JSON.stringify({
  happProxy: panel.happProxyEnabled,
  fragmentation: {
    enabled: panel.happFragmentationEnabled,
    packets: panel.happFragmentationPackets,
    length: panel.happFragmentationLength,
    interval: panel.happFragmentationInterval,
  },
  vlessCount: vless.length,
  sampleRemark: decodeURIComponent(vless[0]?.split('#')[1] || ''),
  hasFragmentInLink: vless.some((l) => l.includes('fragment=')),
  fragmentSample: vless.find((l) => l.includes('fragment='))?.match(/fragment=[^&]+/)?.[0],
  bodyFragmentLines: wrapped.split('\n').filter((l) => l.startsWith('#fragmentation')),
}, null, 2));
