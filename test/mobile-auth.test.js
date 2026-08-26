import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateActivationCode,
  hiddifyAndroidPublicAccessConfig,
  mobilePublicAccessConfig,
  normalizeActivationCode,
  verifyMobileAccessToken,
} from '../lib/mobile-auth.js';
import { publicHiddifyAndroidClient, publicMobileClient } from '../lib/edge-clients.js';

test('DADA VPN activation codes are eight unambiguous characters', () => {
  for (let index = 0; index < 100; index += 1) {
    const code = generateActivationCode();
    assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    assert.doesNotMatch(code, /[01IO]/);
  }
});

test('DADA Connect can use a separate UUID or the existing public UUID fallback', () => {
  const previous = {
    access: process.env.HIDDIFY_ANDROID_PUBLIC_ACCESS,
    hiddifyUuid: process.env.HIDDIFY_ANDROID_PUBLIC_UUID,
    mobileUuid: process.env.MOBILE_PUBLIC_UUID,
  };
  try {
    process.env.HIDDIFY_ANDROID_PUBLIC_ACCESS = 'true';
    process.env.MOBILE_PUBLIC_UUID = '33333333-3333-4333-8333-333333333333';
    delete process.env.HIDDIFY_ANDROID_PUBLIC_UUID;
    assert.equal(hiddifyAndroidPublicAccessConfig().uuid, process.env.MOBILE_PUBLIC_UUID);
    assert.equal(publicHiddifyAndroidClient()?.uuid, process.env.MOBILE_PUBLIC_UUID);

    process.env.HIDDIFY_ANDROID_PUBLIC_UUID = '44444444-4444-4444-8444-444444444444';
    assert.equal(hiddifyAndroidPublicAccessConfig().uuid, process.env.HIDDIFY_ANDROID_PUBLIC_UUID);
    assert.equal(publicHiddifyAndroidClient()?.uuid, process.env.HIDDIFY_ANDROID_PUBLIC_UUID);
  } finally {
    for (const [key, value] of Object.entries({
      HIDDIFY_ANDROID_PUBLIC_ACCESS: previous.access,
      HIDDIFY_ANDROID_PUBLIC_UUID: previous.hiddifyUuid,
      MOBILE_PUBLIC_UUID: previous.mobileUuid,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('activation code input accepts spaces and dashes without accepting other data', () => {
  assert.equal(normalizeActivationCode('ab-cd ef23'), 'ABCDEF23');
  assert.equal(normalizeActivationCode('  dada vpn  '), 'DADAVPN');
});

test('invalid mobile access tokens never authenticate', () => {
  assert.equal(verifyMobileAccessToken(''), null);
  assert.equal(verifyMobileAccessToken('not-a-jwt'), null);
});

test('public access configuration validates the shared internal UUID', () => {
  const previousAccess = process.env.MOBILE_PUBLIC_ACCESS;
  const previousUuid = process.env.MOBILE_PUBLIC_UUID;
  try {
    process.env.MOBILE_PUBLIC_ACCESS = 'true';
    process.env.MOBILE_PUBLIC_UUID = '22222222-2222-4222-8222-222222222222';
    assert.deepEqual(mobilePublicAccessConfig(), {
      enabled: true,
      uuid: '22222222-2222-4222-8222-222222222222',
    });
    assert.equal(publicMobileClient()?.uuid, '22222222-2222-4222-8222-222222222222');
    process.env.MOBILE_PUBLIC_UUID = 'not-a-uuid';
    assert.equal(mobilePublicAccessConfig().uuid, '');
  } finally {
    if (previousAccess === undefined) delete process.env.MOBILE_PUBLIC_ACCESS;
    else process.env.MOBILE_PUBLIC_ACCESS = previousAccess;
    if (previousUuid === undefined) delete process.env.MOBILE_PUBLIC_UUID;
    else process.env.MOBILE_PUBLIC_UUID = previousUuid;
  }
});
