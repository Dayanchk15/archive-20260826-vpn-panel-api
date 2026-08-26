import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyHappAndroidCompatibility,
  isHappAndroidCompatibilityRequest,
} from '../lib/android-subscription-compat.js';

test('Happ Android compatibility applies for Happ Android / okhttp UAs', () => {
  assert.equal(isHappAndroidCompatibilityRequest({}, 'Happ/2.9 Android'), true);
  assert.equal(isHappAndroidCompatibilityRequest({}, 'okhttp/4.12.0'), true);
  assert.equal(isHappAndroidCompatibilityRequest({}, 'Mozilla/5.0 Android'), false);
  assert.equal(isHappAndroidCompatibilityRequest({}, 'Happ/2.9 iOS'), false);
});

test('Happ Android keeps Milan IP, mode=auto, and strips fm from Bunny xHTTP', () => {
  const cf = 'vless://00000000-0000-4000-8000-000000000001@8.6.112.0:443?fm=%257B%257D&type=ws&host=fr1.levospeed.click&path=%2Fws&security=tls&sni=fr1.levospeed.click#CF';
  const bunny = 'vless://00000000-0000-4000-8000-000000000001@84.17.59.119:443?encryption=none&security=tls&type=xhttp&headerType=&path=%2Fmedia%2Fv4%2Ffr2%2Fsync&host=levospeedfr1xhttp2.b-cdn.net&sni=levospeedfr1xhttp2.b-cdn.net&fp=chrome&alpn=h2&mode=packet-up&fm=%257B%257D#BN';
  const output = applyHappAndroidCompatibility([cf, bunny].join('\n'));
  const lines = output.split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  const parsedBunny = new URL(lines[1].split('#')[0]);
  assert.equal(parsedBunny.hostname, '84.17.59.119');
  assert.equal(parsedBunny.searchParams.get('type'), 'xhttp');
  assert.equal(parsedBunny.searchParams.get('mode'), 'auto');
  assert.equal(parsedBunny.searchParams.get('host'), 'levospeedfr1xhttp2.b-cdn.net');
  assert.equal(parsedBunny.searchParams.has('headerType'), false);
  assert.equal(parsedBunny.searchParams.has('fm'), false);
});

