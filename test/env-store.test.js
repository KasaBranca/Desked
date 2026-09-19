const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desked-test-'));
process.env.DESKED_ENV_PATH = path.join(tmpDir, '.env');
process.env.DESKED_ENV_EXAMPLE = path.join(tmpDir, '.env.example');

const envStore = require('../lib/env-store');

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('setMany appends new keys and updates existing ones', () => {
  envStore.setMany({ FOO: 'bar', PORT: '8787' });
  assert.strictEqual(envStore.get('FOO'), 'bar');
  assert.strictEqual(envStore.get('PORT'), '8787');

  envStore.set('FOO', 'baz');
  assert.strictEqual(envStore.get('FOO'), 'baz');
  assert.strictEqual(envStore.get('PORT'), '8787');
});

test('special characters are quoted and round-trip', () => {
  const value = 'p#ss word"with\'quotes';
  envStore.set('SECRET', value);
  assert.match(envStore.read(), /^SECRET=".*"$/m);
  assert.strictEqual(envStore.get('SECRET'), value);
});

test('hashed values survive the writer', () => {
  const stored = 'scrypt$16384$8$1$c2FsdA==$aGFzaA==';
  envStore.set('PASSWORD_HASH', stored);
  assert.strictEqual(envStore.get('PASSWORD_HASH'), stored);
});
