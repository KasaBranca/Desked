/**
 * Touch Handler — Converts touch events to trackpad-style mouse actions for mobile
 */
class TouchHandler {
  constructor(canvas, renderer, inputCapture) {
    this.canvas = canvas;
    this.container = canvas.parentElement;
    this.renderer = renderer;
    this.input = inputCapture;
    this.enabled = false;

    // Trackpad Config
    this.SENSITIVITY = 1.2;
    this.TAP_THRESHOLD = 10; // px mapping for detecting static taps
    this.TAP_TIMEOUT = 300; // ms
    this.LONG_PRESS_TIMEOUT = 600; // ms

    // Simulated Cursor State (Normalized 0-1 coordinates)
    this.cursorX = 0.5;
    this.cursorY = 0.5;
    
    // Touch tracking
    this._touches = new Map();
    this._isPinching = false;
    this._isDragging = false; // Mouse drag state (double tap & drag)
    
    // Pinch / Two-finger state
    this._pinchStartDist = 0;
    this._pinchStartZoom = 1;
    this._pinchCenter = { x: 0, y: 0 };
    this._lastTwoFingerMove = null;

    // Tap state
    this._lastTapTime = 0;
    this._tapTimeout = null;
    this._longPressTimeout = null;

    // Touch cursor DOM element
    this._cursor = null;

    this._createCursor();
    this._bindEvents();
    
    // Start cursor loop for smooth tracking
    this._updateCursorVisual();
  }

  setRenderer(renderer) {
    this.renderer = renderer;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (this._cursor) {
      this._cursor.style.display = enabled ? 'block' : 'none';
      if (!enabled) this._cursor.style.opacity = '0';
    }
  }

  _createCursor() {
    this._cursor = document.createElement('div');
    this._cursor.className = 'touch-cursor';
    this._cursor.style.display = 'none';
    this._cursor.style.opacity = '0';
    document.body.appendChild(this._cursor);
  }

  _showCursor() {
    if (!this._cursor || !this.enabled) return;
    this._cursor.style.opacity = '1';
  }

  _updateCursorVisual() {
    if (this.enabled && this.renderer.zoom > 1 && this._isTouching && this._isNearEdge && this._panVelocity) {
      const moved = this.renderer.pan(this._panVelocity.x, this._panVelocity.y);
      
      // Only adjust cursor position by the amount the screen ACTUALLY moved.
      // This prevents the cursor from getting stuck when the desktop edge is reached.
      const rect = this.canvas.getBoundingClientRect();
      this.cursorX -= (moved.dx) / rect.width;
      this.cursorY -= (moved.dy) / rect.height;
      this._clampCursor();
      this.input._send({ type: 'mouse_move', x: this.cursorX, y: this.cursorY });
    }

    if (this._cursor && this.enabled) {
      const rect = this.canvas.getBoundingClientRect();
      const visualX = rect.left + (this.cursorX * rect.width);
      const visualY = rect.top + (this.cursorY * rect.height);
      this._cursor.style.transform = `translate(${visualX}px, ${visualY}px)`;
    }
    requestAnimationFrame(() => this._updateCursorVisual());
  }

  _flashCursor() {
    this._showCursor();
    this._cursor.classList.add('clicking');
    setTimeout(() => {
      this._cursor.classList.remove('clicking');
    }, 150);
  }

  _getTouchDistance(t1, t2) {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  _getTouchCenter(t1, t2) {
    return {
      x: (t1.clientX + t2.clientX) / 2,
      y: (t1.clientY + t2.clientY) / 2,
    };
  }
  
  _clampCursor() {
    this.cursorX = Math.max(0, Math.min(1, this.cursorX));
    this.cursorY = Math.max(0, Math.min(1, this.cursorY));
  }

  _bindEvents() {
    const container = this.container;

    container.addEventListener('touchstart', (e) => {
      if (!this.enabled) return;
      
      const touch = e.touches[0];
      const viewportH = window.innerHeight;
      
      // DEAD ZONE: Ignore any touches in the bottom 100px to allow reliable interaction with the mobile input box
      if (touch.clientY > viewportH - 100) {
        return; 
      }

      // Allow default behavior (keyboard focus, etc.) for UI elements
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.closest('.mobile-input-container')) {
        return;
      }

      e.preventDefault();
      this._showCursor();
      this._isTouching = true;

      const now = performance.now();

      const touchList = Array.from(e.changedTouches);
      for (const touch of touchList) {
        this._touches.set(touch.identifier, {
          startX: touch.clientX,
          startY: touch.clientY,
          lastX: touch.clientX,
          lastY: touch.clientY
        });
      }

      if (this._touches.size < 2) {
        this._isPinching = false;
        this._lastPinchDist = 0;
        this._lastPinchCenterY = 0;
      }

      if (this._touches.size >= 2) {
        this._isPinching = true;
        // Calculate initial distance and center for pinch/scroll
        const touches = Array.from(this._touches.values());
        this._lastPinchDist = this._getDistance(touches[0], touches[1]);
        this._lastPinchCenterY = (touches[0].lastY + touches[1].lastY) / 2;
      }

      if (e.touches.length === 1) {
        // Single finger logic
        const touch = e.touches[0];
        const data = this._touches.get(touch.identifier);
        
        // Check for double-tap-and-hold (drag initiate)
        if (now - this._lastTapTime < this.TAP_TIMEOUT) {
          clearTimeout(this._tapTimeout);
          this._isDragging = true;
          this.input._send({ type: 'mouse_down', x: this.cursorX, y: this.cursorY, button: 'left' });
          this._cursor.classList.add('dragging');
        }

        // Long press detection for right click
        clearTimeout(this._longPressTimeout);
        this._longPressTimeout = setTimeout(() => {
          const t = this._touches.get(touch.identifier);
          if (t && !t.moved && !this._isDragging) {
            this.input._send({ type: 'mouse_click', x: this.cursorX, y: this.cursorY, button: 'right' });
            this._flashCursor();
            if (navigator.vibrate) navigator.vibrate(50);
            t.moved = true; // Prevent tap on release
          }
        }, this.LONG_PRESS_TIMEOUT);

      } else if (e.touches.length === 2) {
        // Two fingers
        clearTimeout(this._longPressTimeout);
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        this._pinchStartDist = this._getTouchDistance(t1, t2);
        this._pinchStartZoom = this.renderer.zoom;
        this._pinchCenter = this._getTouchCenter(t1, t2);
        this._lastTwoFingerMove = this._pinchCenter;
        
        if (this._pinchStartDist > 30) {
          this._isPinching = true;
        }
      }
    }, { passive: false });

    container.addEventListener('touchmove', (e) => {
      if (!this.enabled) return;
      e.preventDefault();

      try {
        // --- 1. State Self-Healing ---
        if (e.touches.length !== this._touches.size) {
          this._touches.clear();
          for (const t of e.touches) {
            this._touches.set(t.identifier, {
              startX: t.clientX, startY: t.clientY,
              lastX: t.clientX, lastY: t.clientY,
              moved: true
            });
          }
          if (this._touches.size >= 2) {
            const tt = Array.from(this._touches.values());
            this._lastPinchDist = this._getDistance(tt[0], tt[1]);
            this._lastPinchCenterY = (tt[0].lastY + tt[1].lastY) / 2;
            this._isPinching = true;
          } else {
            this._isPinching = false;
          }
        }

        // --- 2. Update Touch positions & calculate deltas ---
        const deltas = [];
        for (const touch of e.changedTouches) {
          const data = this._touches.get(touch.identifier);
          if (data) {
            const dx = touch.clientX - data.lastX;
            const dy = touch.clientY - data.lastY;
            data.lastX = touch.clientX;
            data.lastY = touch.clientY;
            data.moved = true;
            deltas.push({ dx, dy });
          }
        }

        // --- 3. Interaction Logic ---
        if (e.touches.length === 1) {
          // SINGLE FINGER: Mouse movement
          const data = this._touches.get(e.touches[0].identifier);
          if (data && deltas.length > 0) {
            const rect = this.canvas.getBoundingClientRect();
            // We use the first delta from our changedTouches loop
            const { dx, dy } = deltas[0];
            this.cursorX += (dx * this.SENSITIVITY) / rect.width;
            this.cursorY += (dy * this.SENSITIVITY) / rect.height;
            this._clampCursor();
            
            // Edge Panning
            this._isNearEdge = false;
            if (this.renderer.zoom > 1) {
              const edgeThreshold = 0.20;
              const maxPanSpeed = 25;
              const viewportW = window.innerWidth;
              const viewportH = window.innerHeight;
              const sX = rect.left + (this.cursorX * rect.width);
              const sY = rect.top + (this.cursorY * rect.height);

              let vx = 0, vy = 0;
              if (sX < viewportW * edgeThreshold) vx = maxPanSpeed * (1 - (sX / (viewportW * edgeThreshold)));
              else if (sX > viewportW * (1 - edgeThreshold)) vx = -maxPanSpeed * (1 - ((viewportW - sX) / (viewportW * edgeThreshold)));
              if (sY < viewportH * edgeThreshold) vy = maxPanSpeed * (1 - (sY / (viewportH * edgeThreshold)));
              else if (sY > viewportH * (1 - edgeThreshold)) vy = -maxPanSpeed * (1 - ((viewportH - sY) / (viewportH * edgeThreshold)));

              if (Math.abs(vx) > 1 || Math.abs(vy) > 1) {
                this._isNearEdge = true;
                this._panVelocity = { x: vx, y: vy };
              }
            }
            this.input._send({ type: 'mouse_move', x: this.cursorX, y: this.cursorY });
          }
        } else if (e.touches.length === 2) {
          // TWO FINGERS: Pinch Zoom & Scroll
          const t1 = e.touches[0];
          const t2 = e.touches[1];
          const d1 = this._touches.get(t1.identifier);
          const d2 = this._touches.get(t2.identifier);

          if (d1 && d2) {
            const currentDist = this._getDistance(d1, d2);
            const currentCenterY = (d1.lastY + d2.lastY) / 2;
            const currentCenterX = (d1.lastX + d2.lastX) / 2;

            // Zoom
            if (this._lastPinchDist > 0) {
              const ratio = currentDist / this._lastPinchDist;
              if (Math.abs(1 - ratio) > 0.01) {
                this.renderer.setZoom(this.renderer.zoom * ratio, currentCenterX, currentCenterY);
                this._lastPinchDist = currentDist;
              }
            }

            // Scroll (Mouse Wheel)
            if (this._lastPinchCenterY > 0) {
              const dy = currentCenterY - this._lastPinchCenterY;
              if (Math.abs(dy) > 2) {
                this.input._send({ type: 'mouse_scroll', x: this.cursorX, y: this.cursorY, deltaY: dy * 0.5 });
                this._lastPinchCenterY = currentCenterY;
              }
            }
          }
        }
      } catch (err) {
        console.error('[TouchHandler] Move Error:', err);
      }
    }, { passive: false });

    container.addEventListener('touchend', (e) => {
      if (!this.enabled) return;
      e.preventDefault();

      clearTimeout(this._longPressTimeout);

      for (const touch of e.changedTouches) {
        const data = this._touches.get(touch.identifier);
        if (!data) continue;

        if (e.touches.length === 0) {
          this._isTouching = false;
          this._isNearEdge = false;
          // Release drag if active
          if (this._isDragging) {
            this.input._send({ type: 'mouse_up', x: this.cursorX, y: this.cursorY, button: 'left' });
            this._isDragging = false;
            this._cursor.classList.remove('dragging');
          } 
          // Detect simple tap
          else if (!data.moved && !this._isPinching) {
            const now = performance.now();
            
            if (now - this._lastTapTime < this.TAP_TIMEOUT) {
              // Confirm double click (second tap of a double tap)
              clearTimeout(this._tapTimeout);
              this.input._send({ type: 'mouse_dblclick', x: this.cursorX, y: this.cursorY, button: 'left' });
              this._flashCursor();
              this._lastTapTime = 0;
            } else {
              this._lastTapTime = now;
              this._tapTimeout = setTimeout(() => {
                // Confirm single click (at cursor position!)
                this.input._send({ type: 'mouse_click', x: this.cursorX, y: this.cursorY, button: 'left' });
                this._flashCursor();
              }, this.TAP_TIMEOUT);
            }
          }

          this._isPinching = false;
          this._lastTwoFingerMove = null;
        }

        this._touches.delete(touch.identifier);
      }
    }, { passive: false });

    container.addEventListener('touchcancel', (e) => {
      for (const touch of e.changedTouches) {
        this._touches.delete(touch.identifier);
      }
      this._isDragging = false;
      this._isPinching = false;
      this._lastTwoFingerMove = null;
      this._isTouching = false;
      this._isNearEdge = false;
      if (this._cursor) this._cursor.classList.remove('dragging');
    });
  }
}
