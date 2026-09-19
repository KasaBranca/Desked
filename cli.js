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
  ensureEnv();

  const opts = parseFlags(argv);
  const hadEnv = fs.existsSync(envStore.ENV_PATH);

  console.log('');
  console.log('Desked setup');
  console.log('============');
  console.log('');

  // 1. Password
  let password = opts.password;
  if (password) {
    const error = validatePassword(password);
    if (error) fail(error);
  } else if (opts.yes) {
    fail('--yes requires --password <value>.');
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
  const port = process.env.PORT || '3389';
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
    const args = token
      ? ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run', '--token', token]
      : ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`];
    console.log(`[Desked] Starting ${token ? 'named' : 'Quick'} Tunnel...`);
    tunnel = spawn(CLOUDFLARED, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    let urlPrinted = false;
    const scan = (data) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match && !urlPrinted) {
        urlPrinted = true;
        console.log('');
        console.log(`  Public URL: ${match[0]}`);
        console.log('');
      }
    };
    tunnel.stdout.on('data', scan);
    tunnel.stderr.on('data', scan);
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
  let password = opts.password;
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
  console.log('  install      Register the elevated Windows scheduled tasks');
  console.log('  uninstall    Remove the scheduled tasks');
  console.log('  help         Show this help');
  console.log('');
  console.log('Setup options (skip the prompts):');
  console.log('  --password <value>   Set the login password');
  console.log('  --quick              Force Quick Tunnel (default)');
  console.log('  --token <value>      Use a named tunnel with this Cloudflare token');
  console.log('  --port <number>      Server port (default 3389)');
  console.log('  --yes                Non-interactive (requires --password)');
  console.log('  --no-download        Do not auto-download cloudflared.exe');
  console.log('');
  console.log('Tip: use "npm run setup", "npm start", "npm run password".');
  console.log('');
}

function parseFlags(argv) {
  const opts = { password: '', token: '', port: '', quick: false, yes: false, noDownload: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--password') opts.password = next() || '';
    else if (arg === '--token') opts.token = next() || '';
    else if (arg === '--port') opts.port = next() || '';
    else if (arg === '--quick') opts.quick = true;
    else if (arg === '--yes' || arg === '-y') opts.yes = true;
    else if (arg === '--no-download') opts.noDownload = true;
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
