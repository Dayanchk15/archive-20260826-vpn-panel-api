import { createHash, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

function argumentsMap(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    if (!name?.startsWith('--') || values[index + 1] === undefined) {
      throw new Error(`Invalid argument near ${name || '<empty>'}`);
    }
    result[name.slice(2)] = values[index + 1];
  }
  return result;
}

function required(options, name) {
  const value = String(options[name] || '').trim();
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function canonicalManifest(release) {
  return [
    release.versionCode,
    release.versionName,
    release.minimumVersionCode,
    release.apkUrl,
    release.sha256.toLowerCase(),
    release.changelog,
  ].join('\n');
}

try {
  const options = argumentsMap(process.argv.slice(2));
  const apkPath = required(options, 'apk');
  const privateKeyPath = required(options, 'private-key');
  const apk = readFileSync(apkPath);
  const release = {
    versionCode: Number(required(options, 'version-code')),
    versionName: required(options, 'version-name'),
    minimumVersionCode: Number(options['minimum-version-code'] || 1),
    apkUrl: required(options, 'apk-url'),
    sha256: createHash('sha256').update(apk).digest('hex'),
    changelog: String(options.changelog || ''),
  };
  if (!Number.isInteger(release.versionCode) || release.versionCode < 1) {
    throw new Error('--version-code must be a positive integer');
  }
  if (!Number.isInteger(release.minimumVersionCode) || release.minimumVersionCode < 1) {
    throw new Error('--minimum-version-code must be a positive integer');
  }
  if (!release.apkUrl.startsWith('https://')) throw new Error('--apk-url must use HTTPS');

  const signer = createSign('RSA-SHA256');
  signer.update(canonicalManifest(release), 'utf8');
  signer.end();
  const signature = signer.sign(readFileSync(privateKeyPath), 'base64');
  process.stdout.write(`${JSON.stringify({ ...release, signature }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.stderr.write(
    'Usage: npm run mobile:release-manifest -- --apk app.apk --private-key release-manifest-private.pem ' +
      '--apk-url https://example.com/dada.apk --version-code 2 --version-name 1.1.0 ' +
      '--minimum-version-code 1 --changelog "Changes"\n'
  );
  process.exitCode = 1;
}
