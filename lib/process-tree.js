/**
 * Windows process-tree helpers used by `desked restart`.
 *
 * The server is normally launched from a shell (PowerShell/cmd). Restarting by
 * only killing node.exe leaves that shell and its process tree on screen, so
 * every restart piles up another window. These helpers find the shell that
 * launched the running server so it can be closed together with its children.
 */
'use strict';

const { spawnSync } = require('child_process');

/**
 * Shells that can own a console window. Only these are ever terminated, so a
 * stale discovery can never take down explorer.exe / svchost.exe / services.
 */
const SHELL_LAUNCHER_NAMES = new Set([
  'powershell.exe',
  'pwsh.exe',
  'cmd.exe',
  'wt.exe',
  'windowsterminal.exe',
]);

/** Parse `PID<TAB>PPID<TAB>Name<TAB>CommandLine` lines into a Map. */
function parseProcessTable(text) {
  const table = new Map();
  if (!text) return table;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    table.set(pid, {
      parent: Number.isInteger(ppid) ? ppid : 0,
      name: String(parts[2] || '').toLowerCase(),
      commandLine: parts.slice(3).join('\t'),
    });
  }
  return table;
}

/** Snapshot of running processes: pid -> { parent, name, commandLine }. */
function getProcessTable() {
  if (process.platform !== 'win32') return new Map();
  const script =
    'Get-CimInstance Win32_Process | ' +
    'ForEach-Object { @($_.ProcessId, $_.ParentProcessId, $_.Name, $_.CommandLine) -join [char]9 }';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || !result.stdout) return new Map();
  return parseProcessTable(result.stdout);
}

/** The process and every ancestor, nearest first, stopping at cycles. */
function ancestorPids(pid, table) {
  const chain = [];
  const seen = new Set();
  let cur = pid;
  while (cur && cur > 0 && !seen.has(cur)) {
    seen.add(cur);
    const info = table.get(cur);
    if (!info) break;
    chain.push(cur);
    cur = info.parent;
  }
  return chain;
}

/** Nearest shell ancestor of `pid` (the window that launched it), or null. */
function findLauncherPid(pid, table) {
  let cur = pid;
  const seen = new Set();
  while (cur && cur > 0 && !seen.has(cur)) {
    seen.add(cur);
    const info = table.get(cur);
    if (!info) return null;
    if (info.name === 'cmd.exe') {
      const parent = table.get(info.parent);
      // npm runs package scripts through a transient `cmd.exe /d /s /c ...`
      // wrapper. That is not the user's window, so keep walking up to the real
      // interactive shell above npm.
      if (!parent || parent.name !== 'node.exe') return cur;
    } else if (SHELL_LAUNCHER_NAMES.has(info.name)) {
      return cur;
    }
    cur = info.parent;
  }
  return null;
}

/** True when the entry looks like a Desked `node server.js` process. */
function isDeskedServer(entry) {
  if (!entry) return false;
  if (!/^node(\.exe)?$/.test(entry.name)) return false;
  return /server\.js/i.test(entry.commandLine || '');
}

module.exports = {
  SHELL_LAUNCHER_NAMES,
  parseProcessTable,
  getProcessTable,
  ancestorPids,
  findLauncherPid,
  isDeskedServer,
};
