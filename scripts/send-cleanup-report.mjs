#!/usr/bin/env node
import { sendTelegramAlert } from '../lib/telegram-alert.js';

const text = `📋 VPN Panel — отчёт 2026-06-26

✅ Удалены ноды USA/UK (4): usa1, usa2, uk1, uk2
✅ Cloud Run сервисы удалены из GCP
✅ Подписки обновлены (47 пользователей)
✅ Осталось 11 EU-нод — все HTTP OK (400)

🔧 Исправлено:
• traffic LATEST на всех нодах (без pin на старые ревизии)
• warm только germany8 (min=1), остальные cold (min=0)
• max=2, 1 CPU, 46 UUID синхронизированы

⚠️ Time Out (иногда):
Причина — cold start на нодах кроме germany8 (10–30 сек).
Рекомендация клиентам: использовать первый сервер Germany 8 или обновить подписку в Happ.`;

const result = await sendTelegramAlert(text);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
