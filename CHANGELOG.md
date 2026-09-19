# Changelog

All notable changes to Desked are documented here.

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
