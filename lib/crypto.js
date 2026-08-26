import crypto from 'crypto';

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function secretKey() {
  const raw = String(process.env.SERVER_SECRETS_KEY || '').trim();
  if (!raw) throw new Error('SERVER_SECRETS_KEY is required for managed-server secrets');
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptSecret(value) {
  const plain = String(value ?? '');
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptSecret(value) {
  const encoded = String(value ?? '').trim();
  if (!encoded) return '';
  const [version, ivText, tagText, dataText] = encoded.split(':');
  if (version !== 'v1' || !ivText || !tagText || !dataText) {
    throw new Error('Invalid encrypted secret format');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    secretKey(),
    Buffer.from(ivText, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
