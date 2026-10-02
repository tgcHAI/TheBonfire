'use strict';
// Regression harness for the inline message editor.
// Runs the REAL page (jsdom) against the REAL server.js against a THROWAWAY
// copy of the repo, so json/dialogue in the workspace is never mutated.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = __dirname;
const PORT = 4199;
const BASE = 'http://localhost:' + PORT;
const TMP = path.join(os.tmpdir(), 'bonfire-verify-' + process.pid);

// 'mats' is deliberately NOT copied: jsdom has no layout engine, so it never
// rasterises the logo or the icons, and those URLs just 404 inside the sandbox.
for (const d of ['js', 'json', 'HTML', 'CSS']) {
  fs.cpSync(path.join(ROOT, d), path.join(TMP, d), { recursive: true });
}
fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(TMP, 'server.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok, extra: extra === undefined ? '' : String(extra) });
}
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error('TIMEOUT: ' + label);
    await sleep(100);
  }
}

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
    try { return (await fetch(BASE + '/api/dialogue')).ok; } catch (e) { return false; }
  }, 20000, 'server up');

  const apiCalls = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => {
    if (!/Could not load|css|image/i.test(e.message)) console.log('  [jsdom]', e.message);
  });

  const html = fs.readFileSync(path.join(ROOT, 'HTML', 'ConversationPit.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: BASE + '/HTML/ConversationPit.html?backend=' + encodeURIComponent(BASE),
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.alert = () => {};
      window.confirm = () => true;
      // jsdom has no layout engine, so matchMedia is absent; the page only
      // reads it to pick a mobile/desktop layout.
      window.matchMedia = (q) => ({
        matches: false, media: q,
        addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {}, onchange: null, dispatchEvent() { return false; },
      });
      window.fetch = (u, o) => {
        const url = String(u);
        if (url.indexOf('/api/dialogue') >= 0) apiCalls.push((o && o.method) || 'GET');
        return fetch(u, o);
      };
    },
  });
  const w = dom.window;
  const ev = (s) => w.eval(s);
  function id0() { return ev('Explorer.convId'); }

  await waitFor(
    () => Promise.resolve(ev('typeof conversations !== "undefined" && DATA_SOURCE === "api" && conversations.length > 0')),
    30000, 'page boot');

  // Throwaway room, created and deleted through the page's own code paths.
  await w.eval('createConversationFromEditor()');
  await sleep(600);
  const id = ev('Explorer.convId');
  const Q = JSON.stringify(id);
  check('throwaway room created', !!id, 'id=' + id);
  ev('if (!WM.isOpen("editor")) WM.open("editor"); openFolder(' + Q + ');');
  await sleep(400);

  const ED = '.ex-editor-list';
  const rows = () => w.document.querySelectorAll(ED + ' .ex-row');
  const conv = () => ev('conversations.find(function(c){return c.id===' + Q + '})');
  const texts = () => ev('Array.prototype.map.call(document.querySelectorAll(".ex-editor-list .ex-text"), function(t){return t.value})');
  const async2 = async (s) => { await w.eval(s); };
  const storeOf = async (cid) => {
    const d = await (await fetch(BASE + '/api/dialogue?nocache=' + Date.now())).json();
    return (Array.isArray(d) ? d : d.conversations).find((c) => c.id === cid);
  };

  // ---- 1. a fresh room is seeded with one divider; the inspector is gone ----
  const n0 = rows().length;
  check('fresh room seeded, rows match messages', n0 >= 1 && n0 === conv().messages.length,
    n0 + ' rows / ' + conv().messages.length + ' messages');
  check('inspector window is gone', ev('!WM.list().some(function(x){return x.app==="inspector"})')
    && ev('WM.list().length') === 2, 'windows=' + ev('WM.list().map(function(x){return x.app}).join(",")'));
  check('no filename chrome', w.document.querySelectorAll(ED + ' .exp-file').length === 0
    && !/\d{4}\.json/.test(w.document.getElementById('expBody').textContent));

  // ---- 2. author the room: "+ New Line" x3 ----
  const addBtn = w.document.querySelector('[data-exp="addRow"]');
  for (let i = 0; i < 3; i++) { addBtn.click(); await sleep(60); }
  check('rows render one-per-message', rows().length === n0 + 3 && conv().messages.length === n0 + 3,
    rows().length + ' rows / ' + conv().messages.length + ' messages');
  check('every row has a live text field', w.document.querySelectorAll(ED + ' .ex-text').length === rows().length);
  const lastMsg = conv().messages.slice(-1)[0];
  check('new lines use the real store schema',
    JSON.stringify(lastMsg) === JSON.stringify({ type: 'chat', text: 'New line', screenName: '???', time: '', delayMs: 1600 }),
    JSON.stringify(lastMsg));
  check('empty state cleared once a line exists', !w.document.querySelector(ED + ' .exp-empty'));

  // ---- 3. inline edit: type into a cell, blur commits ----
  const ta = rows()[0].querySelector('.ex-text');
  ta.value = 'EDITED LINE ONE';
  ta.dispatchEvent(new w.Event('change', { bubbles: true }));
  check('edit marks the room dirty', ev('hasPendingWork()') === true);
  check('dirty badge visible', w.document.getElementById('exDirty').hidden === false);

  // ---- 4. Enter walks down; on the last row it creates the next line ----
  ta.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(60);
  check('Enter moves down without adding a row',
    rows().length === n0 + 3 && w.document.activeElement === rows()[1].querySelector('.ex-text'));
  const nLast = rows().length;
  rows()[nLast - 1].querySelector('.ex-text')
    .dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(80);
  check('Enter on last row appends a line', rows().length === nLast + 1, nLast + ' -> ' + rows().length);

  // ---- 4. coalescing: N edits in one window == 1 request ----
  apiCalls.length = 0;
  await async2('(function(){ var c = conversations.find(function(x){return x.id===' + Q + '});'
    + ' var tas = document.querySelectorAll(".ex-editor-list .ex-text");'
    + ' for (var i=0;i<tas.length;i++){ tas[i].value = "burst "+i; tas[i].dispatchEvent(new Event("change",{bubbles:true})); }'
    + ' return flushNow(); })()');
  const writes = apiCalls.filter((m) => m !== 'GET');
  check('burst of N edits == 1 write request', writes.length === 1, writes.length + ' writes: ' + writes.join(','));

  // ---- 5. round-trip against the real store ----
  let store = await storeOf(id);
  check('room persisted to the store', !!store);
  const typed = store ? store.messages.filter((m) => /^burst \d+$/.test(m.text || '')).length : 0;
  check('every typed line round-tripped', typed >= 4, typed + ' of ' + (store ? store.messages.length : 0) + ' lines');
  check('store agrees with the editor',
    store && JSON.stringify(store.messages) === JSON.stringify(conv().messages));

  // ---- 6. reorder moves every index, still one write ----
  apiCalls.length = 0;
  const tBefore = texts();
  rows()[0].querySelector('.ex-down').dispatchEvent(new w.Event('click', { bubbles: true }));
  await sleep(60);
  await async2('flushNow()');
  const tAfter = texts();
  check('down-arrow swaps two rows', tBefore[0] === tAfter[1] && tBefore[1] === tAfter[0],
    JSON.stringify(tBefore.slice(0, 2)) + ' -> ' + JSON.stringify(tAfter.slice(0, 2)));
  check('reorder is one write', apiCalls.filter((m) => m !== 'GET').length === 1,
    apiCalls.filter((m) => m !== 'GET').join(','));
  store = await storeOf(id);
  check('reorder persisted in order',
    store.messages[0].text === tAfter[0] && store.messages[1].text === tAfter[1],
    JSON.stringify(store.messages.slice(0, 2).map((m) => m.text)));

  // ---- 7. Escape abandons the row ----
  const r2 = rows()[1];
  const t2 = r2.querySelector('.ex-text');
  const saved = conv().messages[1].text;
  t2.value = 'THROWN AWAY';
  t2.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check('Escape reverts the row', t2.value === saved, 'control=' + t2.value);

  // ---- 8. undo reverts a committed burst AND persists the revert ----
  const preUndo = conv().messages.map((m) => m.text);
  await async2('(function(){ undoLastChange(); return flushNow(); })()');
  await sleep(400);
  store = await storeOf(id);
  const undone = store.messages.map((m) => m.text);
  check('undo changed the room', JSON.stringify(undone) !== JSON.stringify(preUndo),
    JSON.stringify(preUndo.slice(0, 2)) + ' -> ' + JSON.stringify(undone.slice(0, 2)));
  check('undo persisted (store == memory)', JSON.stringify(undone) === JSON.stringify(conv().messages.map((m) => m.text)));

  // ---- 9. delete a row ----
  const n9 = rows().length;
  rows()[0].querySelector('.ex-del').dispatchEvent(new w.Event('click', { bubbles: true }));
  await sleep(80);
  await async2('flushNow()');
  await sleep(300);
  check('delete removes the row', rows().length === n9 - 1, n9 + ' -> ' + rows().length);
  store = await storeOf(id);
  check('delete persisted', store.messages.length === n9 - 1, 'store=' + store.messages.length);

  // ---- 10. reload persistence ----
  const diskConv = await storeOf(id);
  check('reload sees identical messages',
    JSON.stringify(diskConv.messages) === JSON.stringify(conv().messages),
    'disk=' + diskConv.messages.length + ' mem=' + conv().messages.length);

  // ---- 11. playback still works off the same data ----
  await async2('syncPlayer()');
  check('playback stream still built', ev('typeof currentIndex') === "number" && conv().messages.length > 0,
    'currentIndex=' + ev('currentIndex'));

  // ---- 12. cleanup ----
  await async2('deleteConversationFromEditor(conversations.find(function(x){return x.id===' + Q + '}))');
  await sleep(500);
  const d2 = await (await fetch(BASE + '/api/dialogue?nocache=' + Date.now())).json();
  const list = Array.isArray(d2) ? d2 : d2.conversations;
  check('throwaway room removed from the store', !list.some((c) => c.id === id));
  check('throwaway dir cleaned off disk', !fs.existsSync(path.join(TMP, 'json', 'dialogue', id)));
  check('workspace json/dialogue untouched',
    !fs.readdirSync(path.join(ROOT, 'json', 'dialogue')).some((d) => d === id));

  w.close();
}

main().then(() => {
  srv.kill();
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  console.log('\n  INLINE EDITOR REGRESSION\n  ' + '-'.repeat(72));
  let pass = 0;
  for (const r of results) {
    console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + pad(r.name, 46) + (r.extra ? ' | ' + r.extra : ''));
    if (r.ok) pass++;
  }
  console.log('  ' + '-'.repeat(72));
  console.log('  ' + pass + '/' + results.length + ' checks passed\n');
  if (pass !== results.length) console.log('  server log:\n' + srvLog.split('\n').slice(-25).map((l) => '    ' + l).join('\n') + '\n');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  process.exit(pass === results.length ? 0 : 1);
}).catch((err) => {
  srv.kill();
  console.log('\n  HARNESS ERROR:', err && err.message);
  console.log((err && err.stack ? err.stack : '').split('\n').slice(0, 8).join('\n'));
  console.log('  server log:\n' + srvLog.split('\n').slice(-25).map((l) => '    ' + l).join('\n'));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  process.exit(2);
});

