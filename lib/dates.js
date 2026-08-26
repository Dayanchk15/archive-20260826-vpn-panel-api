export function addDays(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + Number(days));
  return copy;
}

export function nowIso() {
  return new Date().toISOString();
}
