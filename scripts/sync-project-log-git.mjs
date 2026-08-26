#!/usr/bin/env node
import 'dotenv/config';
import {
  pullProjectLogFromGit,
  pushProjectLogToGit,
  syncProjectLogGit,
  getProjectLogGitMeta,
} from '../lib/project-log-git-sync.js';

const mode = process.argv[2] || 'sync';
const source = process.argv.includes('--telegram') ? 'Telegram Desktop Agent' : 'Desktop Agent';

let result;
if (mode === 'pull') {
  result = await pullProjectLogFromGit();
} else if (mode === 'push') {
  result = await pushProjectLogToGit({ source });
} else if (mode === 'meta') {
  result = await getProjectLogGitMeta();
} else {
  result = await syncProjectLogGit({ phase: 'full', source });
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok === false ? 1 : 0);
