const TM_PRIORITY_SERVICES = [
  'neth8',
  'neth9',
  'neth11',
  'singapore2',
  'germany13',
  'germany15',
  'germany17',
  'neth5',
  'germany16',
  'germany12',
  'germany18',
  'neth10',
  'neth11',
  'singapore1',
  'france4',
  'neth7',
  'france3',
  'poland1',
  'neth6',
  'poland2',
  'germany14',
  'france5',
  'france6',
];

const COUNTRY_ALIASES = {
  us: 'usa',
  'united states': 'usa',
  de: 'germany',
  deutschland: 'germany',
  nl: 'netherlands',
  gb: 'uk',
  'united kingdom': 'uk',
  lv: 'latvia',
  pl: 'poland',
  sg: 'singapore',
};

function servicePriorityRank(service) {
  const idx = TM_PRIORITY_SERVICES.indexOf(service);
  return idx === -1 ? 9999 : idx;
}

function countryFromText(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (/\b(france|fr)\b/.test(text)) return 'france';
  if (/\b(germany|deutschland|de)\b/.test(text)) return 'germany';
  if (/\b(netherlands|nl)\b/.test(text)) return 'netherlands';
  if (/\b(united kingdom|uk|gb)\b/.test(text)) return 'uk';
  if (/\b(united states|usa|us)\b/.test(text)) return 'usa';
  if (/\b(latvia|lv)\b/.test(text)) return 'latvia';
  if (/\b(poland|pl)\b/.test(text)) return 'poland';
  if (/\b(singapore|sg)\b/.test(text)) return 'singapore';
  return COUNTRY_ALIASES[text] || text;
}

function transportPriorityRank(server) {
  const text = [server?.id, server?.name, server?.country, server?.host, server?.region]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
  if (text.includes('cloudflare') || text.includes(' cf')) return 0;
  if (text.includes('bunny') || text.includes('b-cdn.net') || text.includes(' bn')) return 1;
  if (text.includes('relay-eu-') || text.includes('glb-vps')) return 2;
  return 3;
}

export function normalizeCountryKey(server) {
  const fromCountry = countryFromText(server?.country);
  if (fromCountry) return fromCountry;
  const fromName = countryFromText(server?.name);
  if (fromName) return fromName;
  return String(server?.service || server?.id || 'other').toLowerCase();
}

function compareWithinCountryGroup(a, b) {
  const transportDiff = transportPriorityRank(a) - transportPriorityRank(b);
  if (transportDiff !== 0) return transportDiff;
  const aWarm = Number(a.minInstances ?? 0) >= 1 ? 1 : 0;
  const bWarm = Number(b.minInstances ?? 0) >= 1 ? 1 : 0;
  if (aWarm !== bWarm) return bWarm - aWarm;
  const aRank = servicePriorityRank(a.service);
  const bRank = servicePriorityRank(b.service);
  if (aRank !== bRank) return aRank - bRank;
  const aTm = a.tmPool ? 1 : 0;
  const bTm = b.tmPool ? 1 : 0;
  if (aTm !== bTm) return bTm - aTm;
  const orderDiff = Number(a.sortOrder ?? 9999) - Number(b.sortOrder ?? 9999);
  if (orderDiff !== 0) return orderDiff;
  return String(a.name || a.id || '').localeCompare(String(b.name || b.id || ''));
}

/** Group by country (USA with USA, DE with DE), then warm / TM priority / sortOrder within country. */
export function sortServersGroupedByCountry(servers) {
  const blockRank = new Map();
  for (const server of servers) {
    const key = normalizeCountryKey(server);
    const order = Number(server.sortOrder ?? 9999);
    blockRank.set(key, Math.min(blockRank.get(key) ?? order, order));
  }
  return [...servers].sort((a, b) => {
    const keyA = normalizeCountryKey(a);
    const keyB = normalizeCountryKey(b);
    if (keyA !== keyB) {
      const rankA = blockRank.get(keyA) ?? 9999;
      const rankB = blockRank.get(keyB) ?? 9999;
      if (rankA !== rankB) return rankA - rankB;
      return keyA.localeCompare(keyB);
    }
    return compareWithinCountryGroup(a, b);
  });
}

export function sortServersForSubscription(servers) {
  return sortServersGroupedByCountry(servers);
}
