#!/usr/bin/env node
import { sendTelegramAlert, telegramAlertsEnabled } from '../lib/telegram-alert.js';

if (!telegramAlertsEnabled()) {
  console.error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
  process.exit(1);
}

const result = await sendTelegramAlert(
  '✅ VPN Panel: тест Telegram-алертов\nАлерты при failed sync и monitor настроены.'
);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
