import { mkdir } from 'fs/promises';
import path from 'path';
import { JsonlLocalAgentStore, configureCursorSdk } from '@cursor/sdk';

let store = null;

export function cursorAgentStoreDir() {
  return (
    process.env.CURSOR_AGENT_STORE_DIR ||
    path.join(process.env.LOCAL_STORAGE_DIR || '/data/files', 'cursor-agent-store')
  );
}

export async function initCursorAgentStore() {
  if (store) return store;
  const root = cursorAgentStoreDir();
  await mkdir(root, { recursive: true });
  store = new JsonlLocalAgentStore(root);
  configureCursorSdk({ local: { store } });
  return store;
}

export function getCursorAgentStore() {
  return store;
}
