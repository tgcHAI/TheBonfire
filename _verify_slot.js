// Slot-roll harness: runs the live extracted animateEntryText against a fake DOM
// and virtual clock; all timings derived from the file's own constants.
const fs = require('fs');
let src = fs.readFileSync('HTML/TheBonfire.html', 'utf8').replace(/\r\n/g, '\n');
const startIdx = src.indexOf('const SCRAMBLE_GLYPHS');
const marker = 'requestAnimationFrame(tick);\n  }';
const endIdx = src.indexOf(marker, startIdx);
if (startIdx < 0 || endIdx < 0) { console.error('SLICE_NOT_FOUND'); process.exit(1); }
const slice = src.slice(startIdx, endIdx + marker.length);

const open = slice.indexOf("'");
const close = slice.indexOf("'", open + 1);
const GLYPHS = slice.slice(open + 1, close);
const DUR = +slice.match(/SCRAMBLE_DURATION = (\d+)/)[1];
const ROLL_MS = +slice.match(/ROLL_MS = (\d+)/)[1];
const ROLL_GLYPHS = +slice.match(/ROLL_GLYPHS = (\d+)/)[1];

const ORIGINAL = ['abc def', 'gh ij', 'kl'];
const FULL = ORIGINAL.join('');
const TOTAL = FULL.length;
const msPerChar = DUR / TOTAL;

let failures = 0;
function assert(cond, msg) { if (!cond) failures++; console.log((cond ? ' ok : ' : 'FAIL: ') + msg); }
const isGlyphChar = (c) => c === ' ' || c === '\t' || GLYPHS.includes(c);
const isAllGlyph = (s) => [...s].every(isGlyphChar);

// What the page should show for stream char p at elapsed time E
function expectedChar(p, E) {
  const revealAt = (p + 1) * msPerChar;
  const rollPhase = (E - (revealAt - ROLL_MS)) / ROLL_MS;
  if (rollPhase >= 1) return { state: 'locked', ch: FULL[p] };
  if (rollPhase >= 0) {
    const reel = Math.floor(ROLL_GLYPHS * (2 * rollPhase - rollPhase * rollPhase));
    return { state: 'reel', ch: (reel % 5 === 0) ? FULL[p] : GLYPHS[(p * 7 + reel) % GLYPHS.length] };
  }
  return { state: 'hidden', ch: null };
}
const revealAt = (p) => (p + 1) * msPerChar;

// Probe times: each lands safely inside one state window
const E1 = revealAt(0) + 0.10 * ROLL_MS;              // char0 locked, char1 hidden
const E2 = revealAt(1) - 0.40 * ROLL_MS;              // char1 mid-reel, char2 hidden
const E3 = revealAt(6) + 30;                          // node0 fully locked, node1 hidden
const E4 = revealAt(8) - 0.40 * ROLL_MS;              // char7 locked, char8 mid-reel, char9 hidden
const E5 = revealAt(13) + 100;                        // everything locked

console.log('params: DUR=' + DUR + ' ROLL_MS=' + ROLL_MS + ' ROLL_GLYPHS=' + ROLL_GLYPHS + ' glyphs=' + GLYPHS.length);
assert(DUR > 0 && ROLL_MS === 480 && ROLL_GLYPHS === 14, 'roll constants present and sane');
assert(!/const blend =/.test(slice), 'dead blend helper removed');

function runCase(reduced) {
    let current = [];
  const makeWalker = () => {
    current = ORIGINAL.map((v) => ({ nodeValue: v }));
    let wi = 0;
    return {
      nextNode() { if (wi >= current.length) return null; this.currentNode = current[wi]; wi++; return this.currentNode; },
    };
  };
  let busy = null;
  const box = {
    setAttribute: (k, v) => { if (k === 'aria-busy') busy = v; },
    removeAttribute: (k) => { if (k === 'aria-busy') busy = null; },
  };
  let clock = 10000, queue = [], watchdog = null;
  const make = new Function('window', 'document', 'NodeFilter', 'performance',
    'requestAnimationFrame', 'setInterval', 'clearInterval',
    slice + '\nreturn { animateEntryText };');
  const { animateEntryText } = make(
    { matchMedia: () => ({ matches: reduced }) },
    { createTreeWalker: () => makeWalker() },
    { SHOW_TEXT: 4 },
    { now: () => clock },
    (fn) => queue.push(fn),
    (fn) => { watchdog = fn; return 1; },
    () => { watchdog = null; }
  );
  let sum = 0;
  const pumpTo = (E) => { const dt = E + 90 - sum; sum += dt; clock += dt; const q = queue; queue = []; q.forEach((fn) => fn(clock)); };
  return { animate: () => animateEntryText(box), pumpTo, nodes: () => current.map((n) => n.nodeValue), busy: () => busy };
}

// CASE A — normal motion: cascade + slot roll
const t = runCase(false);
t.animate();
assert(t.busy() === 'true', 'A: aria-busy set');
assert(t.nodes().every(isAllGlyph), 'A: t=0 seeded masks, no real text');

t.pumpTo(E1);
assert(t.nodes()[0][0] === 'a', 'A: char0 locked right after its revealAt');
assert(isAllGlyph(t.nodes()[0].slice(1)), 'A: E1 chars 1+ hidden jitter');
assert(t.nodes().slice(1).every(isAllGlyph), 'A: E1 nodes 1-2 untouched');

t.pumpTo(E2);
const e2c1 = expectedChar(1, E2);
assert(e2c1.state === 'reel', 'A: probe E2 is inside char1 reel (state ' + e2c1.state + ')');
assert(t.nodes()[0][0] === 'a' && t.nodes()[0][1] === e2c1.ch, 'A: char1 = deterministic reel/tease glyph at E2');
assert(isAllGlyph(t.nodes()[0].slice(2)), 'A: char2+ still hidden at E2');

t.pumpTo(E3);
assert(t.nodes()[0] === 'abc def', 'A: node0 fully decoded at ~half way');
assert(isAllGlyph(t.nodes()[1]) && isAllGlyph(t.nodes()[2]), 'A: node1/2 hidden mid-wave');
assert(t.busy() === 'true', 'A: still decoding at half way');

t.pumpTo(E4);
const e4c8 = expectedChar(8, E4);
assert(e4c8.state === 'reel', 'A: probe E4 inside char8 reel');
assert(t.nodes()[1][0] === 'g' && t.nodes()[1][1] === e4c8.ch, 'A: char7 locked, char8 = deterministic reel');
console.log('  debug E4: node1=' + JSON.stringify(t.nodes()[1]) + ' expected c8=' + JSON.stringify(e4c8.ch) + ' phase=' + ((E4 - (revealAt(8) - ROLL_MS)) / ROLL_MS));
assert(isAllGlyph(t.nodes()[1].slice(2)) && isAllGlyph(t.nodes()[2]), 'A: rest hidden at E4');

t.pumpTo(E5);
assert(t.nodes().join('|') === ORIGINAL.join('|'), 'A: whole entry decoded at ~DUR');
assert(t.busy() === null, 'A: aria-busy cleared');

// CASE B — reduced motion: static masks, no reel, no jitter
const r = runCase(true);
r.animate();
const m0 = r.nodes()[0], m1 = r.nodes()[1];
assert(r.busy() === 'true', 'B: busy set');
r.pumpTo(E2);
assert(r.nodes()[0] === 'a' + m0.slice(1), 'B: only the locked char changed (no reel/jitter)');
assert(r.nodes()[1] === m1, 'B: unrevealed node still the seeded static mask');
r.pumpTo(E5);
assert(r.nodes().join('|') === ORIGINAL.join('|'), 'B: completes with real text');
assert(r.busy() === null, 'B: busy cleared');

// CASE C — stale render: old animation must not clobber the new one
const s = runCase(false);
s.animate();
s.pumpTo(-70);                       // first tick: beat not started, all hidden
s.animate();                         // second render bumps the token
s.pumpTo(1820);                      // old tick fires first: must abort
assert(s.busy() === 'true', 'C: second animation owns aria-busy');
assert(s.nodes()[0][0] === 'a' && isAllGlyph(s.nodes()[0].slice(1)), 'C: fresh timeline rendered, old one did not clobber');
s.pumpTo(E5 + DUR + 5000);
assert(s.nodes().join('|') === ORIGINAL.join('|'), 'C: stale animation never corrupted final text');
assert(s.busy() === null, 'C: busy cleared');

console.log(failures === 0 ? '\nALL_CHECKS_PASSED' : '\nFAILURES=' + failures);
process.exit(failures === 0 ? 0 : 1);

