# Changelog

All notable changes to Desked are documented here.

## [1.9.4]

### Fixed
- Severe latency while watching fast motion (games, full-screen video). The
  browser buffered 4–12 decoded frames before painting and replayed that stale
  backlog over the live stream. The H.264 renderer now draws the newest decoded
  frame and discards the rest, so motion stays in sync with the network.
- Blocky "noise" during fast motion. The hardware H.264 encoders were capped at
  2–4 Mbps, far too low for 720p24 game/video content; the cap is now 8 Mbps
  (NVENC/QSV/AMF/libx264) and QSV runs with `async_depth 1` for lower latency.
- Garbage frames after a slow client fell behind. When the WebSocket send
  buffer filled, the server dropped individual P-frames, breaking the H.264
  reference chain until the next keyframe. It now stops at the last decodable
  frame and resumes cleanly on the next keyframe.
- The decoder and its pending queue dropped individual chunks (GOP holes) while
  resyncing. Both now discard the whole backlog and wait for a keyframe.

## [1.9.3]

### Changed
- The mobile bottom text field now reuses the login password field's V2 pill
  (`input-group`) and gets the same liquid-metal rim on focus. The BS/Enter/Send
  buttons are kept on their own layer above the field's bloom.

## [1.9.2]

### Fixed
- The login connection status ("Connecting…"/"Connected") was painted over by
  the liquid-metal field's bloom on focus. The status is no longer static, so
  it now sits on its own layer above the field's overhanging iframe instead of
  being clipped by it.

## [1.9.1]

### Fixed
- Content-Security-Policy violations on the login screen. The pixel-grid
  loader delays and the audio button's hidden state are now CSS classes
  instead of inline `style` attributes, and the liquid-metal adapter is baked
  into `liquid-metal-button.html` instead of being injected at runtime.
- The liquid-metal rim rendered as a thick white pill: the embed's document
  now paints the card's surface color so the iframe's base canvas no longer
  shows through the rim's overhang, and the bloom is toned down for the
  smaller field.
- Added a data-URI favicon (removes the `/favicon.ico` 404).

## [1.9.0]

### Added
- Liquid-metal rim on the login password field, ported from the V2 search
  form. The canonical `LiquidMetalButton` is served same-origin as
  `public/liquid-metal-button.html` and embedded in an iframe that reveals the
  travelling chrome edge on focus; `public/js/liquid-metal.js` adapts the
  geometry and tames the bloom.
- The V2 top-page halftone-flow WebGL background (`public/js/halftone-flow.js`)
  behind the login card, reproduced from the canonical shader.

### Changed
- The password field and its submit button are now a single V2-style pill
  (input + button inside one rim) instead of a field plus a detached button.
- The login card no longer shows the gradient hairline at its top edge.
- `/liquid-metal-button.html` is served with a relaxed script/style CSP and
  `X-Frame-Options: SAMEORIGIN` so the app can frame it; all other routes keep
  the strict policy and `DENY`.

## [1.8.0]

### Added
- `npm run restart` (`node cli.js restart`). It checks for an update first
  (the only prompt) and then restarts **unattended**: it bounces the
  `DeskedServer` / `DeskedTunnel` scheduled tasks when they are installed, or
  stops the running server and starts it again in the current terminal
  otherwise. Pass `--no-update-check` to skip the version check.

### Changed
- The web UI now uses the V2 "Framer-inspired" dark design system: the Inter
  typeface, `#090909` surfaces with hairline borders, pill-shaped fields with
  an accent focus glow, glass toolbars/overlays, a gradient card hairline and
  the pixel-grid loader. Markup and behavior are unchanged.

## [1.7.1]

### Fixed
- The mobile text-input row overflowed on narrow phones, pushing the **Send**
  button outside the card. The input now shrinks (`min-width: 0`) and the
  action buttons are compacted on screens up to 400 px wide.

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
