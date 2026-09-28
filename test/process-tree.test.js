const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseProcessTable,
  ancestorPids,
  findLauncherPid,
  isDeskedServer,
} = require('../lib/process-tree');

function tableFrom(rows) {
  const text = rows
    .map(([pid, ppid, name, cmd]) => [pid, ppid, name, cmd || ''].join('\t'))
    .join('\n');
  return parseProcessTable(text);
}

test('parseProcessTable keeps pid, parent, name and command line', () => {
  const table = tableFrom([
    [100, 1, 'explorer.exe', 'C:\\Windows\\explorer.exe'],
    [500, 400, 'node.exe', '"C:\\node\\node.exe" server.js'],
  ]);
  assert.equal(table.size, 2);
  assert.deepEqual(table.get(500), {
    parent: 400,
    name: 'node.exe',
    commandLine: '"C:\\node\\node.exe" server.js',
  });
});

test('ancestorPids walks to the root, nearest first', () => {
  const table = tableFrom([
    [100, 1, 'explorer.exe'],
    [200, 100, 'powershell.exe'],
    [300, 200, 'node.exe', 'npm-cli.js run restart'],
    [500, 300, 'node.exe', 'server.js'],
  ]);
  assert.deepEqual(ancestorPids(500, table), [500, 300, 200, 100]);
});

test('findLauncherPid returns the nearest shell, not the terminal host', () => {
  const table = tableFrom([
    [100, 1, 'explorer.exe'],
    [50, 100, 'windowsterminal.exe'],
    [200, 50, 'powershell.exe'],
    [300, 200, 'node.exe', 'npm-cli.js run start'],
    [500, 300, 'node.exe', 'server.js'],
  ]);
  assert.equal(findLauncherPid(500, table), 200);
});

test('findLauncherPid handles a server started directly from cmd', () => {
  const table = tableFrom([
    [100, 1, 'explorer.exe'],
    [200, 100, 'cmd.exe'],
    [500, 200, 'node.exe', 'server.js'],
  ]);
  assert.equal(findLauncherPid(500, table), 200);
});

test("findLauncherPid skips npm's transient cmd wrapper", () => {
  const table = tableFrom([
    [100, 1, 'explorer.exe'],
    [200, 100, 'powershell.exe'],
    [700, 200, 'node.exe', 'npm-cli.js run restart'],
    [800, 700, 'cmd.exe', 'cmd.exe /d /s /c node cli.js restart'],
    [900, 800, 'node.exe', 'cli.js restart'],
    [500, 900, 'node.exe', 'server.js'],
  ]);
  assert.equal(findLauncherPid(500, table), 200);
});

test('findLauncherPid returns null when no shell is involved', () => {
  const table = tableFrom([[500, 1, 'node.exe', 'server.js']]);
  assert.equal(findLauncherPid(500, table), null);
});

test('isDeskedServer matches node server.js only', () => {
  const table = tableFrom([
    [400, 1, 'node.exe', '"C:\\node\\node.exe" cli.js start'],
    [500, 400, 'node.exe', '"C:\\node\\node.exe" server.js'],
    [600, 1, 'chrome.exe', 'chrome.exe'],
  ]);
  assert.equal(isDeskedServer(table.get(500)), true);
  assert.equal(isDeskedServer(table.get(400)), false);
  assert.equal(isDeskedServer(table.get(600)), false);
  assert.equal(isDeskedServer(undefined), false);
});
