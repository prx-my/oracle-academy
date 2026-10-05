'use strict';

const assert = require('assert');
const crypto = require('crypto');
const oa = require('../src');
const db = require('../src/default-browser');

assert.strictEqual(typeof oa.launch, 'function');
assert.strictEqual(typeof oa.login, 'function');
assert.strictEqual(typeof oa.dumpPage, 'function');

assert.ok(oa.isSignonUrl('https://signon.oracle.com/signin'));
assert.ok(oa.isSignonUrl('https://idcs-abc.identity.oraclecloud.com/ui/v1/signin'));
assert.ok(!oa.isSignonUrl('https://academy.oracle.com/pls/f?p=62000'));

assert.ok(oa.isAcademyUrl('https://academy.oracle.com/pls/f?p=62000'));
assert.ok(!oa.isAcademyUrl('https://signon.oracle.com/signin'));

assert.match(oa.HUB_URL, /academy\.oracle\.com/);
assert.match(oa.STUDENT_HUB_URL, /p=63000/);
assert.match(oa.MEMBER_HUB_URL, /p=62000/);

// Chromium cookie decryption round-trip (v10 + sha256(host) prefix).
{
  const key = crypto.randomBytes(16);
  const host = 'academy.oracle.com';
  const plain = 'SESSION12345';
  const prefix = crypto.createHash('sha256').update(host).digest();
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const ct = Buffer.concat([cipher.update(Buffer.concat([prefix, Buffer.from(plain)])), cipher.final()]);
  const enc = Buffer.concat([Buffer.from('v10'), ct]).toString('hex');
  assert.strictEqual(db.decryptChromiumValue(enc, host, key), plain);
  assert.strictEqual(db.decryptChromiumValue('', host, key), '');
}

assert.strictEqual(db.chromeTimeToUnix('13348540800000000'), 1704067200);
assert.strictEqual(db.chromeTimeToUnix(0), -1);
assert.strictEqual(db.sameSiteFromChromium(0), 'None');
assert.strictEqual(db.sameSiteFromChromium(1), 'Lax');
assert.strictEqual(db.sameSiteFromChromium(2), 'Strict');
assert.strictEqual(db.sameSiteFromChromium(-1), undefined);

console.log('smoke: ok');
