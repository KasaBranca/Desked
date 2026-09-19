const koffi = require('koffi');
const sharp = require('sharp');
const config = require('./config');

// --- Load Windows DLLs ---
const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');

// --- DPI Awareness (get real screen resolution) ---
const SetProcessDPIAware = user32.func('__stdcall', 'SetProcessDPIAware', 'bool', []);
SetProcessDPIAware();

// --- GDI Function Declarations ---
const GetDC = user32.func('__stdcall', 'GetDC', 'void*', ['void*']);
const ReleaseDC = user32.func('__stdcall', 'ReleaseDC', 'int', ['void*', 'void*']);
const GetSystemMetrics = user32.func('__stdcall', 'GetSystemMetrics', 'int', ['int']);

const CreateCompatibleDC = gdi32.func('__stdcall', 'CreateCompatibleDC', 'void*', ['void*']);
const CreateCompatibleBitmap = gdi32.func('__stdcall', 'CreateCompatibleBitmap', 'void*', ['void*', 'int', 'int']);
const SelectObject = gdi32.func('__stdcall', 'SelectObject', 'void*', ['void*', 'void*']);
const BitBlt = gdi32.func('__stdcall', 'BitBlt', 'bool', ['void*', 'int', 'int', 'int', 'int', 'void*', 'int', 'int', 'uint32']);
const GetDIBits = gdi32.func('__stdcall', 'GetDIBits', 'int', ['void*', 'void*', 'uint', 'uint', 'void*', 'void*', 'uint']);
const DeleteObject = gdi32.func('__stdcall', 'DeleteObject', 'bool', ['void*']);
const DeleteDC = gdi32.func('__stdcall', 'DeleteDC', 'bool', ['void*']);

// Constants
const SRCCOPY = 0x00CC0020;
const CAPTUREBLT = 0x40000000;
const SRCCOPY_CAPTUREBLT = SRCCOPY | CAPTUREBLT;
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const BI_RGB = 0;
const DIB_RGB_COLORS = 0;

class ScreenCapture {
  constructor() {
    /** @type {'jpeg'|'h264'} */
    this.streamMode = config.streamMode === 'h264' ? 'h264' : 'jpeg';
    this.quality = config.captureQuality;
    this.scale = config.captureScale;
    this.screenWidth = GetSystemMetrics(SM_CXSCREEN);
    this.screenHeight = GetSystemMetrics(SM_CYSCREEN);

    // Pre-allocate GDI resources
    this._desktopDC = null;
    this._memDC = null;
    this._hBitmap = null;
    this._pixelBuffer = null;
    this._prevPixelBuffer = null;
    this._bmiBuffer = null;
    this._initialized = false;
    this._firstFrame = true;

    // Change detection
    this._lastFrameSize = 0;
    this._unchangedCount = 0;

    this._init();
    console.log(`[ScreenCapture] Screen: ${this.screenWidth}x${this.screenHeight} (GDI direct capture)`);
  }

  setStreamMode(mode) {
    this.streamMode = mode === 'h264' ? 'h264' : 'jpeg';
  }

  _init() {
    try {
      // Get desktop DC
      this._desktopDC = GetDC(null);
      if (!this._desktopDC) throw new Error('GetDC failed');

      // Create compatible DC and bitmap
      this._memDC = CreateCompatibleDC(this._desktopDC);
      if (!this._memDC) throw new Error('CreateCompatibleDC failed');

      this._hBitmap = CreateCompatibleBitmap(this._desktopDC, this.screenWidth, this.screenHeight);
      if (!this._hBitmap) throw new Error('CreateCompatibleBitmap failed');

      SelectObject(this._memDC, this._hBitmap);

      // Pre-allocate pixel buffers (BGRA = 4 bytes per pixel)
      const bufferSize = this.screenWidth * this.screenHeight * 4;
      this._pixelBuffer = Buffer.alloc(bufferSize);
      this._prevPixelBuffer = Buffer.alloc(bufferSize);

      // Pre-allocate BITMAPINFOHEADER (40 bytes)
      this._bmiBuffer = Buffer.alloc(40);
      this._bmiBuffer.writeUInt32LE(40, 0);                    // biSize
      this._bmiBuffer.writeInt32LE(this.screenWidth, 4);       // biWidth
      this._bmiBuffer.writeInt32LE(-this.screenHeight, 8);     // biHeight (negative = top-down)
      this._bmiBuffer.writeUInt16LE(1, 12);                    // biPlanes
      this._bmiBuffer.writeUInt16LE(32, 14);                   // biBitCount (32-bit BGRA)
      this._bmiBuffer.writeUInt32LE(BI_RGB, 16);               // biCompression
      // Rest is 0 (already zeroed by Buffer.alloc)

      this._initialized = true;
    } catch (err) {
      console.error('[ScreenCapture] Initialization failed:', err.message);
      this._cleanup();
    }
  }

  _cleanup() {
    if (this._hBitmap) { DeleteObject(this._hBitmap); this._hBitmap = null; }
    if (this._memDC) { DeleteDC(this._memDC); this._memDC = null; }
    if (this._desktopDC) { ReleaseDC(null, this._desktopDC); this._desktopDC = null; }
    this._initialized = false;
  }

  setQuality(quality) {
    this.quality = Math.min(100, Math.max(1, quality));
  }

  setScale(scale) {
    this.scale = Math.min(1.0, Math.max(0.1, scale));
  }

  _swapBGRAtoRGBA(buffer) {
    const u32 = new Uint32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength >> 2);
    for (let i = 0; i < u32.length; i++) {
      const v = u32[i];
      // BGRA [B,G,R,A] in memory → swap B and R, and force A to 0xFF (255) to prevent black screen
      u32[i] = 0xFF000000 | (v & 0x0000FF00) | ((v >> 16) & 0xFF) | ((v & 0xFF) << 16);
    }
  }

  /**
   * Copy a sub-rectangle out of a BGRA full-frame buffer into a tightly packed RGBA buffer.
   * Avoids the full-screen BGRA→RGBA swap; we only convert the pixels we will actually encode.
   */
  _extractRegionToRGBA(src, stride, x, y, w, h) {
    const srcU32 = new Uint32Array(src.buffer, src.byteOffset, src.byteLength >> 2);
    const out = Buffer.allocUnsafe(w * h * 4);
    const dstU32 = new Uint32Array(out.buffer, out.byteOffset, out.byteLength >> 2);
    let di = 0;
    for (let row = y; row < y + h; row++) {
      const base = row * stride + x;
      for (let col = 0; col < w; col++) {
        const v = srcU32[base + col];
        // BGRA → RGBA with alpha forced to 0xFF
        dstU32[di++] = 0xFF000000 | (v & 0x0000FF00) | ((v >> 16) & 0xFF) | ((v & 0xFF) << 16);
      }
    }
    return out;
  }

  /**
   * Find bounding box of changed pixels between two frames.
   * Uses native Buffer.compare (memcmp) per row to quickly skip unchanged rows,
   * which is typically orders of magnitude faster than the per-pixel JS loop.
   * Returns {x, y, w, h} or null if no change.
   */
  _findDiff(curr, prev, width, height) {
    const rowBytes = width * 4;

    // Pass 1: row-level memcmp → y range of changed rows
    let minY = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      const off = y * rowBytes;
      if (curr.compare(prev, off, off + rowBytes, off, off + rowBytes) !== 0) {
        if (minY === -1) minY = y;
        maxY = y;
      }
    }
    if (minY === -1) return null; // No difference

    // Pass 2: per-pixel scan only within changed rows → x bounds
    const u32Curr = new Uint32Array(curr.buffer, curr.byteOffset, curr.byteLength >> 2);
    const u32Prev = new Uint32Array(prev.buffer, prev.byteOffset, prev.byteLength >> 2);
    let minX = width;
    let maxX = -1;
    for (let y = minY; y <= maxY; y++) {
      const base = y * width;
      for (let x = 0; x < width; x++) {
        if (u32Curr[base + x] !== u32Prev[base + x]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }

    if (maxX === -1) return null;

    // Pad by 2 pixels to avoid edge compression artifacts
    minX = Math.max(0, minX - 2);
    minY = Math.max(0, minY - 2);
    maxX = Math.min(width - 1, maxX + 2);
    maxY = Math.min(height - 1, maxY + 2);

    return {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1
    };
  }

  forceFullFrame() {
    this._firstFrame = true;
  }

  async captureFrame() {
    if (!this._initialized) return null;

    try {
      const t0 = performance.now();
      
      // 1. BitBlt: Copy screen to memory DC (including layered windows/cursor)
      const ok = BitBlt(
        this._memDC, 0, 0, this.screenWidth, this.screenHeight,
        this._desktopDC, 0, 0, SRCCOPY_CAPTUREBLT
      );
      if (!ok) return null;
      const t1 = performance.now();

      // 2. GetDIBits: Copy bitmap data to pixel buffer
      const lines = GetDIBits(
        this._memDC, this._hBitmap,
        0, this.screenHeight,
        this._pixelBuffer, this._bmiBuffer,
        DIB_RGB_COLORS
      );
      if (lines === 0) return null;
      const t2 = performance.now();

      // H.264 fast path: encoder accepts BGRA directly (see hw-h264-encoder.js pix_fmt=bgra)
      // and handles inter-frame diffing internally, so skip the expensive JS swap+diff loops.
      if (this.streamMode === 'h264') {
        this._firstFrame = false;
        let out = this._pixelBuffer;
        let outWidth = this.screenWidth;
        let outHeight = this.screenHeight;
        if (this.scale < 1.0) {
          const scaledWidth = Math.max(2, Math.round(this.screenWidth * this.scale) & ~1);
          const scaledHeight = Math.max(2, Math.round(this.screenHeight * this.scale) & ~1);
          out = await sharp(this._pixelBuffer, {
            raw: {
              width: this.screenWidth,
              height: this.screenHeight,
              channels: 4,
            },
          })
            .resize(scaledWidth, scaledHeight, { fit: 'fill', fastShrinkOnLoad: true })
            .raw()
            .toBuffer();
          outWidth = scaledWidth;
          outHeight = scaledHeight;
        }
        // Pointer swap so the next BitBlt/GetDIBits writes into the other buffer,
        // keeping `out` valid until the encoder has consumed it.
        const temp = this._prevPixelBuffer;
        this._prevPixelBuffer = this._pixelBuffer;
        this._pixelBuffer = temp;
        return {
          buffer: null,
          rgba: out,
          width: outWidth,
          height: outHeight,
          hasChanged: true,
        };
      }

      // 3. Calculate Difference on raw BGRA (byte-order agnostic — memcmp just needs same format).
      //    Skipping full-frame BGRA→RGBA swap here saves ~8MB/frame of JS work at 1080p.
      let diffBox = null;
      if (this._firstFrame) {
        this._firstFrame = false;
        diffBox = { x: 0, y: 0, width: this.screenWidth, height: this.screenHeight };
      } else {
        diffBox = this._findDiff(this._pixelBuffer, this._prevPixelBuffer, this.screenWidth, this.screenHeight);
      }

      // Pointer Swap ZERO-COPY: Previous becomes Current, Current becomes target for next GetDIBits!
      const temp = this._prevPixelBuffer;
      this._prevPixelBuffer = this._pixelBuffer;
      this._pixelBuffer = temp;

      if (!diffBox) {
        return { buffer: null, hasChanged: false };
      }

      // 4. Copy just the diff region into a tightly packed RGBA buffer (also performs BGRA→RGBA).
      //    This keeps _prevPixelBuffer pristine BGRA for the next frame's diff, and avoids
      //    paying a full-screen JS pixel swap on every frame.
      const regionRGBA = this._extractRegionToRGBA(
        this._prevPixelBuffer,
        this.screenWidth,
        diffBox.x,
        diffBox.y,
        diffBox.width,
        diffBox.height,
      );

      // 5. Build Sharp pipeline directly over the packed region (no extract needed).
      let pipeline = sharp(regionRGBA, {
        raw: {
          width: diffBox.width,
          height: diffBox.height,
          channels: 4,
        },
      });

      // Scaling applies ONLY if requested, normally 1.0 for highest speed
      if (this.scale < 1.0) {
        pipeline = pipeline.resize(
          Math.max(1, Math.round(diffBox.width * this.scale)), 
          Math.max(1, Math.round(diffBox.height * this.scale)), 
          { fit: 'fill', fastShrinkOnLoad: true }
        );
      }

      // Return an encode PROMISE (not awaited) so the caller can start the next
      // BitBlt/GetDIBits while Sharp runs on the libuv threadpool. This pipelines
      // capture (main thread) and JPEG encode (worker thread) for ~30–40% more FPS.
      const jpegPromise = pipeline
        .jpeg({
          quality: this.quality <= 90 ? this.quality : 85,
          mozjpeg: false,
          chromaSubsampling: '4:2:0',
          force: true,
        })
        .toBuffer();

      const scaledWidth = Math.max(1, Math.round(diffBox.width * this.scale));
      const scaledHeight = Math.max(1, Math.round(diffBox.height * this.scale));

      const isFull = (diffBox.x === 0 && diffBox.y === 0 &&
                      diffBox.width === this.screenWidth &&
                      diffBox.height === this.screenHeight);

      return {
        bufferPromise: jpegPromise,
        x: Math.round(diffBox.x * this.scale),
        y: Math.round(diffBox.y * this.scale),
        width: scaledWidth,
        height: scaledHeight,
        hasChanged: true,
        isFullFrame: isFull,
      };
    } catch (err) {
      console.error('[ScreenCapture] Capture failed:', err.message);
      return null;
    }
  }

  getScreenInfo() {
    return {
      width: Math.round(this.screenWidth * this.scale),
      height: Math.round(this.screenHeight * this.scale),
      physicalWidth: this.screenWidth,
      physicalHeight: this.screenHeight
    };
  }

  destroy() {
    this._cleanup();
  }
}

module.exports = new ScreenCapture();
