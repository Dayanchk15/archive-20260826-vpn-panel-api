import { sendTelegramAlert } from '../lib/telegram-alert.js';

const text = `VPN Panel EU (VPS 45.140.42.39)
Scaling: germany8 min=1 max=1 (warm); 10 cold nodes min=0 max=1
Fix germany11: traffic LATEST + reconcile -> rev germany11-00232-6dp
Probe: 11/11 HTTP OK (400)
Policy: set-max1-min0-cold unchanged`;

const result = await sendTelegramAlert(text);
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
