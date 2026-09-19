/**
 * Install Desked as an elevated Windows Scheduled Task.
 *
 * WHY Task Scheduler instead of the Startup folder?
 * The server must run at High Integrity Level to bypass Windows UIPI.
 * UIPI blocks mouse_event / keybd_event / SendInput from reaching elevated
 * processes (e.g. Task Manager) when the injecting process has a lower IL.
 * Task Scheduler's RunLevel=Highest grants a High IL token without a UAC
 * prompt on every boot.
 *
 * Usage (run as Administrator):
 *   npm run install-service
 */
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const projectDir = path.resolve(__dirname, '..');
const psScript   = path.join(__dirname, 'create-task.ps1');
const startupFolder = path.join(
  process.env.APPDATA,
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'
);
const oldStartupVbs = path.join(startupFolder, 'RemoteDesktop.vbs');
const legacyStartupVbs = path.join(startupFolder, 'Desked.vbs');

console.log('[*] Installing Desked as an elevated Scheduled Task...');
console.log('    (High Integrity Level — bypasses UIPI for Task Manager input)');
console.log('');

// Remove legacy Startup-folder VBS if it exists (it runs at Medium IL)
for (const vbs of [oldStartupVbs, legacyStartupVbs]) {
  if (fs.existsSync(vbs)) {
    try {
      fs.unlinkSync(vbs);
      console.log(`[-] Removed legacy Startup shortcut: ${vbs}`);
    } catch (e) {
      console.warn(`[!] Could not remove legacy shortcut: ${e.message}`);
    }
  }
}

// Run the PowerShell task-creation script
try {
  execSync(
    `powershell.exe -ExecutionPolicy Bypass -NonInteractive -File "${psScript}"`,
    { stdio: 'inherit', cwd: projectDir }
  );
} catch (err) {
  console.error('');
  console.error('[!] Failed to register scheduled tasks.');
  console.error('    Make sure you are running this command as Administrator:');
  console.error('    Right-click your terminal → "Run as administrator", then npm run install-service');
  process.exit(1);
}
