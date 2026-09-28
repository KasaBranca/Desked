/**
 * Liquid metal edge — ported from the V2 search form.
 *
 * The canonical ThreeUI LiquidMetalButton (variant "pill") is served
 * same-origin at /liquid-metal-button.html and embedded in an iframe that
 * overhangs the field on every side. An adapter hides the metal face (so only
 * the authored rim and its travelling highlights show) and insets the authored
 * .btn by the same 32px the iframe overhangs, so the rim lands on the field's
 * border. Focus lights the metal via the source's own __hover hook.
 */
(function () {
  'use strict';

  var LM_PAD = 32;
  // Turn down the white bloom that spills around the rim. Upstream defaults are
  // glow: 1.95 / glowR: 1.30.
  var LM_GLOW = { glow: 0.6, glowR: 0.8, glowIn: 0.1 };

  function attachLiquidEdge(field, eager) {
    if (!field || field.dataset.lmReady === '1') return;
    field.dataset.lmReady = '1';
    field.classList.add('lm-field');

    var frame = null;
    var hover = function (v) {
      if (frame) {
        try { frame.contentWindow.__hover(v); } catch (_) {}
      }
    };

    var adapt = function () {
      if (!frame) return;
      try {
        var w = frame.contentWindow;
        var d = frame.contentDocument;
        if (!w || !d) return;
        if (!d.getElementById('lm-ring-adapter')) {
          var st = d.createElement('style');
          st.id = 'lm-ring-adapter';
          st.textContent = [
            'html,body{background:transparent!important;width:100%!important;height:100%!important;margin:0!important;padding:0!important;overflow:hidden!important;display:block!important}',
            '.stage{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;padding:0!important;display:block!important}',
            '.plate{display:none!important}',
            '.btn{position:absolute!important;inset:' + LM_PAD + 'px!important;width:auto!important;height:auto!important;pointer-events:none!important}',
            '.btn .ico,.btn .lbl{display:none!important}',
            '#fx{position:absolute!important;inset:0!important;width:100%!important;height:100%!important}',
          ].join('');
          d.head.appendChild(st);
        }
        // Hooks run on every attempt: focusin can fire before the frame's
        // script exists, so the first injection may have happened too early.
        if (typeof w.__set === 'function') w.__set({}, {}, LM_GLOW, {});
        if (typeof w.__hover === 'function') w.__hover(field.matches(':focus-within') ? 1 : 0);
      } catch (_) { /* still loading; retried on focus */ }
    };

    var ensureFrame = function () {
      if (frame) return;
      frame = document.createElement('iframe');
      frame.className = 'lm-ring';
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.addEventListener('load', adapt);
      frame.src = '/liquid-metal-button.html';
      field.insertBefore(frame, field.firstChild);
    };

    field.addEventListener('focusin', function () { ensureFrame(); adapt(); hover(1); });
    field.addEventListener('focusout', function () { hover(0); });
    if (eager) ensureFrame();
  }

  var field = document.querySelector('#login-form .input-group');
  if (field) attachLiquidEdge(field, true);
})();
