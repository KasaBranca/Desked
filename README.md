# Desked

A self-hosted remote desktop web application that lets you control your home
Windows PC from a phone or PC browser while you are away.

## Features

- Low-latency H.264 streaming (FFmpeg; auto-selects NVENC / QSV / AMF / libx264, falls back to JPEG on failure)
- Mouse, keyboard, and multi-touch input, a virtual keyboard, and Ctrl / Alt / Ctrl+Alt+Del
- Password authentication, session tokens, and brute-force protection (attempt limit + lockout)
- Public access through Cloudflare Tunnel (defaults to an account-free **Quick Tunnel**)
- CLI-based setup (first password + Quick Tunnel)
- Material 3 (light theme) UI

## Setup (CLI)

```bash
npm install
npm run setup
```

`npm run setup` interactively configures the following and saves it to `.env`.

1. **First password** (8+ characters, confirmation required, input hidden)
2. **Tunnel mode** — defaults to **Quick Tunnel** (press Enter). Enter a named token only if you need a stable URL
3. **Port** (default 3389)

For non-interactive use (`--password` is visible in your shell history):

```bash
node cli.js setup --yes --password <password> --quick --port 3389

# Avoid shell history by passing the password via stdin
echo <password> | node cli.js setup --yes --password-stdin --quick --port 3389
```

### Start

```bash
npm start
```

This starts the server and the Cloudflare Tunnel together and prints the Quick
Tunnel public URL, a **shortened URL** (TinyURL), and a **QR code** you can scan
with your phone. Use `npm run start:server` to start the server only.

On startup Desked checks GitHub for the latest version and asks
`Update now? [y/N]` when an update exists (yes runs `git pull` / downloads the
archive, then `npm install`). To skip the check, pass `--no-update-check` or set
`DESKED_NO_UPDATE_CHECK=1`.

### CLI commands

| Command | Description |
|---------|-------------|
| `npm run setup` | Interactive setup (password, tunnel, port) |
| `npm start` | Start the server + tunnel and print the public/short URLs and QR code |
| `npm run password` | Change the password in `.env` (`--password-stdin` supported) |
| `npm run update` | Update to the latest version (verifies the GitHub Release SHA-256; `--yes` skips the prompt, `--no-update-check` disables the startup check) |
| `npm run check` | Only check whether an update is available |
| `npm run install-service` | Register an auto-start task with administrator privileges |
| `npm run uninstall-service` | Remove the auto-start task |

## Configuration (.env)

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | 127.0.0.1 | Bind address. Reachable only through the Cloudflare Tunnel (set `0.0.0.0` to also expose it on the LAN) |
| `PORT` | 3389 | Server port (change it if it conflicts with Windows RDP) |
| `PASSWORD_HASH` | (required) | scrypt hash. Set via `npm run setup` / `npm run password` (no plaintext is stored) |
| `TUNNEL_TOKEN` | (empty) | Empty uses a Quick Tunnel (default). Set a token to use a named tunnel |
| `CAPTURE_QUALITY` | 60 | Image quality (1-100) |
| `CAPTURE_SCALE` | 0.6667 | Capture resolution scale (0.1-1.0) |
| `TARGET_FPS` | 10 | Target frame rate for JPEG mode |
| `STREAM_MODE` | h264 | `h264` or `jpeg` |
| `H264_ENCODER` | (empty = auto) | Empty auto-selects NVENC > QSV > AMF > libx264. Set e.g. `h264_nvenc` to force one |
| `H264_TARGET_FPS` / `H264_CAPTURE_FPS` | 24 | Output / capture FPS |
| `H264_GOP` | 24 | Keyframe interval |
| `H264_CQ` | 28 | Quality (lower is better) |
| `SESSION_TIMEOUT_HOURS` | 24 | Session lifetime (hours) |
| `MAX_LOGIN_ATTEMPTS` | 5 | Login attempt limit |
| `LOCKOUT_MINUTES` | 15 | Lockout duration (minutes) |

## External access

### Quick Tunnel (default)

`cloudflared.exe` is not included in the repository (size). `npm run setup` or
`npm start` detects a missing binary and offers to download it automatically
(disable with `--no-download`). To install it manually, grab it from
[here](https://github.com/cloudflare/cloudflared/releases) and place it in the
project root.

On startup it runs the following and issues a
`https://<random>.trycloudflare.com` URL. No Cloudflare account or token is
needed, but the URL changes on every start. `npm start` prints the issued URL,
a shortened TinyURL, and a **QR code** you can scan with your phone.

```bash
cloudflared tunnel --url http://localhost:3389
```

### Named tunnel (stable URL)

Enter a token in `npm run setup` (or set `TUNNEL_TOKEN` in `.env`) to start with
a named tunnel. To run it continuously, use an elevated shell:

```bash
npm run install-service
```

This registers two scheduled tasks, `DeskedServer` (high integrity level) and
`DeskedTunnel`, and writes the tunnel URL/logs to `cloudflare.log`.

### Port forwarding

Forward the external port to your internal IP:3389 on the router. In this case,
change `HOST=0.0.0.0` in `.env` (the default `127.0.0.1` is not reachable from
outside). Provide HTTPS termination separately.

## Security

- **HTTPS is required**: route traffic through Cloudflare Tunnel or a reverse
  proxy such as nginx + Let's Encrypt. Passwords and video are not protected
  over plain HTTP.
- Passwords are stored as a **scrypt hash** (`PASSWORD_HASH`); no plaintext is
  left on disk.
- Use a **strong password**, and never commit `.env` (it is already in
  `.gitignore`).
- WebSocket connections are accepted only from the same origin (cross-site
  WebSocket hijacking protection). Inbound payloads are capped at 64 KB.
- `ws` is pinned to `>= 8.21.3`, which fixes the tiny-fragment
  memory-exhaustion DoS.
- Login attempt limiting and lockout, session expiry, and server-side logout
  (token revocation) are implemented. The lockout key trusts
  `CF-Connecting-IP` only for loopback connections.
- A strict **Content-Security-Policy** and related headers
  (`nosniff` / `frame-ancestors 'none'`, etc.) are sent.
- `cloudflared.exe` is downloaded at a **pinned version** and verified with
  SHA-256.
- Runtime artifacts such as `cloudflared.exe`, logs, and screenshots are not
  committed.

See [SECURITY.md](SECURITY.md) for the detailed threat model and known
limitations (such as the plan to separate the administrator-level process).

## Development

```bash
npm ci          # install dependencies exactly as locked
npm test        # unit tests (node:test)
```

`test/` contains tests for password hashing and the `.env` writer. GitHub
Actions (Windows) runs `npm ci` -> syntax check -> tests, and Dependabot
monitors dependency updates. See [CHANGELOG.md](CHANGELOG.md) for the change
history.

## Troubleshooting

- **`EADDRINUSE: address already in use :::3389`**: another Desked instance
  (such as the resident task) is already using port 3389. Stop it with
  `Stop-ScheduledTask -TaskName 'DeskedServer'` or change `PORT` in `.env`.
- **`cloudflared.exe not found`**: run `npm run setup` to download it
  automatically, or place it in the project root manually.
- **`InputHandler: Server is not elevated`**: input cannot reach elevated apps.
  Start it as a high-integrity task with `npm run install-service`.
- **Chrome warns that "the password may have been compromised"**: this mostly
  happens when you access Desked over **HTTP (non-HTTPS)**. Use the Cloudflare
  Tunnel `https://...` URL. The login screen also shows a warning. If the
  warning persists over HTTPS, the password is likely in a breach list, so
  change it to a new random one with `npm run password`.

## Controls

### PC (mouse & keyboard)
- The mouse and keyboard work as-is
- Right click and wheel scrolling are supported

### Smartphone (touch)
- **Tap**: left click / **Double tap**: double click / **Long press**: right click
- **Drag**: slide your finger / **Two-finger scroll**: wheel / **Pinch**: zoom
- **Keyboard button**: show the mobile keyboard

### Toolbar
- **Fullscreen** / **Keyboard** / **Ctrl** / **Alt** / **C+A+D** / **Quality** / **Scale** / **Disconnect**
- Change the password from the server-side CLI (`npm run password`)

## Tech stack

- **Screen Capture**: FFmpeg Desktop Duplication / GDI + sharp
- **Input Simulation**: koffi + Windows API (user32.dll)
- **WebSocket**: ws
- **HTTP**: Express
- **Client**: HTML5 Canvas + WebCodecs + Vanilla JS
