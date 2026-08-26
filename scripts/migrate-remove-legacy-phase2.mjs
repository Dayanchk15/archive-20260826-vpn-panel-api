#!/usr/bin/env node
/**
 * Phase 2: remove legacy servers from users, disable legacy nodes in panel + Cloud Run.
 */
import { getSetting, setSetting } from '../lib/postgres.js';
import {
  getServerById,
  listServers,
  listUsers,
  updateUser,
  upsertServer,
} from '../lib/db-store.js';
import { upsertUserSubscriptionFile } from '../lib/user-subscription-file.js';
import { applyCloudRunServerPanelState, syncVpnEdgeClients } from '../lib/vpn-edge-sync.js';
import { nowIso } from '../lib/dates.js';

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const SETTING_KEY = 'euphoricUserMigration';

function legacyTmServers(servers) {
  return servers.filter((s) => s.tmPool === true && s.cloudRunProfileId !== 'gcp-euphoric');
}

function euphoricIds(servers) {
  return servers
    .filter(
      (s) =>
        s.cloudRunProfileId === 'gcp-euphoric' &&
        s.enabled !== false &&
        String(s.host || '').trim()
    )
    .map((s) => s.id);
}

async function main() {
  const state = (await getSetting(SETTING_KEY)) || {};
  if (!state.phase2Pending && !FORCE && !DRY_RUN) {
    console.log(JSON.stringify({ ok: true, skipped: true, message: 'Phase 2 not pending' }, null, 2));
    return;
  }

  const servers = await listServers();
  const legacy = legacyTmServers(servers);
  const legacyIdSet = new Set(legacy.map((s) => s.id));
  const targetEuphoric = euphoricIds(servers);

  const userUpdates = [];
  for (const user of await listUsers(5000)) {
    const prev = Array.isArray(user.serverIds) ? user.serverIds.map(String) : [];
    const next = prev.filter((id) => !legacyIdSet.has(id));
    for (const id of targetEuphoric) {
      if (!next.includes(id)) next.push(id);
    }
    if (!next.length) {
      targetEuphoric.forEach((id) => next.push(id));
    }

    const same =
      next.length === prev.length && next.every((id) => prev.includes(id)) && prev.every((id) => next.includes(id));
    if (same) continue;

    if (!DRY_RUN) {
      await updateUser(user.id, { serverIds: next, updatedAt: nowIso() });
    }
    userUpdates.push({ userId: user.id, name: user.name, before: prev, after: next });
  }

  const legacyDisabled = [];
  for (const server of legacy) {
    if (!DRY_RUN) {
      await upsertServer(server.id, {
        enabled: false,
        minInstances: 0,
        maxInstances: 0,
        updatedAt: nowIso(),
      });
      const edge = await applyCloudRunServerPanelState(await getServerById(server.id));
      legacyDisabled.push({ id: server.id, service: server.service, ok: edge.ok, message: edge.message });
    } else {
      legacyDisabled.push({ id: server.id, service: server.service, dryRun: true });
    }
  }

  let refreshed = 0;
  if (!DRY_RUN) {
    for (const user of await listUsers(5000)) {
      await upsertUserSubscriptionFile(user);
      refreshed += 1;
    }
  }

  let sync = null;
  if (!DRY_RUN) {
    sync = await syncVpnEdgeClients({ serverIds: targetEuphoric });
    await setSetting(SETTING_KEY, {
      ...state,
      phase2At: nowIso(),
      phase2Pending: false,
      completedAt: nowIso(),
      phase2UsersUpdated: userUpdates.length,
    });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        phase: 2,
        dryRun: DRY_RUN,
        usersUpdated: userUpdates.length,
        legacyDisabled,
        subscriptionsRefreshed: refreshed,
        sync: sync
          ? {
              ok: sync.ok,
              updated: sync.cloudRun?.updated?.length,
              failed: sync.cloudRun?.failed,
            }
          : null,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
