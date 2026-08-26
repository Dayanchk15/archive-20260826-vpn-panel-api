import { sendTelegramAlert } from '../lib/telegram-alert.js';
const msg = `Стабилизация VPN нод (VPS 45.140.42.39):
• Политика: min=0 везде, кроме germany8 (TM, min=1); max=2; 1 CPU / 1Gi
• Поэтапный reconcile (30–45с пауза), west4 → west3/9, syncVpnEdgeClientsPhased (46 UUID)
• Откат трафика с failed ревизий (quota); germany8 на рабочей ревизии
• HTTP пробы: было 10/15 → сейчас 13/15 (статус 400)
• Ещё 429: germany11, usa2 (cold, min=0) — повтор reconcile при освобождении квоты`;
const r = await sendTelegramAlert(msg);
console.log(JSON.stringify(r));
process.exit(r.ok ? 0 : 1);