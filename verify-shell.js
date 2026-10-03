'use strict';
// Regression harness for the OS shell (HTML/TheBonfire.html).
// Loads the REAL shell in jsdom against the REAL server.js against a THROWAWAY
// copy of the repo, so json/ is never mutated in the workspace.
//
// jsdom notes that shaped this file:
//   * it has no fetch - the pages' loaders would throw into their own try/catch
//     and the archive would silently stay empty;
//   * the pages pass RELATIVE urls ('../json/...'), so the stub must resolve
//     them against document.baseURI or node's fetch throws on URL parsing;
//   * it has no layout engine, so getBoundingClientRect() is all zeros and the WM
//     falls back to window.innerWidth/innerHeight (which it already handles);
//   * '<!-- populated by JS -->' is non-empty text, so waits must look for real
//     nodes, not innerHTML.length.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = __dirname;
const PORT = 4202;
const BASE = 'http://localhost:' + PORT;
const TMP = path.join(os.tmpdir(), 'bonfire-shell-' + process.pid);

for (const d of ['js', 'json', 'HTML', 'CSS']) {
  fs.cpSync(path.join(ROOT, d), path.join(TMP, d), { recursive: true });
}
fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(TMP, 'server.js'));

const MOBILE = process.env.BONFIRE_VIEWPORT === 'mobile';

// jsdom gives every iframe a brand-new window, so stubs installed from Node -
// including ones patched onto the Window prototype - never reach the framed app,
// and it dies on "matchMedia is not a function" before its WM can boot. There is
// no iframe equivalent of beforeParse, so the only deterministic hook is the
// document itself. Inject a stub at the top of each page in the THROWAWAY COPY.
// The real files in the workspace are never modified.
const STUB = '<script>' + [
  '(function () {',
  '  window.matchMedia = function (q) { return { matches: __MM__, media: q, onchange: null,',
  '    addListener: function () {}, removeListener: function () {},',
  '    addEventListener: function () {}, removeEventListener: function () {},',
  '    dispatchEvent: function () { return false; } }; };',
  '  if (!window.fetch) {',
  '    window.fetch = function (url, opts) {',
  '      opts = opts || {};',
  '      return new Promise(function (res, rej) {',
  '        var x = new XMLHttpRequest();',
  '        x.open(opts.method || "GET", url, true);',
  '        if (opts.headers) { for (var k in opts.headers) x.setRequestHeader(k, opts.headers[k]); }',
  '        x.onload = function () { res({ ok: x.status >= 200 && x.status < 300, status: x.status,',
  '          statusText: x.statusText,',
  '          json: function () { return Promise.resolve(JSON.parse(x.responseText)); },',
  '          text: function () { return Promise.resolve(x.responseText); } }); };',
  '        x.onerror = function () { rej(new Error("network error")); };',
  '        x.send(opts.body || null);',
  '      });',
  '    };',
  '  }',
  '})();',
].join('\n').replace('__MM__', MOBILE ? 'true' : 'false') + '</script>\n';

for (const page of ['TheBonfire.html', 'ConversationPit.html']) {
  const f = path.join(TMP, 'HTML', page);
  const html = fs.readFileSync(f, 'utf8');
  if (html.split('<head>').length - 1 !== 1) throw new Error('no single <head> in ' + page);
  fs.writeFileSync(f, html.replace('<head>', '<head>\n' + STUB), 'utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
}
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return; } catch (e) { /* keep polling */ }
    if (Date.now() - t0 > ms) throw new Error('TIMEOUT: ' + label);
    await sleep(100);
  }
}
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ } };

const srv = spawn(process.execPath, ['server.js'], {
  cwd: TMP,
  env: Object.assign({}, process.env, { PORT: String(PORT) }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', (d) => { srvLog += d; });
srv.stderr.on('data', (d) => { srvLog += d; });

async function main() {
  await waitFor(async () => {
    try { return (await fetch(BASE + '/')).ok; } catch (e) { return false; }
  }, 20000, 'server up');

  const pageUrl = BASE + '/HTML/TheBonfire.html';
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => {
    if (!/Could not load|css|image|iframe/i.test(e.message)) console.log('  [jsdom] ' + e.message);
  });

  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'HTML', 'TheBonfire.html'), 'utf8'), {
    url: pageUrl,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.alert = () => {};
      // jsdom has no fetch. The pages pass RELATIVE urls, and node's fetch cannot
      // parse them, so resolve against a base. Both pages live in /HTML/, so one
      // base resolves correctly for the shell and for the framed app.
      const stubFetch = (u, o) => fetch(new URL(String(u), pageUrl).href, o);
      const stubMM = (q) => ({
        matches: MOBILE, media: q,
        addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {}, onchange: null, dispatchEvent() { return false; },
      });
      w.fetch = stubFetch;
      w.matchMedia = stubMM;
    },
  });
  const w = dom.window;
  const d = w.document;
  const ev = (s) => w.eval(s);

  // An iframe gets a FRESH window object, so the instance stubs installed in
  // beforeParse never reach it and the framed app dies on "matchMedia is not a
  // function". Patch the shared Window prototype instead - done here rather than
  // in beforeParse because the prototype is only stable once JSDOM returns.
  try {
    const proto = Object.getPrototypeOf(w);
    const mm = w.matchMedia;
    const fx = w.fetch;
    proto.matchMedia = function (q) { return mm.call(w, q); };
    proto.fetch = function (u, o) { return fx.call(w, u, o); };
  } catch (e) {
    console.log('  [warn] could not patch Window prototype: ' + e.message);
  }

  // ---- 1. the shell boots into a desktop ----
  await waitFor(() => typeof w.WM !== 'undefined' && !!d.getElementById('desktop'), 20000, 'shell boot');
  await waitFor(() => d.querySelectorAll('#deskIcons .desk-ico').length >= 2, 20000, 'desk icons');

  const icons = [...d.querySelectorAll('#deskIcons .desk-ico')];
  check('shell exposes a desktop layer', !!d.getElementById('desktop'));
  check('two desktop icons', icons.length === 2, icons.map((i) => i.textContent.trim()).join(' | '));
  // Desktop convention: one icon per row, stacked downward, not a side by side row.
  // Asserted through computed style only: jsdom has no layout engine, so every
  // getBoundingClientRect() returns 0x0 and a geometry assertion here could never
  // pass without stubbing the very thing under test.
  const iconFlex = w.getComputedStyle(d.getElementById('deskIcons')).flexDirection;
  check('desktop icons stack vertically', iconFlex === 'column', iconFlex);
  check('desktop icons stay a single column',
    w.getComputedStyle(d.getElementById('deskIcons')).flexWrap === 'nowrap',
    w.getComputedStyle(d.getElementById('deskIcons')).flexWrap);
  check('no page-crossing nav links remain', d.querySelectorAll('.topbar-nav a[href]').length === 0);

  const filesIco = icons.find((i) => i.getAttribute('data-wm-open') === 'files');
  const chatIco = icons.find((i) => i.getAttribute('data-wm-open') === 'chat');
  check('Files icon exists and uses Files_icon', !!filesIco && /desk-ico-files/.test(filesIco.innerHTML));
  check('Conversation Pit icon exists', !!chatIco);
  check('wm.js is shared, not inlined', /js\/wm\.js/.test(d.documentElement.innerHTML));

  // ---- 2. Files window: the reader was adopted, not rebuilt ----
  await waitFor(() => d.querySelectorAll('#entryBox p').length > 0, 25000, 'reader rendered');
  check('Files window is open at boot', ev('WM.isOpen("files")'));
  check('reader lives inside the window', !!d.querySelector('#win-files #entryBox'));
  check('entry list lives inside the window', !!d.querySelector('#win-files #sidebar'));
  check('adopted window is managed by the WM', ev('WM.wins.has("files")'));

  // Drop cap regression guard: the selector fix must survive the re-parenting.
  const drop = d.querySelector('#entryBox .drop');
  check('drop cap still renders in the windowed reader', !!drop,
    drop ? 'text=' + JSON.stringify(drop.textContent) : 'missing');
  if (drop) {
    const cs = w.getComputedStyle(drop);
    check('drop cap keeps ember treatment (28px/bold/float)',
      cs.fontSize === '28px' && cs.fontWeight === '700' && cs.float === 'left',
      cs.fontSize + '/' + cs.fontWeight + '/' + cs.float);
  }
  const firstP = d.querySelector('#entryBox p');
  check('paragraph rhythm intact after re-parenting',
    !!firstP && w.getComputedStyle(firstP).marginBottom === '1.2em',
    firstP ? w.getComputedStyle(firstP).marginBottom : 'n/a');

  // ---- 3. window controls ----
  const bar = d.querySelector('#win-files .pwin-bar');
  check('window bar exposes min/max/close', !!bar && bar.querySelectorAll('[data-wm-act]').length === 3,
    bar ? String(bar.querySelectorAll('[data-wm-act]').length) : 'no bar');

  ev('WM.minimize(WM.wins.get("files"))');
  check('minimize marks the window', ev('WM.wins.get("files").state') === 'min');
  ev('WM.restore(WM.wins.get("files"))');
  check('restore brings it back', ev('WM.wins.get("files").state') === 'normal');
  ev('WM.maximize(WM.wins.get("files"))');
  check('maximize fills the work area', ev('WM.wins.get("files").state') === 'max');
  ev('WM.restore(WM.wins.get("files"))');
  ev('WM.close(WM.wins.get("files"))');
  check('close hides it', ev('!WM.isOpen("files")'));
  filesIco.click();
  check('clicking the desktop icon reopens it', ev('WM.isOpen("files")'));

  // ---- 4. taskbar ----
  check('taskbar has a chip per open window',
    d.querySelectorAll('#wmTaskbar .wm-chip').length === ev('WM.list().length'),
    d.querySelectorAll('#wmTaskbar .wm-chip').length + ' chip(s)');
  ev('WM.close(WM.wins.get("files"))');
  check('closed window drops off the taskbar',
    d.querySelectorAll('#wmTaskbar .wm-chip').length === ev('WM.list().length'));
  filesIco.click();

  // ---- 5. the framed Conversation Pit ----
  chatIco.click();
  check('Conversation Pit window opens', ev('WM.isOpen("chat")'));
  await waitFor(() => !!d.querySelector('#win-chat iframe'), 15000, 'iframe created');

  const frame = d.querySelector('#win-chat iframe');
  check('window body hosts a frame, not a copied page',
    !!frame && /ConversationPit\.html$/.test(frame.getAttribute('src')));

  await waitFor(() => {
    const f = frame.contentWindow;
    return f && typeof f.WM !== 'undefined' && f.document
      && f.document.body.classList.contains('is-embedded');
  }, 30000, 'frame boots in embed mode');

  const cw = frame.contentWindow;
  const cd = cw.document;
  check('frame detected it is framed', cd.body.classList.contains('is-embedded'));
  check('frame hides its own topbar (no stacked bars)',
    !!cd.querySelector('.topbar') && cw.getComputedStyle(cd.querySelector('.topbar')).display === 'none');
  check('frame hides its own desktop surface',
    cw.getComputedStyle(cd.querySelector('.body')).display === 'none');
  check('frame fills the window (layer inset 0)',
    /^0(px)?$/.test(cd.getElementById('desktop').style.inset), cd.getElementById('desktop').style.inset);
  check('frame hides its inner taskbar (the parent owns the dock)',
    !!cd.getElementById('wmTaskbar') && cw.getComputedStyle(cd.getElementById('wmTaskbar')).display === 'none');
  check('frame hides its transient status line',
    cw.getComputedStyle(cd.getElementById('wmStatus')).display === 'none');
  // Option B: the window bar keeps only the live status, so the furniture goes
  // but the channel's Online/Offline dot and [OFF-LOG] badge survive.
  const innerBar = cd.querySelector('#win-chat .pwin-bar');
  check('frame has a window bar for the live status', !!innerBar);
  // The chat bar uses .chat-title/.chat-winbtns; a WM-built window would use
  // .pwin-title/.pwin-btns. Resolve by hand so a missing selector is a clean
  // false rather than getComputedStyle(null) throwing.
  const barEl = (sel) => (innerBar ? innerBar.querySelector(sel) : null);
  const barHidden = (sel) => {
    const e = barEl(sel);
    return !!e && cw.getComputedStyle(e).display === 'none';
  };
  const barVisible = (sel) => {
    const e = barEl(sel);
    return !!e && cw.getComputedStyle(e).display !== 'none';
  };
  check('frame hides the inner window title', barHidden('.pwin-title') || barHidden('.chat-title'));
  check('frame hides the inner window icon', barHidden('.pwin-ico'));
  check('frame hides the inner window controls (close lives in the shell)',
    barHidden('.pwin-btns') || barHidden('.chat-winbtns'));
  check('frame KEEPS the live status dot visible', barVisible('.chat-status-dot'));
  // The badge carries the hidden attribute until a restricted room is showing,
  // so assert presence here, not visibility.
  check('frame KEEPS the [OFF-LOG] badge', !!barEl('.restricted-badge'));
  // The app should fill the frame: no window-inside-a-window framing.
  const innerWin = cd.querySelector('#win-chat');
  const winCs = cw.getComputedStyle(innerWin);
  check('frame window has no border/radius/shadow',
    (winCs.borderTopWidth === '0px' || winCs.borderTopStyle === 'none')
    && (winCs.borderTopLeftRadius === '0px' || winCs.boxShadow === 'none'),
    'border=' + winCs.borderTopWidth + ' radius=' + winCs.borderTopLeftRadius + ' shadow=' + winCs.boxShadow);
  check('frame window fills the layer',
    innerWin.style.width === cw.eval('WM.bounds().w + "px"')
    && innerWin.style.height === cw.eval('WM.bounds().h + "px"'),
    innerWin.style.width + 'x' + innerWin.style.height);
  check('frame exposes the cross-frame editor contract',
    !!(cw.BonfireApp && typeof cw.BonfireApp.toggleEditor === 'function'));

  await waitFor(() => cw.eval('typeof conversations!=="undefined" && DATA_SOURCE==="api" && conversations.length>0'),
    30000, 'frame conversations load');
  check('frame loaded real conversations', cw.eval('conversations.length') > 0,
    cw.eval('conversations.length') + ' conversation(s)');
  check('frame chat window is open and maximized',
    cw.eval('WM.isOpen("chat") && WM.wins.get("chat").state') === 'max');

  // ---- 6. the chat frame keeps its cross-frame editor contract ----
  // The shell's own pencil used to be a second door into this frame's editor.
  // Conv.exe replaced it, but the contract must survive for anything else that
  // wants to drive that window.
  check('chat frame still exposes its editor contract',
    !!(cw.BonfireApp && typeof cw.BonfireApp.toggleEditor === 'function'));
  cw.eval('BonfireApp.toggleEditor()');
  await sleep(300);
  check('the contract still opens the frame editor', cw.eval('WM.isOpen("editor")'));
  cw.eval('WM.close(WM.wins.get("editor"))');

  // ---- 7. the gate is shared across the frame boundary ----
  // Driven through the real panel UI rather than Gate.tryUnlock(): that export
  // was removed as dead surface, and the panel is the path a user actually takes.
  check('gate is locked in the frame', cw.eval('Gate.isUnlocked()') === false);
  const locked = cw.eval('visibleConversations().length');

  d.querySelector('.topbar-logo').click();
  await sleep(200);
  const gateInput = d.querySelector('#gateInput');
  check('shell gate panel opens from the topbar logo', !!gateInput);
  gateInput.value = 'HEARTH';
  d.querySelector('#gateUnlock').click();
  await sleep(300);
  check('entering the code unlocks the shell', ev('Gate.isUnlocked()') === true);

  const seen = cw.eval('visibleConversations().length');
  check('the unlock carries into the frame (shared localStorage)',
    cw.eval('localStorage.getItem("eho.gate.unlocked")') === '1');
  check('restricted rooms become visible in the frame', seen > locked, locked + ' -> ' + seen);

  // ---- 9. Admin.exe hub ----
  const adminIco = d.querySelector('#deskCorner .desk-ico');
  check('Admin.exe sits in the bottom-right corner', !!adminIco);
  check('Admin.exe icon is labelled as an executable',
    adminIco.textContent.trim() === 'Admin.exe', adminIco.textContent.trim());
  check('corner icon is absolutely positioned, not in the top-left strip',
    w.getComputedStyle(d.getElementById('deskCorner')).position === 'absolute',
    w.getComputedStyle(d.getElementById('deskCorner')).position);
  check('Admin window starts closed', ev('!WM.isOpen("admin")'));
  check('the old entry-editor dropdown is gone (the gate keeps its own panel)',
    d.getElementById('editorPanel') === null
    && [...d.querySelectorAll('.editor-panel')].every((p) => p.querySelector('#gateInput')));

  adminIco.click();
  check('Admin.exe icon opens the hub', ev('WM.isOpen("admin")'));

  // The hub edits nothing: it only offers a choice.
  check('the hub holds no editor form', !d.querySelector('#win-admin #ed-body'));
  check('the hub offers exactly two choices',
    d.querySelectorAll('#win-admin .hub-card').length === 2);
  const cardNames = [...d.querySelectorAll('#win-admin .hub-card b')].map((b) => b.textContent);
  check('choices are named Entry.exe and Conv.exe',
    cardNames.join(',') === 'Entry.exe,Conv.exe', cardNames.join(', '));
  check('both cards are real buttons (keyboard reachable)',
    [...d.querySelectorAll('#win-admin .hub-card')].every((c) => c.tagName === 'BUTTON'));

  // ---- 10. Entry.exe ----
  d.querySelectorAll('#win-admin .hub-card')[0].click();
  check('Entry.exe opens as its own window', ev('WM.isOpen("entry")'));
  check('Entry.exe is titled Entry.exe',
    d.querySelector('#win-entry .pwin-title').textContent === 'Entry.exe');
  check('the entry editor form lives inside Entry.exe', !!d.querySelector('#win-entry #ed-body'));
  check('Entry.exe is a separate window from the hub', ev('WM.isOpen("admin")'));
  check('Entry.exe has a taskbar chip',
    [...d.querySelectorAll('#wmTaskbar .wm-chip')].some((c) => c.textContent.indexOf('Entry.exe') >= 0));

  // The topbar pencil is an inert placeholder: Entry.exe is reached only via the hub.
  ev('WM.close(WM.wins.get("entry"))');
  const pencil = d.querySelector('.editor-toggle');
  check('the topbar pencil is still present', !!pencil);
  check('the topbar pencil is disabled', pencil.disabled === true);
  check('the topbar pencil cannot open Entry.exe', (() => {
    pencil.click();
    return !ev('WM.isOpen("entry")');
  })());
  check('the pencil is styled as inert',
    w.getComputedStyle(pencil).opacity !== '1'
    || w.getComputedStyle(pencil).cursor === 'default',
    'opacity=' + w.getComputedStyle(pencil).opacity + ' cursor=' + w.getComputedStyle(pencil).cursor);

  // Entry.exe must remain reachable, but only through the hub.
  d.querySelectorAll('#win-admin .hub-card')[0].click();
  check('Entry.exe is still reachable through the hub', ev('WM.isOpen("entry")'));

  // ---- 11. Conv.exe ----
  check('Conv.exe frame is NOT built before first open', !d.querySelector('#win-conv iframe'));
  d.querySelectorAll('#win-admin .hub-card')[1].click();
  check('Conv.exe opens as its own window', ev('WM.isOpen("conv")'));
  check('Conv.exe is titled Conv.exe',
    d.querySelector('#win-conv .pwin-title').textContent === 'Conv.exe');
  await waitFor(() => !!d.querySelector('#win-conv iframe'), 20000, 'Conv.exe frame');
  const convFrame = d.querySelector('#win-conv iframe');
  check('Conv.exe frame asks for editor-only mode',
    /\?app=editor$/.test(convFrame.getAttribute('src')), convFrame.getAttribute('src'));

  await waitFor(() => {
    const f = convFrame.contentWindow;
    return f && typeof f.WM !== 'undefined' && f.document
      && f.document.body.classList.contains('is-editor-only');
  }, 30000, 'Conv.exe frame boots');

  const ecw = convFrame.contentWindow;
  const ecd = ecw.document;
  check('Conv.exe frame is in editor-only mode', ecd.body.classList.contains('is-editor-only'));
  // The editor now opens only after the store answers, so it lands a beat after
  // the frame reports itself ready. Wait for it rather than racing it.
  await waitFor(() => ecw.eval('WM.isOpen("editor")'), 20000, 'Conv.exe editor open');
  check('Conv.exe frame booted straight into the editor', ecw.eval('WM.isOpen("editor")'));
  check('Conv.exe frame left the chat closed', ecw.eval('!WM.isOpen("chat")'));
  check('Conv.exe frame editor is maximized',
    ecw.eval('WM.wins.get("editor").state') === 'max');
  check('Conv.exe frame hides its dock and status line',
    ecw.getComputedStyle(ecd.getElementById('wmTaskbar')).display === 'none');
  check('Conv.exe frame hides the WM boot diagnostic',
    ecw.getComputedStyle(ecd.getElementById('wmBoot')).display === 'none');
  check('the boot line has no leftover text in the frame',
    (ecd.getElementById('wmBoot').textContent || '') === ''
    || ecw.getComputedStyle(ecd.getElementById('wmBoot')).display === 'none');

  // The bug this file was extended to catch: the editor window paints once when
  // it is built, and Conv.exe boots straight into it BEFORE the store answers,
  // so it rendered an empty list that nothing ever repainted.
  await waitFor(() => ecw.eval('conversations.length') > 0, 15000, 'Conv.exe frame data');
  await sleep(300);
  const expBody = ecd.getElementById('expBody');
  const folderBtns = expBody ? expBody.querySelectorAll('.exp-folder').length : 0;
  check('Conv.exe editor lists the real rooms',
    folderBtns === ecw.eval('conversations.length'),
    'rows=' + folderBtns + ' conversations=' + ecw.eval('conversations.length'));
  check('Conv.exe editor is NOT showing the empty-archive state',
    expBody && expBody.querySelector('.exp-empty') === null);
  check('Conv.exe editor did not fall back to the legacy flat file',
    ecw.eval('DATA_SOURCE') === 'api', ecw.eval('DATA_SOURCE'));

  // A single click must open a room. This regressed once: the folders opened on
  // dblclick only, so a single press just moved a highlight and looked dead.
  const folders = () => ecd.querySelectorAll('.exp-folder');
  check('the editor lists room folders', folders().length === ecw.eval('conversations.length'),
    folders().length + ' folder(s)');
  const folderTitle = folders()[1].querySelector('.exp-folder-title').textContent;
  check('folder tooltip says click, not double-click',
    /click to open/i.test(folders()[1].title), folders()[1].title);
  // Real press sequence: pointerdown -> mousedown -> mouseup -> click. A plain
  // .click() would not catch a handler that only bound to dblclick.
  const f1 = folders()[1];
  ['pointerdown', 'mousedown', 'mouseup'].forEach((type) => {
    f1.dispatchEvent(new ecw.MouseEvent(type, { bubbles: true, cancelable: true }));
  });
  f1.dispatchEvent(new ecw.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(300);
  check('a SINGLE click opens the room', ecw.eval('Explorer.view') === 'folder',
    ecw.eval('Explorer.view'));
  check('the opened room is the one clicked',
    ecw.eval('conversations.find(function(c){return c.id===Explorer.convId}).title') === folderTitle,
    folderTitle);
  check('the folder view rendered message rows for that room',
    ecd.querySelectorAll('.ex-row').length > 0,
    ecd.querySelectorAll('.ex-row').length + ' row(s)');
  ecw.eval('(function(){ var b=document.querySelector(\'[data-exp="root"]\'); if (b) b.click(); })()');
  await sleep(200);
  check('Back returns to the room list', ecw.eval('Explorer.view') === 'root',
    ecw.eval('Explorer.view'));

  // Refresh must repaint an already-open editor, not silently do nothing.
  ecw.eval('refreshConversations()');
  await sleep(400);
  const after = ecd.getElementById('expBody').querySelectorAll('.exp-folder').length;
  check('refreshConversations() repaints the open editor', after === ecw.eval('conversations.length'),
    'rows=' + after);
  const refreshBtn = ecd.querySelector('[data-exp="refresh"]');
  check('the editor exposes a Refresh control', !!refreshBtn);
  refreshBtn.click();
  await sleep(400);
  check('the editor Refresh button repaints the list',
    ecd.getElementById('expBody').querySelectorAll('.exp-folder').length === ecw.eval('conversations.length'));

  // The editor-only frame must not build a chat stream nobody will see.
  check('Conv.exe frame skipped the chat stream build',
    ecw.eval('typeof stream === "undefined" || stream.length === 0'),
    'stream=' + ecw.eval('typeof stream === "undefined" ? "n/a" : stream.length'));

  // The fourth door is gone: the chat window bar no longer carries a pencil.
  check('the chat window bar no longer has an editor button',
    d.querySelector('#win-chat .pwin-btns button[aria-label="Open the conversation editor"]') === null);

  // ---- 12. no window spawns on top of an icon ----
  // jsdom has no layout, so every box measures 0x0 and avoidRects() would find
  // nothing to avoid - the avoidance logic would then pass VACUOUSLY. Give the
  // layer and both icon containers synthetic boxes so the geometry is genuinely
  // exercised. These stubs live only in the harness.
  const box = (x, y, ww, hh) => function () {
    return { left: x, top: y, width: ww, height: hh, right: x + ww, bottom: y + hh };
  };
  d.getElementById('desktop').getBoundingClientRect = box(0, 48, 1024, 700);
  d.getElementById('deskIcons').getBoundingClientRect = box(20, 20, 320, 120);
  d.getElementById('deskCorner').getBoundingClientRect = box(900, 600, 120, 120);

  check('window manager avoids both icon areas',
    ev('WM.avoidRects().length') === 2, ev('WM.avoidRects().length') + ' rect(s)');

  const rects = JSON.parse(ev('JSON.stringify(WM.avoidRects())'));
  const overlaps = (a, r) => r.x < a.x + a.w && r.x + r.w > a.x && r.y < a.y + a.h && r.y + r.h > a.y;
  check('both the top-left strip and the bottom-right corner are avoided',
    rects.length === 2 && rects.some((a) => a.y < 200) && rects.some((a) => a.y > 400),
    JSON.stringify(rects));

  // Centred placement would land on the top-left strip, so this must relocate.
  const spawned = JSON.parse(ev('JSON.stringify(WM.spawnRect(400, 300))'));
  check('a spawned window clears both icons', !rects.some((a) => overlaps(a, spawned)),
    JSON.stringify(spawned));
  check('the relocated window still fits the work area',
    spawned.x >= 0 && spawned.y >= 0
    && spawned.x + spawned.w <= 1024 && spawned.y + spawned.h <= 700,
    JSON.stringify(spawned));

  // ---- 13. the embedded roster (AIM-style room switcher) ----
  // Embed mode hides #sidebar, so this list is the only way to leave a room.
  const roster = cd.getElementById('roster');
  check('the chat window has a roster beside the transcript', !!roster);
  check('roster sits inside the chat window, left of the transcript',
    !!roster && roster.parentElement.classList.contains('chat-body')
    && !!roster.parentElement.querySelector('#chatArea'));
  check('roster is shown when embedded',
    cw.getComputedStyle(roster).display !== 'none', cw.getComputedStyle(roster).display);
  check('roster rows are real buttons (keyboard reachable)',
    [...roster.querySelectorAll('.roster-row')].every((r) => r.tagName === 'BUTTON'));

  const rows = roster.querySelectorAll('.roster-row');
  check('roster lists every visible room',
    rows.length === cw.eval('visibleConversations().length'),
    'rows=' + rows.length + ' visible=' + cw.eval('visibleConversations().length'));
  check('roster shows a presence dot per room',
    roster.querySelectorAll('.roster-dot').length === rows.length);
  check('presence reflects the stored status (padded values trimmed)',
    roster.querySelectorAll('.roster-dot.is-online').length
      === cw.eval('conversations.filter(function(c){'
        + 'return String(c.status||"").trim().toLowerCase()==="online"}).length'),
    roster.querySelectorAll('.roster-dot.is-online').length + ' online');
  check('exactly one row is active',
    roster.querySelectorAll('.roster-row.is-active').length === 1);

  // Switching rooms: click a different row and confirm the chat follows.
  const beforeIdx = cw.eval('currentIndex');
  const target = [...rows].find((r) => !r.classList.contains('is-active'));
  target.click();
  await sleep(250);
  check('clicking a roster row switches the open room',
    cw.eval('currentIndex') !== beforeIdx, beforeIdx + ' -> ' + cw.eval('currentIndex'));
  check('the active highlight follows the open room',
    cw.eval('document.querySelector("#roster .roster-row.is-active .roster-name").textContent')
      === cw.eval('conversations[currentIndex].title'));
  check('the transcript rebuilt for the new room', cw.eval('stream.length > 0'));

  // Gating: a locked archive must not list restricted rooms in the roster.
  // Driven through #gateRelock, not Gate.lock(): that export was removed as dead
  // surface, and the button is the path a user actually takes.
  const relock = cd.querySelector('#gateRelock');
  check('the frame builds no gate panel of its own (the parent owns it)',
    relock === null);
  // Gating. The frame's own gate panel is never built (embed mode hides the
  // topbar that opens it), so the frame's locked state cannot be driven from
  // here. Instead assert the property directly: the roster is EXACTLY the
  // gate-filtered list, never a superset - and prove that is not vacuous by
  // requiring the archive to actually contain a restricted room.
  check('the archive contains restricted rooms (so gating is meaningful)',
    cw.eval('conversations.some(function(c){return !!c.restricted})'));
  const shown = [...roster.querySelectorAll('.roster-name')].map((n) => n.textContent);
  const allowed = cw.eval('visibleConversations().map(function(c){return c.title || c.id})');
  check('roster is exactly the gate-filtered list, not a superset',
    JSON.stringify(shown) === JSON.stringify(allowed),
    'shown=' + shown.length + ' allowed=' + allowed.length);
  check('every roster row names a conversation that passed the gate',
    shown.every((t) => allowed.indexOf(t) >= 0));
  check('an unlocked roster marks the restricted rooms with [OFF-LOG]',
    cw.eval('Gate.isUnlocked()')
      ? roster.querySelectorAll('.restricted-badge').length
          === cw.eval('conversations.filter(function(c){return !!c.restricted}).length')
      : true,
    roster.querySelectorAll('.restricted-badge').length + ' badge(s)');

  // ---- 14. mobile / narrow-viewport behaviour ----
  // Base (non-media) rules are asserted through computed style; the @media
  // blocks are asserted by inspecting the shipped stylesheet, because jsdom has
  // no layout engine and does not evaluate media queries in getComputedStyle.
  check('WM reports the viewport mode under test',
    ev('WM.isMobile()') === MOBILE, 'isMobile=' + ev('WM.isMobile()'));

  const transport = cd.querySelector('.chat-transport');
  check('chat transport wraps instead of overflowing',
    cw.getComputedStyle(transport).flexWrap === 'wrap',
    cw.getComputedStyle(transport).flexWrap);
  check('the divider select is capped to its container',
    cw.getComputedStyle(cd.querySelector('select.chat-btn')).maxWidth === '100%',
    cw.getComputedStyle(cd.querySelector('select.chat-btn')).maxWidth);

  const sheet = fs.readFileSync(path.join(ROOT, 'CSS', 'TheBonfire.css'), 'utf8');
  const flat = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
  check('mobile reclaim rule exists and skips embedded frames',
    /@media[^{]*max-width:\s*820px\)\s*\{[^@]*?body:not\(\.is-embedded\)\s+\.pwin:not\(\.is-max\)/s.test(flat));
  check('embedded window fill is important-overridden',
    /\.is-embedded\s+\.pwin[^}]*inset:\s*0\s*!important/s.test(flat)
    && /\.is-embedded\s+\.pwin[^}]*border:\s*0\s*!important/s.test(flat));
  check('a phone transport breakpoint exists at 600px',
    /@media\s*\(max-width:\s*600px\)/.test(flat));
  check('the roster is hidden below 600px',
    /@media\s*\(max-width:\s*600px\)\s*\{[^@]*?\.roster\s*\{\s*display:\s*none\s*!important/s.test(flat));

  // ---- 15. sidebar: no horizontal scrollbar, full-width rows ----
  // The Files window's entry list is the live instance of .sidebar/.nav-item in
  // the shell (the framed Conversation Pit hides its own in embed mode).
  const sb = d.querySelector('#win-files .sidebar');
  check('the shell sidebar is a flex column', w.getComputedStyle(sb).flexDirection === 'column',
    w.getComputedStyle(sb).flexDirection);
  check('the shell sidebar scrolls vertically', w.getComputedStyle(sb).overflowY === 'auto',
    w.getComputedStyle(sb).overflowY);
  // The real bug: overflow-y:auto alone computes overflow-x from `visible` to
  // `auto`, so any title wider than the column grew a bottom scrollbar.
  check('the shell sidebar cannot scroll horizontally', w.getComputedStyle(sb).overflowX === 'hidden',
    w.getComputedStyle(sb).overflowX);

  const navItems = sb.querySelectorAll('.nav-item');
  check('sidebar has items', navItems.length > 0, navItems.length + ' item(s)');
  check('each item carries its own truncating title element',
    navItems.length > 0 && [...navItems].every((n) => !!n.querySelector('.nav-title')),
    (navItems[0] && navItems[0].querySelector('.nav-title')) ? 'yes' : 'no');
  const tCs = navItems.length ? w.getComputedStyle(navItems[0].querySelector('.nav-title')) : {};
  check('titles ellipsize instead of overflowing',
    tCs.overflow === 'hidden' && tCs.textOverflow === 'ellipsis' && tCs.whiteSpace === 'nowrap',
    (tCs.overflow || '?') + '/' + (tCs.textOverflow || '?') + '/' + (tCs.whiteSpace || '?'));
  check('items are display:block, not inline-block',
    w.getComputedStyle(navItems[0]).display === 'block', w.getComputedStyle(navItems[0]).display);
  check('items are border-box', w.getComputedStyle(navItems[0]).boxSizing === 'border-box',
    w.getComputedStyle(navItems[0]).boxSizing);

  // The framed app's roster gets the same treatment.
  check('the roster also cannot scroll horizontally',
    cw.getComputedStyle(roster).overflowX === 'hidden', cw.getComputedStyle(roster).overflowX);

  // ---- 16. workspace untouched ----
  // Count directories only: index.json lives in the same folder and is not a room.
  const rooms = fs.readdirSync(path.join(ROOT, 'json', 'dialogue'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
  check('workspace json/dialogue untouched', rooms.length === 6, rooms.length + ' rooms');

  w.close();
}

main().then(() => {
  srv.kill();
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  console.log('\n  OS SHELL REGRESSION\n  ' + '-'.repeat(72));
  let pass = 0;
  for (const r of results) {
    console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + pad(r.name, 46) + (r.extra ? ' | ' + r.extra : ''));
    if (r.ok) pass++;
  }
  console.log('  ' + '-'.repeat(72));
  console.log('  ' + pass + '/' + results.length + ' checks passed\n');
  if (pass !== results.length) console.log('  server log:\n' + srvLog.split('\n').slice(-20).map((l) => '    ' + l).join('\n') + '\n');
  cleanup();
  process.exit(pass === results.length ? 0 : 1);
}).catch((err) => {
  srv.kill();
  console.log('\n  HARNESS ERROR:', err && err.message);
  console.log((err && err.stack ? err.stack : '').split('\n').slice(0, 8).join('\n'));
  console.log('  server log:\n' + srvLog.split('\n').slice(-20).map((l) => '    ' + l).join('\n'));
  cleanup();
  process.exit(2);
});