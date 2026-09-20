/**
 * WASAPI loopback capture for the default render (speaker) device.
 *
 * Windows exposes no DirectShow/FFmpeg loopback input, so we call the WASAPI
 * COM APIs directly through koffi. This captures whatever the PC is playing
 * (system audio) without any virtual audio cable or "Stereo Mix".
 */
'use strict';

const koffi = require('koffi');

const CLSID_MMDeviceEnumerator = '{BCDE0395-E52F-467C-8E3D-C4579291692E}';
const IID_IMMDeviceEnumerator = '{A95664D2-9614-4F35-A746-DE8DB63617E6}';
const IID_IAudioClient = '{1CB9AD4C-DBFA-4c32-B178-C2F568A703B2}';
const IID_IAudioCaptureClient = '{C8ADBD64-E71E-48a0-A4DE-185C395CD317}';

const CLSCTX_ALL = 0x17;
const AUDCLNT_SHAREMODE_SHARED = 0;
const AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
const AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
const AUDCLNT_E_DEVICE_INVALIDATED = 0x88890004;

const PTR_SIZE = 8;

function guidBuffer(s) {
  const hex = s.replace(/[{}-]/g, '');
  const b = Buffer.alloc(16);
  b.writeUInt32LE(parseInt(hex.slice(0, 8), 16), 0);
  b.writeUInt16LE(parseInt(hex.slice(8, 12), 16), 4);
  b.writeUInt16LE(parseInt(hex.slice(12, 16), 16), 6);
  for (let i = 0; i < 8; i++) b[8 + i] = parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16);
  return b;
}

let ole32 = null;
let CoInitializeEx = null;
let CoCreateInstance = null;
let CoTaskMemFree = null;

function loadOle32() {
  if (ole32) return;
  if (process.platform !== 'win32') throw new Error('WASAPI is only available on Windows');
  ole32 = koffi.load('ole32.dll');
  CoInitializeEx = ole32.func('CoInitializeEx', 'int32', ['void *', 'uint32']);
  CoCreateInstance = ole32.func('CoCreateInstance', 'int32', ['void *', 'void *', 'uint32', 'void *', 'void *']);
  CoTaskMemFree = ole32.func('CoTaskMemFree', 'void', ['void *']);
}

/** Read a COM vtable method pointer and return a callable (first arg = this). */
function comMethod(obj, index, result, args) {
  const vtable = koffi.decode(obj, 'void *');
  const addr = koffi.decode(vtable, index * PTR_SIZE, 'void *');
  const proto = koffi.proto(result, ['void *', ...args]);
  return koffi.decode(addr, proto);
}

/** Copy native memory into a standalone Buffer (koffi.view shares memory). */
function copyView(ptr, size) {
  const out = Buffer.allocUnsafe(size);
  Buffer.from(koffi.view(ptr, size)).copy(out);
  return out;
}

function readFloat(format) {
  const wFormatTag = format.readUInt16LE(0);
  const channels = format.readUInt16LE(2);
  const sampleRate = format.readUInt32LE(4);
  const bits = format.readUInt16LE(14);
  const cbSize = format.readUInt16LE(16);

  let tag = wFormatTag;
  if (wFormatTag === 0xfffe && cbSize >= 22 && format.length >= 40) {
    // WAVE_FORMAT_EXTENSIBLE: SubFormat GUID starts at offset 24.
    tag = format.readUInt16LE(24);
  }

  let sampleFormat;
  if (tag === 0x0003) sampleFormat = 'f32';
  else if (tag === 0x0001) {
    if (bits === 16) sampleFormat = 's16';
    else if (bits === 24) sampleFormat = 's24';
    else if (bits === 32) sampleFormat = 's32';
    else if (bits === 8) sampleFormat = 'u8';
  }
  if (!sampleFormat || !channels || !sampleRate) return null;

  const bytesPerSample = bits / 8;
  return {
    sampleFormat,
    ffmpegFormat: sampleFormat === 'u8' ? 'u8' : `${sampleFormat}le`,
    channels,
    sampleRate,
    bits,
    bytesPerSample,
    blockAlign: bytesPerSample * channels,
  };
}

class WasapiLoopback {
  constructor({ pollMs = 10 } = {}) {
    this.pollMs = pollMs;
    this.onPcm = null;
    this.onError = null;
    this.format = null;

    this._pEnum = null;
    this._pDevice = null;
    this._pClient = null;
    this._pCapture = null;
    this._timer = null;
    this._running = false;

    this._bufs = {
      next: Buffer.alloc(4),
      data: Buffer.alloc(8),
      frames: Buffer.alloc(4),
      flags: Buffer.alloc(4),
      devPos: Buffer.alloc(8),
      qpcPos: Buffer.alloc(8),
    };
  }

  isRunning() {
    return this._running;
  }

  /**
   * Open the default render endpoint in loopback mode.
   * @returns {{sampleFormat:string, channels:number, sampleRate:number, blockAlign:number}}
   */
  start() {
    if (this._running) return this.format;
    loadOle32();

    const hrInit = CoInitializeEx(null, 0x0);
    // S_FALSE / RPC_E_CHANGED_MODE mean COM is already initialized.
    if (hrInit !== 0 && hrInit !== 1 && (hrInit >>> 0) !== 0x80010106) {
      throw new Error(`CoInitializeEx failed (0x${(hrInit >>> 0).toString(16)})`);
    }

    const ppEnum = Buffer.alloc(8);
    let hr = CoCreateInstance(
      guidBuffer(CLSID_MMDeviceEnumerator), null, CLSCTX_ALL, guidBuffer(IID_IMMDeviceEnumerator), ppEnum
    );
    if (hr !== 0) throw new Error(`CoCreateInstance(MMDeviceEnumerator) failed (0x${(hr >>> 0).toString(16)})`);
    this._pEnum = koffi.decode(ppEnum, 'void *');

    const ppDev = Buffer.alloc(8);
    const pEnumGetDefault = comMethod(this._pEnum, 4, 'int32', ['uint32', 'uint32', 'void *']);
    hr = pEnumGetDefault(this._pEnum, 0 /*eRender*/, 0 /*eConsole*/, ppDev);
    if (hr !== 0) {
      this._release();
      throw new Error(`GetDefaultAudioEndpoint failed (0x${(hr >>> 0).toString(16)})`);
    }
    this._pDevice = koffi.decode(ppDev, 'void *');

    const ppClient = Buffer.alloc(8);
    const devActivate = comMethod(this._pDevice, 3, 'int32', ['void *', 'uint32', 'void *', 'void *']);
    hr = devActivate(this._pDevice, guidBuffer(IID_IAudioClient), CLSCTX_ALL, null, ppClient);
    if (hr !== 0) {
      this._release();
      throw new Error(`IAudioClient activation failed (0x${(hr >>> 0).toString(16)})`);
    }
    this._pClient = koffi.decode(ppClient, 'void *');

    const ppWfx = Buffer.alloc(8);
    const getMix = comMethod(this._pClient, 8, 'int32', ['void *']);
    hr = getMix(this._pClient, ppWfx);
    if (hr !== 0) {
      this._release();
      throw new Error(`GetMixFormat failed (0x${(hr >>> 0).toString(16)})`);
    }
    const pWfx = koffi.decode(ppWfx, 'void *');
    // Copy the WAVEFORMATEX(TENSIBLE) so we can free the COM allocation.
    const wfxSize = Math.max(18, 18 + koffi.decode(pWfx, 16, 'uint16'));
    const format = copyView(pWfx, wfxSize);
    CoTaskMemFree(pWfx);

    const parsed = readFloat(format);
    if (!parsed) {
      this._release();
      throw new Error('Unsupported WASAPI mix format');
    }
    this.format = parsed;

    const initAudio = comMethod(this._pClient, 3, 'int32', ['uint32', 'uint32', 'int64', 'int64', 'void *', 'void *']);
    hr = initAudio(
      this._pClient,
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_LOOPBACK,
      1000000n, // 100 ms buffer
      0n,
      format,
      null
    );
    if (hr !== 0) {
      this._release();
      throw new Error(`IAudioClient::Initialize failed (0x${(hr >>> 0).toString(16)})`);
    }

    const ppCap = Buffer.alloc(8);
    const getService = comMethod(this._pClient, 14, 'int32', ['void *', 'void *']);
    hr = getService(this._pClient, guidBuffer(IID_IAudioCaptureClient), ppCap);
    if (hr !== 0) {
      this._release();
      throw new Error(`GetService(IAudioCaptureClient) failed (0x${(hr >>> 0).toString(16)})`);
    }
    this._pCapture = koffi.decode(ppCap, 'void *');

    const start = comMethod(this._pClient, 10, 'int32', []);
    hr = start(this._pClient);
    if (hr !== 0) {
      this._release();
      throw new Error(`IAudioClient::Start failed (0x${(hr >>> 0).toString(16)})`);
    }

    this._getNextSize = comMethod(this._pCapture, 5, 'int32', ['void *']);
    this._getBuffer = comMethod(this._pCapture, 3, 'int32', ['void *', 'void *', 'void *', 'void *', 'void *']);
    this._releaseBuffer = comMethod(this._pCapture, 4, 'int32', ['uint32']);

    this._running = true;
    this._timer = setInterval(() => this._drain(), this.pollMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    return this.format;
  }

  _drain() {
    if (!this._running) return;
    const b = this._bufs;
    try {
      let hr = this._getNextSize(this._pCapture, b.next);
      if (hr !== 0) return this._fail(hr);
      let avail = b.next.readUInt32LE(0);
      while (avail > 0) {
        hr = this._getBuffer(this._pCapture, b.data, b.frames, b.flags, b.devPos, b.qpcPos);
        if (hr !== 0) return this._fail(hr);
        const pData = koffi.decode(b.data, 'void *');
        const frames = b.frames.readUInt32LE(0);
        const flags = b.flags.readUInt32LE(0);
        if (frames > 0 && typeof this.onPcm === 'function') {
          const size = frames * this.format.blockAlign;
          let pcm;
          if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
            pcm = Buffer.alloc(size);
          } else if (pData) {
            pcm = copyView(pData, size);
          }
          if (pcm) this.onPcm(pcm, frames);
        }
        this._releaseBuffer(this._pCapture, frames);
        hr = this._getNextSize(this._pCapture, b.next);
        if (hr !== 0) return this._fail(hr);
        avail = b.next.readUInt32LE(0);
      }
    } catch (err) {
      this._fail(err);
    }
  }

  _fail(err) {
    const code = typeof err === 'number' ? err >>> 0 : null;
    this.stop();
    const isInvalidated = code === AUDCLNT_E_DEVICE_INVALIDATED;
    if (typeof this.onError === 'function') {
      this.onError(new Error(isInvalidated ? 'Audio device changed or was removed' : `WASAPI capture failed (${err && err.message ? err.message : err})`));
    }
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._running = false;
    if (this._pClient) {
      try {
        const stop = comMethod(this._pClient, 11, 'int32', []);
        stop(this._pClient);
      } catch (_) {}
    }
    this._release();
  }

  _release() {
    const release = (obj) => {
      if (!obj) return;
      try {
        comMethod(obj, 2, 'uint32', [])(obj);
      } catch (_) {}
    };
    release(this._pCapture);
    release(this._pClient);
    release(this._pDevice);
    release(this._pEnum);
    this._pCapture = null;
    this._pClient = null;
    this._pDevice = null;
    this._pEnum = null;
    this.format = null;
  }
}

module.exports = { WasapiLoopback };
