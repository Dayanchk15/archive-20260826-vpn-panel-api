import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getPanelSettings, updatePanelSettings } from '/app/lib/settings.js';
const root=path.join(process.env.LOCAL_STORAGE_DIR||'/data/files','backups');
const names=(await readdir(root)).filter(x=>(x.startsWith('ss-per-user-')||x.startsWith('ss-label-'))&&x.endsWith('.json')).sort().reverse();
if(!names.length) throw new Error('No SS per-user backup found');
let old='';
for (const name of names) {
  const backup=JSON.parse(await readFile(path.join(root,name),'utf8'));
  old=(backup.globalExtraSubscriptionLines||[]).map(String).find(x=>x.startsWith('ss://')&&x.includes('@193.233.219.173:443')) || '';
  if(old) break;
}
if(!old) throw new Error('Shared SS fallback is absent from backup');
const settings=await getPanelSettings(); const lines=Array.isArray(settings.globalExtraSubscriptionLines)?settings.globalExtraSubscriptionLines.map(String):[];
if(lines.includes(old)){ console.log(JSON.stringify({ok:true,changed:false},null,2)); process.exit(0); }
await updatePanelSettings({globalExtraSubscriptionLines:[...lines,old]});
console.log(JSON.stringify({ok:true,changed:true,restored:true},null,2));
