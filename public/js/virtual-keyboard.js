/**
 * Virtual Keyboard — Mobile keyboard integration
 * Uses a hidden input element to trigger the OS keyboard
 * Text/composition/key events are handled once by InputCapture.
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
    if (this.isOpen) return;
    this.previousKeyboardMode = this.input.keyboardMode;
    this.input.setKeyboardMode('text');
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
    if (!this.isOpen) return;
    this.isOpen = false;
    this.hiddenInput.blur();
    this.hiddenInput.style.pointerEvents = 'none';
    this.hiddenInput.style.top = '-100px';
    this.hiddenInput.style.left = '-100px';
    document.getElementById('btn-keyboard')?.classList.remove('active');
    this.input.setKeyboardMode(this.previousKeyboardMode);
  }

  _bindEvents() {
    // Re-focus hidden input when canvas is tapped (if keyboard is open)
    document.getElementById('remote-canvas')?.addEventListener('touchend', () => {
      if (this.isOpen && !this.input.isKeyMode()) {
        setTimeout(() => {
          this.hiddenInput.focus();
        }, 100);
      }
    });
  }
}
