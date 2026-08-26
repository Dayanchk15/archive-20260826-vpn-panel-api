/** Подтверждённые Google IP для маскировки VLESS в Туркменистане (audit: пул). */
export const TM_GOOGLE_ADDRESS_IPS = [
  '216.58.198.50',
  '142.251.39.142',
];

export function tmAddressIpForIndex(serverIndex = 0) {
  const pool = TM_GOOGLE_ADDRESS_IPS;
  const idx = Math.abs(Number(serverIndex) || 0) % pool.length;
  return pool[idx];
}
