import { copyFile, mkdir, readFile, stat, writeFile } from 'fs/promises';
import path from 'path';
import { nowIso } from './dates.js';

const DEFAULT_RELATIVE = 'PROJECT_LOG.md';
const MAX_BOOTSTRAP_CHARS = Number(process.env.PROJECT_LOG_BOOTSTRAP_MAX_CHARS || 14000);

export function resolveProjectLogPath() {
  if (process.env.PROJECT_LOG_PATH) {
    return path.resolve(process.env.PROJECT_LOG_PATH);
  }
  const cwd = process.env.CURSOR_AGENT_CWD || process.cwd();
  return path.join(cwd, DEFAULT_RELATIVE);
}

export function resolveProjectLogDataPath() {
  const base = process.env.LOCAL_STORAGE_DIR || '/data/files';
  return path.join(base, DEFAULT_RELATIVE);
}

/** Копирует PROJECT_LOG в persistent volume на VPS (если ещё нет или bundle новее). */
export async function ensureProjectLogOnDataVolume() {
  const dataPath = resolveProjectLogDataPath();
  const bundlePath = path.join(process.env.CURSOR_AGENT_CWD || process.cwd(), DEFAULT_RELATIVE);
  await mkdir(path.dirname(dataPath), { recursive: true });

  let needCopy = false;
  try {
    await stat(dataPath);
  } catch {
    needCopy = true;
  }

  if (!needCopy) {
    try {
      const [bundleStat, dataStat] = await Promise.all([stat(bundlePath), stat(dataPath)]);
      if (bundleStat.mtimeMs > dataStat.mtimeMs) {
        needCopy = true;
      }
    } catch {
      // bundle missing — keep data volume copy
    }
  }

  if (needCopy) {
    try {
      await copyFile(bundlePath, dataPath);
      return { action: 'copied-bundle-to-data', path: dataPath };
    } catch (err) {
      if (err.code === 'ENOENT') {
        await writeFile(
          dataPath,
          `# PROJECT_LOG\n\n**Последнее обновление:** ${nowIso().slice(0, 10)}\n`,
          'utf8'
        );
        return { action: 'created-empty', path: dataPath };
      }
      throw err;
    }
  }

  return { action: 'unchanged', path: dataPath };
}

export async function readProjectLogContent() {
  const filePath = resolveProjectLogPath();
  try {
    const content = await readFile(filePath, 'utf8');
    const info = await stat(filePath);
    return {
      ok: true,
      path: filePath,
      content,
      mtimeMs: info.mtimeMs,
      size: info.size,
    };
  } catch (err) {
    return {
      ok: false,
      path: filePath,
      error: err.code === 'ENOENT' ? 'файл не найден' : err.message || String(err),
    };
  }
}

export function buildDesktopAgentMemoryPrompt(logContent, { agentName = 'Desktop Agent' } = {}) {
  const trimmed = String(logContent || '').trim();
  const body =
    trimmed.length > MAX_BOOTSTRAP_CHARS
      ? `${trimmed.slice(0, MAX_BOOTSTRAP_CHARS)}\n\n… (обрезано, полный файл: PROJECT_LOG.md)`
      : trimmed;

  return [
    `[${agentName} — общая память проекта]`,
    `Ты агент «${agentName}» для vpn-panel-api.`,
    'Перед работой учитывай PROJECT_LOG.md ниже.',
    'После ЛЮБОГО изменения кода или деплоя VPS — допиши блок в раздел «Журнал изменений» в PROJECT_LOG.md (без секретов).',
    'Этот же файл читает Cursor IDE на Desktop — держи его актуальным.',
    '',
    '--- PROJECT_LOG.md ---',
    body || '(пусто)',
    '--- конец PROJECT_LOG.md ---',
  ].join('\n');
}

export async function getDesktopAgentBootstrapPrompt({ agentName } = {}) {
  const log = await readProjectLogContent();
  if (!log.ok) {
    return buildDesktopAgentMemoryPrompt('', { agentName });
  }
  return buildDesktopAgentMemoryPrompt(log.content, { agentName });
}

export async function appendProjectLogEntry(lines, { date = new Date() } = {}) {
  const filePath = resolveProjectLogPath();
  const day = date.toISOString().slice(0, 10);
  const block = [
    '',
    `### ${day} — ${lines.title || 'обновление'}`,
    '',
    ...(lines.body || []).map((l) => String(l)),
    '',
  ].join('\n');

  let existing = '';
  try {
    existing = await readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    existing = `# PROJECT_LOG\n\n`;
  }

  const marker = '## Журнал изменений';
  let next;
  if (existing.includes(marker)) {
    next = existing.replace(marker, `${block}${marker}`);
  } else {
    next = `${existing.trimEnd()}\n\n${marker}\n${block}`;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
  return { ok: true, path: filePath };
}

export function desktopAgentName() {
  return process.env.CURSOR_AGENT_NAME || 'Desktop Agent';
}
