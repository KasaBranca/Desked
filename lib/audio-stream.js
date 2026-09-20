/**
 * System-audio streaming pipeline:
 *   WASAPI loopback (default speakers) -> FFmpeg libopus -> Ogg packets.
 *
 * The captured PCM is fed to a long-running FFmpeg process; the Ogg output is
 * parsed into OpusHead (sent once) and Opus packets (sent as audio frames).
 */
'use strict';

const { spawn } = require('child_process');
const { WasapiLoopback } = require('./wasapi-loopback');
const { OggOpusParser } = require('./ogg-opus');

class AudioStream {
  constructor({ ffmpegPath = 'ffmpeg', bitrate = 96, onInit, onPacket, onError } = {}) {
    this.ffmpegPath = ffmpegPath;
    this.bitrate = bitrate;
    this.onInit = onInit || null;
    this.onPacket = onPacket || null;
    this.onError = onError || null;

    this._loop = null;
    this._proc = null;
    this._parser = null;
    this._running = false;
    this._opusHead = null;
    this._stderr = '';
  }

  isRunning() {
    return this._running;
  }

  get opusHead() {
    return this._opusHead;
  }

  /**
   * @returns {{sampleFormat:string, channels:number, sampleRate:number, blockAlign:number}}
   */
  start() {
    if (this._running) return this._loop ? this._loop.format : null;

    const loop = new WasapiLoopback();
    const format = loop.start();
    this._loop = loop;

    this._parser = new OggOpusParser({
      onHeader: (head) => {
        this._opusHead = Buffer.from(head);
        if (typeof this.onInit === 'function') this.onInit(this._opusHead);
      },
      onPacket: (packet) => {
        if (typeof this.onPacket === 'function') this.onPacket(packet);
      },
      onError: (err) => console.error('[AudioStream] Ogg parse error:', err.message),
    });

    this._spawnFfmpeg(format);
    loop.onPcm = (pcm) => this._write(pcm);
    loop.onError = (err) => {
      console.error('[AudioStream]', err.message);
      this.stop();
      if (typeof this.onError === 'function') this.onError(err);
    };

    this._running = true;
    return format;
  }

  _spawnFfmpeg(format) {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', format.ffmpegFormat,
      '-ar', String(format.sampleRate),
      '-ac', String(format.channels),
      '-i', 'pipe:0',
      '-af', 'aresample=48000',
      '-ac', '2',
      '-c:a', 'libopus',
      '-b:a', `${this.bitrate}k`,
      '-application', 'lowdelay',
      '-frame_duration', '20',
      '-vbr', 'on',
      '-flush_packets', '1',
      // The Ogg muxer buffers ~1 s per page by default; use short pages for low latency.
      '-page_duration', '10000',
      '-f', 'opus',
      'pipe:1',
    ];
    const proc = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this._proc = proc;
    this._stderr = '';

    proc.stdout.on('data', (chunk) => this._parser && this._parser.push(chunk));
    proc.stderr.on('data', (chunk) => {
      this._stderr = (this._stderr + chunk.toString()).slice(-2000);
    });
    proc.on('error', (err) => {
      console.error('[AudioStream] FFmpeg spawn error:', err.message);
      if (typeof this.onError === 'function') this.onError(err);
      this._proc = null;
    });
    proc.on('close', (code) => {
      if (this._running && code !== 0) {
        console.error('[AudioStream] FFmpeg exited', code, this._stderr.slice(-500));
      }
      this._proc = null;
    });
  }

  _write(pcm) {
    const proc = this._proc;
    if (!proc || !proc.stdin || !proc.stdin.writable) return;
    // Bound memory: drop audio if FFmpeg stalls badly rather than buffering.
    if (proc.stdin.writableLength > 2 * 1024 * 1024) return;
    try {
      proc.stdin.write(pcm);
    } catch (_) {
      // Ignore transient EPIPE; the close handler will report a hard failure.
    }
  }

  stop() {
    this._running = false;
    if (this._loop) {
      try {
        this._loop.stop();
      } catch (_) {}
      this._loop = null;
    }
    if (this._proc) {
      try {
        this._proc.stdin.end();
      } catch (_) {}
      try {
        this._proc.kill('SIGKILL');
      } catch (_) {}
      this._proc = null;
    }
    if (this._parser) this._parser.reset();
    this._opusHead = null;
  }
}

module.exports = { AudioStream };
