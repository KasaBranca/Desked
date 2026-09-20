/**
 * Shared helpers for announcing the Cloudflare Tunnel public URL.
 * Used by the CLI and by scripts/tunnel.js so the short URL is printed
 * regardless of how the tunnel was launched (terminal, VBS, scheduled task).
 */
'use strict';

const TRY_CLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** Print a scannable QR code for the given URL (best effort). */
function printQr(url) {
  try {
    const qrcode = require('qrcode-terminal');
    qrcode.generate(url, { small: true });
  } catch (_) {
    console.log('[Desked] Install "qrcode-terminal" to display a QR code (npm install).');
  }
}

const UA = { 'user-agent': 'desked-cli' };
const SHORT_TIMEOUT = 6000;

// Public shorteners block trycloudflare.com at different rates, so try several
// and use the first one that returns a valid link. All are no-key services.
const SHORTENERS = [
  {
    name: 'TinyURL',
    async run(url) {
      const res = await fetch(
        `https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`,
        { signal: AbortSignal.timeout(SHORT_TIMEOUT), headers: UA }
      );
      return res.ok ? (await res.text()).trim() : null;
    },
  },
  {
    name: 'is.gd',
    async run(url) {
      const res = await fetch(
        `https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`,
        { signal: AbortSignal.timeout(SHORT_TIMEOUT), headers: UA }
      );
      return res.ok ? (await res.text()).trim() : null;
    },
  },
  {
    name: 'spoo.me',
    async run(url) {
      const res = await fetch('https://spoo.me/', {
        method: 'POST',
        signal: AbortSignal.timeout(SHORT_TIMEOUT),
        headers: { ...UA, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ url }).toString(),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data && typeof data.short_url === 'string' ? data.short_url : null;
    },
  },
  {
    name: 'cleanuri.com',
    async run(url) {
      const res = await fetch('https://cleanuri.com/api/v1/shorten', {
        method: 'POST',
        signal: AbortSignal.timeout(SHORT_TIMEOUT),
        headers: { ...UA, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ url }).toString(),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data && typeof data.result_url === 'string' ? data.result_url : null;
    },
  },
  {
    name: 'clck.ru',
    async run(url) {
      const res = await fetch(`https://clck.ru/--?url=${encodeURIComponent(url)}`, {
        signal: AbortSignal.timeout(SHORT_TIMEOUT),
        headers: UA,
      });
      return res.ok ? (await res.text()).trim() : null;
    },
  },
];

/**
 * Shorten a URL so it is easy to type by hand, trying multiple no-key
 * services. Best effort: returns null on failure so startup still prints the
 * original URL.
 */
async function shortenUrl(url) {
  for (const provider of SHORTENERS) {
    try {
      let short = await provider.run(url);
      if (typeof short !== 'string') continue;
      short = short.trim();
      if (!/^https?:\/\/\S+$/i.test(short)) continue;
      // spoo.me returns an http link; upgrade it (it serves https too).
      if (/^http:\/\/spoo\.me\//i.test(short)) short = short.replace(/^http:/i, 'https:');
      return short;
    } catch (_) {
      // try the next provider
    }
  }
  return null;
}

/**
 * Print the public tunnel URL, its shortened form, and (on a TTY) a QR code.
 * Skips the QR when the output is redirected (e.g. cloudflare.log).
 */
async function announceTunnelUrl(url, { qr = Boolean(process.stdout.isTTY) } = {}) {
  console.log('');
  console.log(`  Cloudflare Tunnel URL: ${url}`);
  const short = await shortenUrl(url);
  console.log(`  Short URL:             ${short || '(unavailable; use the URL above)'}`);
  if (qr) {
    console.log('  Scan to open on your phone:');
    console.log('');
    printQr(short || url);
  }
  console.log('');
}

module.exports = { TRY_CLOUDFLARE_RE, printQr, shortenUrl, announceTunnelUrl };
