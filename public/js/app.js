/**
 * Desked — Main Application
 * Orchestrates WebSocket connection, authentication, and all modules
 */
(function () {
  'use strict';

  // --- DOM Elements ---
  const loginScreen = document.getElementById('login-screen');
  const desktopScreen = document.getElementById('desktop-screen');
  const loginForm = document.getElementById('login-form');
  const passwordInput = document.getElementById('password-input');
  const loginBtn = document.getElementById('login-btn');
  const loginError = document.getElementById('login-error');
  const connectionStatus = document.getElementById('connection-status');
  const statusText = connectionStatus.querySelector('.status-text');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingText = document.getElementById('loading-text');
  const loadingDetail = document.getElementById('loading-detail');
  const reconnectOverlay = document.getElementById('reconnect-overlay');
  const canvas = document.getElementById('remote-canvas');

  // Toolbar
  const toolbarToggle = document.getElementById('toolbar-toggle');
  const toolbarPanel = document.getElementById('toolbar-panel');
  const btnFullscreen = document.getElementById('btn-fullscreen');
  const btnKeyboard = document.getElementById('btn-keyboard');
  const btnCtrl = document.getElementById('btn-ctrl');
  const btnAlt = document.getElementById('btn-alt');
  const btnCad = document.getElementById('btn-cad');
  const btnDisconnect = document.getElementById('btn-disconnect');
  const qualitySlider = document.getElementById('quality-slider');
  const qualityValue = document.getElementById('quality-value');
  const scaleSlider = document.getElementById('scale-slider');
  const scaleValue = document.getElementById('scale-value');
  const statsFps = document.getElementById('stats-fps');
  const statsSize = document.getElementById('stats-size');
  const statsResolution = document.getElementById('stats-resolution');
  
  // Mobile Input
  const mobileInputContainer = document.getElementById('mobile-input-container');
  const mobileTextInput = document.getElementById('mobile-text-input');

  // Change Password
  const btnPassword = document.getElementById('btn-password');
  const passwordFab = document.getElementById('password-fab');
  const passwordModal = document.getElementById('password-modal');
  const passwordForm = document.getElementById('password-form');
  const passwordClose = document.getElementById('password-close');
  const passwordCancel = document.getElementById('password-cancel');
  const passwordSubmit = document.getElementById('password-submit');
  const currentPasswordInput = document.getElementById('current-password-input');
  const newPasswordInput = document.getElementById('new-password-input');
  const confirmPasswordInput = document.getElementById('confirm-password-input');
  const passwordMessage = document.getElementById('password-message');

  // --- Initialize Modules ---
  const canvasRenderer = new CanvasRenderer('remote-canvas');
  const videoRenderer = new VideoRenderer('remote-canvas');
  let activeRenderer = canvasRenderer;
  /** @type {'jpeg'|'h264'} */
  let streamMode = 'jpeg';

  const inputCapture = new InputCapture(canvas, canvasRenderer);
  const touchHandler = new TouchHandler(canvas, canvasRenderer, inputCapture);
  const virtualKeyboard = new VirtualKeyboard(inputCapture);

  canvasRenderer.onFirstFrame = () => {
    tFirstPaint = performance.now();
    refreshLoadingUi();
    setTimeout(() => hideLoadingOverlay(), 900);
  };
  videoRenderer.onFirstFrame = () => {
    tFirstPaint = performance.now();
    refreshLoadingUi();
    setTimeout(() => hideLoadingOverlay(), 900);
  };

  // --- State ---
  let ws = null;
  let sessionToken = localStorage.getItem('rd_token');
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let statsTimer = null;
  let isConnected = false;
  let tConnectStart = performance.now();
  let tWsOpen = 0;
  let tAuthOk = 0;
  /** @type {number} first 0x01 (H.264 init), performance.now() */
  let tPacketH264Init = 0;
  /** @type {number} first 0x02 */
  let tPacketH264Frame = 0;
  /** @type {number} first JPEG binary */
  let tPacketJpeg = 0;
  /** @type {number} first successful canvas paint */
  let tFirstPaint = 0;
  let loadingTickTimer = null;
  let loadingHint = '';

  /** Reassemble 0x03 chunked WS payloads (H.264 0x02 packet or JPEG header+image). */
  const wsChunkReasm = new Map();
  const WS_CHUNK_HDR = 15;
  const MAX_WS_CHUNK_ASSEMBLY = 16 * 1024 * 1024;

  function resetWsChunkReasm() {
    wsChunkReasm.clear();
  }

  function uint8ToArrayBuffer(u8) {
    if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return u8.buffer;
    return u8.slice().buffer;
  }

  function handleWsBinaryChunk(buffer) {
    const byteLength = buffer.byteLength;
    if (byteLength < WS_CHUNK_HDR) return;
    const dv = new DataView(buffer);
    const fragId = dv.getUint32(1, true);
    const total = dv.getUint32(5, true);
    const offset = dv.getUint32(9, true);
    const sliceLen = dv.getUint16(13, true);
    if (total < 14 || total > MAX_WS_CHUNK_ASSEMBLY) return;
    if (sliceLen === 0 || WS_CHUNK_HDR + sliceLen > byteLength) return;
    if (offset + sliceLen > total) return;

    const now = performance.now();
    let st = wsChunkReasm.get(fragId);
    if (!st) {
      if (offset !== 0) return;
      st = { total, buf: new Uint8Array(total), nextOff: 0, t0: now };
      wsChunkReasm.set(fragId, st);
    } else {
      if (st.total !== total || offset !== st.nextOff) {
        wsChunkReasm.delete(fragId);
        return;
      }
      if (now - st.t0 > 20000) {
        wsChunkReasm.delete(fragId);
        return;
      }
    }

    const u8 = new Uint8Array(buffer);
    st.buf.set(u8.subarray(WS_CHUNK_HDR, WS_CHUNK_HDR + sliceLen), offset);
    st.nextOff = offset + sliceLen;

    for (const [k, v] of wsChunkReasm) {
      if (k !== fragId && now - v.t0 > 15000) wsChunkReasm.delete(k);
    }

    if (st.nextOff === st.total) {
      wsChunkReasm.delete(fragId);
      const ab = uint8ToArrayBuffer(st.buf);
      if (streamMode === 'h264') {
        if (!tPacketH264Frame) tPacketH264Frame = performance.now();
        videoRenderer.handleFramePacket(ab);
      } else {
        if (!tPacketJpeg) tPacketJpeg = performance.now();
        canvasRenderer.renderFrame(ab);
      }
    }
  }

  // --- WebSocket Connection ---
  function getWsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}`;
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }

    tConnectStart = performance.now();
    tWsOpen = 0;
    tAuthOk = 0;
    tPacketH264Init = 0;
    tPacketH264Frame = 0;
    tPacketJpeg = 0;
    tFirstPaint = 0;
    resetWsChunkReasm();
    setConnectionStatus('connecting');

    try {
      ws = new WebSocket(getWsUrl());
      ws.binaryType = 'arraybuffer';
    } catch (err) {
      setConnectionStatus('error', 'Connection failed');
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      console.log('[App] WebSocket connected');
      tWsOpen = performance.now();
      isConnected = true;
      reconnectDelay = 1000;
      setConnectionStatus('connected');

      // Set WebSocket on input capture
      inputCapture.setWebSocket(ws);

      // Try token re-auth
      if (sessionToken) {
        ws.send(JSON.stringify({ type: 'auth', token: sessionToken }));
      }
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const now = performance.now();
        if (streamMode === 'h264') {
          const u8 = new Uint8Array(event.data);
          if (u8[0] === 0x01) {
            if (!tPacketH264Init) tPacketH264Init = now;
            videoRenderer.handleInitPacket(event.data).catch((e) => {
              console.error('[App] H.264 decoder init failed:', e);
            });
          } else if (u8[0] === 0x02) {
            if (!tPacketH264Frame) tPacketH264Frame = now;
            videoRenderer.handleFramePacket(event.data);
          } else if (u8[0] === 0x03) {
            handleWsBinaryChunk(event.data);
          }
        } else {
          const ju8 = new Uint8Array(event.data);
          if (ju8[0] === 0x03) {
            handleWsBinaryChunk(event.data);
          } else {
            if (!tPacketJpeg) tPacketJpeg = now;
            canvasRenderer.renderFrame(event.data);
          }
        }
        if (desktopScreen.classList.contains('active') && loadingOverlay && !loadingOverlay.classList.contains('hidden')) {
          refreshLoadingUi();
        }
        return;
      }

      // JSON message
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      handleMessage(msg);
    };

    ws.onclose = () => {
      console.log('[App] WebSocket disconnected');
      resetWsChunkReasm();
      isConnected = false;
      inputCapture.setEnabled(false);
      touchHandler.setEnabled(false);

      if (desktopScreen.classList.contains('active')) {
        hideLoadingOverlay();
        reconnectOverlay.classList.remove('hidden');
      }

      setConnectionStatus('error', 'Disconnected');
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error('[App] WebSocket error');
    };
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'auth_result':
        if (msg.success) {
          sessionToken = msg.token;
          localStorage.setItem('rd_token', sessionToken);
          tAuthOk = performance.now();

          streamMode = msg.stream === 'h264' ? 'h264' : 'jpeg';
          if (streamMode === 'h264') {
            activeRenderer = videoRenderer;
            videoRenderer.setTargetFps(msg.fps || 60);
            inputCapture.setRenderer(videoRenderer);
            touchHandler.setRenderer(videoRenderer);
          } else {
            activeRenderer = canvasRenderer;
            inputCapture.setRenderer(canvasRenderer);
            touchHandler.setRenderer(canvasRenderer);
          }

          // Switch to desktop screen
          loginScreen.classList.remove('active');
          desktopScreen.classList.add('active');
          showLoadingOverlay('Waiting for first frame...');
          reconnectOverlay.classList.add('hidden');

          // Set screen size
          if (msg.screenWidth && msg.screenHeight) {
            activeRenderer.setScreenSize(msg.screenWidth, msg.screenHeight);
          }

          // Enable input
          inputCapture.setEnabled(true);
          passwordFab.classList.remove('hidden');
          
          // Enable touch handler and mobile UI on any touch-capable device
          const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
          touchHandler.setEnabled(isTouchDevice);
          
          if (isTouchDevice) {
            mobileInputContainer.style.display = 'flex';
          }

          // Start stats update
          startStatsUpdate();

          // Update resolution display
          if (msg.screenWidth && msg.screenHeight) {
            statsResolution.textContent = `${msg.screenWidth}×${msg.screenHeight}`;
          }

          console.log('[App] Authenticated successfully');
        } else {
          // Auth failed
          sessionToken = null;
          localStorage.removeItem('rd_token');
          passwordFab.classList.add('hidden');
          closePasswordModal();

          if (desktopScreen.classList.contains('active')) {
            // Was viewing desktop, token expired — go back to login
            desktopScreen.classList.remove('active');
            loginScreen.classList.add('active');
          }

          showLoginError(msg.error || 'Authentication failed');
          loginBtn.disabled = false;
        }
        break;

      case 'screen_info':
        if (msg.width && msg.height) {
          activeRenderer.setScreenSize(msg.width, msg.height);
          statsResolution.textContent = `${msg.width}×${msg.height}`;
        }
        break;

      case 'password_result':
        passwordSubmit.disabled = false;
        if (msg.success) {
          const saved = msg.persisted !== false;
          showPasswordMessage(
            saved ? 'Password changed successfully.' : (msg.error || 'Password changed, but could not be saved to .env'),
            saved ? 'success' : 'error'
          );
          passwordForm.reset();
          setTimeout(closePasswordModal, 1500);
        } else {
          showPasswordMessage(msg.error || 'Failed to change password', 'error');
        }
        break;

      case 'error':
        console.error('[App] Server error:', msg.error);
        break;
    }
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      console.log(`[App] Reconnecting in ${reconnectDelay}ms...`);
      connect();
      reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
    }, reconnectDelay);
  }

  function disconnect() {
    clearTimeout(reconnectTimer);
    sessionToken = null;
    localStorage.removeItem('rd_token');

    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }

    videoRenderer.destroy();
    streamMode = 'jpeg';
    activeRenderer = canvasRenderer;
    inputCapture.setRenderer(canvasRenderer);
    touchHandler.setRenderer(canvasRenderer);

    inputCapture.setEnabled(false);
    touchHandler.setEnabled(false);
    stopStatsUpdate();
    passwordFab.classList.add('hidden');
    closePasswordModal();

    desktopScreen.classList.remove('active');
    loginScreen.classList.add('active');
    hideLoadingOverlay();
    reconnectOverlay.classList.add('hidden');
    loginError.textContent = '';
    passwordInput.value = '';
  }

  function startLoadingTick() {
    stopLoadingTick();
    loadingTickTimer = setInterval(() => refreshLoadingUi(), 400);
  }

  function stopLoadingTick() {
    if (loadingTickTimer) {
      clearInterval(loadingTickTimer);
      loadingTickTimer = null;
    }
  }

  function showLoadingOverlay(message) {
    canvasRenderer._hasRenderedFrame = false;
    videoRenderer._hasRenderedFrame = false;
    tPacketH264Init = 0;
    tPacketH264Frame = 0;
    tPacketJpeg = 0;
    tFirstPaint = 0;
    loadingHint = message || '';
    loadingOverlay.classList.remove('hidden');
    refreshLoadingUi();
    startLoadingTick();
  }

  function hideLoadingOverlay() {
    stopLoadingTick();
    loadingHint = '';
    loadingOverlay.classList.add('hidden');
  }

  function fmtSinceConnect(t) {
    if (!t) return '—';
    return `${Math.round((t - tConnectStart) / 100) / 10}s`;
  }

  function refreshLoadingUi() {
    if (!loadingText) return;
    const now = performance.now();
    const wsMs = tWsOpen ? Math.round(tWsOpen - tConnectStart) : null;
    const authMs = tAuthOk ? Math.round(tAuthOk - tConnectStart) : null;
    const totalMs = Math.round(now - tConnectStart);
    const parts = [];
    if (loadingHint) parts.push(loadingHint);
    parts.push(`Elapsed: ${Math.round(totalMs / 100) / 10}s`);
    if (wsMs != null) parts.push(`WS: ${Math.round(wsMs / 100) / 10}s`);
    if (authMs != null) parts.push(`Auth: ${Math.round(authMs / 100) / 10}s`);
    loadingText.textContent = parts.join('  ·  ');

    if (loadingDetail) {
      if (streamMode === 'h264') {
        loadingDetail.textContent = [
          `H.264 init packet: ${fmtSinceConnect(tPacketH264Init)}`,
          `video packet: ${fmtSinceConnect(tPacketH264Frame)}`,
          `painted: ${fmtSinceConnect(tFirstPaint)}`,
        ].join('  ·  ');
      } else {
        loadingDetail.textContent = [
          `JPEG packet: ${fmtSinceConnect(tPacketJpeg)}`,
          `painted: ${fmtSinceConnect(tFirstPaint)}`,
        ].join('  ·  ');
      }
    }
  }

  // --- Connection Status ---
  function setConnectionStatus(state, message) {
    connectionStatus.className = 'connection-status';
    switch (state) {
      case 'connecting':
        statusText.textContent = message || 'Connecting...';
        break;
      case 'connected':
        connectionStatus.classList.add('connected');
        statusText.textContent = message || 'Connected';
        break;
      case 'error':
        connectionStatus.classList.add('error');
        statusText.textContent = message || 'Disconnected';
        break;
    }
  }

  // --- Login ---
  function showLoginError(msg) {
    loginError.textContent = msg;
    loginError.style.animation = 'none';
    // Trigger reflow
    void loginError.offsetWidth;
    loginError.style.animation = 'shake 0.4s ease';
  }

  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const password = passwordInput.value.trim();
    if (!password) return;

    loginBtn.disabled = true;
    loginError.textContent = '';

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      showLoginError('Not connected to server');
      loginBtn.disabled = false;
      return;
    }

    ws.send(JSON.stringify({ type: 'auth', password }));

    // Re-enable button after timeout
    setTimeout(() => { loginBtn.disabled = false; }, 2000);
  });

  // --- Toolbar ---
  toolbarToggle.addEventListener('click', () => {
    toolbarPanel.classList.toggle('hidden');
  });

  // Close toolbar when clicking outside
  document.addEventListener('click', (e) => {
    if (!toolbarPanel.classList.contains('hidden') &&
        !toolbarPanel.contains(e.target) &&
        e.target !== toolbarToggle &&
        !toolbarToggle.contains(e.target)) {
      toolbarPanel.classList.add('hidden');
    }
  });

  btnFullscreen.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  btnKeyboard.addEventListener('click', () => {
    virtualKeyboard.toggle();
  });

  btnCtrl.addEventListener('click', () => {
    const active = inputCapture.toggleStickyModifier('ctrl');
    btnCtrl.classList.toggle('active', active);
  });

  btnAlt.addEventListener('click', () => {
    const active = inputCapture.toggleStickyModifier('alt');
    btnAlt.classList.toggle('active', active);
  });

  btnCad.addEventListener('click', () => {
    inputCapture.sendCtrlAltDel();
  });

  // --- Change Password ---
  function openPasswordModal() {
    passwordForm.reset();
    showPasswordMessage('', '');
    passwordSubmit.disabled = false;
    passwordModal.classList.remove('hidden');
    currentPasswordInput.focus();
  }

  function closePasswordModal() {
    passwordModal.classList.add('hidden');
  }

  function showPasswordMessage(text, type) {
    passwordMessage.textContent = text;
    passwordMessage.className = 'modal-message' + (type ? ' ' + type : '');
  }

  btnPassword.addEventListener('click', openPasswordModal);
  passwordFab.addEventListener('click', openPasswordModal);
  passwordClose.addEventListener('click', closePasswordModal);
  passwordCancel.addEventListener('click', closePasswordModal);
  passwordModal.addEventListener('click', (e) => {
    if (e.target === passwordModal) closePasswordModal();
  });

  passwordForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      showPasswordMessage('Not connected to server', 'error');
      return;
    }

    const currentPassword = currentPasswordInput.value;
    const newPassword = newPasswordInput.value;
    const confirmPassword = confirmPasswordInput.value;

    if (newPassword.length < 8) {
      showPasswordMessage('New password must be at least 8 characters', 'error');
      return;
    }
    if (newPassword !== confirmPassword) {
      showPasswordMessage('New passwords do not match', 'error');
      return;
    }
    if (newPassword === currentPassword) {
      showPasswordMessage('New password must be different from the current one', 'error');
      return;
    }

    passwordSubmit.disabled = true;
    showPasswordMessage('Updating…', '');
    ws.send(JSON.stringify({
      type: 'change_password',
      currentPassword,
      newPassword,
    }));

    setTimeout(() => { passwordSubmit.disabled = false; }, 5000);
  });

  btnDisconnect.addEventListener('click', () => {
    disconnect();
  });

  // Quality slider
  qualitySlider.addEventListener('input', () => {
    qualityValue.textContent = qualitySlider.value;
  });

  qualitySlider.addEventListener('change', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'set_quality',
        quality: parseInt(qualitySlider.value, 10),
      }));
    }
  });

  // Scale slider
  scaleSlider.addEventListener('input', () => {
    scaleValue.textContent = scaleSlider.value + '%';
  });

  scaleSlider.addEventListener('change', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'set_quality',
        scale: parseInt(scaleSlider.value, 10) / 100,
      }));
    }
  });

  // --- Stats Update ---
  function startStatsUpdate() {
    stopStatsUpdate();
    statsTimer = setInterval(() => {
      const stats = activeRenderer.getStats();
      statsFps.textContent = stats.fps + ' FPS';
      statsSize.textContent = formatBytes(stats.frameSize);
      statsResolution.textContent = stats.resolution;
    }, 1000);
  }

  function stopStatsUpdate() {
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    return (bytes / 1024).toFixed(0) + ' KB';
  }

  // --- Prevent default browser shortcuts on desktop screen ---
  document.addEventListener('keydown', (e) => {
    if (!desktopScreen.classList.contains('active')) return;
    // Prevent common browser shortcuts
    if (e.ctrlKey && ['w', 'r', 't', 'n', 'l', 'p'].includes(e.key.toLowerCase())) {
      e.preventDefault();
    }
    // Prevent F5, F11, etc.
    if (['F5', 'F11'].includes(e.key)) {
      e.preventDefault();
    }
  });

  // --- Prevent pinch-to-zoom on the page ---
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('gesturechange', (e) => e.preventDefault());

  // --- Initial Connection ---
  connect();

  // --- Mobile Input Handling ---
  const mobileInputBs = document.getElementById('mobile-input-bs');
  const mobileInputEnter = document.getElementById('mobile-input-enter');
  const mobileInputSend = document.getElementById('mobile-input-send');

  let lastValue = "";
  
  const sendTextToPc = (withEnter = false) => {
    const val = mobileTextInput.value;
    if (val.length > 0) {
      inputCapture._send({ type: 'text_input', text: val });
      if (withEnter) {
        inputCapture._send({ type: 'key_down', code: 'Enter' });
        inputCapture._send({ type: 'key_up', code: 'Enter' });
      }
      mobileTextInput.value = "";
      lastValue = "";
    } else if (withEnter) {
      // If empty but Enter button pressed, just send Enter
      inputCapture._send({ type: 'key_down', code: 'Enter' });
      inputCapture._send({ type: 'key_up', code: 'Enter' });
    }
  };

  mobileTextInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sendTextToPc(false); // Pressing enter on mobile keyboard just sends text
    }
  });

  mobileTextInput.addEventListener('input', (e) => {
    const val = mobileTextInput.value;
    if (val.length < lastValue.length) {
      inputCapture._send({ type: 'key_down', code: 'Backspace' });
      inputCapture._send({ type: 'key_up', code: 'Backspace' });
    } 
    lastValue = val;
  });

  mobileInputSend.addEventListener('click', () => {
    sendTextToPc(false);
  });

  mobileInputEnter.addEventListener('click', () => {
    sendTextToPc(true);
  });

  mobileInputBs.addEventListener('click', () => {
    inputCapture._send({ type: 'key_down', code: 'Backspace' });
    inputCapture._send({ type: 'key_up', code: 'Backspace' });
  });

  mobileTextInput.addEventListener('touchstart', (e) => {
    e.stopPropagation(); // Don't let parent touch handlers interfere
  });
  
  mobileTextInput.addEventListener('click', (e) => {
    mobileTextInput.focus();
  });

  // Focus password input
  passwordInput.focus();

})();
