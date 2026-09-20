/**
 * Opus audio playback using WebCodecs AudioDecoder + WebAudio.
 *
 * Server packets:
 *   0x04 + u32 LE len + OpusHead
 *   0x05 + u32 LE len + raw Opus packet
 */
class AudioPlayer {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.decoder = null;
    this.enabled = false;
    this.available = 'AudioDecoder' in window;

    this._head = null;
    this._channels = 2;
    this._ts = 0;
    this._configured = false;
    this._pending = [];
    this._nextTime = 0;
    this._sources = new Set();

    this.onStateChange = null;
  }

  /** Create/resume the AudioContext. Must be called from a user gesture. */
  unlock() {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.gain = this.ctx.createGain();
        this.gain.gain.value = 1;
        this.gain.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch (_) {}
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (this.enabled) {
      this.unlock();
      this._nextTime = 0;
      if (this._head && !this._configured) this._configureDecoder();
    } else {
      this._stopSources();
      this._pending = [];
    }
    if (typeof this.onStateChange === 'function') this.onStateChange(this.enabled);
  }

  handleInitPacket(buffer) {
    if (!this.available) return;
    if (buffer.byteLength < 5) return;
    const dv = new DataView(buffer);
    const len = dv.getUint32(1, true);
    if (len < 19 || buffer.byteLength < 5 + len) return;
    const head = new Uint8Array(buffer, 5, len).slice();
    // Guard against a JPEG frame whose first byte happens to be 0x04.
    if (String.fromCharCode(head[0], head[1], head[2], head[3]) !== 'Opus') return;

    this._head = head;
    this._channels = head[9] || 2;
    if (this._configured) return;
    if (this.enabled) this._configureDecoder();
  }

  handlePacket(buffer) {
    if (!this.available || !this.enabled) return;
    if (buffer.byteLength < 5) return;
    const dv = new DataView(buffer);
    const len = dv.getUint32(1, true);
    if (len === 0 || buffer.byteLength < 5 + len) return;
    const data = new Uint8Array(buffer, 5, len);

    if (!this._configured) {
      if (this._head) this._configureDecoder();
      this._pending.push(data.slice());
      if (this._pending.length > 50) this._pending.shift();
      return;
    }
    this._decode(data);
  }

  _configureDecoder() {
    if (this._configured || !this._head) return;
    try {
      if (this.decoder) {
        try { this.decoder.close(); } catch (_) {}
        this.decoder = null;
      }
      this.decoder = new AudioDecoder({
        output: (data) => this._onData(data),
        error: (e) => {
          console.warn('[Audio] Decoder error:', e && e.message ? e.message : e);
          this._configured = false;
          try { if (this.decoder) this.decoder.close(); } catch (_) {}
          this.decoder = null;
        },
      });
      this.decoder.configure({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: this._channels,
        description: this._head,
      });
      this._configured = true;
      for (const data of this._pending.splice(0)) this._decode(data);
    } catch (e) {
      console.warn('[Audio] configure failed:', e.message || e);
      this._configured = false;
    }
  }

  _decode(data) {
    if (!this.decoder || this.decoder.state !== 'configured') return;
    try {
      this.decoder.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: this._ts,
          duration: 20000,
          data,
        })
      );
      this._ts += 20000;
    } catch (e) {
      console.warn('[Audio] decode failed:', e.message || e);
    }
  }

  _onData(audioData) {
    try {
      if (!this.ctx || !this.gain) {
        audioData.close();
        return;
      }
      const channels = audioData.numberOfChannels;
      const frames = audioData.numberOfFrames;
      const sampleRate = audioData.sampleRate || 48000;
      const buffer = this.ctx.createBuffer(channels, frames, sampleRate);
      const tmp = new Float32Array(frames);
      for (let c = 0; c < channels; c++) {
        audioData.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
        buffer.copyToChannel(tmp, c);
      }
      audioData.close();

      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.gain);
      src.onended = () => this._sources.delete(src);
      this._sources.add(src);

      const now = this.ctx.currentTime;
      if (this._nextTime < now + 0.02 || this._nextTime > now + 0.6) {
        this._nextTime = now + 0.06;
      }
      src.start(this._nextTime);
      this._nextTime += buffer.duration;
    } catch (e) {
      try { audioData.close(); } catch (_) {}
      console.warn('[Audio] playback:', e.message || e);
    }
  }

  _stopSources() {
    for (const src of this._sources) {
      try { src.stop(); } catch (_) {}
    }
    this._sources.clear();
  }

  destroy() {
    this.setEnabled(false);
    if (this.decoder) {
      try { this.decoder.close(); } catch (_) {}
      this.decoder = null;
    }
    this._configured = false;
    this._pending = [];
    this._head = null;
    if (this.ctx) {
      try { this.ctx.close(); } catch (_) {}
      this.ctx = null;
    }
  }
}
