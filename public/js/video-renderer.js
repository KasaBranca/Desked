/**
 * H.264 WebCodecs renderer — draws decoded frames to a canvas (same role as CanvasRenderer for input mapping).
 */
class VideoRenderer {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.screenWidth = 1920;
    this.screenHeight = 1080;

    this.baseScale = 1;
    this.basePanX = 0;
    this.basePanY = 0;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.minZoom = 1;
    this.maxZoom = 4;

    this.frameCount = 0;
    this.lastFpsTime = performance.now();
    this.fps = 0;
    this.lastFrameSize = 0;
    this.onFirstFrame = null;
    this._hasRenderedFrame = false;

    this.decoder = null;
    this._ts = 0;
    this._configured = false;
    this._needsKeyframe = true;
    this._pending = [];
    this._configPromise = null;
    this._presentationQueue = [];
    this._presentationStarted = false;
    this._targetFps = 60;
    this._presentationIntervalMs = 1000 / this._targetFps;
    this._nextPresentationAt = 0;
    this._presentationRaf = 0;
    this._ensurePresentationLoop();
    /** While decoder is not ready, drop deltas first so a key is not evicted by the cap. */
    this._maxPendingChunks = 180;

    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  setScreenSize(width, height) {
    if (this.screenWidth === width && this.screenHeight === height) return;
    this.screenWidth = width;
    this.screenHeight = height;
    this._resize();
  }

  setTargetFps(fps) {
    const value = Number(fps);
    this._targetFps = Number.isFinite(value) ? Math.max(1, Math.min(120, value)) : 60;
    this._presentationIntervalMs = 1000 / this._targetFps;
    this._nextPresentationAt = 0;
  }

  _resize() {
    this.canvas.width = this.screenWidth;
    this.canvas.height = this.screenHeight;
    this.canvas.style.width = this.screenWidth + 'px';
    this.canvas.style.height = this.screenHeight + 'px';
    this.canvas.style.maxWidth = 'none';
    this.canvas.style.maxHeight = 'none';
    this.canvas.style.position = 'absolute';
    this.canvas.style.left = '0px';
    this.canvas.style.top = '0px';

    const containerW = window.innerWidth;
    const containerH = window.innerHeight;
    const aspectRatio = this.screenWidth / this.screenHeight;

    if (containerW / containerH > aspectRatio) {
      this.baseScale = containerH / this.screenHeight;
    } else {
      this.baseScale = containerW / this.screenWidth;
    }

    this.basePanX = (containerW - (this.screenWidth * this.baseScale)) / 2;
    this.basePanY = (containerH - (this.screenHeight * this.baseScale)) / 2;

    this._clampPan();
    this._updateTransform();
  }

  _updateTransform() {
    this.canvas.style.transformOrigin = '0px 0px';
    const finalScale = this.baseScale * this.zoom;
    const finalX = Math.round(this.basePanX + this.panX);
    const finalY = Math.round(this.basePanY + this.panY);
    this.canvas.style.transform = `translate(${finalX}px, ${finalY}px) scale(${finalScale})`;
  }

  async configureDecoder() {
    if (!('VideoDecoder' in window)) {
      throw new Error('WebCodecs VideoDecoder is not available in this browser');
    }
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch (_) {}
      this.decoder = null;
    }
    this._configured = false;
    this._ts = 0;
    for (const frame of this._presentationQueue.splice(0)) {
      frame.close();
    }
    this._presentationStarted = false;
    this._nextPresentationAt = 0;
    this._ensurePresentationLoop();

    const base = {
      codec: 'avc1.42E02A',
      avc: { format: 'annexb' },
      codedWidth: this.screenWidth,
      codedHeight: this.screenHeight,
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true,
    };

    let cfg = base;
    const support = await VideoDecoder.isConfigSupported(base);
    if (support.supported && support.config) {
      cfg = support.config;
    }

    this.decoder = new VideoDecoder({
      output: (frame) => {
        this._presentationQueue.push(frame);
        if (this._presentationQueue.length > 12) {
          const dropped = this._presentationQueue.shift();
          dropped.close();
        }
      },
      error: (e) => {
        console.error('[VideoRenderer] Decoder error:', e);
        this._needsKeyframe = true;
      },
    });

    this.decoder.configure(cfg);
    this._configured = true;
    this._needsKeyframe = true;

    for (const chunk of this._pending.splice(0)) {
      this._decodeChunk(chunk);
    }
  }

  _presentFrame() {
    const now = performance.now();
    if (!this._presentationStarted && this._presentationQueue.length >= 4) {
      this._presentationStarted = true;
      this._nextPresentationAt = now;
    }

    if (
      this._presentationStarted &&
      this._presentationQueue.length > 0 &&
      now >= this._nextPresentationAt
    ) {
      while (this._presentationQueue.length > 8) {
        const dropped = this._presentationQueue.shift();
        dropped.close();
      }

      const frame = this._presentationQueue.shift();
      try {
        const w = frame.displayWidth || frame.codedWidth;
        const h = frame.displayHeight || frame.codedHeight;
        this.setScreenSize(w, h);
        this.ctx.drawImage(frame, 0, 0);
        this.lastFrameSize = w * h * 2;
        this.frameCount++;
        if (!this._hasRenderedFrame) {
          this._hasRenderedFrame = true;
          if (typeof this.onFirstFrame === 'function') this.onFirstFrame();
        }
        const elapsed = now - this.lastFpsTime;
        if (elapsed >= 1000) {
          this.fps = Math.round((this.frameCount / elapsed) * 1000);
          this.frameCount = 0;
          this.lastFpsTime = now;
        }
      } finally {
        frame.close();
      }

      this._nextPresentationAt += this._presentationIntervalMs;
      if (this._nextPresentationAt < now - this._presentationIntervalMs) {
        this._nextPresentationAt = now + this._presentationIntervalMs;
      }
    }

    if (this._presentationStarted && this._presentationQueue.length === 0) {
      this._presentationStarted = false;
      this._nextPresentationAt = 0;
    }
    this._presentationRaf = requestAnimationFrame(() => this._presentFrame());
  }

  _ensurePresentationLoop() {
    if (!this._presentationRaf) {
      this._presentationRaf = requestAnimationFrame(() => this._presentFrame());
    }
  }

  _trimPendingQueue() {
    while (this._pending.length > this._maxPendingChunks) {
      const di = this._pending.findIndex((c) => c.type === 'delta');
      if (di >= 0) this._pending.splice(di, 1);
      else this._pending.shift();
    }
  }

  _decodeChunk(chunk) {
    if (!this.decoder || this.decoder.state === 'closed') return;
    if (this._needsKeyframe) {
      if (chunk.type !== 'key') return;
      this._needsKeyframe = false;
    }
    try {
      this.decoder.decode(chunk);
    } catch (e) {
      console.warn('[VideoRenderer] decode:', e.message || e);
      this._needsKeyframe = true;
    }
  }

  /**
   * Binary packet: 0x01 + u32 LE len + avcC (currently unused in annex-b mode)
   */
  handleInitPacket(buffer) {
    this.lastFrameSize = buffer.byteLength;
    if (!this._configured && !this._configPromise) {
      this._configPromise = this.configureDecoder().finally(() => {
        this._configPromise = null;
      });
    }
    return this._configPromise || Promise.resolve();
  }

  /**
   * Binary packet: 0x02 + f64 ts (µs LE) + u8 key + u32 len + annex-b AU
   */
  handleFramePacket(buffer) {
    if (buffer.byteLength < 14) return;
    const dv = new DataView(buffer);
    const ts = Math.round(dv.getFloat64(1, true));
    const key = dv.getUint8(9);
    const len = dv.getUint32(10, true);
    if (buffer.byteLength < 14 + len) return;
    const data = new Uint8Array(buffer, 14, len);
    this.lastFrameSize = buffer.byteLength;

    const chunk = new EncodedVideoChunk({
      type: key ? 'key' : 'delta',
      timestamp: ts,
      data,
    });

    if (!this._configured) {
      if (!this._configPromise) {
        this._configPromise = this.configureDecoder().finally(() => {
          this._configPromise = null;
        });
      }
      this._pending.push(chunk);
      this._trimPendingQueue();
      return;
    }
    this._decodeChunk(chunk);
  }

  canvasToNormalized(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    let x = (clientX - rect.left) / rect.width;
    let y = (clientY - rect.top) / rect.height;
    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    };
  }

  setZoom(newZoom, focusX, focusY) {
    const oldZoom = this.zoom;
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, newZoom));

    if (this.zoom === 1) {
      this.panX = 0;
      this.panY = 0;
    } else {
      const zoomDelta = this.zoom / oldZoom;
      const finalTx_old = this.basePanX + this.panX;
      const finalTy_old = this.basePanY + this.panY;
      const finalTx_new = focusX - (focusX - finalTx_old) * zoomDelta;
      const finalTy_new = focusY - (focusY - finalTy_old) * zoomDelta;
      this.panX = finalTx_new - this.basePanX;
      this.panY = finalTy_new - this.basePanY;
      this._clampPan();
    }

    this._updateTransform();
  }

  pan(deltaX, deltaY) {
    if (this.zoom <= 1) return { dx: 0, dy: 0 };
    const oldX = this.panX;
    const oldY = this.panY;
    this.panX += deltaX;
    this.panY += deltaY;
    this._clampPan();
    this._updateTransform();
    return { dx: this.panX - oldX, dy: this.panY - oldY };
  }

  _clampPan() {
    const scaledWidth = this.screenWidth * (this.baseScale * this.zoom);
    const scaledHeight = this.screenHeight * (this.baseScale * this.zoom);
    const containerW = window.innerWidth;
    const containerH = window.innerHeight;

    if (scaledWidth <= containerW) {
      this.panX = 0;
    } else {
      const minPanX = containerW - scaledWidth - this.basePanX;
      const maxPanX = -this.basePanX;
      this.panX = Math.max(minPanX, Math.min(maxPanX, this.panX));
    }

    if (scaledHeight <= containerH) {
      this.panY = 0;
    } else {
      const minPanY = containerH - scaledHeight - this.basePanY;
      const maxPanY = -this.basePanY;
      this.panY = Math.max(minPanY, Math.min(maxPanY, this.panY));
    }
  }

  getStats() {
    return {
      fps: this.fps,
      frameSize: this.lastFrameSize,
      resolution: `${this.screenWidth}×${this.screenHeight}`,
    };
  }

  destroy() {
    if (this._presentationRaf) {
      cancelAnimationFrame(this._presentationRaf);
      this._presentationRaf = 0;
    }
    for (const frame of this._presentationQueue.splice(0)) {
      frame.close();
    }
    this._presentationStarted = false;
    this._nextPresentationAt = 0;
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch (_) {}
      this.decoder = null;
    }
    this._pending = [];
    this._needsKeyframe = true;
    this._hasRenderedFrame = false;
    this._configured = false;
    this._configPromise = null;
  }
}
