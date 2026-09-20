#!/usr/bin/env node
/**
 * Desked CLI
 *
 *   node cli.js setup       Interactive setup (password + tunnel mode)
 *   node cli.js start       Start the server and the tunnel (Quick Tunnel by default)
 *   node cli.js password    Change the password in .env
 *   node cli.js install     Register the elevated Windows scheduled tasks
 *   node cli.js uninstall   Remove the scheduled tasks
 *
 * Quick Tunnel is the default: leave TUNNEL_TOKEN empty and a temporary
 * https://<random>.trycloudflare.com URL is created on every start.
 * Set a token (setup option 2) for a stable named tunnel.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { Readable } = require('stream');
const { spawn, spawnSync } = require('child_process');
const envStore = require('./lib/env-store');
const passwordUtil = require('./lib/password');

const ROOT = envStore.ROOT;
const CLOUDFLARED = path.join(ROOT, 'cloudflared.exe');
// Pin the release and verify its SHA-256 (from the GitHub release notes) so we
// never execute whatever "latest" currently points at. Windows on ARM runs the
// amd64 build under emulation; Cloudflare does not ship a Windows arm64 build.
const CLOUDFLARED_VERSION = '2026.9.1';
const CLOUDFLARED_SHA256 = '2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712';
const CLOUDFLARED_URL =
  `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe`;

// Update check / self-update
const REPO_SLUG = 'KasaBranca/Desked';
// Prefer the GitHub API: raw.githubusercontent is CDN-cached and can report a
// stale version for several minutes after a push.
const REMOTE_API_URL = `https://api.github.com/repos/${REPO_SLUG}/contents/package.json?ref=main`;
const REMOTE_PACKAGE_URL = `https://raw.githubusercontent.com/${REPO_SLUG}/main/package.json`;
const RELEASE_API_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
const ARCHIVE_URL = `https://github.com/${REPO_SLUG}/archive/refs/heads/main.zip`;
const GITHUB_HEADERS = {
  accept: 'application/vnd.github+json',
  'cache-control': 'no-cache',
  'user-agent': 'desked-cli',
};
const NPM_CMD = 'npm';
const UPDATE_EXCLUDES = new Set(['.env', 'cloudflared.exe', 'cloudflared.exe.download', 'node_modules', '.git', '.vscode']);

// ---------------------------------------------------------------- input helpers

function question(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

/** Read a line without echoing it (falls back to visible input when not a TTY). */
function questionHidden(query) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      question(query).then(resolve);
      return;
    }
    process.stdout.write(query);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (char) => {
      if (char === '\n' || char === '\r' || char === '\u0004') {
        cleanup();
        process.stdout.write('\n');
        resolve(value);
      } else if (char === '\u0003') {
        cleanup();
        process.stdout.write('\n');
        process.exit(130);
      } else if (char === '\u007f' || char === '\b') {
        value = value.slice(0, -1);
      } else if (char >= ' ') {
        value += char;
      }
    };
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

/** Read all of stdin (used by --password-stdin so secrets stay out of argv). */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.resume();
  });
}

async function resolvePasswordInput(opts) {
  if (opts.password) return opts.password;
  if (opts.passwordStdin) {
    const first = (await readStdin()).split(/\r?\n/)[0];
    return first;
  }
  return '';
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters.';
  }
  if (password.length > 200) return 'Password must be 200 characters or fewer.';
  if (/[\r\n]/.test(password)) return 'Password must not contain line breaks.';
  return null;
}

async function promptNewPassword() {
  for (;;) {
    const first = await questionHidden('New password (8+ characters): ');
    const error = validatePassword(first);
    if (error) {
      console.error(`  ! ${error}`);
      continue;
    }
    const confirm = await questionHidden('Confirm password: ');
    if (first !== confirm) {
      console.error('  ! Passwords do not match. Try again.');
      continue;
    }
    return first;
  }
}

// ---------------------------------------------------------------- cloudflared

async function downloadCloudflared() {
  console.log(`[Desked] Downloading cloudflared ${CLOUDFLARED_VERSION}...`);
  const res = await fetch(CLOUDFLARED_URL, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const tmp = `${CLOUDFLARED}.download`;
  const out = fs.createWriteStream(tmp);
  const hasher = crypto.createHash('sha256');
  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => hasher.update(chunk));
  await new Promise((resolve, reject) => {
    source.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    source.on('error', reject);
  });

  const digest = hasher.digest('hex');
  if (digest !== CLOUDFLARED_SHA256) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`checksum mismatch (expected ${CLOUDFLARED_SHA256}, got ${digest})`);
  }
  fs.renameSync(tmp, CLOUDFLARED);
  console.log(`[Desked] Verified SHA-256 and saved to ${CLOUDFLARED}`);
}

/** Ensure cloudflared.exe exists, offering to download it. Returns true when available. */
async function ensureCloudflared(opts = {}) {
  if (fs.existsSync(CLOUDFLARED)) return true;
  if (opts.noDownload) return false;

  if (!opts.assumeYes) {
    const answer = (await question('cloudflared.exe not found. Download it now (~65 MB)? [Y/n]: '))
      .trim()
      .toLowerCase();
    if (answer === 'n' || answer === 'no') return false;
  }

  try {
    await downloadCloudflared();
    return true;
  } catch (err) {
    console.error(`[Desked] Download failed: ${err.message}`);
    console.error('[Desked] Download manually: https://github.com/cloudflare/cloudflared/releases');
    return false;
  }
}

// ---------------------------------------------------------------- update check

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function getLocalVersion() {
  try {
    return require(path.join(ROOT, 'package.json')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function fetchLatestVersion() {
  const headers = {
    accept: 'application/vnd.github+json',
    'cache-control': 'no-cache',
    'user-agent': 'desked-cli',
  };

  try {
    const res = await fetch(`${REMOTE_API_URL}&t=${Date.now()}`, {
      signal: AbortSignal.timeout(4000),
      headers,
    });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.content === 'string') {
        const pkg = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
        if (typeof pkg.version === 'string') return pkg.version;
      }
    }
  } catch {
    // fall through to the raw fallback
  }

  try {
    const res = await fetch(`${REMOTE_PACKAGE_URL}?t=${Date.now()}`, {
      signal: AbortSignal.timeout(4000),
      headers: { 'cache-control': 'no-cache' },
    });
    if (!res.ok) return null;
    const pkg = await res.json();
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function runStep(description, command, args, opts = {}) {
  console.log(`[Desked] ${description}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (result.error) {
    console.error(`[Desked] ${description} failed: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`[Desked] ${description} exited with code ${result.status}`);
    return false;
  }
  return true;
}

function gitAvailable() {
  const probe = spawnSync('git', ['--version'], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}

async function fetchLatestRelease() {
  try {
    const res = await fetch(`${RELEASE_API_URL}?t=${Date.now()}`, {
      signal: AbortSignal.timeout(4000),
      headers: GITHUB_HEADERS,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function parseChecksums(text, assetName) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match && match[2].trim() === assetName) return match[1].toLowerCase();
  }
  return null;
}

async function downloadTo(url, dest) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const out = fs.createWriteStream(dest);
  const source = Readable.fromWeb(res.body);
  source.on('error', (err) => out.destroy(err));
  await new Promise((resolve, reject) => {
    source.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
  });
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** node --check the staged sources before touching the live install. */
function verifySourceSyntax(dir) {
  const files = [
    'server.js',
    'cli.js',
    'lib/auth.js',
    'lib/config.js',
    'lib/env-store.js',
    'lib/password.js',
    'lib/tunnel-url.js',
    'scripts/tunnel.js',
  ];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', path.join(dir, file)], { stdio: 'ignore' });
    if (result.error || result.status !== 0) {
      console.error(`[Desked] Syntax check failed for ${file}`);
      return false;
    }
  }
  return true;
}

/** Copy source files (excluding runtime/user data) from src to dest. */
function copyTree(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (UPDATE_EXCLUDES.has(entry.name)) continue;
    if (entry.name.endsWith('.log') || entry.name === 'debug_frame.jpg') continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyTree(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

/**
 * Download the update into a staging directory (never the live install).
 * Prefers a GitHub Release asset and verifies SHA-256 when a SHA256SUMS asset
 * is present; falls back to the main branch archive. Returns
 * { sourceDir, cleanup } or null.
 */
async function stageUpdate(expectedVersion) {
  const workDir = path.join(os.tmpdir(), `desked-update-${Date.now()}`);
  const zipPath = path.join(workDir, 'update.zip');
  const extractDir = path.join(workDir, 'extract');
  fs.mkdirSync(workDir, { recursive: true });
  const cleanup = () => fs.rmSync(workDir, { recursive: true, force: true });

  try {
    let downloadUrl = ARCHIVE_URL;
    let expectedSha = null;

    const release = await fetchLatestRelease();
    if (release && Array.isArray(release.assets)) {
      const zipAsset = release.assets.find((a) => /\.zip$/i.test(a.name));
      const sumsAsset = release.assets.find((a) => /sha256sums/i.test(a.name));
      if (zipAsset) {
        downloadUrl = zipAsset.browser_download_url;
        console.log(`[Desked] Downloading release ${release.tag_name}...`);
        if (sumsAsset) {
          const sumsRes = await fetch(sumsAsset.browser_download_url, {
            signal: AbortSignal.timeout(8000),
            headers: { 'cache-control': 'no-cache' },
          });
          if (sumsRes.ok) expectedSha = parseChecksums(await sumsRes.text(), zipAsset.name);
        }
      }
    }
    if (downloadUrl === ARCHIVE_URL) {
      console.log('[Desked] Downloading latest archive (main branch)...');
    }

    await downloadTo(downloadUrl, zipPath);

    if (expectedSha) {
      const actual = sha256File(zipPath);
      if (actual !== expectedSha) {
        throw new Error(`SHA-256 mismatch (expected ${expectedSha}, got ${actual})`);
      }
      console.log('[Desked] Verified SHA-256.');
    } else {
      console.warn('[Desked] No SHA256SUMS asset found; verified version only.');
    }

    console.log('[Desked] Extracting...');
    const expand = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`,
    ], { stdio: 'inherit' });
    if (expand.status !== 0) throw new Error('extraction failed');

    const entries = fs.readdirSync(extractDir, { withFileTypes: true });
    const sourceDir = entries.length === 1 && entries[0].isDirectory()
      ? path.join(extractDir, entries[0].name)
      : extractDir;

    const pkgPath = path.join(sourceDir, 'package.json');
    if (!fs.existsSync(pkgPath)) throw new Error('archive does not contain package.json');

    const stagedVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    if (expectedVersion && stagedVersion !== expectedVersion) {
      throw new Error(`archive version ${stagedVersion} does not match expected ${expectedVersion}`);
    }

    return { sourceDir, cleanup };
  } catch (err) {
    console.error(`[Desked] Update failed: ${err.message}`);
    cleanup();
    return null;
  }
}

function updateFromGit() {
  if (!runStep('Pulling latest changes (git)', 'git', ['pull', '--ff-only'])) {
    console.error('[Desked] git pull failed. Commit/stash local changes and retry, or re-download the repo.');
    return false;
  }
  if (!verifySourceSyntax(ROOT)) return false;
  if (!runStep('Installing dependencies', NPM_CMD, ['install'], { shell: true })) {
    console.error('[Desked] Dependency install failed.');
    return false;
  }
  return true;
}

async function updateFromArchive(expectedVersion) {
  const staged = await stageUpdate(expectedVersion);
  if (!staged) return false;

  if (!verifySourceSyntax(staged.sourceDir)) {
    staged.cleanup();
    return false;
  }

  const backupDir = path.join(os.tmpdir(), `desked-backup-${Date.now()}`);
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    copyTree(ROOT, backupDir); // snapshot the current sources

    copyTree(staged.sourceDir, ROOT); // apply the staged update

    if (!runStep('Installing dependencies', NPM_CMD, ['install'], { shell: true })) {
      console.error('[Desked] Dependency install failed. Rolling back...');
      copyTree(backupDir, ROOT);
      runStep('Restoring dependencies', NPM_CMD, ['install'], { shell: true });
      return false;
    }
    return true;
  } finally {
    fs.rmSync(backupDir, { recursive: true, force: true });
    staged.cleanup();
  }
}

async function performUpdate(expectedVersion) {
  const isGit = fs.existsSync(path.join(ROOT, '.git')) && gitAvailable();
  const ok = isGit ? updateFromGit() : await updateFromArchive(expectedVersion);
  if (!ok) return false;

  console.log('');
  console.log('[Desked] Update complete. Restart Desked to use the new version.');
  console.log('');
  return true;
}

/**
 * Check the latest version on GitHub and offer to update.
 * Fails silently when offline; only prompts on an interactive terminal.
 */
async function maybeOfferUpdate(opts = {}) {
  if (opts.noUpdateCheck || process.env.DESKED_NO_UPDATE_CHECK === '1') return;

  let latest;
  try {
    latest = await fetchLatestVersion();
  } catch {
    return;
  }
  if (!latest) return;

  const current = getLocalVersion();
  if (compareVersions(latest, current) <= 0) return;

  console.log('');
  console.log(`  Update available: ${current} -> ${latest}  (https://github.com/${REPO_SLUG})`);
  if (!process.stdin.isTTY) {
    console.log('  Run "npm run update" to update.');
    console.log('');
    return;
  }

  const answer = (await question('Update now? [y/N]: ')).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    console.log('  Skipped. Run "npm run update" at any time.');
    console.log('');
    return;
  }
  await performUpdate(latest);
}

// ---------------------------------------------------------------- .env helpers

function ensureEnv() {
  if (envStore.ensureFromExample()) {
    console.log('Created .env from .env.example.');
  }
}

function loadEnv() {
  require('dotenv').config({ path: envStore.ENV_PATH });
}

// ---------------------------------------------------------------- commands

async function cmdSetup(argv) {
  const hadEnv = fs.existsSync(envStore.ENV_PATH);
  ensureEnv();

  const opts = parseFlags(argv);

  console.log('');
  console.log('Desked setup');
  console.log('============');
  console.log('');

  // 1. Password
  let password = await resolvePasswordInput(opts);
  if (password) {
    const error = validatePassword(password);
    if (error) fail(error);
  } else if (opts.yes) {
    fail('--yes requires --password <value> or --password-stdin.');
  } else {
    const existing = envStore.get('PASSWORD_HASH') || envStore.get('PASSWORD');
    console.log(existing
      ? 'A password is already configured. Enter a new one.'
      : 'Set the password you will use to sign in.');
    password = await promptNewPassword();
  }

  // 2. Tunnel mode (Quick Tunnel is the default)
  let token = opts.token || '';
  if (opts.quick) token = '';
  if (!opts.quick && !opts.token && !opts.yes) {
    loadEnv();
    const currentToken = envStore.get('TUNNEL_TOKEN') || '';
    const currentLabel = currentToken ? 'Named Tunnel' : 'Quick Tunnel';
    console.log('');
    console.log('Tunnel mode:');
    console.log('  1) Quick Tunnel (default) - temporary https://<random>.trycloudflare.com URL');
    console.log('  2) Named Tunnel          - stable URL, requires a Cloudflare Tunnel token');
    const choice = (await question(`Choose 1 or 2 (current: ${currentLabel}) [1]: `)).trim();
    if (choice === '2') {
      token = (await question('Cloudflare Tunnel token: ')).trim();
      if (!token) {
        console.log('No token entered; using Quick Tunnel.');
      }
    } else {
      token = '';
    }
  }

  // 3. Port
  let port = opts.port;
  if (!port && !opts.yes) {
    const currentPort = envStore.get('PORT') || '3389';
    const answer = (await question(`Port [${currentPort}]: `)).trim();
    port = answer || currentPort;
  }
  if (!port) port = envStore.get('PORT') || '3389';

  envStore.setMany({
    HOST: envStore.get('HOST') || '0.0.0.0',
    PORT: port,
    PASSWORD: '',
    PASSWORD_HASH: passwordUtil.hash(password),
    TUNNEL_TOKEN: token,
  });

  console.log('');
  console.log(`Saved to ${envStore.ENV_PATH}`);
  console.log(`  Port:   ${port}`);
  console.log(`  Tunnel: ${token ? 'Named Tunnel' : 'Quick Tunnel (default)'}`);
  console.log('');

  await ensureCloudflared({ assumeYes: opts.yes, noDownload: opts.noDownload });
  console.log('');

  if (!hadEnv) {
    console.log('Next: npm start   (starts the server + tunnel; the public URL is printed)');
    console.log('      npm run install-service   (start automatically at logon, elevated)');
  } else {
    console.log('Restart the server for the change to take effect.');
  }
  console.log('');
}

async function cmdStart(argv) {
  if (!fs.existsSync(envStore.ENV_PATH) || (!envStore.get('PASSWORD_HASH') && !envStore.get('PASSWORD'))) {
    console.error('No password configured. Run: npm run setup');
    process.exit(1);
  }
  loadEnv();

  const opts = parseFlags(argv);
  await maybeOfferUpdate(opts);
  const token = process.env.TUNNEL_TOKEN || '';

  let hasCloudflared = fs.existsSync(CLOUDFLARED);
  if (!hasCloudflared) {
    hasCloudflared = await ensureCloudflared({ assumeYes: opts.yes, noDownload: opts.noDownload });
    if (!hasCloudflared && !opts.noDownload) {
      console.warn('[Desked] Running the server only (no tunnel).');
    }
  }

  console.log('[Desked] Starting server...');
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'inherit' });

  let tunnel = null;
  let shuttingDown = false;

  // If the server cannot start (e.g. port already in use), stop everything.
  server.on('exit', (code) => {
    if (shuttingDown) return;
    if (tunnel) {
      try { tunnel.kill(); } catch (_) {}
    }
    process.exit(code == null ? 1 : code);
  });

  if (!hasCloudflared) {
    console.warn(`[Desked] cloudflared.exe not found at ${CLOUDFLARED}`);
    console.warn('[Desked] Server only. Run "npm run setup" or download cloudflared:');
    console.warn('         https://github.com/cloudflare/cloudflared/releases');
  } else {
    console.log(`[Desked] Starting ${token ? 'named' : 'Quick'} Tunnel...`);
    // The supervisor prints the public URL, the short URL and a QR code, so
    // the same behavior is shared with the VBS/task launchers.
    const tunnelScript = path.join(ROOT, 'scripts', 'tunnel.js');
    tunnel = spawn(process.execPath, [tunnelScript], { cwd: ROOT, stdio: 'inherit' });
    tunnel.on('exit', (code) => {
      if (code !== 0 && code !== null) console.error(`[Desked] cloudflared exited with code ${code}`);
    });
  }

  const shutdown = () => {
    shuttingDown = true;
    if (tunnel) {
      try { tunnel.kill(); } catch (_) {}
    }
    try { server.kill(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdPassword(argv) {
  ensureEnv();
  const opts = parseFlags(argv);
  let password = await resolvePasswordInput(opts);
  if (!password && !opts.yes) {
    password = await promptNewPassword();
  }
  const error = validatePassword(password);
  if (error) fail(error);

  envStore.setMany({ PASSWORD: '', PASSWORD_HASH: passwordUtil.hash(password) });
  console.log(`Password updated in ${envStore.ENV_PATH}.`);
  console.log('Restart the server for the change to take effect.');
}

function cmdRunNodeScript(script) {
  const result = spawnSync(process.execPath, [script], { cwd: ROOT, stdio: 'inherit' });
  process.exit(result.status == null ? 1 : result.status);
}

async function cmdCheck() {
  const current = getLocalVersion();
  let latest = null;
  try {
    latest = await fetchLatestVersion();
  } catch {
    latest = null;
  }
  console.log(`Current version: ${current}`);
  console.log(`Latest version:  ${latest || 'unknown'}`);
  if (latest) {
    console.log(compareVersions(latest, current) > 0 ? 'Update available.' : 'Up to date.');
  }
}

async function cmdUpdate(argv) {
  const opts = parseFlags(argv);
  const current = getLocalVersion();
  let latest = null;
  try {
    latest = await fetchLatestVersion();
  } catch {
    latest = null;
  }

  if (latest) {
    console.log(`Current version: ${current}`);
    console.log(`Latest version:  ${latest}`);
    if (!opts.dryRun && compareVersions(latest, current) <= 0) {
      console.log('Already up to date.');
      return;
    }
  } else {
    console.log('Could not check the latest version; updating from the repository anyway.');
  }

  if (opts.dryRun) {
    console.log('Dry run: staging and verifying the update without applying it.');
    const staged = await stageUpdate(latest || undefined);
    if (!staged) return;
    const ok = verifySourceSyntax(staged.sourceDir);
    staged.cleanup();
    console.log(ok ? 'Dry run OK: staged update verified.' : 'Dry run failed.');
    return;
  }

  if (!opts.yes && process.stdin.isTTY) {
    const answer = (await question('Update now? [y/N]: ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      console.log('Cancelled.');
      return;
    }
  }
  await performUpdate(latest);
}

function printHelp() {
  console.log('');
  console.log('Desked CLI');
  console.log('');
  console.log('Usage: node cli.js <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  setup        Interactive setup: password + tunnel mode (Quick Tunnel default)');
  console.log('  start        Start the server and the tunnel, printing the public URL');
  console.log('  password     Change the password stored in .env');
  console.log('  update       Update to the latest version from GitHub');
  console.log('  check        Check whether a newer version is available');
  console.log('  install      Register the elevated Windows scheduled tasks');
  console.log('  uninstall    Remove the scheduled tasks');
  console.log('  help         Show this help');
  console.log('');
  console.log('Setup options (skip the prompts):');
  console.log('  --password <value>   Set the login password (visible in shell history)');
  console.log('  --password-stdin     Read the password from stdin (safer for scripts)');
  console.log('  --quick              Force Quick Tunnel (default)');
  console.log('  --token <value>      Use a named tunnel with this Cloudflare token');
  console.log('  --port <number>      Server port (default 3389)');
  console.log('  --yes                Non-interactive (requires --password or --password-stdin)');
  console.log('  --no-download        Do not auto-download cloudflared.exe');
  console.log('  --no-update-check    Skip the version check on start');
  console.log('  --dry-run            (update) Stage and verify without applying');
  console.log('');
  console.log('Tip: use "npm run setup", "npm start", "npm run password".');
  console.log('');
}

function parseFlags(argv) {
  const opts = { password: '', passwordStdin: false, token: '', port: '', quick: false, yes: false, noDownload: false, noUpdateCheck: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--password') opts.password = next() || '';
    else if (arg === '--password-stdin') opts.passwordStdin = true;
    else if (arg === '--token') opts.token = next() || '';
    else if (arg === '--port') opts.port = next() || '';
    else if (arg === '--quick') opts.quick = true;
    else if (arg === '--yes' || arg === '-y') opts.yes = true;
    else if (arg === '--no-download') opts.noDownload = true;
    else if (arg === '--no-update-check') opts.noUpdateCheck = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('--password=')) opts.password = arg.slice('--password='.length);
    else if (arg.startsWith('--token=')) opts.token = arg.slice('--token='.length);
    else if (arg.startsWith('--port=')) opts.port = arg.slice('--port='.length);
  }
  return opts;
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- entry point

async function main() {
  const [command, ...argv] = process.argv.slice(2);

  switch (command) {
    case 'setup':
      await cmdSetup(argv);
      break;
    case 'start':
      await cmdStart(argv);
      break;
    case 'password':
    case 'passwd':
      await cmdPassword(argv);
      break;
    case 'update':
      await cmdUpdate(argv);
      break;
    case 'check':
      await cmdCheck();
      break;
    case 'install':
    case 'install-service':
      cmdRunNodeScript('scripts/install-service.js');
      break;
    case 'uninstall':
    case 'uninstall-service':
      cmdRunNodeScript('scripts/uninstall-service.js');
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
