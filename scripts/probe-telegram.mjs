#!/usr/bin/env node
const t = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const me = await fetch(`https://api.telegram.org/bot${t}/getMe`).then((r) => r.json());
console.log('getMe ok:', me.ok, me.result?.username);
const updates = await fetch(`https://api.telegram.org/bot${t}/getUpdates`).then((r) => r.json());
const chats = (updates.result || []).map((u) => ({
  chatId: u.message?.chat?.id,
  type: u.message?.chat?.type,
  title: u.message?.chat?.title || u.message?.chat?.username,
}));
console.log('recent chats from updates:', JSON.stringify(chats, null, 2));
console.log('configured CHAT_ID:', chatId);
