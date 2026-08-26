import { getPanelSettings } from '/app/lib/settings.js';
import { listUsers } from '/app/lib/db-store.js';
import { buildUserSubscriptionBody } from '/app/lib/subscription.js';
const panel=await getPanelSettings(); const users=await listUsers(10000); const sample=users.find(u=>u.status!=='disabled'); const body=sample?await buildUserSubscriptionBody(sample):'';
console.log(JSON.stringify({globalLines:(panel.globalExtraSubscriptionLines||[]).filter(x=>String(x).includes('193.233.219.173')),active:users.filter(u=>u.status!=='disabled').length,sample:sample?.id||null,sampleSS:body.split(/\r?\n/).filter(x=>x.startsWith('ss://')&&x.includes('193.233.219.173')).map(x=>x.replace(/ss:\/\/[^@]+@/,'ss://REDACTED@')).slice(0,3),sampleHasSS:body.includes('193.233.219.173:20000')},null,2));
