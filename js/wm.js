// js/wm.js - page-agnostic pseudo-window manager, shared by the OS shell
// (HTML/TheBonfire.html) and the Conversation Pit (HTML/ConversationPit.html).
//
// Extracted verbatim from ConversationPit.html so both surfaces run the same
// drag / minimize / maximize / close logic instead of a forked copy.
//
// Exposes: window.WM, window.TOPBAR_H, window.renderTaskbar, window.wmStatus,
// window.wmAlert. Load it BEFORE the page script that calls WM.init().
(function (global) {
  // ── WINDOW MANAGER ──
  // A small, page-agnostic pseudo-window layer. Windows are absolutely positioned
  // inside the #desktop host, so their coordinate space is the work area rather
  // than the viewport - which is what lets this later grow into a full desktop
  // surface without touching the manager.
  //
  // The z band (10..49; taskbar 52) deliberately stops short of the restricted
  // gate (.editor-panel, z-index 100) and the mobile drawer (55/60/65), so a
  // window can never cover the gate. Closed windows keep their DOM (cheap, and
  // it keeps the playback engine's nodes valid) and drop off the taskbar.
  // Matches the .shell grid row; only used when the layer has no box yet.
  const TOPBAR_H = 48;

  const WM = {
    apps: new Map(),      // appId -> spec  (register())
    wins: new Map(),      // appId -> window record (one window per app id)
    order: [],            // appIds in focus order; last one is frontmost
    zMin: 10,
    zMax: 49,
    cascade: 0,
    layer: null,          // #desktop host
    bar: null,            // #wmTaskbar
    listeners: [],

    isMobile() { return window.matchMedia('(max-width: 820px)').matches; },
    register(appId, spec) { this.apps.set(appId, spec); },
    on(evt, fn) { if (evt === 'change') this.listeners.push(fn); },
    emit() { this.listeners.forEach((fn) => { try { fn(); } catch (e) { /* a listener must not break the layer */ } }); },

    // Usable work area: the layer minus the taskbar strip. Measured from the live
    // box with an inner-size fallback, then floored - a layer that has not been
    // laid out must not collapse every window to 0x0.
    bounds() {
      // The layer can be absent when this copy of the page predates the desktop
      // layer, so fall back to the viewport instead of throwing: one missing
      // element must not take the whole window manager down with it.
      const el = this.layer;
      const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      const w = (r && Math.round(r.width)) || (el && el.clientWidth) || (window.innerWidth || 0);
      const h = (r && Math.round(r.height)) || (el && el.clientHeight)
              || Math.max(0, (window.innerHeight || 0) - TOPBAR_H);
      return { w: Math.max(320, w), h: Math.max(240, h - (this.bar ? this.bar.offsetHeight : 0)) };
    },

    // Belt and braces: a window must never stay hidden by inline styling left
    // over from a previous state, must be positioned, and must sit in the band.
    ensureVisible(win) {
      const el = win.el;
      if (el.style.display === 'none') el.style.removeProperty('display');
      if (el.style.visibility) el.style.removeProperty('visibility');
      if (el.style.opacity) el.style.removeProperty('opacity');
      el.style.position = 'absolute';
      const z = Number(el.style.zIndex);
      if (!z || z < this.zMin || z > this.zMax) el.style.zIndex = String(this.zMin);
    },

    apply(win) {
      const el = win.el;
      this.ensureVisible(win);
      el.style.left = win.rect.x + 'px';
      el.style.top = win.rect.y + 'px';
      el.style.width = win.rect.w + 'px';
      el.style.height = win.rect.h + 'px';
    },

    // keep the title bar reachable and the body inside the work area
    clampRect(win) {
      const b = this.bounds();
      // A slice of every window must stay inside the layer, otherwise a
      // window opened while the layer was briefly small is left off-screen.
      const visX = Math.min(win.rect.w, 240);
      const visY = Math.min(win.rect.h, 120);
      win.rect.w = Math.min(b.w, Math.max(win.minW, win.rect.w));
      win.rect.h = Math.min(b.h, Math.max(win.minH, win.rect.h));
      win.rect.x = Math.max(-(win.rect.w - visX), Math.min(win.rect.x, b.w - visX));
      win.rect.y = Math.max(-(win.rect.h - visY), Math.min(win.rect.y, b.h - visY));
    },

    // Desktop icon areas in layer coordinates. Returns every one of them, not a
    // single union box: the shell keeps an icon strip top-left AND Admin.exe in
    // the bottom-right corner, and a union of the two would span the screen and
    // leave a window nowhere to spawn. No window ever lands on an icon.
    avoidRects() {
      const out = [];
      if (!this.layer || !this.layer.getBoundingClientRect) return out;
      const lr = this.layer.getBoundingClientRect();
      document.querySelectorAll('#deskIcons, #deskCorner').forEach((box) => {
        if (!box.getBoundingClientRect) return;
        const r = box.getBoundingClientRect();
        if (!r.width || !r.height) return;
        out.push({ x: r.left - lr.left, y: r.top - lr.top, w: r.width, h: r.height });
      });
      return out;
    },

    // Centre the window, cascade each new one, then step clear of the icons.
    spawnRect(w, h) {
      const b = this.bounds();
      const step = (this.cascade++ % 6) * 26;
      const rect = {
        x: Math.max(0, Math.min((b.w - w) / 2 - 60 + step, b.w - w)),
        y: Math.max(0, Math.min(48 + step, b.h - h)),
        w: Math.round(w), h: Math.round(h)
      };
      const avoid = this.avoidRects();
      if (avoid.length) {
        const hits = (r) => avoid.some((a) => r.x < a.x + a.w && r.x + r.w > a.x &&
                                          r.y < a.y + a.h && r.y + r.h > a.y);
        if (hits(rect)) {
          // Try the free bands first: under the icon strip, then to its right,
          // then below a bottom-corner icon. Falls back to the unclamped rect.
          const candidates = [];
          for (const a of avoid) {
            candidates.push({ x: rect.x, y: a.y + a.h + 12 });
            candidates.push({ x: a.x + a.w + 12, y: rect.y });
          }
          const fit = candidates.find((c) => c.x >= 0 && c.y >= 0 &&
            c.x + rect.w <= b.w && c.y + rect.h <= b.h && !hits(c));
          if (fit) { rect.x = fit.x; rect.y = fit.y; }
          else {
            rect.x = Math.max(0, Math.min(rect.x, Math.max(0, b.w - rect.w)));
            rect.y = Math.max(0, Math.min(rect.y, Math.max(0, b.h - rect.h)));
          }
        }
      }
      return rect;
    },

    open(appId, payload) {
      // An existing window record wins even without a registered builder, so
      // adopted windows (the chat) reopen from a desktop icon or the taskbar.
      const existing = this.wins.get(appId);
      let win = existing;
      const spec = this.apps.get(appId);
      if (existing) {
        existing.payload = payload;
        if (existing.state !== 'normal') this.restore(existing);
        this.focus(existing);
      } else if (spec) {
        win = this.create(appId, spec, payload);
      }
      if (!win) { wmStatus('no app registered: ' + appId, true); return null; }
      console.debug('[wm] open', appId, '->', win.title, win.rect);
      wmStatus('opened: ' + win.title);
      if (spec && spec.onOpen) spec.onOpen(win);
      return win;
    },

    create(appId, spec, payload) {
      const b = this.bounds();
      const w = Math.min(spec.width || 480, b.w);
      const h = Math.min(spec.height || 360, b.h);
      const win = {
        id: appId, appId: appId, title: spec.title || appId, icon: spec.icon || '',
        payload: payload, state: 'normal', restore: null,
        rect: this.spawnRect(w, h),
        minW: spec.minW || 240, minH: spec.minH || 140, el: null
      };
      const el = document.createElement('section');
      el.className = 'pwin';
      el.id = 'win-' + appId;
      el.setAttribute('data-wm', appId);
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', win.title);
      el.innerHTML =
        '<div class="pwin-bar" data-wm-drag>' +
          '<span class="pwin-ico ' + (spec.iconClass || '') + '" aria-hidden="true"></span>' +
          '<span class="pwin-title"></span>' +
          '<span class="pwin-btns">' +
            '<button type="button" class="pwin-btn" data-wm-act="min" title="Minimize" aria-label="Minimize the window">_</button>' +
            '<button type="button" class="pwin-btn" data-wm-act="max" title="Maximize" aria-label="Maximize the window">&#9633;</button>' +
            '<button type="button" class="pwin-btn" data-wm-act="close" title="Close" aria-label="Close the window">&#215;</button>' +
          '</span>' +
        '</div>' +
        '<div class="pwin-body"></div>';
      win.el = el;
      el.querySelector('.pwin-title').textContent = win.title;
      if (spec.build) spec.build(win, el.querySelector('.pwin-body'));
      this.layer.insertBefore(el, this.bar);
      this.wins.set(appId, win);
      this.order.push(appId);
      this.bindWindow(win);
      // onOpen is left to open(): the window is attached by now, and open()
      // reports the action first so a builder warning is not clobbered.
      if (this.isMobile()) this.maximize(win); else this.apply(win);
      this.renumber();
      this.emit();
      return win;
    },
    adopt(el, spec) {
      // Wrap an element already in the markup (the chat window) as a managed
      // window without rebuilding it, so the playback engine keeps its nodes.
      const b = this.bounds();
      const bw = Math.min(spec.width || 480, b.w);
      const bh = Math.min(spec.height || 360, b.h);
      const win = {
        id: spec.appId, appId: spec.appId, title: spec.title, icon: spec.icon || '',
        payload: null, state: 'normal', restore: null,
        rect: spec.rect ? Object.assign({}, spec.rect) : this.spawnRect(bw, bh),
        minW: spec.minW || 260, minH: spec.minH || 160, el: el
      };
      this.layer.insertBefore(el, this.bar);
      el.classList.add('pwin');
      el.setAttribute('data-wm', win.id);
      this.wins.set(win.id, win);
      this.order.push(win.id);
      this.bindWindow(win);
      this.clampRect(win);
      if (this.isMobile()) this.maximize(win); else this.apply(win);
      this.renumber();
      this.emit();
      return win;
    },

    bindWindow(win) {
      const el = win.el;
      el.addEventListener('pointerdown', () => this.focus(win), true);
      const handle = el.querySelector('[data-wm-drag]');
      if (handle) this.bindDrag(win, handle);
      el.querySelectorAll('[data-wm-act]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const act = btn.getAttribute('data-wm-act');
          if (act === 'min') this.minimize(win);
          else if (act === 'max') this.toggleMax(win);
          else if (act === 'close') this.close(win);
        });
      });
    },

    bindDrag(win, handle) {
      let start = null;
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('[data-wm-act]')) return;   // let the controls work
        if (this.isMobile() || win.state === 'max') return;
        start = { px: e.clientX, py: e.clientY, x: win.rect.x, y: win.rect.y };
        win.el.classList.add('is-dragging');
        try { handle.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ }
        e.preventDefault();
      });
      handle.addEventListener('pointermove', (e) => {
        if (!start) return;
        win.rect.x = start.x + (e.clientX - start.px);
        win.rect.y = start.y + (e.clientY - start.py);
        this.clampRect(win);
        this.apply(win);
      });
      const end = (e) => {
        if (!start) return;
        start = null;
        win.el.classList.remove('is-dragging');
        try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    },

    focus(win) {
      if (!win || !this.wins.has(win.id)) return;
      this.order = this.order.filter((id) => id !== win.id).concat(win.id);
      this.renumber();
      this.emit();
    },

    // bounded depth: renumber from the focus order rather than chasing a counter,
    // so the band never creeps up towards the gate
    renumber() {
      const top = this.order[this.order.length - 1];
      this.order.forEach((id, i) => {
        const win = this.wins.get(id);
        if (!win) return;
        win.el.style.zIndex = String(this.zMin + i);
        win.el.classList.toggle('is-focused', id === top && (win.state === 'normal' || win.state === 'max'));
      });
    },

    minimize(win) {
      if (!win) return;
      win.state = 'min';
      win.el.classList.add('is-min');
      this.order = this.order.filter((id) => id !== win.id).concat(win.id);
      this.renumber();
      this.emit();
    },

    close(win) {
      // hides but keeps the DOM; the taskbar chip goes away, so it is reopened
      // from a desktop icon (or the pencil) rather than rebuilt
      if (!win) return;
      win.state = 'closed';
      win.el.classList.add('is-closed');
      this.renumber();
      this.emit();
    },

    restore(win) {
      if (!win) return;
      win.el.classList.remove('is-min', 'is-closed', 'is-max');
      if (win.state === 'max' && win.restore) win.rect = win.restore;
      win.state = 'normal';
      win.restore = null;
      this.clampRect(win);
      this.apply(win);
      this.renumber();
      this.emit();
    },

    maximize(win) {
      if (!win) return;
      if (win.state !== 'max') win.restore = Object.assign({}, win.rect);
      win.state = 'max';
      win.el.classList.remove('is-min', 'is-closed');
      win.el.classList.add('is-max');
      const b = this.bounds();
      win.rect = { x: 0, y: 0, w: b.w, h: b.h };
      this.apply(win);
      this.renumber();
      this.emit();
    },

    toggleMax(win) {
      if (!win) return;
      if (win.state === 'max') this.restore(win); else this.maximize(win);
    },
    isOpen(appId) {
      const win = this.wins.get(appId);
      return !!(win && win.state !== 'closed' && win.state !== 'min');
    },

    list() {
      return this.order
        .map((id) => this.wins.get(id))
        .filter((w) => w && w.state !== 'closed')
        .map((w) => ({ id: w.id, title: w.title, icon: w.icon, state: w.state,
                       focused: w.id === this.order[this.order.length - 1] }));
    },

    setTitle(win, text) {
      if (!win) return;
      win.title = text;
      win.el.querySelector('.pwin-title').textContent = text;
      win.el.setAttribute('aria-label', text);
      this.emit();
    },

    // keep windows inside the layer across viewport changes
    fit() {
      this.wins.forEach((win) => {
        if (win.state === 'min' || win.state === 'closed') return;
        if (win.state === 'max') {
          const b = this.bounds();
          win.rect = { x: 0, y: 0, w: b.w, h: b.h };
        } else {
          this.clampRect(win);
        }
        this.apply(win);
      });
    },

    init() {
      this.layer = document.getElementById('desktop');
      this.bar = document.getElementById('wmTaskbar');
      if (!this.layer) {
        wmAlert('This page copy has no desktop layer (#desktop), so the window manager cannot start. '
          + 'It is a stale copy: hard-refresh (Ctrl+Shift+R) and make sure HTML/ConversationPit.html is the file being served.');
        return false;
      }
      window.addEventListener('resize', () => this.fit());
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        // gate.js owns Escape while its panel is open; never steal it
        if (document.querySelector('.editor-panel.open')) return;
        const top = this.order[this.order.length - 1];
        if (top) this.close(this.wins.get(top));
      });
      // any element carrying data-wm-open launches (or refocuses) that app
      document.addEventListener('click', (e) => {
        const opener = e.target.closest('[data-wm-open]');
        if (opener) this.open(opener.getAttribute('data-wm-open'));
      });
      return true;
    }
  };

  // ── TASKBAR ──
  // Rendered from WM.list() on every change, so it already behaves like the dock
  // that a full desktop surface will want.
  function renderTaskbar() {
    const bar = WM.bar;
    if (!bar) return;
    bar.innerHTML = '';
    WM.list().forEach((w) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'wm-chip' + (w.focused && w.state !== 'min' ? ' is-active' : '');
      chip.title = w.title;

      const ico = document.createElement('span');
      ico.className = 'wm-chip-ico';
      ico.setAttribute('aria-hidden', 'true');
      if (w.icon) ico.style.backgroundImage = "url('" + w.icon + "')";

      const label = document.createElement('span');
      label.className = 'wm-chip-title';
      label.textContent = w.title;

      chip.appendChild(ico);
      chip.appendChild(label);
      chip.addEventListener('click', () => {
        const win = WM.wins.get(w.id);
        if (!win) return;
        if (win.state === 'min') WM.restore(win);
        WM.focus(win);
      });
      bar.appendChild(chip);
    });
  }

  // Transient line in the desktop layer naming the last window action, so a
  // failed open or an unreachable store reads as an explanation, not silence.
  let wmStatusTimer = null;
  function wmStatus(text, warn) {
    const el = document.getElementById('wmStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-warn', !!warn);
    if (wmStatusTimer) clearTimeout(wmStatusTimer);
    wmStatusTimer = setTimeout(function () {
      el.textContent = '';
      el.classList.remove('is-warn');
    }, 4000);
  }

  // Permanent banner for conditions the reader must act on: a stale page copy, or
  // a host with no dialogue API. Unlike wmStatus it does not auto-clear.
  function wmAlert(text) {
    const el = document.getElementById('wmAlert');
    if (!el) { console.error('[bonfire]', text); return; }
    el.hidden = false;
    el.textContent = text;
  }
  global.TOPBAR_H = TOPBAR_H;
  global.WM = WM;
  global.renderTaskbar = renderTaskbar;
  global.wmStatus = wmStatus;
  global.wmAlert = wmAlert;
})(typeof window !== 'undefined' ? window : globalThis);
