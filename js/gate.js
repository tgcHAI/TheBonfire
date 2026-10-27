// js/gate.js — shared restricted-archive gate for TheBonfire and ConversationPit.
// Restricted entries/conversations are hidden (and unplayable) until the topbar
// logo button is clicked and the correct code is entered. The unlock is kept in
// localStorage so it survives a reload, and any change is broadcast as an
// 'eho:gatechange' event so each page can re-render its sidebar and content.
//
// This is a client-side passcode, not real security: the code lives in this
// file and the data is served as plain JSON. It gates the archive's atmosphere
// and hides restricted material from casual browsing, matching the site theme.
//
// The gate UI reuses the pages' editor dropdown pattern (.editor-panel + .open),
// so it slides down from under the topbar with the same look as the editors.
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

  var panel = null;
  var inputField = null;
  var inputEl = null;
  var hintEl = null;
  var errorEl = null;
  var unlockBtn = null;
  var relockBtn = null;
  var logo = null;

  function fireChange() {
    window.dispatchEvent(new CustomEvent('eho:gatechange'));
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.className = 'editor-panel';
    panel.id = 'gatePanel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'gateTitle');
    panel.innerHTML =
      '<div class="editor-inner">' +
        '<div class="editor-heading">' +
          '<span id="gateTitle">Restricted Archive</span>' +
          '<div class="editor-actions">' +
            '<button class="ed-btn" id="gateCancel" type="button">Cancel</button>' +
            '<button class="ed-btn ed-save" id="gateUnlock" type="button">Unlock</button>' +
            '<button class="ed-btn" id="gateRelock" type="button" hidden>Lock again</button>' +
          '</div>' +
        '</div>' +
        '<div class="editor-fields">' +
          '<div class="ed-field" id="gateInputField">' +
            '<label for="gateInput">Access code</label>' +
            '<input type="password" id="gateInput" autocomplete="off" placeholder="Enter the code to open restricted files">' +
          '</div>' +
          '<div class="ed-field">' +
            '<span class="ed-hint" id="gateHint">Enter the code to open restricted files.</span>' +
            '<span class="ed-hint gate-error" id="gateError" hidden>Incorrect code.</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(panel);

    inputField = panel.querySelector('#gateInputField');
    inputEl = panel.querySelector('#gateInput');
    hintEl = panel.querySelector('#gateHint');
    errorEl = panel.querySelector('#gateError');
    unlockBtn = panel.querySelector('#gateUnlock');
    relockBtn = panel.querySelector('#gateRelock');

    unlockBtn.addEventListener('click', function () {
      tryUnlock(inputEl.value);
    });
    panel.querySelector('#gateCancel').addEventListener('click', close);
    relockBtn.addEventListener('click', lock);
    // Enter in the code field submits; Escape closes the panel.
    inputEl.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); tryUnlock(inputEl.value); }
      if (ev.key === 'Escape') close();
    });
  }

  // Re-apply the current settings strings to the unlock view. Runs on panel
  // build, when a late-config fetch resolves, and after a save keeps the next
  // panel open current without touching the rest of the DOM.
  function syncPanelText() {
    if (!panel) return;
    var titleEl = panel.querySelector('#gateTitle');
    if (titleEl) titleEl.textContent = config.title;
    if (inputEl) inputEl.placeholder = config.placeholder;
    if (hintEl) hintEl.textContent = unlocked ? config.hintOpen : config.hintLocked;
    if (errorEl) errorEl.textContent = config.error;
  }

  function syncPanelState() {
    inputField.hidden = unlocked;
    unlockBtn.hidden = unlocked;
    relockBtn.hidden = !unlocked;
    hintEl.hidden = false;
    errorEl.hidden = true;
    inputEl.value = '';
  }

  // Edit mode: the dropdown swaps to the settings form. Field values are set as
  // element properties (never interpolated into markup), so labels containing
  // quotes or angle brackets cannot break the panel.
  function showEditView() {
    panel.innerHTML =
      '<div class="editor-inner">' +
        '<div class="editor-heading">' +
          '<span id="gateTitle">Gate Panel Editor</span>' +
          '<div class="editor-actions">' +
            '<button class="ed-btn" id="gateEditCancel" type="button">Cancel</button>' +
            '<button class="ed-btn ed-save" id="gateSave" type="button">Save</button>' +
          '</div>' +
        '</div>' +
        '<div class="editor-fields">' +
          '<div class="ed-row">' +
            '<div class="ed-field">' +
              '<label for="gateCode">Access code</label>' +
              '<input type="text" id="gateCode" autocomplete="off" spellcheck="false">' +
            '</div>' +
            '<div class="ed-field">' +
              '<label for="gatePanelTitle">Panel title</label>' +
              '<input type="text" id="gatePanelTitle">' +
            '</div>' +
          '</div>' +
          '<div class="ed-row">' +
            '<div class="ed-field">' +
              '<label for="gateHintLocked">Hint — archive locked</label>' +
              '<input type="text" id="gateHintLocked">' +
            '</div>' +
            '<div class="ed-field">' +
              '<label for="gateHintOpen">Hint — archive open</label>' +
              '<input type="text" id="gateHintOpen">' +
            '</div>' +
          '</div>' +
          '<div class="ed-row">' +
            '<div class="ed-field">' +
              '<label for="gatePlaceholder">Code field placeholder</label>' +
              '<input type="text" id="gatePlaceholder">' +
            '</div>' +
            '<div class="ed-field">' +
              '<label for="gateError">Wrong-code message</label>' +
              '<input type="text" id="gateError">' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    panel.querySelector('#gateCode').value = config.code;
    panel.querySelector('#gatePanelTitle').value = config.title;
    panel.querySelector('#gateHintLocked').value = config.hintLocked;
    panel.querySelector('#gateHintOpen').value = config.hintOpen;
    panel.querySelector('#gatePlaceholder').value = config.placeholder;
    panel.querySelector('#gateError').value = config.error;

    panel.querySelector('#gateEditCancel').addEventListener('click', function () {
      showUnlockView();
      syncPanelState();
    });
    panel.querySelector('#gateSave').addEventListener('click', saveConfigFromPanel);
    panel.querySelector('#gateCode').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); saveConfigFromPanel(); }
      if (ev.key === 'Escape') close();
    });
  }

  function flashEditorBtn(text) {
    var btn = panel.querySelector('#gateSave');
    if (!btn) return;
    var orig = btn.textContent;
    btn.textContent = text;
    btn.style.color = 'var(--ember-bright)';
    setTimeout(function () {
      btn.textContent = orig;
      btn.style.color = '';
    }, 1800);
  }

  function persistConfig(done) {
    try {
      localStorage.setItem('eho.gate.config', JSON.stringify(config));
      done(true);
    } catch (e) {
      done(false);
    }
  }

  // Programmatic save (also used by the panel); merges over the current config
  // and persists atomically on the server. `done` receives true on success.
  function saveConfig(next, done) {
    config = Object.assign({}, DEFAULTS, config, next || {});
    persistConfig(function (ok) {
      if (done) done(ok);
    });
  }

  function saveConfigFromPanel() {
    var next = {
      code: panel.querySelector('#gateCode').value.trim(),
      title: panel.querySelector('#gatePanelTitle').value.trim(),
      hintLocked: panel.querySelector('#gateHintLocked').value.trim(),
      hintOpen: panel.querySelector('#gateHintOpen').value.trim(),
      placeholder: panel.querySelector('#gatePlaceholder').value.trim(),
      error: panel.querySelector('#gateError').value.trim()
    };
    if (!next.code) { flashEditorBtn('Code required'); return; }
    saveConfig(next, function (ok) {
      flashEditorBtn(ok ? 'Saved!' : 'Saved (browser only)');
      if (ok) setTimeout(close, 450);
    });
  }

  // Open toggles the dropdown like the editor panels; each open re-syncs the
  // panel with the current lock state.
  function open() {
    if (!panel) buildPanel();
    var isOpen = unlocked;
    inputField.hidden = isOpen;
    unlockBtn.hidden = isOpen;
    relockBtn.hidden = !isOpen;
    hintEl.hidden = false;
    hintEl.textContent = isOpen ? 'Archive is open.' : 'Enter the code to open restricted files.';
    errorEl.hidden = true;
    inputEl.value = '';
    panel.classList.toggle('open');
    setLogoExpanded(panel.classList.contains('open'));
    if (panel.classList.contains('open') && !isOpen) inputEl.focus();
  }

  function close() {
    if (panel) {
      panel.classList.remove('open');
      setLogoExpanded(false);
    }
  }

  function tryUnlock(code) {
    if (code === CODE) {
      unlocked = true;
      try { localStorage.setItem(STORAGE_KEY, '1'); } catch (e) { /* non-persistent */ }
      close();
      fireChange();
      return true;
    }
    hintEl.hidden = true;
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

  function setLogoExpanded(expanded) {
    if (logo) logo.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  // Turn the topbar logo into the gate's trigger button. Both archive pages
  // share the .topbar-logo class, so one wiring pass covers both. This script
  // runs in <head> before the body exists, so wiring is deferred until the DOM
  // is ready; window.Gate is still defined synchronously for the pages' inline
  // scripts that call Gate.isUnlocked() during load.
  function wireLogo() {
    logo = document.querySelector('.topbar-logo');
    if (!logo) return;
    logo.setAttribute('role', 'button');
    logo.setAttribute('tabindex', '0');
    logo.setAttribute('aria-haspopup', 'dialog');
    logo.setAttribute('aria-label', 'Restricted archive');
    logo.setAttribute('title', 'Restricted archive');
    logo.setAttribute('aria-expanded', 'false');
    logo.addEventListener('click', open);
    logo.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireLogo);
  } else {
    wireLogo();
  }

  // Load persisted settings (backed by the gate route in server.js when served).
  loadConfig();

  // Only isUnlocked is consumed by the pages (both call sites are guarded-entry
  // checks). open/lock/tryUnlock/saveConfig stay wired to their own panel
  // controls in here, so they are internal and are not part of the public API.
  window.Gate = {
    isUnlocked: function () { return unlocked; },
    getConfig: function () { return Object.assign({}, config); },
    saveConfig: saveConfig,
    open: open,
    lock: lock,
    tryUnlock: tryUnlock
  };
})();