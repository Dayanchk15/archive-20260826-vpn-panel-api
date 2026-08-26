/** Normalize, trim and de-duplicate externally supplied subscription links. */
export function normalizeExtraSubscriptionLines(lines) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(lines) ? lines : []) {
    const line = String(value || '').trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    result.push(line);
  }
  return result;
}

export function mergeExtraSubscriptionLines(current, added) {
  return normalizeExtraSubscriptionLines([
    ...normalizeExtraSubscriptionLines(current),
    ...normalizeExtraSubscriptionLines(added),
  ]);
}

export function removeExtraSubscriptionLine(current, index) {
  const lines = normalizeExtraSubscriptionLines(current);
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) return lines;
  return lines.filter((_, lineIndex) => lineIndex !== index);
}

export function renameExtraSubscriptionLine(current, index, remark) {
  const lines = normalizeExtraSubscriptionLines(current);
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) return lines;
  const encodedRemark = encodeURIComponent(String(remark || '').trim());
  const base = lines[index].split('#')[0];
  lines[index] = base + (encodedRemark ? `#${encodedRemark}` : '');
  return normalizeExtraSubscriptionLines(lines);
}

/** Run awaited subscription rebuilds without flooding PostgreSQL/local storage. */
export async function syncExtraSubscriptionFiles(
  users,
  { reloadUser, upsertSubscriptionFile, concurrency = 4 }
) {
  const list = Array.isArray(users) ? users : [];
  const failures = [];
  let refreshed = 0;
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(10, Number(concurrency) || 4, list.length || 1));

  async function worker() {
    while (cursor < list.length) {
      const user = list[cursor++];
      try {
        const latest = (await reloadUser(user.id)) || user;
        await upsertSubscriptionFile(latest);
        refreshed += 1;
      } catch (err) {
        failures.push({
          userId: String(user?.id || ''),
          name: String(user?.name || ''),
          error: err?.message || String(err),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return {
    requested: list.length,
    refreshed,
    failed: failures.length,
    failures,
  };
}
