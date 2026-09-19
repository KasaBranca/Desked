/**
 * Uninstall Desked scheduled tasks and cleanup.
 *
 * Removes:
 *   - DeskedServer / DeskedTunnel          (Task Scheduler)
 *   - RemoteDesktopServer / RemoteDesktopTunnel (legacy Task Scheduler)
 *   - Legacy Startup-folder VBS shortcut (if present)
 */
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const startupFolder = path.join(
  process.env.APPDATA,
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'
);
const legacyStartupVbs = [
  path.join(startupFolder, 'Desked.vbs'),
  path.join(startupFolder, 'RemoteDesktop.vbs'),
];

// 1. Remove scheduled tasks (current + legacy names)
const tasks = ['DeskedServer', 'DeskedTunnel', 'RemoteDesktopServer', 'RemoteDesktopTunnel'];
for (const task of tasks) {
  try {
    execSync(
      `powershell.exe -Command "Unregister-ScheduledTask -TaskName '${task}' -Confirm:$false -ErrorAction SilentlyContinue"`,
      { stdio: 'pipe' }
    );
    console.log(`[-] Removed scheduled task: ${task}`);
  } catch {
    console.log(`[i] Task not found (already removed?): ${task}`);
  }
}

// 2. Remove legacy Startup-folder VBS if present
for (const vbs of legacyStartupVbs) {
  if (fs.existsSync(vbs)) {
    try {
      fs.unlinkSync(vbs);
      console.log(`[-] Removed legacy Startup shortcut: ${vbs}`);
    } catch (e) {
      console.warn(`[!] Could not remove: ${e.message}`);
    }
  }
}

console.log('');
console.log('  ✅ Desked will no longer start automatically.');
console.log('');
