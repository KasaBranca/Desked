const test = require('node:test');
const assert = require('node:assert');

const password = require('../lib/password');

test('hash produces a scrypt record and verifies', () => {
  const stored = password.hash('correct horse battery staple');
  assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$[^$]+\$[^$]+$/);
  assert.ok(password.isHashed(stored));
  assert.ok(password.verify('correct horse battery staple', stored));
  assert.ok(!password.verify('wrong password', stored));
});

test('verify rejects missing or non-hashed values', () => {
  assert.ok(!password.verify('x', 'plaintext'));
  assert.ok(!password.verify('x', ''));
  assert.ok(!password.verify('x', null));
  assert.ok(!password.verify('x', undefined));
});

test('random salt makes identical passwords hash differently', () => {
  const a = password.hash('same-password');
  const b = password.hash('same-password');
  assert.notStrictEqual(a, b);
  assert.ok(password.verify('same-password', a));
  assert.ok(password.verify('same-password', b));
});
