import { getPanelSettings } from '/app/lib/settings.js';
const s = await getPanelSettings();
console.log(JSON.stringify({
  subscriptionBaseUrl: s.subscriptionBaseUrl,
  importUrlMode: s.importUrlMode,
  connectionMode: s.connectionMode,
  preferGcsDirectUrl: s.preferGcsDirectUrl,
  subscriptionRelayOnly: s.subscriptionRelayOnly,
}, null, 2));
