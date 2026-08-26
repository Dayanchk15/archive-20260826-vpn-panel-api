const API_BASE = 'https://api.telegram.org';

export function getTelegramToken() {
  return String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

async function telegramRequest(method, body = {}) {
  const token = getTelegramToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');
  const response = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.description || `Telegram HTTP ${response.status}`);
  }
  return data.result;
}

export async function sendTelegramMessage(chatId, text, options = {}) {
  return telegramRequest('sendMessage', {
    chat_id: chatId,
    text: String(text || '').slice(0, 4096),
    disable_web_page_preview: true,
    parse_mode: options.parseMode,
    reply_markup: options.replyMarkup,
  });
}

export async function editTelegramMessage(chatId, messageId, text, options = {}) {
  return telegramRequest('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: String(text || '').slice(0, 4096),
    disable_web_page_preview: true,
    parse_mode: options.parseMode,
    reply_markup: options.replyMarkup,
  });
}

export async function answerCallbackQuery(callbackQueryId, text) {
  return telegramRequest('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text ? String(text).slice(0, 200) : undefined,
    show_alert: false,
  });
}

export async function sendChatAction(chatId, action = 'typing') {
  return telegramRequest('sendChatAction', { chat_id: chatId, action });
}

export async function getTelegramUpdates(offset, timeoutSec = 25) {
  return telegramRequest('getUpdates', {
    offset,
    timeout: timeoutSec,
    allowed_updates: ['message', 'callback_query'],
  });
}

export function splitTelegramText(text, limit = 4000) {
  const chunks = [];
  let rest = String(text || '');
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
