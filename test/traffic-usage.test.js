import test from 'node:test';
import assert from 'node:assert/strict';
import { BYTES_PER_GIB, bytesToGiB, getTotalUsedGB } from '../lib/traffic-usage.js';

test('traffic bytes use GiB consistently', () => {
  assert.equal(bytesToGiB(BYTES_PER_GIB), 1);
  assert.equal(bytesToGiB(5 * BYTES_PER_GIB), 5);
  assert.equal(bytesToGiB(-1), 0);
});

test('total usage sums upload and download exactly once', () => {
  assert.equal(getTotalUsedGB({ uploadUsedGB: 2.5, downloadUsedGB: 7.5, trafficUsedGB: 99 }), 10);
  assert.equal(getTotalUsedGB({ trafficUsedGB: 12.25 }), 12.25);
  assert.equal(getTotalUsedGB({ uploadUsedGB: 'bad', downloadUsedGB: 3 }), 3);
});
