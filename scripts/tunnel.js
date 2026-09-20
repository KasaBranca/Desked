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

require('dotenv').config({ path: envStore.ENV_PATH });

const ROOT = envStore.ROOT;
const CLOUDFLARED = path.join(ROOT, 'cloudflared.exe');
const port = process.env.PORT || '3389';
const token = process.env.TUNNEL_TOKEN || '';

const args = token
  ? ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run', '--token', token]
  : ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`];

const child = spawn(CLOUDFLARED, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

let announced = false;
const scan = (data) => {
  if (announced) return;
  const match = data.toString().match(TRY_CLOUDFLARE_RE);
  if (!match) return;
  announced = true;
  announceTunnelUrl(match[0]).catch(() => {});
};
child.stdout.on('data', scan);
child.stderr.on('data', scan);

child.on('error', (err) => {
  console.error(`[Desked] Failed to start cloudflared: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code == null ? 0 : code);
});

const shutdown = () => {
  try { child.kill(); } catch (_) {}
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
