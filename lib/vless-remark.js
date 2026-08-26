/** Фрагмент #remark — URL-encoded (как tonywaka / 3x-ui). */
export function encodeVlessRemark(text) {
  return encodeURIComponent(String(text || '').trim()).replace(/\+/g, '%20');
}

/**
 * Happ: #Title?serverDescription=base64
 * - Title с флагом: encodeURIComponent (emoji → %F0%9F…), как в docs/emoji
 * - ?serverDescription=… — без кодирования (иначе Happ не подхватывает)
 */
export function encodeHappServerRemark(title, serverDescription) {
  const rawTitle = String(title || '').trim().slice(0, 30);
  const desc = String(serverDescription || '').trim().slice(0, 30);
  if (!desc) return encodeVlessRemark(rawTitle);
  const b64 = Buffer.from(desc, 'utf8').toString('base64');
  // Happ: #Title?serverDescription=base64 — title URL-encoded (emoji/пробелы), ?serverDescription= как в docs
  const encodedTitle = encodeURIComponent(rawTitle);
  return `${encodedTitle}?serverDescription=${b64}`;
}

export function sanitizeVlessRemark(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/\//g, '-')
    .replace(/:/g, '-')
    .replace(/[#?&]/g, '');
}

export function formatVlessRemark(text) {
  return encodeVlessRemark(text);
}

/** Happ list label: flag + country only (e.g. 🇩🇪 Germany). */
export function formatNumberedBrandRemark(_brandName, _listIndex, server) {
  const flag = String(server?.flag || '').trim();
  const country = String(server?.country || 'Server').trim();
  return flag ? `${flag} ${country}` : country;
}
