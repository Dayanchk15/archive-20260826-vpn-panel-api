import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGoogleDriveUrl,
  canonicalGoogleDriveUrl,
  extractDriveFileId,
  isGoogleDriveUrl,
} from '../lib/google-drive.js';

test('extracts a Drive file id from the googleapis media URL', () => {
  const id = '1J76w_kN_iMGpc2JV5Lchrfmpz413tBDO';
  assert.equal(
    extractDriveFileId(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=test`),
    id
  );
});

test('preserves an existing Drive URL byte-for-byte', () => {
  const url = 'https://www.googleapis.com/drive/v3/files/abc_123?alt=media&key=old-key';
  assert.equal(isGoogleDriveUrl(url), true);
  assert.equal(buildGoogleDriveUrl('abc_123', url), url);
});

test('normalizes legacy Drive download links for the admin copy view', () => {
  const legacy = 'https://drive.usercontent.google.com/download?id=abc_123&export=download';
  assert.equal(isGoogleDriveUrl(legacy), true);
  assert.equal(
    canonicalGoogleDriveUrl(legacy),
    'https://www.googleapis.com/drive/v3/files/abc_123?alt=media'
  );
});

test('builds a stable media URL for a newly assigned file id', () => {
  const previous = process.env.GOOGLE_DRIVE_API_KEY;
  process.env.GOOGLE_DRIVE_API_KEY = 'test-key';
  try {
    assert.equal(
      buildGoogleDriveUrl('abc_123'),
      'https://www.googleapis.com/drive/v3/files/abc_123?alt=media&key=test-key'
    );
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_DRIVE_API_KEY;
    else process.env.GOOGLE_DRIVE_API_KEY = previous;
  }
});
