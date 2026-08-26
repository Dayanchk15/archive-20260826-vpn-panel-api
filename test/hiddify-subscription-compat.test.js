import assert from 'node:assert/strict';
import {
  applyHiddifyFragmentCompatibility,
  isHiddifySubscriptionRequest,
  resolveHiddifyFragmentation,
} from '../lib/hiddify-subscription-compat.js';

assert.equal(isHiddifySubscriptionRequest('HiddifyNext/2.5.7', ''), true);
assert.equal(resolveHiddifyFragmentation({}, 'HiddifyNext/2.5.7').packets, 'tlshello');
assert.equal(resolveHiddifyFragmentation({}, 'HiddifyNextX/2.5.7').packets, 'tlshello');

const out = applyHiddifyFragmentCompatibility(
  'vless://u@1.2.3.4:443?security=tls&type=ws&path=%2F&host=a.example&sni=a.example#TE',
  {},
  'HiddifyNext/2.5.7'
);
assert.match(out, /#enable-fragment:\s*true/i);
assert.match(out, /fragment=2%2C0-1%2Ctlshello|fragment=2,0-1,tlshello/);

console.log('hiddify-subscription-compat.test.js OK');
