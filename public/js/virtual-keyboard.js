/**
 * Virtual Keyboard — Mobile keyboard integration
 * Uses a hidden input element to trigger the OS keyboard
 * and captures input events from it
 */
class VirtualKeyboard {
  constructor(inputCapture) {
    this.input = inputCapture;
    this.hiddenInput = document.getElementById('hidden-keyboard-input');
    this.isOpen = false;

    this._bindEvents();
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open() {
    this.isOpen = true;
    this.hiddenInput.style.position = 'fixed';
    this.hiddenInput.style.top = '50%';
    this.hiddenInput.style.left = '50%';
    this.hiddenInput.style.opacity = '0';
    this.hiddenInput.style.pointerEvents = 'auto';
    this.hiddenInput.focus();
    // Reset to ensure keyboard shows
    this.hiddenInput.value = '';
    document.getElementById('btn-keyboard')?.classList.add('active');
  }

  close() {
    this.isOpen = false;
    this.hiddenInput.blur();
    this.hiddenInput.style.pointerEvents = 'none';
    this.hiddenInput.style.top = '-100px';
    this.hiddenInput.style.left = '-100px';
    document.getElementById('btn-keyboard')?.classList.remove('active');
  }

  _bindEvents() {
    // Handle IME composition (Flick input, Voice dictation, Auto-complete)
    this.hiddenInput.addEventListener('compositionend', (e) => {
      if (e.data) {
        this.input._send({ type: 'text_input', text: e.data });
      }
      this.hiddenInput.value = '';
    });

    // Capture standard input (direct typing outside IME)
    this.hiddenInput.addEventListener('input', (e) => {
      // Ignore if currently composing (IME in progress)
      if (e.isComposing) return; 

      const data = e.data;
      if (data) {
        this.input._send({ type: 'text_input', text: data });
        this.hiddenInput.value = '';
      }
    });

    // Handle special keys from mobile keyboard (Backspace, Enter)
    this.hiddenInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;

      // Special control keys that need direct keycode simulation mapping
      if (e.key === 'Backspace' || e.key === 'Enter' || e.key === 'Tab') {
        const code = this.input._keyToCode(e.key);
        this.input._send({ type: 'key_down', code });
        this.input._send({ type: 'key_up', code });
        // Don't prevent default on backspace so the hidden input can clear itself if needed
      }
    });

    // Re-focus hidden input when canvas is tapped (if keyboard is open)
    document.getElementById('remote-canvas')?.addEventListener('touchend', () => {
      if (this.isOpen) {
        setTimeout(() => {
          this.hiddenInput.focus();
        }, 100);
      }
    });
  }
}
