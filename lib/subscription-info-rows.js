import { buildInfoRowVlessLink } from './vless.js';

const INFO_HOST = 'www.google.com';
const INFO_PORT = 80;

function formatGb(value) {
  const n = Number(value || 0);
  if (n === 0) return '0';
  if (n < 10) return n.toFixed(2);
  return n.toFixed(1);
}

export function buildInfoServerLinks(meta, options = {}) {
  const name = meta.profileTitle || 'User';
  const clientUuid = meta.clientUuid;
  const infoHost = options.infoRowHost || meta.infoRowHost || INFO_HOST;
  const infoPort = Number(options.infoRowPort || meta.infoRowPort || INFO_PORT);
  const usedGB =
    Number(meta.uploadUsedGB || 0) + Number(meta.downloadUsedGB || 0) ||
    Number(meta.trafficUsedGB || 0);
  const limitGB = Number(meta.trafficLimitGB || 0);
  const days = Number(meta.daysRemaining || 0);

  const rows = [
    buildInfoRowVlessLink(clientUuid, {
      host: infoHost,
      port: infoPort,
      label: `👤 ${name}`,
      serverDescription: options.serverDescription,
    }),
    buildInfoRowVlessLink(clientUuid, {
      host: infoHost,
      port: infoPort,
      label: `⏳ ${formatGb(limitGB)} GB/${formatGb(usedGB)} GB`,
      serverDescription: options.serverDescription,
    }),
    buildInfoRowVlessLink(clientUuid, {
      host: infoHost,
      port: infoPort,
      label: `📅 ${days}`,
      serverDescription: options.serverDescription,
    }),
  ];

  if (options.includeDisabledNotice) {
    rows.push(
      buildInfoRowVlessLink(clientUuid, {
        host: infoHost,
        port: infoPort,
        label: '🚫 Вы были отключены',
      })
    );
  }

  return rows;
}
