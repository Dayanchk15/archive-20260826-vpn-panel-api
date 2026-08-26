/** VIP users with per-user subscription overrides (not global panel settings). */

export const DAYANCH_VIP_USER_ID = 'usr_bnjXUy4O1NZufeqW';

/** Bonus/relay lines allowed in Dayanch subscription. */
export const DAYANCH_RELAY_SERVER_IDS = [
  'relay-eu-nl',
  'relay-eu-de',
  'relay-eu-am',
  'relay-eu-gb',
  'relay-eu-de2',
  'glb-vps-1',
  'relay-eu-fr1',
  'relay-eu-fr2',
];

export function isDayanchVipUser(user) {
  return String(user?.id || '').trim() === DAYANCH_VIP_USER_ID;
}

export function isRelaySubscriptionServer(server) {
  const id = String(server?.id || '').trim();
  if (DAYANCH_RELAY_SERVER_IDS.includes(id)) return true;
  if (id.startsWith('relay-eu-')) return true;
  const svc = String(server?.service || '').trim();
  return svc === 'relay-dayanch' || svc === 'tampa-relay' || svc.startsWith('relay-eu-');
}
