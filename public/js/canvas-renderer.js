/**
 * Canvas Renderer — Renders JPEG frames on an HTML5 Canvas
 */
class CanvasRenderer {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.screenWidth = 1920;
    this.screenHeight = 1080;
    
    // Base layout (fit to screen)
    this.baseScale = 1;
    this.basePanX = 0;
    this.basePanY = 0;

    // Zoom/Pan state (mobile)
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.minZoom = 1;
    this.maxZoom = 4;

    // Stats
    this.frameCount = 0;
    this.lastFpsTime = performance.now();
    this.fps = 0;
    this.lastFrameSize = 0;
    this.onFirstFrame = null;
    this._hasRenderedFrame = false;

    // Frame Queue management
    this._queue = [];
    this._processing = false;

    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  setScreenSize(width, height) {
    this.screenWidth = width;
    this.screenHeight = height;
    this._resize();
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

  /**
   * Render a binary JPEG frame (ArrayBuffer)
   */
  renderFrame(buffer) {
    if (buffer.byteLength <= 24) {
      console.warn('[Renderer] Frame too small:', buffer.byteLength);
      return;
    }

    const dv = new DataView(buffer);
    const x = dv.getUint32(0, true);
    const y = dv.getUint32(4, true);
    const w = dv.getUint32(8, true);
    const h = dv.getUint32(12, true);
    const frameType = dv.getUint8(16);
    
    // Stats
    this.lastFrameSize = buffer.byteLength;

    // Safety check: coordinates must be reasonable
    if (x > 10000 || y > 10000 || w > 10000 || h > 10000 || w === 0 || h === 0) {
      console.warn('[Renderer] Invalid header:', { x, y, w, h, size: buffer.byteLength });
      return;
    }

    const jpegBuffer = buffer.slice(24);
    
    // Diagnostic: check JPEG magic number (FF D8)
    const jpegU8 = new Uint8Array(jpegBuffer);
    if (jpegU8[0] !== 0xFF || jpegU8[1] !== 0xD8) {
      console.warn('[Renderer] Invalid JPEG magic number at offset 24:', 
        jpegU8[0]?.toString(16), jpegU8[1]?.toString(16), 
        'Header:', { x, y, w, h, type: frameType });
    }

    const isFullFrame = (frameType === 1);

    // Push to queue
    this._queue.push({ jpegBuffer, x, y, w, h, isFullFrame });
    // Full-frame updates are self-contained. When motion is heavy, discard all
    // older work as soon as a newer full frame arrives.
    if (isFullFrame && this._queue.length > 1) {
      this._queue.splice(0, this._queue.length - 1);
    }
    
    // Process queue
    this._processQueue();
  }

  async _processQueue() {
    if (this._processing) return;
    this._processing = true;

    while (this._queue.length > 0) {
      // If we're lagging, skip to the latest full frame to catch up
      if (this._queue.length > 2) {
        let latestFullIdx = -1;
        for (let i = this._queue.length - 1; i >= 0; i--) {
          if (this._queue[i].isFullFrame) { latestFullIdx = i; break; }
        }
        if (latestFullIdx !== -1) {
          this._queue.splice(0, latestFullIdx);
        }
      }

      const frame = this._queue.shift();
      if (!frame) break;
      try {
        await this._drawFrame(frame);
      } catch (err) {
        console.error('[Renderer] Frame draw error:', err);
      }
    }

    this._processing = false;
  }

  async _drawFrame(frame) {
    // createImageBitmap decodes JPEG on a worker thread without going through the
    // DOM image-loading pipeline — significantly faster than new Image()+blob URL.
    const blob = new Blob([frame.jpegBuffer], { type: 'image/jpeg' });
    let bmp;
    try {
      bmp = await createImageBitmap(blob);
    } catch (err) {
      console.error('[Renderer] createImageBitmap failed:', err);
      return;
    }

    const { ctx, canvas } = this;
    if (frame.isFullFrame) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.drawImage(bmp, frame.x, frame.y, frame.w, frame.h);
    }
    bmp.close();

    this.frameCount++;
    if (!this._hasRenderedFrame) {
      this._hasRenderedFrame = true;
      if (typeof this.onFirstFrame === 'function') this.onFirstFrame();
    }
    const now = performance.now();
    const elapsed = now - this.lastFpsTime;
    if (elapsed >= 1000) {
      this.fps = Math.round((this.frameCount / elapsed) * 1000);
      this.frameCount = 0;
      this.lastFpsTime = now;
    }
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
}
