require('dotenv').config();

const passwordUtil = require('./password');

const config = {
  // Bind loopback by default: reach Desked through the Cloudflare Tunnel.
  // Set HOST=0.0.0.0 only if you also want direct LAN access.
  host: process.env.HOST || '127.0.0.1',
  port: parseInt(process.env.PORT, 10) || 3389,
  tunnelToken: process.env.TUNNEL_TOKEN || null,

  // Screen capture
  captureQuality: Math.min(100, Math.max(1, parseInt(process.env.CAPTURE_QUALITY, 10) || 60)),
  captureScale: Math.min(1.0, Math.max(0.1, parseFloat(process.env.CAPTURE_SCALE) || 0.6667)),
  targetFps: Math.min(120, Math.max(1, parseInt(process.env.TARGET_FPS, 10) || 10)),

  // Streaming: h264 = FFmpeg hardware H.264 (NVENC/QSV/AMF or libx264); jpeg = legacy Sharp JPEG
  streamMode: (process.env.STREAM_MODE || 'h264').toLowerCase() === 'jpeg' ? 'jpeg' : 'h264',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  // Capture through FFmpeg's Desktop Duplication API instead of GDI/Node.
  h264DesktopCapture: process.env.H264_DESKTOP_CAPTURE !== '0',
  // Empty = auto-select the best available encoder (NVENC > QSV > AMF > libx264).
  h264Encoder: (process.env.H264_ENCODER || '').toLowerCase().trim(),
  // Nominal output / WebSocket timestamp pacing (encoded FPS may be lower).
  h264TargetFps: Math.min(120, Math.max(1, parseInt(process.env.H264_TARGET_FPS, 10) || 24)),
  // How often we sample the screen while H.264 is on (decoupled from encoder throughput).
  h264CaptureFps: Math.min(120, Math.max(1, parseInt(process.env.H264_CAPTURE_FPS, 10) || 24)),
  // Longer GOP improves throughput/quality dramatically vs all-I frames.
  h264Gop: Math.min(300, Math.max(1, parseInt(process.env.H264_GOP, 10) || 24)),
  h264Cq: Math.min(51, Math.max(10, parseInt(process.env.H264_CQ, 10) || 28)),

  // Auth
  passwordHash: null,
  legacyPlaintextPassword: false,
  sessionTimeoutMs: (parseInt(process.env.SESSION_TIMEOUT_HOURS, 10) || 24) * 60 * 60 * 1000,
  maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS, 10) || 5,
  lockoutMs: (parseInt(process.env.LOCKOUT_MINUTES, 10) || 15) * 60 * 1000,
};

// Resolve the password hash. Prefer PASSWORD_HASH; fall back to legacy
// plaintext PASSWORD (hashed in memory only, never persisted).
if (process.env.PASSWORD_HASH) {
  config.passwordHash = process.env.PASSWORD_HASH;
} else if (process.env.PASSWORD) {
  config.passwordHash = passwordUtil.hash(process.env.PASSWORD);
  config.legacyPlaintextPassword = true;
  console.warn('[Config] PASSWORD is stored in plaintext. Run "npm run password" to migrate to a hashed password.');
}

// Validate
if (!config.passwordHash) {
  console.error('ERROR: No password configured. Run "npm run setup" (writes PASSWORD_HASH to .env).');
  process.exit(1);
}

module.exports = config;
