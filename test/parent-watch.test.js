const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { isProcessAlive, watchParent } = require('../lib/parent-watch');

test('isProcessAlive distinguishes live and dead processes', async () => {
  assert.equal(isProcessAlive(process.pid), true);

  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(isProcessAlive(child.pid), true);

  const exited = new Promise((resolve) => child.on('exit', resolve));
  child.kill();
  await exited;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(isProcessAlive(child.pid), false);
});

test('watchParent fires once when the watched process is gone', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  await new Promise((resolve) => setTimeout(resolve, 400));

  let fired = 0;
  const done = new Promise((resolve) => {
    watchParent(
      () => {
        fired += 1;
        resolve();
      },
      { pid: child.pid, intervalMs: 50, unref: false }
    );
  });

  assert.equal(fired, 0);
  const exited = new Promise((resolve) => child.on('exit', resolve));
  child.kill();
  await exited;

  await done;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(fired, 1);
});

test('watchParent is a no-op for the current process', () => {
  assert.equal(watchParent(() => {}, { pid: process.pid }), null);
});
