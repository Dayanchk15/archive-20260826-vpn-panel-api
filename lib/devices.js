export async function registerDeviceAccess() {
  return { allowed: true, skipped: true, reason: 'device-limit-disabled' };
}

export function applyDeviceLimitHeaders() {
  // Device limit disabled — traffic GB limit is used instead.
}
