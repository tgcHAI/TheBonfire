// js/gate.js — shared restricted-archive gate for TheBonfire and ConversationPit.
// Restricted entries/conversations are hidden (and unplayable) until the topbar
// logo button is clicked and the correct code is entered. The unlock is kept in
// localStorage so it survives a reload, and any change is broadcast as an
// 'eho:gatechange' event so each page can re-render its sidebar and content.
//
// This is a client-side passcode, not real security: the code lives in this
// file and the data is served as plain JSON. It gates the archive's atmosphere
// and hides restricted material from casual browsing, matching the site theme.
(function () {
  // The code required to open the restricted archive.
  var CODE = 'HEARTH';
  var STORAGE_KEY = 'eho.gate.unlocked';

  var unlocked = false;
  try {
    unlocked = localStorage.getItem(STORAGE_KEY) === '1';
  } catch (e) {
    // localStorage unavailable (e.g. file:// or blocked) — start locked.
  }

  var overlay = null;
  var inputEl = null;
  var errorEl = null;
  var openEl = null;

  function fireChange() {
    window.dispatchEvent(new CustomEvent('eho:gatechange'));
  }

  function buildOverlay() {
    overlay = document.createElement('div');
    overlay.className = 'gate-overlay';
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="gate-panel" role="dialog" aria-modal="true" aria-labelledby="gateTitle">' +
        '<div class="gate-head">' +
          '<span class="gate-lock" aria-hidden="true">&#128274;</span>' +
          '<div>' +
            '<div class="gate-title" id="gateTitle">RESTRICTED ARCHIVE</div>' +
            '<div class="gate-sub" id="gateSub">Enter the code to open restricted files.</div>' +
          '</div>' +
        '</div>' +
        '<input class="gate-input" id="gateInput" type="password" autocomplete="off" placeholder="Code" aria-label="Access code">' +
        '<div class="gate-error" id="gateError" hidden>Incorrect code.</div>' +
        '<div class="gate-actions" id="gateActions">' +
          '<button class="gate-btn gate-btn-primary" id="gateUnlock" type="button">Unlock</button>' +
          '<button class="gate-btn" id="gateCancel" type="button">Cancel</button>' +
        '</div>' +
        '<div class="gate-open" id="gateOpen" hidden>' +
          '<span>Archive is open.</span>' +
          '<button class="gate-btn" id="gateRelock" type="button">Lock again</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    inputEl = overlay.querySelector('#gateInput');
    errorEl = overlay.querySelector('#gateError');
    openEl = overlay.querySelector('#gateOpen');

    overlay.querySelector('#gateUnlock').addEventListener('click', function () {
      tryUnlock(inputEl.value);
    });
    overlay.querySelector('#gateCancel').addEventListener('click', close);
    overlay.querySelector('#gateRelock').addEventListener('click', lock);
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) close();
    });
    // Enter in the code field submits; Escape closes the overlay.
    inputEl.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); tryUnlock(inputEl.value); }
      if (ev.key === 'Escape') close();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && overlay && !overlay.hidden) close();
    });
  }

  function open() {
    if (!overlay) buildOverlay();
    overlay.hidden = false;
    errorEl.hidden = true;
    if (unlocked) {
      // Already open — offer a way to secure the archive again.
      overlay.querySelector('#gateActions').hidden = true;
      openEl.hidden = false;
    } else {
      overlay.querySelector('#gateActions').hidden = false;
      openEl.hidden = true;
    }
    inputEl.value = '';
    inputEl.focus();
  }

  function close() {
    if (overlay) overlay.hidden = true;
  }

  function tryUnlock(code) {
    if (code === CODE) {
      unlocked = true;
      try { localStorage.setItem(STORAGE_KEY, '1'); } catch (e) { /* non-persistent */ }
      close();
      fireChange();
      return true;
    }
    errorEl.hidden = false;
    inputEl.classList.remove('gate-shake');
    // Restart the shake animation on each wrong attempt.
    void inputEl.offsetWidth;
    inputEl.classList.add('gate-shake');
    inputEl.select();
    return false;
  }

  function lock() {
    unlocked = false;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* non-persistent */ }
    close();
    fireChange();
  }

  // Turn the topbar logo into the gate's trigger button. Both archive pages
  // share the .topbar-logo class, so one wiring pass covers both.
  var logo = document.querySelector('.topbar-logo');
  if (logo) {
    logo.setAttribute('role', 'button');
    logo.setAttribute('tabindex', '0');
    logo.setAttribute('aria-haspopup', 'dialog');
    logo.setAttribute('aria-label', 'Restricted archive');
    logo.setAttribute('title', 'Restricted archive');
    logo.addEventListener('click', open);
    logo.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
    });
  }

  window.Gate = {
    isUnlocked: function () { return unlocked; },
    open: open,
    lock: lock,
    tryUnlock: tryUnlock
  };
})();