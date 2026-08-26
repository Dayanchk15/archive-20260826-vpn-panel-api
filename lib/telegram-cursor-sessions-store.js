import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';

const MAX_AGENTS_PER_CHAT = 10;

function storePath() {
  const base =
    process.env.TELEGRAM_CURSOR_SESSIONS_DIR ||
    process.env.LOCAL_STORAGE_DIR ||
    path.join(process.cwd(), 'data', 'files');
  return path.join(base, 'telegram-cursor-sessions.json');
}

function emptyStore() {
  return { version: 1, chats: {} };
}

async function loadStore() {
  const file = storePath();
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyStore();
    parsed.chats = parsed.chats || {};
    parsed.version = 1;
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return emptyStore();
    throw err;
  }
}

async function saveStore(store) {
  const file = storePath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

function normalizeChatRecord(record) {
  return {
    lastAgentId: record?.lastAgentId || null,
    lastUsedAt: record?.lastUsedAt || null,
    agents: Array.isArray(record?.agents) ? record.agents : [],
  };
}

export async function getSavedAgentId(chatId) {
  const store = await loadStore();
  const record = normalizeChatRecord(store.chats[String(chatId)]);
  return record.lastAgentId || null;
}

export async function hasSavedAgent(chatId) {
  return Boolean(await getSavedAgentId(chatId));
}

export async function rememberAgent(chatId, agentId, { touchOnly = false, agentName } = {}) {
  const key = String(chatId);
  const id = String(agentId || '').trim();
  if (!id) return null;

  const store = await loadStore();
  const record = normalizeChatRecord(store.chats[key]);
  const now = new Date().toISOString();

  if (!touchOnly) {
    const exists = record.agents.some((item) => item.agentId === id);
    if (!exists) {
      record.agents.unshift({
        agentId: id,
        createdAt: now,
        agentName: agentName || process.env.CURSOR_AGENT_NAME || 'Desktop Agent',
      });
      record.agents = record.agents.slice(0, MAX_AGENTS_PER_CHAT);
    }
  }

  record.lastAgentId = id;
  record.lastUsedAt = now;
  if (agentName) record.agentName = agentName;
  store.chats[key] = record;
  await saveStore(store);
  return record;
}

export async function getChatAgentHistory(chatId) {
  const store = await loadStore();
  return normalizeChatRecord(store.chats[String(chatId)]);
}

export async function clearSavedAgent(chatId) {
  const key = String(chatId);
  const store = await loadStore();
  if (!store.chats[key]) return false;
  delete store.chats[key];
  await saveStore(store);
  return true;
}

export function getSessionsStorePath() {
  return storePath();
}
