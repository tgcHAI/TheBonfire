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

// jsdom gives every iframe a brand-new window, so stubs installed from Node -
// including ones patched onto the Window prototype - never reach the framed app,
// and it dies on "matchMedia is not a function" before its WM can boot. There is
// no iframe equivalent of beforeParse, so the only deterministic hook is the
// document itself. Inject a stub at the top of each page in the THROWAWAY COPY.
// The real files in the workspace are never modified.
const STUB = '<script>' + [
  '(function () {',
  '  window.matchMedia = function (q) { return { matches: false, media: q, onchange: null,',
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
].join('\n') + '</script>\n';

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
        matches: false, media: q,
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
  check('frame keeps its taskbar for its own windows',
    !!cd.getElementById('wmTaskbar') && cw.getComputedStyle(cd.getElementById('wmTaskbar')).display !== 'none');
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

  // The topbar pencil is a shortcut straight to Entry.exe, not to the hub.
  ev('WM.close(WM.wins.get("entry"))');
  d.querySelector('.editor-toggle').click();
  check('the topbar pencil opens Entry.exe directly', ev('WM.isOpen("entry")'));

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
  check('Conv.exe frame booted straight into the editor', ecw.eval('WM.isOpen("editor")'));
  check('Conv.exe frame left the chat closed', ecw.eval('!WM.isOpen("chat")'));
  check('Conv.exe frame editor is maximized',
    ecw.eval('WM.wins.get("editor").state') === 'max');
  check('Conv.exe frame hides its dock and status line',
    ecw.getComputedStyle(ecd.getElementById('wmTaskbar')).display === 'none');

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

  // ---- 11. workspace untouched ----
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