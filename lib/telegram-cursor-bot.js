import { Agent, CursorAgentError } from '@cursor/sdk';
import {
  answerCallbackQuery,
  editTelegramMessage,
  getTelegramUpdates,
  sendChatAction,
  sendTelegramMessage,
  splitTelegramText,
} from './telegram-api.js';
import {
  getSavedAgentId,
  hasSavedAgent,
  rememberAgent,
  clearSavedAgent,
  getSessionsStorePath,
} from './telegram-cursor-sessions-store.js';
import {
  desktopAgentName,
  getDesktopAgentBootstrapPrompt,
  readProjectLogContent,
} from './project-log-memory.js';
import { pullProjectLogFromGit, pushProjectLogToGit } from './project-log-git-sync.js';
import { getCursorAgentStore, initCursorAgentStore } from './cursor-agent-store.js';

const sessions = new Map();

function botEnabled() {
  return (
    process.env.TELEGRAM_BOT_CHAT_ENABLED === 'true' &&
    Boolean(process.env.TELEGRAM_BOT_TOKEN) &&
    Boolean(process.env.CURSOR_API_KEY)
  );
}

function allowedChatIds() {
  const raw =
    process.env.TELEGRAM_ALLOWED_CHAT_IDS ||
    process.env.TELEGRAM_CHAT_ID ||
    '';
  return new Set(
    String(raw)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  );
}

function isAllowedChat(chatId) {
  const ids = allowedChatIds();
  if (!ids.size) return false;
  return ids.has(String(chatId));
}

function agentModel() {
  return process.env.CURSOR_AGENT_MODEL || 'composer-2.5';
}

function agentCwd() {
  return process.env.CURSOR_AGENT_CWD || process.cwd();
}

function agentOptions() {
  const local = {
    cwd: agentCwd(),
    settingSources: ['project'],
  };
  const persistedStore = getCursorAgentStore();
  if (persistedStore) local.store = persistedStore;

  return {
    apiKey: process.env.CURSOR_API_KEY,
    name: desktopAgentName(),
    model: { id: agentModel() },
    local,
  };
}

async function idleKeyboard(chatId) {
  const rows = [[{ text: '🆕 Новый агент', callback_data: 'cursor:new' }]];
  if (await hasSavedAgent(chatId)) {
    rows.push([{ text: '▶️ Продолжить предыдущего', callback_data: 'cursor:resume' }]);
  }
  return { inline_keyboard: rows };
}

function activeKeyboard() {
  return {
    inline_keyboard: [[{ text: '🛑 Завершить чат', callback_data: 'cursor:stop' }]],
  };
}

async function disposeSession(chatId, { keepSaved = true } = {}) {
  const key = String(chatId);
  const session = sessions.get(key);
  if (session?.agent) {
    if (keepSaved && session.agent.agentId) {
      await rememberAgent(chatId, session.agent.agentId, { touchOnly: true });
    }
    try {
      await session.agent[Symbol.asyncDispose]?.();
    } catch {
      // ignore dispose errors
    }
  }
  sessions.delete(key);
}

async function attachAgent(chatId, agent, { resumed = false } = {}) {
  const key = String(chatId);
  await rememberAgent(chatId, agent.agentId, { agentName: desktopAgentName() });
  sessions.set(key, {
    agent,
    busy: false,
    startedAt: Date.now(),
    resumed,
    agentId: agent.agentId,
    agentName: desktopAgentName(),
    memoryInjected: false,
  });
  return sessions.get(key);
}

async function createNewAgent(chatId) {
  await disposeSession(chatId);
  const agent = await Agent.create(agentOptions());
  return attachAgent(chatId, agent, { resumed: false });
}

async function resumeSavedAgent(chatId) {
  const savedId = await getSavedAgentId(chatId);
  if (!savedId) {
    throw new Error('Сохранённый агент не найден');
  }
  await disposeSession(chatId);
  try {
    const agent = await Agent.resume(savedId, agentOptions());
    return attachAgent(chatId, agent, { resumed: true });
  } catch (err) {
    const msg = String(err?.message || err);
    if (/not found/i.test(msg)) {
      await clearSavedAgent(chatId);
      const agent = await Agent.create(agentOptions());
      const session = await attachAgent(chatId, agent, { resumed: false });
      session.resumeFallback = true;
      return session;
    }
    throw err;
  }
}

async function runCursorPrompt(chatId, prompt) {
  const key = String(chatId);
  const session = sessions.get(key);
  if (!session?.agent) {
    throw new Error('Сначала выберите «Новый агент» или «Продолжить предыдущего»');
  }
  if (session.busy) {
    throw new Error('Агент ещё отвечает на предыдущее сообщение');
  }

  session.busy = true;
  try {
    await sendChatAction(chatId, 'typing');
    try {
      await pullProjectLogFromGit();
    } catch (gitErr) {
      console.warn('PROJECT_LOG git pull:', gitErr.message || gitErr);
    }

    let message = String(prompt || '').trim();
    if (!session.memoryInjected) {
      const memory = await getDesktopAgentBootstrapPrompt({ agentName: session.agentName });
      message = `${memory}\n\n---\n\nЗапрос пользователя:\n${message}`;
      session.memoryInjected = true;
    }
    const run = await session.agent.send(message);
    let text = '';
    for await (const event of run.stream()) {
      if (event.type === 'assistant') {
        for (const block of event.message.content) {
          if (block.type === 'text') text += block.text;
        }
      }
    }
    const result = await run.wait();
    if (result.status === 'error') {
      throw new Error('Агент завершил с ошибкой');
    }
    await rememberAgent(chatId, session.agent.agentId, { touchOnly: true });

    try {
      const pushed = await pushProjectLogToGit({ source: 'Telegram Desktop Agent' });
      if (pushed.action === 'push') {
        console.log('PROJECT_LOG git push:', pushed.message);
      }
    } catch (gitErr) {
      console.warn('PROJECT_LOG git push:', gitErr.message || gitErr);
    }

    return text.trim() || '(пустой ответ)';
  } finally {
    session.busy = false;
  }
}

async function sendWelcome(chatId, active = false, extra = '') {
  const name = desktopAgentName();
  const suffix = extra ? `\n\n${extra}` : '';
  const log = await readProjectLogContent();
  const logHint = log.ok ? `Память: ${log.path}` : 'Память: PROJECT_LOG.md';
  const text = active
    ? `✅ ${name} активен.${suffix}\n\n${logHint}\nПишите запросы как в Cursor.`
    : `👋 ${name}${suffix}\n\n${logHint}\n\n• 🆕 Новый агент — чистая сессия\n• ▶️ Продолжить — диалог + PROJECT_LOG`;
  await sendTelegramMessage(chatId, text, {
    replyMarkup: active ? activeKeyboard() : await idleKeyboard(chatId),
  });
}

async function handleStartCommand(chatId) {
  const active = sessions.has(String(chatId));
  const session = sessions.get(String(chatId));
  let extra = '';
  if (active && session?.agentId) {
    extra = session.resumed
      ? `${desktopAgentName()}: продолжение (${session.agentId.slice(0, 12)}…)`
      : `${desktopAgentName()}: новый (${session.agentId.slice(0, 12)}…)`;
  } else if (await hasSavedAgent(chatId)) {
    const saved = await getSavedAgentId(chatId);
    extra = `Сохранённый агент: ${saved.slice(0, 12)}…`;
  }
  await sendWelcome(chatId, active, extra);
}

async function activateAgent(chatId, messageId, { mode }) {
  await sendChatAction(chatId, 'typing');
  const session =
    mode === 'resume' ? await resumeSavedAgent(chatId) : await createNewAgent(chatId);

  const log = await readProjectLogContent();
  let title;
  if (session.resumeFallback) {
    title = `⚠️ ${desktopAgentName()}: старая сессия недоступна (контейнер перезапускался).\nСоздан новый агент с памятью PROJECT_LOG.`;
  } else {
    title =
      mode === 'resume'
        ? `✅ ${desktopAgentName()}: продолжаем предыдущую сессию.`
        : `✅ ${desktopAgentName()}: создан новый агент.`;
  }
  const text = `${title}\n\nID: ${session.agentId}\n${log.ok ? `Память: ${log.path}` : 'Память: PROJECT_LOG.md'}\nСессии: ${getSessionsStorePath()}\n\nПишите запросы обычным текстом.`;

  if (messageId) {
    await editTelegramMessage(chatId, messageId, text, { replyMarkup: activeKeyboard() });
  } else {
    await sendTelegramMessage(chatId, text, { replyMarkup: activeKeyboard() });
  }
}

async function handleCallback(callback) {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  if (!chatId || !isAllowedChat(chatId)) {
    await answerCallbackQuery(callback.id, 'Нет доступа');
    return;
  }

  const data = String(callback.data || '');

  if (data === 'cursor:new' || data === 'cursor:resume') {
    const mode = data === 'cursor:resume' ? 'resume' : 'new';
    await answerCallbackQuery(
      callback.id,
      mode === 'resume' ? 'Подключаю сохранённого агента…' : 'Создаю нового агента…'
    );
    try {
      await activateAgent(chatId, messageId, { mode });
    } catch (err) {
      const msg =
        err instanceof CursorAgentError
          ? `Не удалось подключить агента: ${err.message}`
          : `Ошибка: ${err.message || err}`;
      await sendTelegramMessage(chatId, msg, { replyMarkup: await idleKeyboard(chatId) });
    }
    return;
  }

  if (data === 'cursor:stop') {
    await answerCallbackQuery(callback.id, 'Чат завершён');
    await disposeSession(chatId, { keepSaved: true });
    const saved = await getSavedAgentId(chatId);
    const text = saved
      ? `Чат завершён. Агент сохранён (${saved.slice(0, 12)}…).\n\nМожно продолжить позже или создать нового.`
      : 'Чат завершён. Можно создать нового агента.';
    if (messageId) {
      await editTelegramMessage(chatId, messageId, text, {
        replyMarkup: await idleKeyboard(chatId),
      });
    } else {
      await sendTelegramMessage(chatId, text, { replyMarkup: await idleKeyboard(chatId) });
    }
  }
}

async function handleTextMessage(message) {
  const chatId = message.chat?.id;
  const text = String(message.text || '').trim();
  if (!chatId || !text || !isAllowedChat(chatId)) return;

  if (text === '/start' || text === '/menu') {
    await handleStartCommand(chatId);
    return;
  }

  if (text === '/memory' || text === '/память') {
    const log = await readProjectLogContent();
    const lines = [
      `🧠 ${desktopAgentName()} — общая память`,
      log.ok ? `Файл: ${log.path}` : `Ошибка: ${log.error}`,
      log.ok ? `Размер: ${log.size} байт` : '',
      'Синхронизация с Desktop: node scripts/sync-project-log-memory.mjs push|pull',
    ].filter(Boolean);
    await sendTelegramMessage(chatId, lines.join('\n'), {
      replyMarkup: sessions.has(String(chatId)) ? activeKeyboard() : await idleKeyboard(chatId),
    });
    return;
  }

  if (!sessions.has(String(chatId))) {
    await sendTelegramMessage(chatId, 'Сначала выберите «Новый агент» или «Продолжить предыдущего».', {
      replyMarkup: await idleKeyboard(chatId),
    });
    return;
  }

  const statusMsg = await sendTelegramMessage(chatId, '⏳ Думаю…');
  try {
    const reply = await runCursorPrompt(chatId, text);
    const chunks = splitTelegramText(reply);
    await editTelegramMessage(chatId, statusMsg.message_id, chunks[0], {
      replyMarkup: activeKeyboard(),
    });
    for (let i = 1; i < chunks.length; i += 1) {
      await sendTelegramMessage(chatId, chunks[i]);
    }
  } catch (err) {
    const errText = err instanceof CursorAgentError ? err.message : String(err.message || err);
    await editTelegramMessage(chatId, statusMsg.message_id, `❌ ${errText}`, {
      replyMarkup: activeKeyboard(),
    });
  }
}

async function handleUpdate(update) {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }
  if (update.message?.text) {
    await handleTextMessage(update.message);
  }
}

export async function startTelegramCursorBot() {
  if (!botEnabled()) {
    if (process.env.TELEGRAM_BOT_CHAT_ENABLED === 'true') {
      console.warn(
        'TELEGRAM_BOT_CHAT_ENABLED=true but TELEGRAM_BOT_TOKEN or CURSOR_API_KEY missing — bot not started'
      );
    }
    return;
  }

  const ids = [...allowedChatIds()];
  await initCursorAgentStore();
  console.log(
    `Telegram Cursor bot: polling started (${ids.length} allowed chat id(s)), sessions file: ${getSessionsStorePath()}, agent store: ${process.env.CURSOR_AGENT_STORE_DIR || '(default under /data/files/cursor-agent-store)'}`
  );

  let offset = 0;
  for (;;) {
    try {
      const updates = await getTelegramUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (err) {
      console.error('Telegram bot poll error:', err.message || err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export function telegramCursorBotConfigured() {
  return (
    process.env.TELEGRAM_BOT_CHAT_ENABLED === 'true' &&
    Boolean(process.env.TELEGRAM_BOT_TOKEN) &&
    Boolean(process.env.CURSOR_API_KEY) &&
    allowedChatIds().size > 0
  );
}
