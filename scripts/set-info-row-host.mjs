#!/usr/bin/env node
import { getPanelSettings, updatePanelSettings } from '../lib/settings.js';
import { nowIso } from '../lib/dates.js';

const NEW_HOST = process.env.INFO_ROW_HOST || 'www.google.com';
const panel = await getPanelSettings();
const prev = panel.infoRowHost;
await updatePanelSettings({ ...panel, infoRowHost: NEW_HOST, updatedAt: nowIso() });
const updated = await getPanelSettings();
console.log(JSON.stringify({ ok: true, prev, infoRowHost: updated.infoRowHost }, null, 2));
