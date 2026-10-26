/**
 * Input Capture — Captures mouse and keyboard events and sends them via WebSocket
 */
class InputCapture {
  constructor(canvas, renderer) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.ws = null;
    this.enabled = false;
    this.textInput = document.getElementById('hidden-keyboard-input');
    this._pressedKeys = new Map();
    this._remoteKeys = new Set();
    this._composing = false;
    this._compositionCommit = null;
    this._compositionTimer = 0;
    this._pointerType = 'mouse';
    // Key holds are the default for remote apps and games. Text mode is explicit.
    this.keyboardMode = 'keys';

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
    if (this.ws !== ws) this._releaseKeys();
    this.ws = ws;
  }

  setRenderer(renderer) {
    this.renderer = renderer;
  }

  setEnabled(enabled) {
    if (!enabled) {
      this._releaseKeys();
      this._resetComposition();
    }
    this.enabled = enabled;
  }

  isKeyMode() {
    return this.keyboardMode === 'keys' || document.pointerLockElement === this.canvas;
  }

  setKeyboardMode(mode) {
    if (!['keys', 'text'].includes(mode)) return;
    this._releaseKeys();
    this._resetComposition();
    this.keyboardMode = mode;
    this._updateKeyboardModeButton();
    if (this.enabled) this._focusKeyboard();
  }

  _focusKeyboard() {
    if (!this.isKeyMode() && this.textInput) {
      this.textInput.focus({ preventScroll: true });
    } else {
      this.canvas.focus({ preventScroll: true });
    }
  }

  _updateKeyboardModeButton() {
    const button = document.getElementById('btn-input-mode');
    if (!button) return;
    const locked = document.pointerLockElement === this.canvas;
    const text = !this.isKeyMode();
    button.textContent = locked ? '入力：ゲーム操作' : text ? '入力：文字' : '入力：操作';
    button.title = locked ? 'Escでマウスロックを解除' : text
      ? 'クライアント配列で文字入力中。クリックしてキー操作へ切り替え'
      : 'ゲームやアプリのキー操作中。クリックしてクライアント配列の文字入力へ切り替え';
    button.setAttribute('aria-pressed', String(text));
    button.classList.toggle('active', text);
    button.disabled = locked;
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
      if (msg.type === 'key_down') this._remoteKeys.add(msg.code);
      if (msg.type === 'key_up') this._remoteKeys.delete(msg.code);
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

    canvas.addEventListener('pointerdown', (e) => { this._pointerType = e.pointerType; });
    document.getElementById('btn-input-mode')?.addEventListener('click', () => {
      this.setKeyboardMode(this.keyboardMode === 'keys' ? 'text' : 'keys');
    });
    this._updateKeyboardModeButton();

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
      if (this._pointerType === 'mouse' && !this.isKeyMode() && this.textInput) {
        // A real editable target lets the client's IME/dead keys compose text.
        // Keep its caret near the click so local IME candidates remain visible.
        this.textInput.style.top = `${e.clientY}px`;
        this.textInput.style.left = `${e.clientX}px`;
        this.textInput.focus({ preventScroll: true });
      } else {
        canvas.focus();
      }
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
    // Characters follow the client's layout; controls and game input stay keys.
    document.addEventListener('keydown', (e) => {
      if (!this.enabled || this._isLocalEditor(e.target)) return;
      this._updateModifiers(e);

      const keyMode = this.isKeyMode();
      if (!keyMode && (e.isComposing || this._composing || e.keyCode === 229 ||
          ['Dead', 'Process', 'Unidentified'].includes(e.key))) {
        return; // Let the client's native text input finish the composition.
      }

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

      const physicalCode = e.code || this._keyToCode(e.key);
      if (!keyMode && (physicalCode === 'AltLeft' || physicalCode === 'AltRight')) {
        // Reserve physical Alt for local mouse-button remapping:
        // Alt + left drag => remote right drag.
        if (e.key !== 'AltGraph' && !e.getModifierState?.('AltGraph')) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      const altGraph = e.getModifierState?.('AltGraph') || (e.ctrlKey && e.altKey);
      const shortcut = (e.ctrlKey && !altGraph) || e.metaKey ||
        this.stickyModifiers.ctrl || this.stickyModifiers.alt;
      const printable = typeof e.key === 'string' && Array.from(e.key).length === 1 &&
        !/[\u0000-\u001f\u007f]/.test(e.key);

      if (!keyMode && printable && !shortcut) {
        // Native input handles characters/IME when focused. Else use key, never
        // code: e.g. JIS Shift+2 is '"', US Shift+2 is '@', AZERTY KeyQ is 'a'.
        if (e.target !== this.textInput) {
          e.preventDefault();
          e.stopPropagation();
          this.sendText(e.key);
        }
        return;
      }
      // These locks belong to the client when typing text. Unicode already
      // contains the client's case/NumLock result; don't toggle the host locks.
      if (!keyMode && ['CapsLock', 'NumLock'].includes(e.key)) return;

      e.preventDefault();
      e.stopPropagation();

      if (this.stickyModifiers.ctrl && !this.modifiers.ctrl) {
        this._send({ type: 'key_down', code: 'ControlLeft' });
      }
      if (this.stickyModifiers.alt && !this.modifiers.alt) {
        this._send({ type: 'key_down', code: 'AltLeft' });
      }

      let code = this._pressedKeys.get(physicalCode);
      if (!code) {
        const logicalCode = this._keyToCode(e.key);
        code = !keyMode && shortcut && /^(Key[A-Z]|Digit[0-9])$/.test(logicalCode)
          ? logicalCode : physicalCode;
        this._pressedKeys.set(physicalCode, code);
      }
      this._send({ type: 'key_down', code });
    });

    document.addEventListener('keyup', (e) => {
      if (!this.enabled) return;
      const physicalCode = e.code || this._keyToCode(e.key);
      const code = this._pressedKeys.get(physicalCode);
      if (this._isLocalEditor(e.target) && !code) return;
      if (code) {
        e.preventDefault();
        e.stopPropagation();
        this._send({ type: 'key_up', code });
        this._pressedKeys.delete(physicalCode);
      }

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

    window.addEventListener('blur', () => this._releaseKeys());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._releaseKeys();
    });
    document.addEventListener('pointerlockchange', () => {
      this._releaseKeys();
      this._resetComposition();
      this._updateKeyboardModeButton();
      if (this.enabled) this._focusKeyboard();
    });
    this._bindTextInput();
  }

  _isLocalEditor(target) {
    return target !== this.textInput &&
      (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable);
  }

  sendText(text) {
    if (!this.enabled || typeof text !== 'string' || !text) return;
    // AltGr can arrive as Ctrl+Alt, and Shift may already be held remotely.
    // Unicode is complete text: briefly lift only modifiers sent by this client.
    const held = [...this._remoteKeys].filter(code =>
      /^(Shift|Control|Alt|Meta)(Left|Right)$/.test(code));
    for (const code of held) this._send({ type: 'key_up', code });
    this._send({ type: 'text_input', text });
    for (const code of held) this._send({ type: 'key_down', code });
  }

  _resetComposition() {
    clearTimeout(this._compositionTimer);
    this._compositionCommit = null;
    this._composing = false;
    if (this.textInput) this.textInput.value = '';
  }

  _bindTextInput() {
    const input = this.textInput;
    if (!input) return;
    input.addEventListener('compositionstart', () => {
      this._resetComposition();
      if (this.isKeyMode()) return;
      this._composing = true;
    });
    input.addEventListener('compositionend', (e) => {
      if (this.isKeyMode()) { this._resetComposition(); return; }
      this._composing = false;
      this.sendText(e.data);
      // Browsers differ on whether the final input comes before/after this
      // event. Remember this commit through the trailing input to send once.
      this._compositionCommit = e.data;
      input.value = '';
      this._compositionTimer = setTimeout(() => {
        this._compositionCommit = null;
      }, 0);
    });
    input.addEventListener('input', (e) => {
      if (this.isKeyMode()) { input.value = ''; return; }
      if (e.isComposing || this._composing) return;
      const text = e.data || input.value;
      if (text && text !== this._compositionCommit) this.sendText(text);
      this._compositionCommit = null;
      input.value = '';
    });
    input.addEventListener('beforeinput', (e) => {
      if (!this.enabled || this.isKeyMode() || e.isComposing || this._composing) return;
      const code = {
        deleteContentBackward: 'Backspace', deleteContentForward: 'Delete',
        insertLineBreak: 'Enter', insertParagraph: 'Enter',
      }[e.inputType];
      if (code) {
        e.preventDefault();
        this._send({ type: 'key_down', code });
        this._send({ type: 'key_up', code });
      }
    });
  }

  _releaseKeys() {
    for (const code of [...this._remoteKeys]) this._send({ type: 'key_up', code });
    this._remoteKeys.clear();
    this._pressedKeys.clear();
    this._releaseStickyModifiers();
    for (const mod of Object.keys(this.modifiers)) this.modifiers[mod] = false;
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
    if (!this.isKeyMode() && e.altKey && e.button === 0) return 'right';
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
