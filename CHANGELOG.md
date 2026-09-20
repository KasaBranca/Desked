# Changelog

All notable changes to Desked are documented here.

## [1.7.0]

### Added
- System audio streaming to the browser. The default speakers are captured
  through **WASAPI loopback** (via `koffi`, no virtual audio cable or Stereo Mix
  required), encoded to **Opus** with FFmpeg, and played with the WebCodecs
  `AudioDecoder` + WebAudio. Includes a toolbar mute toggle.
- `AUDIO_ENABLED` (default on) and `AUDIO_BITRATE` (default 96 kbps) settings.
- `lib/wasapi-loopback.js`, `lib/ogg-opus.js`, `lib/audio-stream.js`, and the
  browser `public/js/audio-player.js`.

## [1.6.1]

### Fixed
- `npm start` and `npm run setup` now remove the legacy hidden Startup
  launchers (`RemoteDesktop.vbs` / `Desked.vbs`). They started node and
  cloudflared detached at logon, so they never stopped when the terminal
  closed.

## [1.6.0]

### Added
- The server and tunnel now exit together with the launcher: closing the
  terminal (or the CLI/shell process dying abruptly) stops `node` and
  `cloudflared` instead of leaving them running. Implemented with a parent
  watchdog plus `SIGHUP` handling.

### Changed
- cloudflared's verbose `INF` output is hidden in an interactive terminal
  (warnings, errors, the public URL, the short URL, and the QR code are still
  shown). Redirected output such as `cloudflare.log` keeps the full log. Set
  `DESKED_TUNNEL_VERBOSE=1` to force the full output in a terminal.

## [1.5.2]

### Fixed
- `npm start` now automatically re-executes itself after a self-update so the
  new code (and the shared tunnel supervisor) takes effect immediately, instead
  of continuing to run the old in-memory code until a manual restart.

## [1.5.1]

### Fixed
- The startup short URL never appeared for Quick Tunnels. TinyURL (and is.gd,
  v.gd, da.gd) reject `trycloudflare.com`, and the tunnel is launched by the
  VBS/scheduled-task launchers rather than `cli.js`. The shortener now falls
  back across several no-key providers, and the tunnel is started through a
  shared supervisor (`scripts/tunnel.js`) that prints the public URL and short
  URL wherever it runs, including `cloudflare.log`.

### Added
- `scripts/tunnel.js`, a Cloudflare Tunnel supervisor shared by `npm start`,
  the VBS launchers, and the scheduled task.

## [1.5.0]

### Added
- `npm start` now also prints a shortened URL for the Cloudflare Tunnel URL.

### Changed
- Rewrote the README in English.

## [1.4.1]

### Changed
- Removed the drop shadow from the login card.

## [1.4.0]

### Security
- Actually bind to `HOST` (`server.listen(port, host)`). Default is now
  `127.0.0.1` so Desked is only reachable through the local Cloudflare Tunnel;
  set `HOST=0.0.0.0` for direct LAN access.

### Changed
- Updates now prefer a **GitHub Release** asset and verify its SHA-256 against
  the release's `SHA256SUMS` (falling back to the main-branch archive with a
  version check when no release exists).
- Updates are staged: download to a temp dir, verify the version and syntax,
  back up the current sources, apply, then `npm install`; on failure the previous
  version is restored.
- `npm install` failures during update are now reported (previously ignored).

### Added
- Release workflow that publishes `desked-<tag>.zip` + `SHA256SUMS` on `v*` tags.

## [1.3.1]

### Changed
- Disable browser credential autofill on the login field (`autocomplete="off"`).
- Add an in-app warning when the page is served over plain HTTP (Chrome flags
  passwords submitted over HTTP as compromised). Use the HTTPS tunnel URL.
- Send `Strict-Transport-Security` (HSTS) on HTTPS responses.

## [1.3.0]

### Changed
- Redesigned the UI as a **Material 3 light theme** (Roboto, M3 color roles,
  shape scale, elevation, state layers).
- Removed all gradients, including the animated login background orbs.

## [1.2.0]

### Added
- On `npm start`, check GitHub for a newer version and offer to update.
  If the user answers yes, Desked runs `git pull --ff-only` (or downloads and
  overlays the latest archive for non-git installs) and then `npm install`.
- `npm run update` to check and update on demand (`--yes`, `--no-update-check`).
- `--no-update-check` flag / `DESKED_NO_UPDATE_CHECK=1` environment variable.

## [1.1.0]

### Security
- Upgrade `ws` to `>= 8.21.3` (fixes the tiny-fragment memory-exhaustion DoS)
  and cap inbound WebSocket payloads at 64 KB.
- Hash passwords with salted scrypt (`PASSWORD_HASH`); never store plaintext.
  Legacy plaintext `PASSWORD` is still accepted and migrated in memory.
- Revoke the server-side session token on logout.
- Trust `CF-Connecting-IP` / `X-Forwarded-For` for the lockout key only when the
  peer is loopback (cloudflared / local proxy), preventing XFF spoofing of rate limits.
- Add a strict Content-Security-Policy and related security headers.
- Pin `cloudflared` to a release and verify its SHA-256 before running it.
- Update `sharp` to 0.35.x and remove the unused `werift` dependency.

### Added
- CLI setup (`npm run setup`) with Quick Tunnel default and optional named tunnel.
- `npm run password` to change the password from the CLI (`--password-stdin` supported).
- QR code for the Quick Tunnel URL on startup.
- Unit tests (`npm test`) and Windows GitHub Actions CI with `npm ci`.
- `SECURITY.md`, `CHANGELOG.md`, and an MIT `LICENSE`.
- Dependabot configuration.

### Changed
- Align default settings across `.env.example`, `config.js`, and the README.
- Auto-select the H.264 encoder (NVENC > QSV > AMF > libx264) when `H264_ENCODER` is empty.

## [1.0.0]

- Initial release: H.264/WebCodecs remote desktop over WebSocket, Windows input
  injection via `koffi`, JPEG fallback, password auth with lockout, and
  Cloudflare Tunnel support.
