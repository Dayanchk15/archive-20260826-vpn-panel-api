import { listUsers } from '/app/lib/db-store.js';
import { getFileByLinkedUserId } from '/app/lib/files.js';
import { readdir, readFile, stat } from 'node:fs/promises';
const subscriptionFiles = [];
try {
  for (const name of await readdir('/data/files')) {
    if (!name.startsWith('subscription-') || !name.endsWith('.txt')) continue;
    const file = `/data/files/${name}`;
    const body = await readFile(file, 'utf8');
    const encodedPart = body.replace(/^#no-limit-xhttp-enabled:\s*1\s*/i, '').trim();
    const decoded = (() => { try { return Buffer.from(encodedPart, 'base64').toString('utf8'); } catch { return ''; } })();
    const searchable = `${body}\n${decoded}`;
    const info = await stat(file);
    const fileHosts = {};
    for (const match of body.matchAll(/@([^:?#\\s]+):/g)) fileHosts[match[1]] = (fileHosts[match[1]] || 0) + 1;
    subscriptionFiles.push({ name, bytes: info.size, modifiedAt: info.mtime.toISOString(), prefix: body.slice(0, 24), decodedBytes: decoded.length, decodedNewVpsLines: (decoded.match(/185\\.96\\.80\\.64/g) || []).length, plainNewVpsLines: (body.match(/185\\.96\\.80\\.64/g) || []).length, fileHosts, fastLabels: ['Russia Moscow', 'France 1 Fast', 'France 2 Fast', 'Germany Fast', 'USA Fast'].reduce((n, label) => n + (searchable.match(new RegExp(label, 'g')) || []).length, 0) });
  }
} catch {}
const users = (await listUsers(10000)).filter((u) => u.status !== 'disabled');
const firstFile = users[0] ? await getFileByLinkedUserId(users[0].id).catch(() => null) : null;
const firstFileContent = String(firstFile?.content || '');
const allLines = users.flatMap((u) => Array.isArray(u.extraSubscriptionLines) ? u.extraSubscriptionLines.map(String) : []);
const labelCounts = {};
const hostCounts = {};
for (const line of allLines) {
  const label = decodeURIComponent(line.split('#')[1] || '');
  labelCounts[label] = (labelCounts[label] || 0) + 1;
  const match = line.match(/@([^:]+):/);
  if (match) hostCounts[match[1]] = (hostCounts[match[1]] || 0) + 1;
}
const report = {
  activeUsers: users.length,
  totalExtraSubscriptionLines: allLines.length,
  labelCounts,
  hostCounts,
  subscriptionFiles,
  fileProbe: firstFile ? { contentLength: firstFileContent.length, updatedAt: firstFile.updatedAt || null, newVpsLines: (firstFileContent.match(/185\\.96\\.80\\.64/g) || []).length, oldVpsLines: (firstFileContent.match(/193\\.233\\.217\\.157/g) || []).length, fastLabels: ['Russia Moscow', 'France 1 Fast', 'France 2 Fast', 'Germany Fast', 'USA Fast'].reduce((n, label) => n + (firstFileContent.match(new RegExp(label, 'g')) || []).length, 0), lineCount: firstFileContent.split(/\\r?\\n/).filter(Boolean).length } : null,
  users: users.map((u) => {
    const lines = Array.isArray(u.extraSubscriptionLines) ? u.extraSubscriptionLines.map(String) : [];
    return {
      id: u.id,
      email: u.email,
      bundleLines: lines.filter((x) => x.includes('@193.233.217.157:')).length,
      fastLines: lines.filter((x) => /Russia Moscow|France 1 Fast|France 2 Fast|Germany Fast|USA Fast/.test(decodeURIComponent(x.split('#')[1] || ''))).length,
      endpointCounts: Object.fromEntries(['193.233.217.157', '193.233.219.173', '185.96.80.64'].map((ip) => [ip, lines.filter((x) => x.includes(`@${ip}:`)).length])),
      labels: lines.filter((x) => x.includes('@193.233.217.157:')).map((x) => decodeURIComponent(x.split('#')[1] || '')).slice(-5),
    };
  }),
};
if (process.env.SUMMARY_ONLY === '1') {
  console.log(JSON.stringify({ activeUsers: report.activeUsers, totalExtraSubscriptionLines: report.totalExtraSubscriptionLines, labelCounts: report.labelCounts, hostCounts: report.hostCounts, fileProbe: report.fileProbe, subscriptionFiles: report.subscriptionFiles }, null, 2));
} else {
  console.log(JSON.stringify(report, null, 2));
}
