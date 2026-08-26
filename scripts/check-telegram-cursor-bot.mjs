#!/usr/bin/env node
import { telegramCursorBotConfigured } from '../lib/telegram-cursor-bot.js';

let sdkOk = false;
try {
  await import('@cursor/sdk');
  sdkOk = true;
} catch (err) {
  console.log('sdk:', err.message);
}

console.log(
  JSON.stringify(
    {
      sdkOk,
      chatEnabled: process.env.TELEGRAM_BOT_CHAT_ENABLED,
      hasCursorKey: Boolean(String(process.env.CURSOR_API_KEY || '').trim()),
      hasBotToken: Boolean(String(process.env.TELEGRAM_BOT_TOKEN || '').trim()),
      allowedChatIds: process.env.TELEGRAM_ALLOWED_CHAT_IDS || process.env.TELEGRAM_CHAT_ID,
      configured: telegramCursorBotConfigured(),
    },
    null,
    2
  )
);
