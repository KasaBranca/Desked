const { spawn } = require('child_process');
const { execFileSync } = require('child_process');
const {
  buildAvcC,
  splitAnnexB,
  nalType,
  firstMbInSlice,
} = require('./h264-annexb');

function findAllStartCodes(buf) {
  const out = [];
  let from = 0;
  while (from < buf.length) {
    let found = false;
    for (let i = from; i + 3 < buf.length; i++) {
      if (buf[i] === 0 && buf[i + 1] === 0) {
        if (buf[i + 2] === 1) {
          out.push(i);
          from = i + 3;
          found = true;
          break;
        }
        if (i + 4 < buf.length && buf[i + 2] === 0 && buf[i + 3] === 1) {
          out.push(i);
          from = i + 4;
          found = true;
          break;
        }
      }
    }
    if (!found) break;
  }
  return out;
}

function consumeByStartCodes(buffer) {
  const scs = findAllStartCodes(buffer);
  if (scs.length < 2) {
    return { complete: Buffer.alloc(0), rest: buffer };
  }
  const cut = scs[scs.length - 1];
  return {
    complete: buffer.subarray(0, cut),
    rest: buffer.subarray(cut),
  };
}

function buildAnnexB(nals) {
  const parts = [];
  for (const nal of nals) {
    parts.push(Buffer.from([0, 0, 0, 1]), nal);
  }
  return Buffer.concat(parts);
}

function pickEncoder(ffmpegPath) {
  try {
    const out = execFileSync(ffmpegPath, ['-hide_banner', '-encoders'], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    if (out.includes('h264_nvenc')) return 'h264_nvenc';
    if (out.includes('h264_qsv')) return 'h264_qsv';
    if (out.includes('h264_amf')) return 'h264_amf';
  } catch {
    return null;
  }
  return 'libx264';
}

function normalizeEncoderName(name) {
  const n = String(name || '').toLowerCase().trim();
  if (['h264_nvenc', 'nvenc'].includes(n)) return 'h264_nvenc';
  if (['h264_qsv', 'qsv'].includes(n)) return 'h264_qsv';
  if (['h264_amf', 'amf'].includes(n)) return 'h264_amf';
  if (['libx264', 'x264', 'cpu'].includes(n)) return 'libx264';
  return null;
}

function buildFfmpegArgs({
  encoder,
  inputW,
  inputH,
  outW,
  outH,
  fps,
  gop,
  cq,
}) {
  const inEvenW = Math.max(2, inputW - (inputW % 2));
  const inEvenH = Math.max(2, inputH - (inputH % 2));
  const evenW = Math.max(2, outW - (outW % 2));
  const evenH = Math.max(2, outH - (outH % 2));
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'bgra',
    '-s',
    `${inEvenW}x${inEvenH}`,
    '-r',
    String(fps),
    '-i',
    'pipe:0',
    '-an',
  ];

  if (evenW !== inEvenW || evenH !== inEvenH) {
    args.push('-vf', `scale=${evenW}:${evenH}:flags=fast_bilinear`);
  }

  if (encoder === 'h264_nvenc') {
    args.push(
      '-c:v',
      'h264_nvenc',
      '-preset',
      'p1',
      '-tune',
      'll',
      '-rc',
      'vbr',
      '-cq',
      String(cq),
      '-maxrate:v',
      '2M',
      '-bufsize:v',
      '4M',
      '-b:v',
      '0',
      '-g',
      String(gop),
      '-bf',
      '0',
    );
  } else if (encoder === 'h264_qsv') {
    args.push(
      '-c:v',
      'h264_qsv',
      '-preset',
      'veryfast',
      '-global_quality',
      String(Math.min(51, Math.max(1, cq))),
      '-maxrate:v',
      '2M',
      '-bufsize:v',
      '4M',
      '-look_ahead',
      '0',
      '-async_depth',
      '1',
      '-g',
      String(gop),
      '-bf',
      '0',
    );
  } else if (encoder === 'h264_amf') {
    args.push(
      '-c:v',
      'h264_amf',
      '-quality',
      'speed',
      '-rc',
      'cqp',
      '-qp_i',
      String(cq),
      '-qp_p',
      String(cq),
      '-g',
      String(gop),
      '-bf',
      '0',
    );
  } else {
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-crf',
      String(Math.min(51, Math.max(18, cq))),
      '-maxrate:v',
      '4M',
      '-bufsize:v',
      '8M',
      '-g',
      String(gop),
      '-bf',
      '0',
      '-x264opts',
      'no-scenecut',
    );
  }

  args.push(
    '-profile:v',
    'baseline',
    '-level',
    '4.2',
    '-pix_fmt',
    'yuv420p',
    '-f',
    'h264',
    'pipe:1',
  );

  return { args, evenW, evenH };
}

function buildDesktopFfmpegArgs({
  encoder,
  inputW,
  inputH,
  outW,
  outH,
  fps,
  gop,
  cq,
}) {
  const evenW = Math.max(2, outW - (outW % 2));
  const evenH = Math.max(2, outH - (outH % 2));
  const filters = ['hwdownload', 'format=bgra'];
  if (evenW !== inputW || evenH !== inputH) {
    filters.push(`scale=${evenW}:${evenH}:flags=fast_bilinear`);
  }

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `ddagrab=framerate=${fps}:draw_mouse=0:dup_frames=0`,
    '-an',
    '-vf',
    filters.join(','),
  ];

  if (encoder === 'h264_qsv') {
    args.push(
      '-c:v', 'h264_qsv',
      '-preset', 'veryfast',
      '-global_quality', String(Math.min(51, Math.max(1, cq))),
      '-maxrate:v', '4M',
      '-bufsize:v', '4M',
      '-look_ahead', '0',
      '-async_depth', '4',
      '-g', String(gop),
      '-bf', '0',
    );
  } else {
    args.push(
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-crf', String(Math.min(51, Math.max(18, cq))),
      '-maxrate:v', '6M',
      '-bufsize:v', '6M',
      '-g', String(gop),
      '-bf', '0',
      '-x264opts', 'no-scenecut',
    );
  }

  args.push(
    '-profile:v', 'baseline',
    '-level', '4.2',
    '-pix_fmt', 'yuv420p',
    '-f', 'h264',
    'pipe:1',
  );
  return { args, evenW, evenH };
}

/**
 * FFmpeg hardware (or ultrafast libx264) encoder: raw RGBA in → H.264 Annex B out → AVCC frames.
 */
class HwH264Encoder {
  constructor(options) {
    this.ffmpegPath = options.ffmpegPath || 'ffmpeg';
    this.fps = options.fps || 30;
    this.gop = options.gop || 1;
    this.cq = options.cq != null ? options.cq : 28;
    this.encoder = options.encoder || pickEncoder(this.ffmpegPath) || 'libx264';
    this.desktopCapture = options.desktopCapture === true;

    this._proc = null;
    this._h264Buf = Buffer.alloc(0);
    this._avcC = null;
    this._latestSps = null;
    this._latestPps = null;
    this._accessUnitNals = [];
    this._accessUnitHasVcl = false;
    this._evenW = 0;
    this._evenH = 0;

    this.onFrame = null;
    this.onInit = null;
    this._stderrBuf = '';
    this._pipeBroken = false;
  }

  get avcC() {
    return this._avcC;
  }

  get dimensions() {
    return { width: this._evenW, height: this._evenH };
  }

  isRunning() {
    return this._proc && !this._proc.killed;
  }

  isPipeBroken() {
    return this._pipeBroken;
  }

  /**
   * @param {number} inputW - captured RGBA width (physical)
   * @param {number} inputH - captured RGBA height (physical)
   * @param {number} outW - encoded width (after scale, even)
   * @param {number} outH - encoded height (after scale, even)
   */
  start(inputW, inputH, outW, outH) {
    this.stop();
    const build = this.desktopCapture ? buildDesktopFfmpegArgs : buildFfmpegArgs;
    const built = build({
      encoder: this.encoder,
      inputW,
      inputH,
      outW,
      outH,
      fps: this.fps,
      gop: this.gop,
      cq: this.cq,
    });

    this._evenW = built.evenW;
    this._evenH = built.evenH;
    this._avcC = null;
    this._h264Buf = Buffer.alloc(0);
    this._latestSps = null;
    this._latestPps = null;
    this._accessUnitNals = [];
    this._accessUnitHasVcl = false;
    this._pipeBroken = false;

    this._proc = spawn(this.ffmpegPath, built.args, {
      stdio: [this.desktopCapture ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    this._proc.stderr.on('data', (d) => {
      this._stderrBuf += d.toString();
      if (this._stderrBuf.length > 4000) {
        this._stderrBuf = this._stderrBuf.slice(-2000);
      }
    });

    this._proc.on('error', (err) => {
      console.error('[HwH264Encoder] spawn error:', err.message);
    });

    this._proc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        console.error('[HwH264Encoder] ffmpeg exited', code, this._stderrBuf.slice(-500));
      }
      this._proc = null;
    });

    this._proc.stdout.on('data', (chunk) => this._onH264Data(chunk));
    if (this._proc.stdin) {
      this._proc.stdin.on('error', (err) => {
        this._pipeBroken = true;
        console.error('[HwH264Encoder] stdin error:', err.message);
      });
    }
  }

  stop() {
    if (this._proc) {
      try {
        if (this._proc.stdin) this._proc.stdin.end();
      } catch (_) {}
      try {
        this._proc.kill('SIGKILL');
      } catch (_) {}
      this._proc = null;
    }
    this._h264Buf = Buffer.alloc(0);
    this._accessUnitNals = [];
    this._accessUnitHasVcl = false;
    this._pipeBroken = false;
  }

  _onH264Data(chunk) {
    this._h264Buf = Buffer.concat([this._h264Buf, chunk]);
    for (;;) {
      const { complete, rest } = consumeByStartCodes(this._h264Buf);
      if (complete.length === 0) break;
      this._h264Buf = rest;
      for (const nal of splitAnnexB(complete)) {
        this._consumeNal(Buffer.from(nal));
      }
    }
  }

  _consumeNal(nal) {
    const type = nalType(nal);

    // Parameter sets and AUD belong to the following picture. If they arrive
    // after a VCL NAL, close the previous access unit before retaining them.
    if ((type === 7 || type === 8 || type === 9) && this._accessUnitHasVcl) {
      this._flushAccessUnit();
    }

    if (type === 7) this._latestSps = Buffer.from(nal);
    if (type === 8) this._latestPps = Buffer.from(nal);

    if (!this._avcC && this._latestSps && this._latestPps) {
      this._avcC = buildAvcC(this._latestSps, this._latestPps);
      if (typeof this.onInit === 'function') {
        this.onInit(Buffer.from(this._avcC));
      }
    }

    // AUD starts a new access unit. Encoders that omit AUDs may emit multiple
    // VCL slices per frame, so only first_mb_in_slice=0 starts the next frame.
    const startsNewPicture = (type === 1 || type === 5) && firstMbInSlice(nal) === 0;
    if (type === 9 || (startsNewPicture && this._accessUnitHasVcl)) {
      this._flushAccessUnit();
    }

    this._accessUnitNals.push(nal);
    if (type === 1 || type === 5) {
      this._accessUnitHasVcl = true;
    }
  }

  _flushAccessUnit() {
    if (!this._accessUnitHasVcl || this._accessUnitNals.length === 0) {
      this._accessUnitNals = [];
      this._accessUnitHasVcl = false;
      return;
    }

    const key = this._accessUnitNals.some((nal) => nalType(nal) === 5);
    let nals = this._accessUnitNals;
    if (key && this._latestSps && this._latestPps) {
      const hasSps = nals.some((nal) => nalType(nal) === 7);
      const hasPps = nals.some((nal) => nalType(nal) === 8);
      if (!hasSps || !hasPps) {
        nals = [
          ...(hasSps ? [] : [this._latestSps]),
          ...(hasPps ? [] : [this._latestPps]),
          ...nals,
        ];
      }
    }

    const payload = buildAnnexB(nals);
    this._accessUnitNals = [];
    this._accessUnitHasVcl = false;
    if (payload.length > 0 && typeof this.onFrame === 'function') {
      this.onFrame({ key, data: payload });
    }
  }

  /**
   * @param {Buffer} rgba - full frame RGBA (width*height*4), dimensions must match started encoder.
   * @returns {Promise<void>}
   */
  writeFrame(rgba) {
    return new Promise((resolve, reject) => {
      if (this.desktopCapture) {
        resolve();
        return;
      }
      if (!this._proc || !this._proc.stdin.writable || this._pipeBroken) {
        resolve();
        return;
      }
      try {
        this._proc.stdin.write(rgba, (err) => {
          if (!err) {
            resolve();
            return;
          }
          if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
            this._pipeBroken = true;
            resolve();
            return;
          }
          reject(err);
        });
      } catch (e) {
        if (e.code === 'EPIPE' || e.code === 'ECONNRESET') {
          this._pipeBroken = true;
          resolve();
          return;
        }
        reject(e);
      }
    });
  }

  setQualityFromPercent(q) {
    const cq = Math.round(51 - (q / 100) * 35);
    this.cq = Math.min(51, Math.max(10, cq));
  }
}

module.exports = {
  HwH264Encoder,
  pickEncoder,
  buildFfmpegArgs,
  buildDesktopFfmpegArgs,
};
