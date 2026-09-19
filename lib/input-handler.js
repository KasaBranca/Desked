const koffi = require('koffi');

// Load Windows DLLs
const user32 = koffi.load('user32.dll');
const shell32 = koffi.load('shell32.dll');

// --- Function declarations ---

// Mouse functions
const SetCursorPos = user32.func('__stdcall', 'SetCursorPos', 'bool', ['int', 'int']);
const GetSystemMetrics = user32.func('__stdcall', 'GetSystemMetrics', 'int', ['int']);

// mouse_event flags
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_ABSOLUTE = 0x8000;

// keybd_event flags
const KEYEVENTF_KEYDOWN = 0x0000;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_EXTENDEDKEY = 0x0001;

// System metrics
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;

// mouse_event: void mouse_event(DWORD dwFlags, DWORD dx, DWORD dy, DWORD dwData, ULONG_PTR dwExtraInfo)
const mouseEvent = user32.func('__stdcall', 'mouse_event', 'void', ['uint32', 'uint32', 'uint32', 'int32', 'uintptr']);

// keybd_event: void keybd_event(BYTE bVk, BYTE bScan, DWORD dwFlags, ULONG_PTR dwExtraInfo)
const keybdEvent = user32.func('__stdcall', 'keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uintptr']);

// --- SendInput structs for Unicode text ---
// On x64, there is a 4-byte padding between the type and the union.
// Input structure: 4 bytes (type) + 4 bytes (padding) + 24 bytes (KEYBDINPUT) = 32 or 40 bytes depending on alignment.
// Using a simpler definition that often works better with Koffi on x64.
const KEYBDINPUT = koffi.pack('KEYBDINPUT', {
    wVk: 'uint16',
    wScan: 'uint16',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr'
});

const INPUT = koffi.pack('INPUT', {
    type: 'uint32',
    unusedPadding: 'uint32', // Explicit padding for x64 alignment
    ki: KEYBDINPUT
});

// Since INPUT is a union, we define it safely for KEYBDINPUT specifically.
// The size of INPUT on x64 is 40 bytes. koffi handles this via packing.
const SendInput = user32.func('__stdcall', 'SendInput', 'uint32', ['uint32', 'void *', 'int32']);
const IsUserAnAdmin = shell32.func('__stdcall', 'IsUserAnAdmin', 'bool', []);

const INPUT_KEYBOARD = 1;
const INPUT_MOUSE = 0;
const KEYEVENTF_UNICODE = 0x0004;
const INPUT_SIZE = 40;

// MapVirtualKeyA for scan code lookup
const MapVirtualKey = user32.func('__stdcall', 'MapVirtualKeyA', 'uint32', ['uint32', 'uint32']);

// Extended keys that need the KEYEVENTF_EXTENDEDKEY flag
const EXTENDED_KEYS = new Set([
  0x21, 0x22, 0x23, 0x24, // PageUp, PageDown, End, Home
  0x25, 0x26, 0x27, 0x28, // Arrow keys
  0x2D, 0x2E, // Insert, Delete
  0x5B, 0x5C, // Left/Right Windows key
  0x5D, // Apps key
  0xA3, 0xA5, // Right Ctrl, Right Alt
]);

// JavaScript key code to Windows Virtual Key code mapping
const KEY_MAP = {
  // Letters
  'KeyA': 0x41, 'KeyB': 0x42, 'KeyC': 0x43, 'KeyD': 0x44, 'KeyE': 0x45,
  'KeyF': 0x46, 'KeyG': 0x47, 'KeyH': 0x48, 'KeyI': 0x49, 'KeyJ': 0x4A,
  'KeyK': 0x4B, 'KeyL': 0x4C, 'KeyM': 0x4D, 'KeyN': 0x4E, 'KeyO': 0x4F,
  'KeyP': 0x50, 'KeyQ': 0x51, 'KeyR': 0x52, 'KeyS': 0x53, 'KeyT': 0x54,
  'KeyU': 0x55, 'KeyV': 0x56, 'KeyW': 0x57, 'KeyX': 0x58, 'KeyY': 0x59,
  'KeyZ': 0x5A,

  // Digits
  'Digit0': 0x30, 'Digit1': 0x31, 'Digit2': 0x32, 'Digit3': 0x33, 'Digit4': 0x34,
  'Digit5': 0x35, 'Digit6': 0x36, 'Digit7': 0x37, 'Digit8': 0x38, 'Digit9': 0x39,

  // Function keys
  'F1': 0x70, 'F2': 0x71, 'F3': 0x72, 'F4': 0x73, 'F5': 0x74,
  'F6': 0x75, 'F7': 0x76, 'F8': 0x77, 'F9': 0x78, 'F10': 0x79,
  'F11': 0x7A, 'F12': 0x7B,

  // Modifiers
  'ShiftLeft': 0xA0, 'ShiftRight': 0xA1,
  'ControlLeft': 0xA2, 'ControlRight': 0xA3,
  'AltLeft': 0xA4, 'AltRight': 0xA5,
  'MetaLeft': 0x5B, 'MetaRight': 0x5C,

  // Navigation
  'ArrowUp': 0x26, 'ArrowDown': 0x28, 'ArrowLeft': 0x25, 'ArrowRight': 0x27,
  'Home': 0x24, 'End': 0x23, 'PageUp': 0x21, 'PageDown': 0x22,

  // Editing
  'Backspace': 0x08, 'Delete': 0x2E, 'Insert': 0x2D,
  'Enter': 0x0D, 'Tab': 0x09, 'Escape': 0x1B, 'Space': 0x20,

  // Symbols & Punctuation
  'Minus': 0xBD, 'Equal': 0xBB,
  'BracketLeft': 0xDB, 'BracketRight': 0xDD,
  'Backslash': 0xDC, 'Semicolon': 0xBA,
  'Quote': 0xDE, 'Backquote': 0xC0,
  'Comma': 0xBC, 'Period': 0xBE, 'Slash': 0xBF,

  // Special
  'CapsLock': 0x14, 'NumLock': 0x90, 'ScrollLock': 0x91,
  'PrintScreen': 0x2C, 'Pause': 0x13,
  'ContextMenu': 0x5D,

  // Numpad
  'Numpad0': 0x60, 'Numpad1': 0x61, 'Numpad2': 0x62, 'Numpad3': 0x63,
  'Numpad4': 0x64, 'Numpad5': 0x65, 'Numpad6': 0x66, 'Numpad7': 0x67,
  'Numpad8': 0x68, 'Numpad9': 0x69,
  'NumpadMultiply': 0x6A, 'NumpadAdd': 0x6B, 'NumpadSubtract': 0x6D,
  'NumpadDecimal': 0x6E, 'NumpadDivide': 0x6F, 'NumpadEnter': 0x0D,
};

class InputHandler {
  constructor() {
    this.screenWidth = GetSystemMetrics(SM_CXSCREEN);
    this.screenHeight = GetSystemMetrics(SM_CYSCREEN);
    this.isElevated = IsUserAnAdmin();
    console.log(
      `[InputHandler] Screen: ${this.screenWidth}x${this.screenHeight}; elevated=${this.isElevated}`
    );
    if (!this.isElevated) {
      console.warn(
        '[InputHandler] Server is not elevated; Windows UIPI will block input to administrator apps.'
      );
    }
  }

  _sendMouse(flags, dx = 0, dy = 0, mouseData = 0) {
    const input = Buffer.alloc(INPUT_SIZE);
    input.writeUInt32LE(INPUT_MOUSE, 0);
    input.writeInt32LE(dx, 8);
    input.writeInt32LE(dy, 12);
    input.writeUInt32LE(mouseData >>> 0, 16);
    input.writeUInt32LE(flags >>> 0, 20);
    return SendInput(1, input, INPUT_SIZE) === 1;
  }

  _sendKey(vk, scan, flags) {
    const input = Buffer.alloc(INPUT_SIZE);
    input.writeUInt32LE(INPUT_KEYBOARD, 0);
    input.writeUInt16LE(vk, 8);
    input.writeUInt16LE(scan, 10);
    input.writeUInt32LE(flags >>> 0, 12);
    return SendInput(1, input, INPUT_SIZE) === 1;
  }

  /**
   * Convert normalized coordinates (0-1) to absolute screen coordinates
   */
  _toAbsolute(normX, normY) {
    const x = Math.round(normX * this.screenWidth);
    const y = Math.round(normY * this.screenHeight);
    return { x: Math.max(0, Math.min(x, this.screenWidth - 1)), y: Math.max(0, Math.min(y, this.screenHeight - 1)) };
  }

  /**
   * Move cursor to normalized position
   */
  mouseMove(normX, normY) {
    const { x, y } = this._toAbsolute(normX, normY);
    SetCursorPos(x, y);
    
    // Inject absolute movement via mouseEvent to trigger Raw Input / DirectInput,
    // which many games require to detect mouse movement.
    const absX = Math.round(normX * 65535);
    const absY = Math.round(normY * 65535);
    this._sendMouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, absX, absY);
  }

  mouseMoveRelative(dx, dy) {
    this._sendMouse(MOUSEEVENTF_MOVE, Math.round(dx), Math.round(dy));
  }

  /**
   * Mouse button click at normalized position
   */
  mouseClick(normX, normY, button = 'left', isRelative = false) {
    if (!isRelative) this.mouseMove(normX, normY);

    let downFlag, upFlag;
    switch (button) {
      case 'right':
        downFlag = MOUSEEVENTF_RIGHTDOWN;
        upFlag = MOUSEEVENTF_RIGHTUP;
        break;
      case 'middle':
        downFlag = MOUSEEVENTF_MIDDLEDOWN;
        upFlag = MOUSEEVENTF_MIDDLEUP;
        break;
      default: // left
        downFlag = MOUSEEVENTF_LEFTDOWN;
        upFlag = MOUSEEVENTF_LEFTUP;
    }
    this._sendMouse(downFlag);
    this._sendMouse(upFlag);
  }

  /**
   * Double click at normalized position
   */
  mouseDblClick(normX, normY, button = 'left', isRelative = false) {
    this.mouseClick(normX, normY, button, isRelative);
    this.mouseClick(normX, normY, button, isRelative);
  }

  /**
   * Mouse button down at normalized position
   */
  mouseDown(normX, normY, button = 'left', isRelative = false) {
    if (!isRelative) this.mouseMove(normX, normY);

    let downFlag;
    switch (button) {
      case 'right': downFlag = MOUSEEVENTF_RIGHTDOWN; break;
      case 'middle': downFlag = MOUSEEVENTF_MIDDLEDOWN; break;
      default: downFlag = MOUSEEVENTF_LEFTDOWN;
    }
    this._sendMouse(downFlag);
  }

  /**
   * Mouse button up at normalized position
   */
  mouseUp(normX, normY, button = 'left', isRelative = false) {
    if (!isRelative) this.mouseMove(normX, normY);

    let upFlag;
    switch (button) {
      case 'right': upFlag = MOUSEEVENTF_RIGHTUP; break;
      case 'middle': upFlag = MOUSEEVENTF_MIDDLEUP; break;
      default: upFlag = MOUSEEVENTF_LEFTUP;
    }
    this._sendMouse(upFlag);
  }

  /**
   * Mouse wheel scroll
   */
  mouseScroll(normX, normY, deltaY) {
    const { x, y } = this._toAbsolute(normX, normY);
    SetCursorPos(x, y);
    // WHEEL_DELTA is 120, deltaY is in "clicks"
    const wheelAmount = Math.round(deltaY * 120);
    this._sendMouse(MOUSEEVENTF_WHEEL, 0, 0, wheelAmount);
  }

  /**
   * Get VK code from JS key code
   */
  _getVK(code) {
    return KEY_MAP[code] || 0;
  }

  /**
   * Key down
   */
  keyDown(code) {
    const vk = this._getVK(code);
    if (vk === 0) {
      console.warn(`[InputHandler] Unknown key code: ${code}`);
      return;
    }
    const scan = MapVirtualKey(vk, 0); // MAPVK_VK_TO_VSC
    let flags = KEYEVENTF_KEYDOWN;
    if (EXTENDED_KEYS.has(vk)) {
      flags |= KEYEVENTF_EXTENDEDKEY;
    }
    this._sendKey(vk, scan, flags);
  }

  /**
   * Key up
   */
  keyUp(code) {
    const vk = this._getVK(code);
    if (vk === 0) return;
    const scan = MapVirtualKey(vk, 0);
    let flags = KEYEVENTF_KEYUP;
    if (EXTENDED_KEYS.has(vk)) {
      flags |= KEYEVENTF_EXTENDEDKEY;
    }
    this._sendKey(vk, scan, flags);
  }

  /**
   * Send Unicode text directly (e.g. for mobile flick input)
   * Uses a raw buffer for SendInput to avoid struct alignment issues on x64.
   */
  textInput(text) {
    if (!text) return;
    
    const inputBuffer = Buffer.alloc(INPUT_SIZE);

    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      inputBuffer.fill(0);

      // --- KEY DOWN ---
      inputBuffer.writeUInt32LE(1, 0); // type = INPUT_KEYBOARD
      inputBuffer.writeUInt16LE(0, 8); // wVk = 0
      inputBuffer.writeUInt16LE(charCode, 10); // wScan = charCode
      inputBuffer.writeUInt32LE(KEYEVENTF_UNICODE, 12); // dwFlags = KEYEVENTF_UNICODE
      SendInput(1, inputBuffer, INPUT_SIZE);

      // --- KEY UP ---
      inputBuffer.writeUInt32LE(KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 12);
      SendInput(1, inputBuffer, INPUT_SIZE);
    }
  }

  /**
   * Handle an input message from the client
   */
  handleInput(msg) {
    try {
      switch (msg.type) {
        case 'mouse_move':
          if (msg.isRelative) {
            this.mouseMoveRelative(msg.dx, msg.dy);
          } else {
            this.mouseMove(msg.x, msg.y);
          }
          break;
        case 'mouse_click':
          this.mouseClick(msg.x, msg.y, msg.button, msg.isRelative);
          break;
        case 'mouse_dblclick':
          this.mouseDblClick(msg.x, msg.y, msg.button, msg.isRelative);
          break;
        case 'mouse_down':
          this.mouseDown(msg.x, msg.y, msg.button, msg.isRelative);
          break;
        case 'mouse_up':
          this.mouseUp(msg.x, msg.y, msg.button, msg.isRelative);
          break;
        case 'mouse_scroll':
          this.mouseScroll(msg.x, msg.y, msg.deltaY);
          break;
        case 'key_down':
          this.keyDown(msg.code);
          break;
        case 'key_up':
          this.keyUp(msg.code);
          break;
        case 'text_input':
          this.textInput(msg.text);
          break;
        default:
          break;
      }
    } catch (err) {
      console.error('[InputHandler] Error:', err.message);
    }
  }
}

module.exports = new InputHandler();
