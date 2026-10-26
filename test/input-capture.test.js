const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function client(mode = 'text') {
  const messages = [];
  const elements = new Map();
  class Target {
    constructor(tagName = 'DIV', id = '') {
      this.tagName = tagName;
      this.id = id;
      this.value = '';
      this.style = {};
      this.handlers = new Map();
      this.classList = { add() {}, remove() {}, toggle() {} };
      this.attributes = {};
    }
    addEventListener(type, handler) {
      if (!this.handlers.has(type)) this.handlers.set(type, []);
      this.handlers.get(type).push(handler);
    }
    emit(type, data = {}) {
      const e = {
        target: this, key: '', code: '', ctrlKey: false, altKey: false,
        shiftKey: false, metaKey: false, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; },
        getModifierState() { return false; }, ...data,
      };
      for (const handler of this.handlers.get(type) || []) handler(e);
      if (this !== document && ['keydown', 'keyup'].includes(type) && !e.stopped) {
        for (const handler of document.handlers.get(type) || []) handler(e);
      }
      return e;
    }
    focus() { document.activeElement = this; }
    blur() { document.activeElement = null; }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  const document = new Target();
  document.getElementById = id => elements.get(id) || null;
  const window = new Target();
  const canvas = new Target('CANVAS', 'remote-canvas');
  const input = new Target('INPUT', 'hidden-keyboard-input');
  const modeButton = new Target('BUTTON', 'btn-input-mode');
  elements.set(canvas.id, canvas);
  elements.set(input.id, input);
  elements.set(modeButton.id, modeButton);
  document.exitPointerLock = () => { document.pointerLockElement = null; };
  canvas.requestPointerLock = () => {
    document.pointerLockElement = canvas;
    return Promise.resolve();
  };
  const context = vm.createContext({
    document, window, console, setTimeout, clearTimeout, performance,
    WebSocket: { OPEN: 1 }, requestAnimationFrame: () => 1,
  });
  for (const name of ['input-capture', 'virtual-keyboard']) {
    const className = name === 'input-capture' ? 'InputCapture' : 'VirtualKeyboard';
    vm.runInContext(fs.readFileSync(path.join(__dirname, `../public/js/${name}.js`), 'utf8') +
      `\nglobalThis.${className} = ${className};`, context);
  }
  const capture = new context.InputCapture(canvas, { canvasToNormalized: () => ({ x: 0.5, y: 0.5 }) });
  const virtualKeyboard = new context.VirtualKeyboard(capture);
  capture.setWebSocket({ readyState: 1, send: data => messages.push(JSON.parse(data)) });
  capture.setEnabled(true);
  if (mode === 'text') capture.setKeyboardMode('text');
  return { capture, virtualKeyboard, modeButton, messages, document, window, canvas, input, Target,
    key(type, data, target = canvas) { return target.emit(type, data); } };
}

test('default mode holds simultaneous movement and jump keys without pointer lock', () => {
  const c = client('keys');
  assert.equal(c.capture.keyboardMode, 'keys');
  assert.equal(c.document.pointerLockElement, undefined);
  for (const [code, key] of [['KeyW', 'w'], ['KeyA', 'a'], ['Space', ' ']]) {
    assert.equal(c.key('keydown', { code, key }).defaultPrevented, true);
  }
  assert.deepEqual(c.messages, [
    { type: 'key_down', code: 'KeyW' }, { type: 'key_down', code: 'KeyA' },
    { type: 'key_down', code: 'Space' },
  ]);
  assert.equal(c.capture._remoteKeys.size, 3);
  for (const [code, key] of [['Space', ' '], ['KeyA', 'a'], ['KeyW', 'w']]) {
    c.key('keyup', { code, key });
  }
  assert.deepEqual(c.messages.slice(3), [
    { type: 'key_up', code: 'Space' }, { type: 'key_up', code: 'KeyA' },
    { type: 'key_up', code: 'KeyW' },
  ]);
  assert.equal(c.capture._remoteKeys.size, 0);
});

test('default controls preserve physical keys, IME process keys, Alt and modifier holds', () => {
  const c = client('keys');
  c.key('keydown', { code: 'KeyW', key: 'Process', keyCode: 229, isComposing: true });
  c.key('keydown', { code: 'KeyW', key: 'Process', repeat: true, keyCode: 229 });
  c.key('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true });
  c.key('keydown', { code: 'KeyD', key: 'D', shiftKey: true });
  c.key('keydown', { code: 'AltLeft', key: 'Alt', altKey: true });
  assert.deepEqual(c.messages, [
    { type: 'key_down', code: 'KeyW' }, { type: 'key_down', code: 'KeyW' },
    { type: 'key_down', code: 'ShiftLeft' }, { type: 'key_down', code: 'KeyD' },
    { type: 'key_down', code: 'AltLeft' },
  ]);
  assert.equal(c.capture._getEffectiveButton({ button: 0, altKey: true }), 'left');
  c.canvas.emit('mousedown', { clientX: 10, clientY: 10, button: 0 });
  assert.equal(c.document.activeElement, c.canvas);
  c.input.emit('compositionend', { data: 'w' });
  c.input.emit('input', { data: 'w' });
  assert.equal(c.messages.some(m => m.type === 'text_input'), false);
});

test('mode button releases movement keys then enables client-layout text and back', () => {
  const c = client('keys');
  c.key('keydown', { code: 'KeyW', key: 'w' });
  c.modeButton.emit('click');
  assert.equal(c.capture.keyboardMode, 'text');
  assert.equal(c.document.activeElement, c.input);
  assert.equal(c.modeButton.attributes['aria-pressed'], 'true');
  c.key('keydown', { code: 'Digit2', key: '"' });
  c.key('keyup', { code: 'KeyW', key: 'w' });
  assert.deepEqual(c.messages, [
    { type: 'key_down', code: 'KeyW' }, { type: 'key_up', code: 'KeyW' },
    { type: 'text_input', text: '"' },
  ]);
  c.modeButton.emit('click');
  assert.equal(c.capture.keyboardMode, 'keys');
  assert.equal(c.document.activeElement, c.canvas);
  assert.equal(c.modeButton.attributes['aria-pressed'], 'false');
});

test('pointer lock overrides text mode and restores it when unlocked', () => {
  const c = client();
  c.document.pointerLockElement = c.canvas;
  c.document.emit('pointerlockchange');
  assert.equal(c.modeButton.disabled, true);
  c.key('keydown', { code: 'KeyW', key: 'z' });
  c.document.pointerLockElement = null;
  c.document.emit('pointerlockchange');
  assert.equal(c.capture.keyboardMode, 'text');
  assert.equal(c.modeButton.disabled, false);
  assert.equal(c.document.activeElement, c.input);
  c.input.emit('input', { data: 'z' });
  assert.deepEqual(c.messages, [
    { type: 'key_down', code: 'KeyW' }, { type: 'key_up', code: 'KeyW' },
    { type: 'text_input', text: 'z' },
  ]);
});

test('mobile keyboard opens in text mode and restores the previous mode on close', () => {
  const c = client('keys');
  c.virtualKeyboard.open();
  c.virtualKeyboard.open();
  assert.equal(c.capture.keyboardMode, 'text');
  c.input.emit('input', { data: '日本語' });
  c.virtualKeyboard.close();
  assert.equal(c.capture.keyboardMode, 'keys');
  assert.deepEqual(c.messages, [{ type: 'text_input', text: '日本語' }]);
});

test('characters use the client layout, including JIS/US symbols and AZERTY/QWERTZ letters', () => {
  for (const [code, key] of [
    ['Digit2', '"'], ['Digit2', '@'], ['Quote', ':'], ['Semicolon', ';'],
    ['IntlYen', '\\'], ['IntlRo', '_'], ['BracketLeft', '「'],
    ['KeyQ', 'a'], ['KeyA', 'q'], ['KeyY', 'z'], ['KeyZ', 'y'],
    ['NumpadDecimal', ','], ['KeyE', 'é'], ['Space', ' '], ['', '🙂'],
  ]) {
    const c = client();
    assert.equal(c.key('keydown', { code, key }).defaultPrevented, true);
    c.key('keyup', { code, key });
    assert.deepEqual(c.messages, [{ type: 'text_input', text: key }], `${code}: ${key}`);
  }
});

test('Shift is lifted for Unicode and restored for a subsequent Shift+Arrow', () => {
  const c = client();
  c.key('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true });
  c.key('keydown', { code: 'Digit2', key: '"', shiftKey: true });
  c.key('keyup', { code: 'Digit2', key: '"', shiftKey: true });
  c.key('keydown', { code: 'ArrowLeft', key: 'ArrowLeft', shiftKey: true });
  c.key('keyup', { code: 'ArrowLeft', key: 'ArrowLeft', shiftKey: true });
  c.key('keyup', { code: 'ShiftLeft', key: 'Shift' });
  assert.deepEqual(c.messages, [
    { type: 'key_down', code: 'ShiftLeft' }, { type: 'key_up', code: 'ShiftLeft' },
    { type: 'text_input', text: '"' }, { type: 'key_down', code: 'ShiftLeft' },
    { type: 'key_down', code: 'ArrowLeft' }, { type: 'key_up', code: 'ArrowLeft' },
    { type: 'key_up', code: 'ShiftLeft' },
  ]);
});

test('AltGr sends its character instead of a Ctrl shortcut, including Windows Ctrl+Alt events', () => {
  for (const getModifierState of [() => false, name => name === 'AltGraph']) {
    const c = client();
    c.key('keydown', { code: 'ControlLeft', key: 'Control', ctrlKey: true });
    c.key('keydown', { code: 'AltRight', key: 'AltGraph', ctrlKey: true, altKey: true, getModifierState });
    c.key('keydown', { code: 'KeyQ', key: '@', ctrlKey: true, altKey: true, getModifierState });
    c.key('keyup', { code: 'KeyQ', key: '@', ctrlKey: true, altKey: true });
    c.key('keyup', { code: 'AltRight', key: 'AltGraph', ctrlKey: true });
    c.key('keyup', { code: 'ControlLeft', key: 'Control' });
    assert.deepEqual(c.messages, [
      { type: 'key_down', code: 'ControlLeft' }, { type: 'key_up', code: 'ControlLeft' },
      { type: 'text_input', text: '@' }, { type: 'key_down', code: 'ControlLeft' },
      { type: 'key_up', code: 'ControlLeft' },
    ]);
  }
});

test('macOS Option characters and repeated characters remain text', () => {
  const c = client();
  for (let i = 0; i < 2; i++) c.key('keydown', { code: 'KeyE', key: 'é', altKey: true, repeat: i > 0 });
  c.key('keyup', { code: 'KeyE', key: 'é' });
  assert.deepEqual(c.messages, [{ type: 'text_input', text: 'é' }, { type: 'text_input', text: 'é' }]);
});

test('Ctrl+A uses the client letter and releases the same key even if modifiers change first', () => {
  const c = client();
  c.key('keydown', { code: 'ControlLeft', key: 'Control', ctrlKey: true });
  c.key('keydown', { code: 'KeyQ', key: 'a', ctrlKey: true });
  c.key('keyup', { code: 'ControlLeft', key: 'Control' });
  c.key('keyup', { code: 'KeyQ', key: 'A', shiftKey: true }, new c.Target('INPUT'));
  assert.deepEqual(c.messages, [
    { type: 'key_down', code: 'ControlLeft' }, { type: 'key_down', code: 'KeyA' },
    { type: 'key_up', code: 'ControlLeft' }, { type: 'key_up', code: 'KeyA' },
  ]);
});

test('toolbar sticky Ctrl keeps shortcuts as keys', () => {
  const c = client();
  c.capture.toggleStickyModifier('ctrl');
  c.key('keydown', { code: 'KeyQ', key: 'a' });
  c.key('keyup', { code: 'KeyQ', key: 'a' });
  assert.ok(c.messages.some(m => m.type === 'key_down' && m.code === 'KeyA'));
  assert.equal(c.messages.some(m => m.type === 'text_input'), false);
  assert.equal(c.capture.stickyModifiers.ctrl, false);
});

test('game mode keeps physical key down/up and repeat for movement', () => {
  const c = client();
  c.document.pointerLockElement = c.canvas;
  c.key('keydown', { code: 'KeyW', key: 'z' });
  c.key('keydown', { code: 'KeyW', key: 'z', repeat: true });
  c.key('keyup', { code: 'KeyW', key: 'z' });
  assert.deepEqual(c.messages, [
    { type: 'key_down', code: 'KeyW' }, { type: 'key_down', code: 'KeyW' },
    { type: 'key_up', code: 'KeyW' },
  ]);
});

test('physical desktop clicks focus native text input; touch and game clicks do not', () => {
  const c = client();
  c.canvas.emit('pointerdown', { pointerType: 'mouse' });
  c.canvas.emit('mousedown', { clientX: 50, clientY: 60, button: 0 });
  assert.equal(c.document.activeElement, c.input);
  assert.equal(c.input.style.top, '60px');
  c.canvas.emit('pointerdown', { pointerType: 'touch' });
  c.canvas.emit('mousedown', { clientX: 50, clientY: 60, button: 0 });
  assert.equal(c.document.activeElement, c.canvas);
  c.document.pointerLockElement = c.canvas;
  c.canvas.emit('pointerdown', { pointerType: 'mouse' });
  c.canvas.emit('mousedown', { clientX: 50, clientY: 60, button: 0 });
  assert.equal(c.document.activeElement, c.canvas);
});

test('native text, backspace, enter and tab are sent once with VirtualKeyboard attached', () => {
  const c = client();
  assert.equal(c.key('keydown', { code: 'KeyQ', key: 'a' }, c.input).defaultPrevented, false);
  c.input.emit('input', { data: 'a', inputType: 'insertText' });
  c.key('keyup', { code: 'KeyQ', key: 'a' }, c.input);
  for (const code of ['Backspace', 'Enter', 'Tab']) {
    assert.equal(c.key('keydown', { code, key: code }, c.input).defaultPrevented, true);
    c.key('keyup', { code, key: code }, c.input);
  }
  assert.deepEqual(c.messages, [
    { type: 'text_input', text: 'a' },
    ...['Backspace', 'Enter', 'Tab'].flatMap(code => [
      { type: 'key_down', code }, { type: 'key_up', code },
    ]),
  ]);
});

test('IME commits once with the final input both before and after compositionend', () => {
  for (const finalInputAfter of [false, true]) {
    const c = client();
    c.input.emit('compositionstart');
    c.key('keydown', { key: 'Process', code: 'KeyN', keyCode: 229 }, c.input);
    c.input.emit('input', { data: 'に', isComposing: true });
    c.key('keydown', { key: 'Enter', code: 'Enter', isComposing: true }, c.input);
    if (!finalInputAfter) c.input.emit('input', { data: '日本語', isComposing: true });
    c.input.emit('compositionend', { data: '日本語' });
    if (finalInputAfter) c.input.emit('input', { data: '日本語', isComposing: false });
    assert.deepEqual(c.messages, [{ type: 'text_input', text: '日本語' }]);
  }
});

test('dead keys and cancelled compositions never inject raw/unknown keys', () => {
  const c = client();
  assert.equal(c.key('keydown', { key: 'Dead', code: 'Quote' }, c.input).defaultPrevented, false);
  c.key('keyup', { key: 'Dead', code: 'Quote' }, c.input);
  c.input.emit('input', { data: 'é' });
  c.input.emit('compositionstart');
  c.input.emit('input', { data: 'に', isComposing: true });
  c.input.emit('compositionend', { data: '' });
  c.input.emit('input', { data: '' });
  assert.deepEqual(c.messages, [{ type: 'text_input', text: 'é' }]);
});

test('mobile beforeinput handles deletion/enter without requiring keyboard events', () => {
  const c = client();
  for (const inputType of ['deleteContentBackward', 'deleteContentForward', 'insertLineBreak']) {
    assert.equal(c.input.emit('beforeinput', { inputType }).defaultPrevented, true);
  }
  assert.deepEqual(c.messages, ['Backspace', 'Delete', 'Enter'].flatMap(code => [
    { type: 'key_down', code }, { type: 'key_up', code },
  ]));
});

test('text input with null data uses the editable value (paste/autocomplete)', () => {
  const c = client();
  c.input.value = 'café🙂';
  c.input.emit('input', { data: null });
  assert.deepEqual(c.messages, [{ type: 'text_input', text: 'café🙂' }]);
  assert.equal(c.input.value, '');
});

test('local editors are untouched and lock keys do not toggle the host', () => {
  const c = client();
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'DIV']) {
    const target = new c.Target(tag);
    target.isContentEditable = tag === 'DIV';
    assert.equal(c.key('keydown', { code: 'KeyA', key: 'a' }, target).defaultPrevented, false);
    c.key('keyup', { code: 'KeyA', key: 'a' }, target);
  }
  for (const code of ['CapsLock', 'NumLock']) {
    c.key('keydown', { code, key: code });
    c.key('keyup', { code, key: code });
  }
  assert.deepEqual(c.messages, []);
});

test('blur, hidden tab, pointer-lock changes and disabling release held keys', () => {
  for (const reason of ['blur', 'hidden', 'pointerlock', 'disabled']) {
    const c = client();
    c.key('keydown', { code: 'ControlLeft', key: 'Control', ctrlKey: true });
    if (reason === 'blur') c.window.emit('blur');
    if (reason === 'hidden') { c.document.hidden = true; c.document.emit('visibilitychange'); }
    if (reason === 'pointerlock') c.document.emit('pointerlockchange');
    if (reason === 'disabled') c.capture.setEnabled(false);
    assert.deepEqual(c.messages, [
      { type: 'key_down', code: 'ControlLeft' }, { type: 'key_up', code: 'ControlLeft' },
    ], reason);
    assert.equal(c.capture._remoteKeys.size, 0);
  }
});

test('disabled clients cannot send text or late composition commits', () => {
  const c = client();
  c.input.emit('compositionstart');
  c.capture.setEnabled(false);
  c.input.emit('compositionend', { data: '日本語' });
  c.input.emit('input', { data: 'a' });
  c.key('keydown', { code: 'KeyA', key: 'a' });
  assert.deepEqual(c.messages, []);
});
