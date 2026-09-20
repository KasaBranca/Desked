#!/usr/bin/env node
/**
 * Cloudflare Tunnel supervisor.
 *
 * Launches cloudflared (Quick Tunnel by default, named tunnel when
 * TUNNEL_TOKEN is set) and, once the public URL is known, prints it together
 * with a TinyURL short URL and (on a TTY) a QR code.
 *
 * Because this prints through stdout, the URL is also captured when the
 * tunnel is started with output redirected to cloudflare.log by the VBS
 * launchers or the scheduled task.
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const envStore = require('../lib/env-store');
const { TRY_CLOUDFLARE_RE, announceTunnelUrl } = require('../lib/tunnel-url');
const { watchParent } = require('../lib/parent-watch');

require('dotenv').config({ path: envStore.ENV_PATH });

const ROOT = envStore.ROOT;
const CLOUDFLARED = path.join(ROOT, 'cloudflared.exe');
const port = process.env.PORT || '3389';
const token = process.env.TUNNEL_TOKEN || '';

const args = token
  ? ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run', '--token', token]
  : ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`];

const child = spawn(CLOUDFLARED, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

// cloudflared is extremely chatty at INF level. In an interactive terminal show
// only warnings/errors (plus the URL announcement below); when the output is
// redirected (e.g. to cloudflare.log) keep the full log for diagnostics.
const quiet =
  process.env.DESKED_TUNNEL_VERBOSE === '1'
    ? false
    : process.env.DESKED_TUNNEL_QUIET === '1' || Boolean(process.stdout.isTTY);
let announced = false;

function handleData(data, out) {
  const text = data.toString();
  if (!announced) {
    const match = text.match(TRY_CLOUDFLARE_RE);
    if (match) {
      announced = true;
      announceTunnelUrl(match[0]).catch(() => {});
    }
  }
  if (!quiet) {
    out.write(text);
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    if (line && /\b(WRN|ERR|FTL)\b/.test(line)) out.write(`${line}\n`);
  }
}

child.stdout.on('data', (data) => handleData(data, process.stdout));
child.stderr.on('data', (data) => handleData(data, process.stderr));

child.on('error', (err) => {
  console.error(`[Desked] Failed to start cloudflared: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code == null ? 0 : code);
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try { child.kill(); } catch (_) {}
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Closing the terminal on Windows raises SIGHUP (CTRL_CLOSE_EVENT).
process.on('SIGHUP', () => {
  shutdown();
  process.exit(0);
});
process.on('exit', shutdown);
// If the launcher dies abruptly (no signal), stop cloudflared with it.
watchParent(() => {
  console.error('[Desked] Launcher exited; stopping cloudflared.');
  shutdown();
  process.exit(0);
});
