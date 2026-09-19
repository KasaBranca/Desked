/**
 * Input Capture — Captures mouse and keyboard events and sends them via WebSocket
 */
class InputCapture {
  constructor(canvas, renderer) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.ws = null;
    this.enabled = false;

    // Modifier key state
    this.modifiers = {
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    };

    // Sticky modifiers (from toolbar buttons)
    this.stickyModifiers = {
      ctrl: false,
      alt: false,
    };

    // Mouse tracking
    this._isDragging = false;
    this._dragButtonOverride = null;
    this._lastMoveTime = 0;
    this._moveThrottle = 16; // ~60fps throttle for mouse move
    this._pendingMove = null;
    this._pendingWheel = null;
    this._inputFlushHandle = 0;

    this._bindEvents();
  }

  setWebSocket(ws) {
    this.ws = ws;
  }

  setRenderer(renderer) {
    this.renderer = renderer;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
  }

  _send(msg) {
    if (msg.type === 'mouse_move') {
      if (msg.isRelative && this._pendingMove?.isRelative) {
        this._pendingMove.dx += msg.dx;
        this._pendingMove.dy += msg.dy;
      } else {
        this._pendingMove = { ...msg };
      }
      this._scheduleInputFlush();
      return;
    }

    if (msg.type === 'mouse_scroll') {
      if (this._pendingWheel) {
        this._pendingWheel.x = msg.x;
        this._pendingWheel.y = msg.y;
        this._pendingWheel.deltaY += msg.deltaY;
      } else {
        this._pendingWheel = { ...msg };
      }
      this._scheduleInputFlush();
      return;
    }

    this._flushRealtimeInput();
    this._sendNow(msg);
  }

  _sendNow(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.enabled) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  _scheduleInputFlush() {
    if (this._inputFlushHandle) return;
    this._inputFlushHandle = requestAnimationFrame(() => {
      this._inputFlushHandle = 0;
      this._flushRealtimeInput();
    });
  }

  _flushRealtimeInput() {
    if (this._pendingMove) {
      const move = this._pendingMove;
      this._pendingMove = null;
      this._sendNow(move);
    }
    if (this._pendingWheel) {
      const wheel = this._pendingWheel;
      this._pendingWheel = null;
      this._sendNow(wheel);
    }
  }

  _bindEvents() {
    const canvas = this.canvas;

    // --- Mouse Events ---
    canvas.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      const now = performance.now();
      if (now - this._lastMoveTime < this._moveThrottle) return;
      this._lastMoveTime = now;

      const isLocked = document.pointerLockElement === canvas;
      if (isLocked) {
        this._send({ type: 'mouse_move', dx: e.movementX, dy: e.movementY, isRelative: true });
      } else {
        const pos = this.renderer.canvasToNormalized(e.clientX, e.clientY);
        this._send({ type: 'mouse_move', x: pos.x, y: pos.y, isRelative: false });
      }
    });

    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      canvas.focus();
      this._isDragging = true;

      const isLocked = document.pointerLockElement === canvas;
      const pos = this.renderer.canvasToNormalized(e.clientX, e.clientY);
      const button = this._getEffectiveButton(e);
      this._dragButtonOverride = button !== this._getButton(e.button) ? button : null;
      this._send({ type: 'mouse_down', x: pos.x, y: pos.y, button, isRelative: isLocked });
    });

    canvas.addEventListener('mouseup', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this._isDragging = false;

      const isLocked = document.pointerLockElement === canvas;
      const pos = this.renderer.canvasToNormalized(e.clientX, e.clientY);
      const button = this._dragButtonOverride || this._getEffectiveButton(e);
      this._dragButtonOverride = null;
      this._send({ type: 'mouse_up', x: pos.x, y: pos.y, button, isRelative: isLocked });

      // Release sticky modifiers after action
      this._releaseStickyModifiers();
    });

    canvas.addEventListener('dblclick', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const isLocked = document.pointerLockElement === canvas;
      const pos = this.renderer.canvasToNormalized(e.clientX, e.clientY);
      this._send({ type: 'mouse_dblclick', x: pos.x, y: pos.y, button: 'left', isRelative: isLocked });
    });

    canvas.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const pos = this.renderer.canvasToNormalized(e.clientX, e.clientY);
      // Normalize deltaY to "clicks" (-3 to 3 range)
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 1
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 12
        : Math.abs(e.deltaY) / 100;
      const deltaY = -Math.sign(e.deltaY) * Math.min(12, Math.max(0.1, unit));
      this._send({ type: 'mouse_scroll', x: pos.x, y: pos.y, deltaY });
    }, { passive: false });

    // Prevent context menu on canvas
    canvas.addEventListener('contextmenu', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const isLocked = document.pointerLockElement === canvas;
      const pos = this.renderer.canvasToNormalized(e.clientX, e.clientY);
      this._send({ type: 'mouse_click', x: pos.x, y: pos.y, button: 'right', isRelative: isLocked });
    });

    // --- Keyboard Events ---
    // Listen on document to catch all keys even when canvas isn't focused
    document.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      // Don't capture if typing in an input/textarea (except our hidden input)
      if (e.target.tagName === 'INPUT' && e.target.id !== 'hidden-keyboard-input') return;
      if (e.target.tagName === 'TEXTAREA') return;

      // Toggle Game Mode (Pointer Lock) with Ctrl+Shift+Z
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyZ') {
        e.preventDefault();
        e.stopPropagation();
        if (document.pointerLockElement === canvas) {
          document.exitPointerLock();
        } else {
          canvas.requestPointerLock().catch(err => console.warn('Pointer lock failed:', err));
        }
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      // Update modifier state
      this._updateModifiers(e);

      // Apply sticky modifiers
      const code = e.code || this._keyToCode(e.key);
      if (code === 'AltLeft' || code === 'AltRight') {
        // Reserve physical Alt for local mouse-button remapping:
        // Alt + left drag => remote right drag.
        return;
      }
      if (this.stickyModifiers.ctrl && !this.modifiers.ctrl) {
        this._send({ type: 'key_down', code: 'ControlLeft' });
      }
      if (this.stickyModifiers.alt && !this.modifiers.alt) {
        this._send({ type: 'key_down', code: 'AltLeft' });
      }

      this._send({ type: 'key_down', code });
    });

    document.addEventListener('keyup', (e) => {
      if (!this.enabled) return;
      if (e.target.tagName === 'INPUT' && e.target.id !== 'hidden-keyboard-input') return;
      if (e.target.tagName === 'TEXTAREA') return;

      e.preventDefault();
      e.stopPropagation();

      const code = e.code || this._keyToCode(e.key);
      if (code === 'AltLeft' || code === 'AltRight') {
        return;
      }
      this._send({ type: 'key_up', code });

      // Release sticky modifiers
      if (this.stickyModifiers.ctrl && !e.ctrlKey) {
        this._send({ type: 'key_up', code: 'ControlLeft' });
      }
      if (this.stickyModifiers.alt && !e.altKey) {
        this._send({ type: 'key_up', code: 'AltLeft' });
      }

      this._updateModifiers(e);
      this._releaseStickyModifiers();
    });
  }

  _getButton(button) {
    switch (button) {
      case 0: return 'left';
      case 1: return 'middle';
      case 2: return 'right';
      default: return 'left';
    }
  }

  _getEffectiveButton(e) {
    // Trackpads often cannot produce a real right-button drag. Alt + left drag
    // is treated as a right-button drag locally, while Alt is not sent remotely.
    if (e.altKey && e.button === 0) return 'right';
    return this._getButton(e.button);
  }

  _updateModifiers(e) {
    this.modifiers.ctrl = e.ctrlKey;
    this.modifiers.alt = e.altKey;
    this.modifiers.shift = e.shiftKey;
    this.modifiers.meta = e.metaKey;
  }

  toggleStickyModifier(mod) {
    this.stickyModifiers[mod] = !this.stickyModifiers[mod];
    return this.stickyModifiers[mod];
  }

  _releaseStickyModifiers() {
    if (this.stickyModifiers.ctrl) {
      this.stickyModifiers.ctrl = false;
      this._send({ type: 'key_up', code: 'ControlLeft' });
      document.getElementById('btn-ctrl')?.classList.remove('active');
    }
    if (this.stickyModifiers.alt) {
      this.stickyModifiers.alt = false;
      this._send({ type: 'key_up', code: 'AltLeft' });
      document.getElementById('btn-alt')?.classList.remove('active');
    }
  }

  /**
   * Send Ctrl+Alt+Del
   */
  sendCtrlAltDel() {
    this._send({ type: 'key_down', code: 'ControlLeft' });
    this._send({ type: 'key_down', code: 'AltLeft' });
    this._send({ type: 'key_down', code: 'Delete' });
    setTimeout(() => {
      this._send({ type: 'key_up', code: 'Delete' });
      this._send({ type: 'key_up', code: 'AltLeft' });
      this._send({ type: 'key_up', code: 'ControlLeft' });
    }, 100);
  }

  /**
   * Fallback: convert key name to code
   */
  _keyToCode(key) {
    const map = {
      'Enter': 'Enter', 'Backspace': 'Backspace', 'Tab': 'Tab',
      'Escape': 'Escape', 'Delete': 'Delete', 'Insert': 'Insert',
      'Home': 'Home', 'End': 'End', 'PageUp': 'PageUp', 'PageDown': 'PageDown',
      'ArrowUp': 'ArrowUp', 'ArrowDown': 'ArrowDown',
      'ArrowLeft': 'ArrowLeft', 'ArrowRight': 'ArrowRight',
      ' ': 'Space', 'Control': 'ControlLeft', 'Alt': 'AltLeft',
      'Shift': 'ShiftLeft', 'Meta': 'MetaLeft', 'CapsLock': 'CapsLock',
      'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4', 'F5': 'F5',
      'F6': 'F6', 'F7': 'F7', 'F8': 'F8', 'F9': 'F9', 'F10': 'F10',
      'F11': 'F11', 'F12': 'F12',
    };
    if (map[key]) return map[key];
    // Single character — try to map to KeyX or DigitX
    if (key.length === 1) {
      const upper = key.toUpperCase();
      if (upper >= 'A' && upper <= 'Z') return 'Key' + upper;
      if (upper >= '0' && upper <= '9') return 'Digit' + upper;
    }
    return key;
  }
}
