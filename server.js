const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('./lib/config');
const auth = require('./lib/auth');
const envStore = require('./lib/env-store');
const screenCapture = require('./lib/screen-capture');
const inputHandler = require('./lib/input-handler');
const { HwH264Encoder, pickEncoder } = require('./lib/hw-h264-encoder');

// --- Express Setup ---
const app = express();
const server = http.createServer(app);

app.use((req, res, next) => {
  if (req.url !== '/health') console.log(`[Server] ${req.method} ${req.url}`);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// --- Password management ---
function isValidNewPassword(password) {
  return (
    typeof password === 'string' &&
    password.length >= 8 &&
    password.length <= 200 &&
    !/[\r\n]/.test(password)
  );
}

/** Update PASSWORD= in .env so the change survives a restart. */
function persistPassword(newPassword) {
  try {
    envStore.set('PASSWORD', newPassword);
    return true;
  } catch (err) {
    console.error('[Server] Failed to persist password to .env:', err.message);
    return false;
  }
}

/**
 * Reject cross-site WebSocket hijacking: browser handshakes carry an Origin
 * header that must match the Host the request was sent to. Non-browser
 * clients that omit Origin (e.g. native tools) are allowed through.
 */
function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// --- WebSocket Setup ---
const wss = new WebSocketServer({ 
  server,
  perMessageDeflate: false, // Disables compression for lower latency (JPEG is already compressed)
  verifyClient: (info, cb) => {
    if (isAllowedOrigin(info.req)) cb(true);
    else cb(false, 403, 'Forbidden');
  },
});

// Track authenticated clients
const clients = new Set();
let captureRunning = false;
/** @type {number} 0 = not started; phase-locked capture cadence */
let captureTickAnchor = 0;

let cachedAvcC = null;
let encInW = 0;
let encInH = 0;
let encOutW = 0;
let encOutH = 0;

function evenDims() {
  const s = screenCapture.getScreenInfo();
  return {
    width: Math.max(2, s.width - (s.width % 2)),
    height: Math.max(2, s.height - (s.height % 2)),
  };
}

function buildAuthPayload(token) {
  const ed = evenDims();
  return {
    type: 'auth_result',
    success: true,
    token,
    screenWidth: ed.width,
    screenHeight: ed.height,
    stream: useH264 ? 'h264' : 'jpeg',
    fps: streamFps(),
  };
}

function sendH264Init(ws, avcC) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  const buf = Buffer.alloc(5 + avcC.length);
  buf[0] = 0x01;
  buf.writeUInt32LE(avcC.length, 1);
  avcC.copy(buf, 5);
  ws.send(buf, { binary: true });
}

let h264OutPtsUs = 0;
/** Split large WS binary (H.264 / JPEG); mobile paths often fail on single huge frames.
 *  Keep below Cloudflare Tunnel's safe WS frame size but large enough that typical
 *  JPEG/H.264 frames fit in ONE message (previously 4KB caused 10-50x chunk overhead). */
const WS_BINARY_MSG_MAX = 256 * 1024;
const WS_BINARY_CHUNK_HDR = 15; // 0x03 + u32 id + u32 total + u32 off + u16 len
let wsBinaryFragSeq = 0;

function sendBinaryMaybeChunked(ws, pkt, streamLabel) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  // Drop frames only when truly backed up; 512KB was too tight once chunks became 256KB.
  if (ws.bufferedAmount > 4 * 1024 * 1024) return;
  const chunkPayloadMax = WS_BINARY_MSG_MAX - WS_BINARY_CHUNK_HDR;
  const useChunks = pkt.length > WS_BINARY_MSG_MAX;
  const fragId = useChunks ? (++wsBinaryFragSeq) >>> 0 : 0;
  try {
    if (!useChunks) {
      ws.send(pkt, { binary: true });
    } else {
      let offset = 0;
      while (offset < pkt.length) {
        const slice = Math.min(chunkPayloadMax, pkt.length - offset);
        const chunk = Buffer.alloc(WS_BINARY_CHUNK_HDR + slice);
        chunk[0] = 0x03;
        chunk.writeUInt32LE(fragId, 1);
        chunk.writeUInt32LE(pkt.length, 5);
        chunk.writeUInt32LE(offset, 9);
        chunk.writeUInt16LE(slice, 13);
        pkt.copy(chunk, WS_BINARY_CHUNK_HDR, offset, offset + slice);
        offset += slice;
        ws.send(chunk, { binary: true });
      }
    }
    if (!ws._sentFirstFrame) {
      ws._sentFirstFrame = true;
      const now = Date.now();
      const dConn = ws._tConnected ? now - ws._tConnected : -1;
      const dAuth = ws._tAuthOk ? now - ws._tAuthOk : -1;
      console.log(
        `[Server] First ${streamLabel} frame sent to ${ws._socket?.remoteAddress || 'client'} after ${dConn}ms (auth+${dAuth}ms)`
      );
    }
  } catch (_) {}
}

function broadcastH264Frame(frame) {
  const stepUs = Math.round(1_000_000 / streamFps());
  h264OutPtsUs += stepUs;
  const pkt = Buffer.alloc(14 + frame.data.length);
  pkt[0] = 0x02;
  pkt.writeDoubleLE(h264OutPtsUs, 1);
  pkt[9] = frame.key ? 1 : 0;
  pkt.writeUInt32LE(frame.data.length, 10);
  frame.data.copy(pkt, 14);

  for (const client of clients) {
    sendBinaryMaybeChunked(client, pkt, 'H.264');
  }
}

function clearH264BroadcastQueue() {
  h264OutPtsUs = 0;
}

let useH264 = config.streamMode === 'h264';
let hwEncoder = null;
function streamFps() {
  return useH264 ? config.h264TargetFps : config.targetFps;
}
function streamCaptureFps() {
  return useH264 && hwEncoder ? config.h264CaptureFps : streamFps();
}

/** Backpressure for JPEG pipeline: at most one Sharp encode in flight at a time. */
let jpegInFlight = null;

let h264EncodeBusy = false;
/** @type {Buffer|null} Keep only the freshest frame while FFmpeg is busy. */
let h264PendingFrame = null;

function clearH264EncodeQueue() {
  h264PendingFrame = null;
  h264EncodeBusy = false;
}

function enqueueH264Frame(rgba) {
  if (!hwEncoder || !hwEncoder.isRunning()) return;
  // The capture buffers are reused, so take one copy. Replacing the pending
  // frame prevents game/video workloads from building seconds of stale video.
  h264PendingFrame = Buffer.from(rgba);
  drainH264EncodeQueue();
}

function drainH264EncodeQueue() {
  if (!useH264 || !hwEncoder || h264EncodeBusy || !h264PendingFrame) return;
  h264EncodeBusy = true;
  const buf = h264PendingFrame;
  h264PendingFrame = null;
  hwEncoder
    .writeFrame(buf)
    .then(() => {
      h264EncodeBusy = false;
      drainH264EncodeQueue();
    })
    .catch(() => {
      h264EncodeBusy = false;
      drainH264EncodeQueue();
    });
}

function canRunEncoder(name) {
  try {
    execFileSync(
      config.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=64x64:r=1',
        '-frames:v',
        '1',
        '-an',
        '-c:v',
        name,
        '-f',
        'null',
        '-',
      ],
      { stdio: 'ignore' }
    );
    return true;
  } catch {
    return false;
  }
}

function chooseWorkingH264Encoder() {
  const forced = pickForcedEncoder();
  if (forced) {
    if (canRunEncoder(forced)) return forced;
    console.warn(`[Server] Requested H.264 encoder ${forced} is not usable; trying fallbacks.`);
  }
  const preferred = pickEncoder(config.ffmpegPath);
  const candidates = [];
  if (preferred) candidates.push(preferred);
  for (const e of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264']) {
    if (!candidates.includes(e)) candidates.push(e);
  }
  for (const enc of candidates) {
    if (canRunEncoder(enc)) return enc;
  }
  return null;
}

function pickForcedEncoder() {
  const n = String(config.h264Encoder || '').toLowerCase().trim();
  if (['h264_nvenc', 'nvenc'].includes(n)) return 'h264_nvenc';
  if (['h264_qsv', 'qsv'].includes(n)) return 'h264_qsv';
  if (['h264_amf', 'amf'].includes(n)) return 'h264_amf';
  if (['libx264', 'x264', 'cpu'].includes(n)) return 'libx264';
  return null;
}

function tryInitH264() {
  if (!useH264) {
    screenCapture.setStreamMode('jpeg');
    return;
  }
  try {
    execFileSync(config.ffmpegPath, ['-version'], { stdio: 'ignore' });
  } catch {
    console.warn('[Server] FFmpeg not found — using JPEG stream. Install FFmpeg or set FFMPEG_PATH.');
    useH264 = false;
    screenCapture.setStreamMode('jpeg');
    return;
  }
  const encName = chooseWorkingH264Encoder();
  if (!encName) {
    console.warn('[Server] No usable H.264 encoder found in FFmpeg — using JPEG stream.');
    useH264 = false;
    screenCapture.setStreamMode('jpeg');
    return;
  }
  console.log(`[Server] H.264 encoder: ${encName} (FFmpeg)`);
  hwEncoder = new HwH264Encoder({
    ffmpegPath: config.ffmpegPath,
    fps: config.h264CaptureFps,
    gop: config.h264Gop,
    cq: config.h264Cq,
    encoder: encName,
    desktopCapture: config.h264DesktopCapture,
  });
  hwEncoder.setQualityFromPercent(config.captureQuality);
  hwEncoder.onInit = (avcC) => {
    cachedAvcC = Buffer.from(avcC);
    for (const c of clients) {
      sendH264Init(c, cachedAvcC);
    }
  };
  hwEncoder.onFrame = (frame) => {
    broadcastH264Frame(frame);
  };
  screenCapture.setStreamMode('h264');
  try {
    if (hwEncoder.desktopCapture) {
      console.log('[Server] Desktop Duplication capture enabled; encoder starts on first client');
      return;
    }
    const si = screenCapture.getScreenInfo();
    hwEncoder.start(si.physicalWidth, si.physicalHeight, si.width, si.height);
    encInW = si.physicalWidth;
    encInH = si.physicalHeight;
    encOutW = si.width;
    encOutH = si.height;
    console.log('[Server] H.264 encoder prewarmed');
  } catch (e) {
    console.warn('[Server] H.264 prewarm skipped:', e.message);
  }
}

function ensureEncoder() {
  if (!useH264 || !hwEncoder) return;
  if (hwEncoder.isPipeBroken() && hwEncoder.encoder !== 'libx264') {
    console.warn(`[Server] ${hwEncoder.encoder} failed at runtime, falling back to libx264.`);
    hwEncoder.encoder = 'libx264';
    encInW = 0;
    encInH = 0;
    encOutW = 0;
    encOutH = 0;
  }
  const si = screenCapture.getScreenInfo();
  const encInputW = hwEncoder.desktopCapture ? si.physicalWidth : si.width;
  const encInputH = hwEncoder.desktopCapture ? si.physicalHeight : si.height;
  if (
    hwEncoder.isRunning() &&
    encInW === encInputW &&
    encInH === encInputH &&
    encOutW === si.width &&
    encOutH === si.height
  ) {
    return;
  }
  try {
    hwEncoder.stop();
    clearH264EncodeQueue();
    hwEncoder.start(encInputW, encInputH, si.width, si.height);
    encInW = encInputW;
    encInH = encInputH;
    encOutW = si.width;
    encOutH = si.height;
    cachedAvcC = null;
    h264OutPtsUs = 0;
  } catch (e) {
    console.error('[Server] H.264 encoder start failed:', e.message);
    useH264 = false;
    screenCapture.setStreamMode('jpeg');
    hwEncoder = null;
  }
}

tryInitH264();

/**
 * Adaptive capture loop using setTimeout (better than setInterval for high fps)
 * Automatically adjusts timing based on actual capture duration
 */
async function captureLoop() {
  if (clients.size === 0) {
    captureRunning = false;
    captureTickAnchor = 0;
    console.log('[Server] Capture stopped (no clients)');
    return;
  }

  const intervalMs = 1000 / streamCaptureFps();
  const loopStartedAt = performance.now();

  try {
    if (useH264 && hwEncoder) {
      ensureEncoder();
      const frame = await screenCapture.captureFrame();
      if (frame && frame.hasChanged && frame.rgba) {
        enqueueH264Frame(frame.rgba);
      }
    } else {
      // Backpressure: if the previous Sharp encode hasn't finished yet, wait for it
      // before starting another capture. This keeps at most one encode in flight
      // while still letting the next BitBlt overlap with the current encode.
      if (jpegInFlight) {
        await jpegInFlight;
      }

      const frame = await screenCapture.captureFrame();

      if (frame && frame.bufferPromise) {
        // Fire-and-track: next captureLoop iteration's BitBlt will run concurrently
        // with Sharp's JPEG encoding on the libuv threadpool.
        jpegInFlight = frame.bufferPromise
          .then((jpegBuffer) => {
            if (!jpegBuffer) return;
            const header = Buffer.alloc(24);
            header.writeUInt32LE(frame.x, 0);
            header.writeUInt32LE(frame.y, 4);
            header.writeUInt32LE(frame.width, 8);
            header.writeUInt32LE(frame.height, 12);
            header[16] = frame.isFullFrame ? 1 : 0;
            const payload = Buffer.concat([header, jpegBuffer]);
            for (const client of clients) {
              if (client.readyState !== client.OPEN) continue;
              try {
                // sendBinaryMaybeChunked has its own (larger) bufferedAmount gate.
                sendBinaryMaybeChunked(client, payload, 'JPEG');
              } catch (_) {
                // Client disconnected
              }
            }
          })
          .catch((err) => {
            console.error('[Server] JPEG encode error:', err.message);
          })
          .finally(() => {
            jpegInFlight = null;
          });
      }
    }
  } catch (err) {
    console.error('[Server] Capture error:', err.message);
  }

  const elapsed = performance.now() - loopStartedAt;
  // If capture/queueing already consumed the frame budget, run the next
  // iteration immediately. Skipping an entire cadence slot halves FPS when
  // a 30 fps capture takes just over 33 ms.
  const delay = Math.max(0, Math.round(intervalMs - elapsed));

  if (captureRunning) {
    if (delay === 0) {
      setImmediate(captureLoop);
    } else {
      setTimeout(captureLoop, delay);
    }
  }
}

function startCapture() {
  if (captureRunning) return;
  captureRunning = true;
  captureTickAnchor = 0;
  console.log(`[Server] Starting capture at ${streamCaptureFps()} fps`);
  if (useH264 && hwEncoder?.desktopCapture) {
    ensureEncoder();
    return;
  }
  captureLoop();
}

function stopCapture() {
  captureRunning = false;
  captureTickAnchor = 0;
  clearH264BroadcastQueue();
  if (hwEncoder?.desktopCapture) {
    hwEncoder.stop();
    clearH264EncodeQueue();
    cachedAvcC = null;
    encInW = 0;
    encInH = 0;
    encOutW = 0;
    encOutH = 0;
  }
}

wss.on('connection', (ws, req) => {
  let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (ip && ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  console.log(`[Server] WebSocket connection from ${ip}`);
  ws._tConnected = Date.now();
  ws._tAuthOk = 0;
  ws._sentFirstFrame = false;

  let authenticated = false;
  let sessionToken = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Handle authentication
    if (msg.type === 'auth') {
      if (msg.token) {
        // Token-based re-auth
        if (auth.validateToken(msg.token)) {
          authenticated = true;
          sessionToken = msg.token;
          ws._tAuthOk = Date.now();
          clients.add(ws);
          screenCapture.forceFullFrame();
          startCapture();
          ws.send(JSON.stringify(buildAuthPayload(sessionToken)));
          if (useH264 && cachedAvcC) {
            sendH264Init(ws, cachedAvcC);
          }
          console.log(`[Server] Client re-authenticated via token from ${ip}`);
        } else {
          ws.send(JSON.stringify({ type: 'auth_result', success: false, error: 'Token expired' }));
        }
      } else if (msg.password) {
        // Password-based auth
        const result = auth.authenticate(msg.password, ip);
        if (result.success) {
          authenticated = true;
          sessionToken = result.token;
          ws._tAuthOk = Date.now();
          clients.add(ws);
          screenCapture.forceFullFrame();
          startCapture();
          ws.send(JSON.stringify(buildAuthPayload(sessionToken)));
          if (useH264 && cachedAvcC) {
            sendH264Init(ws, cachedAvcC);
          }
          console.log(`[Server] Client authenticated from ${ip}`);
        } else {
          ws.send(JSON.stringify({ type: 'auth_result', success: false, error: result.error }));
          console.log(`[Server] Auth failed from ${ip}: ${result.error}`);
        }
      }
      return;
    }

    // All other messages require authentication
    if (!authenticated) {
      ws.send(JSON.stringify({ type: 'error', error: 'Not authenticated' }));
      return;
    }

    // Handle quality/scale changes
    if (msg.type === 'set_quality') {      if (msg.quality != null) {
        screenCapture.setQuality(msg.quality);
        if (hwEncoder) hwEncoder.setQualityFromPercent(msg.quality);
      }
      if (msg.scale != null) {
        screenCapture.setScale(msg.scale);
        // Immediately notify client of new canvas resolution to prevent stretching
        const screenInfo = screenCapture.getScreenInfo();
        ws.send(JSON.stringify({
          type: 'screen_info',
          width: screenInfo.width,
          height: screenInfo.height,
        }));
        screenCapture.forceFullFrame();
      }
      return;
    }

    // Handle password change
    if (msg.type === 'change_password') {
      const current = typeof msg.currentPassword === 'string' ? msg.currentPassword : '';
      const next = typeof msg.newPassword === 'string' ? msg.newPassword : '';

      if (!auth.checkPassword(current)) {
        ws.send(JSON.stringify({
          type: 'password_result',
          success: false,
          error: 'Current password is incorrect',
        }));
        console.log(`[Server] Password change rejected (bad current password) from ${ip}`);
        return;
      }
      if (!isValidNewPassword(next)) {
        ws.send(JSON.stringify({
          type: 'password_result',
          success: false,
          error: 'New password must be 8-200 characters',
        }));
        return;
      }
      if (next === current) {
        ws.send(JSON.stringify({
          type: 'password_result',
          success: false,
          error: 'New password must be different from the current one',
        }));
        return;
      }

      auth.setPassword(next);
      config.password = next;
      const persisted = persistPassword(next);
      auth.revokeOtherSessions(sessionToken);
      ws.send(JSON.stringify({
        type: 'password_result',
        success: true,
        persisted,
        error: persisted ? undefined : 'Changed for this session, but could not be saved to .env',
      }));
      console.log(`[Server] Password changed from ${ip}${persisted ? '' : ' (NOT persisted to .env)'}`);
      return;
    }

    // Handle input events
    inputHandler.handleInput(msg);
  });

  ws.on('close', () => {
    authenticated = false;
    clients.delete(ws);
    console.log(`[Server] Client disconnected from ${ip}`);
    if (clients.size === 0) {
      stopCapture();
    }
  });

  ws.on('error', (err) => {
    console.error(`[Server] WebSocket error from ${ip}:`, err.message);
    clients.delete(ws);
  });
});

setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      try {
        client.ping();
      } catch (_) {}
    }
  }
}, 25000);

// Cleanup expired sessions every 5 minutes
setInterval(() => auth.cleanup(), 5 * 60 * 1000);

// --- Graceful Shutdown ---
function shutdown() {
  console.log('[Server] Shutting down...');
  captureRunning = false;
  if (hwEncoder) {
    try {
      hwEncoder.stop();
    } catch (_) {}
    clearH264EncodeQueue();
    clearH264BroadcastQueue();
  }
  screenCapture.destroy();
  wss.close();
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Get Local IP ---
const os = require('os');
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// --- Start Server ---
server.listen(config.port, () => {
  const localIp = getLocalIp();
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║           Desked Server Running          ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  Local:   http://localhost:${String(config.port).padEnd(21)}║`);
  console.log(`  ║  Network: http://${localIp}:${String(config.port).padEnd(24 - localIp.length)}║`);
  console.log(
    `  ║  FPS:     ${String(
      useH264 ? `${config.h264CaptureFps} cap / ${config.h264TargetFps} out` : streamFps()
    ).padEnd(30)}║`
  );
  console.log(`  ║  Quality: ${String(config.captureQuality).padEnd(30)}║`);
  console.log(`  ║  Scale:   ${String(config.captureScale).padEnd(30)}║`);
  console.log(`  ║  Stream:  ${String(useH264 ? 'H.264 (FFmpeg)' : 'JPEG').padEnd(30)}║`);
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});
