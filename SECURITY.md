# Security

Desked exposes a Windows desktop over the network. Anyone who can reach the web
server and knows the password can view the screen and control the mouse/keyboard,
so the security model is intentionally small and explicit.

## Reporting

Please open a private security advisory on GitHub, or an issue if the advisory
feature is unavailable.

## Protections currently implemented

- The password is stored as a salted **scrypt hash** (`PASSWORD_HASH`); the
  plaintext is never written to disk. Legacy plaintext `PASSWORD` values are
  accepted for backward compatibility but are hashed in memory and warned about.
- 32-byte random session tokens, with a server-side logout that revokes the token.
- Login attempt limit and lockout (`MAX_LOGIN_ATTEMPTS`, `LOCKOUT_MINUTES`).
- Session expiry (`SESSION_TIMEOUT_HOURS`).
- WebSocket same-origin check (cross-site WebSocket hijacking).
- `cloudflared` is downloaded from a **pinned release** and its SHA-256 verified.
- TLS is provided by Cloudflare Tunnel (named or Quick Tunnel).

## Known limitation: privileged network process

The server runs at **High Integrity Level** (Windows Task Scheduler
`RunLevel Highest`) because Windows UIPI blocks input injection into elevated
windows (e.g. Task Manager) from a medium-integrity process. As a result, the
Express/WebSocket/video code that faces the network runs with elevated rights.

A more robust design is to split this into:

```
Browser -> Cloudflare -> unprivileged network server -> local IPC -> privileged input helper
```

The helper would accept only a small, fixed set of input commands over a named
pipe. This is not implemented yet and is the highest-value follow-up for
always-on, internet-exposed deployments.

## Other known limitations

- Session tokens are stored in `localStorage`, so an XSS bug could exfiltrate a
  token. Moving to `HttpOnly`/`Secure`/`SameSite` cookies is a possible follow-up.
- Session tokens are not bound to an IP address, so a stolen token can be reused
  from elsewhere until it expires (or is revoked via logout).

## Recommended for always-on use

- Use a **named Cloudflare Tunnel** (stable URL) or a VPN such as
  Tailscale/WireGuard rather than exposing a port directly.
- Consider putting **Cloudflare Access** in front of the tunnel for an extra
  authentication layer.
- Keep a strong, unique password, and expose the service only to people you trust.
