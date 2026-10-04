#!/usr/bin/env node
'use strict';
// dialogue-tool.js - bulk-edit the Conversation Pit store from outside the app.
//
//   node dialogue-tool.js ls
//   node dialogue-tool.js pull CONV-003                 -> CONV-003.json
//   node dialogue-tool.js pull CONV-003 --stdout        -> printed, no file
//   node dialogue-tool.js push CONV-003 --file room.json
//   node dialogue-tool.js push CONV-003 --stdin  < room.json
//   node dialogue-tool.js push CONV-003 --file room.json --dry-run
//   node dialogue-tool.js new --title "Combat Logs" --stdin < room.json
//
// The store keeps ONE FILE PER MESSAGE (json/dialogue/<ID>/0001.json...), so
// inserting a line by hand means renumbering every file after it - files are
// ordered by numeric filename, and a stale one is still played. pull/push move
// between that layout and a single blob, because saveConversation() renumbers
// and prunes for you. Do not edit the message files directly.
//
// Every write goes through js/dialogue.js, the same module server.js uses, so
// there is no second storage path to drift out of sync.
const fs = require('fs');
const Dialogue = require('./js/dialogue.js');

function die(msg, code) {
  console.error('  error: ' + msg);
  process.exit(code === undefined ? 1 : code);
}

function usage(code) {
  console.log([
    'usage:',
    '  dialogue-tool.js ls',
    '  dialogue-tool.js pull <CONV-ID> [--stdout] [--out FILE]',
    '  dialogue-tool.js push <CONV-ID> (--file FILE | --stdin) [--dry-run]',
    '  dialogue-tool.js new (--file FILE | --stdin) [--title TITLE] [--dry-run]',
  ].join('\n'));
  process.exit(code === undefined ? 0 : code);
}

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') usage(0);
    if (a.slice(0, 2) === '--') {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.slice(0, 2) === '--') flags[key] = true;
      else { flags[key] = next; i++; }
    } else flags._.push(a);
  }
  return flags;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { s += d; });
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', reject);
  });
}

async function readBlob(flags) {
  const raw = flags['file']
    ? fs.readFileSync(String(flags['file']), 'utf8')
    : (flags['stdin'] ? await readStdin() : '');
  // Windows editors and PowerShell's `Set-Content -Encoding UTF8` prepend a BOM,
  // which JSON.parse rejects outright - and this file is exactly what people
  // will open in Notepad and hand-edit.
  const text = raw.replace(/^\uFEFF/, '');
  if (!text.trim()) die('no input: pass --file FILE or pipe JSON on stdin');
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) die('blob must be a JSON object');
    return v;
  } catch (e) {
    die('could not parse JSON: ' + e.message);
  }
}

// The authoritative rules live in js/dialogue.js; asking it means this tool can
// never accept a room the server would later reject.
function validate(conv) {
  try {
    Dialogue.validateConversation(conv);
  } catch (e) {
    die('rejected by the store: ' + e.message + ' (nothing written)');
  }
}
function cmdLs() {
  Dialogue.ensureReady();
  const list = Dialogue.listConversations();
  if (!list.length) { console.log('  (no conversations)'); return; }
  const width = Math.max.apply(null, list.map((c) => String(c.id).length));
  for (const c of list) {
    console.log('  ' + String(c.id).padEnd(width) + '  ' +
      String((c.messages || []).length).padStart(4) + ' lines  ' +
      String(c.status || '').padEnd(8) + ' ' + (c.title || ''));
  }
  console.log('  ' + list.length + ' conversation(s)');
}

function cmdPull(flags) {
  const id = flags._[1];
  if (!id) usage(1);
  Dialogue.ensureReady();
  let conv;
  try {
    conv = Dialogue.readConversation(id);
  } catch (e) {
    die('no such conversation: ' + id + ' (' + e.message + ')');
  }
  // Pretty-printed at the indent writeJson uses, so push -> pull is a stable
  // loop and a diff of the two is readable.
  const text = JSON.stringify(conv, null, 2) + '\n';
  if (flags['stdout'] === true) { process.stdout.write(text); return; }
  const out = String(flags['out'] || id + '.json');
  fs.writeFileSync(out, text, 'utf8');
  console.log('  wrote ' + out + '  (' + (conv.messages || []).length + ' lines, ' +
    (conv.title || '') + ')');
}

async function cmdPush(flags) {
  const id = flags._[1];
  if (!id) usage(1);
  const conv = await readBlob(flags);
  Dialogue.ensureReady();
  let before = 0;
  try { before = (Dialogue.readConversation(id).messages || []).length; }
  catch (e) { die('no such conversation: ' + id + ' (' + e.message + ')'); }

  // The blob is imported INTO id. Honouring the blob's own id would make
  // saveConversation() read the difference as a RENAME: it writes the new
  // folder and deletes the old one, silently destroying a different room.
  if (typeof conv.id === 'string' && conv.id.trim() && conv.id !== id) {
    console.log('  note: blob says id "' + conv.id + '", importing into "' + id + '"');
  }
  conv.id = id;
  if (!Array.isArray(conv.messages)) die('blob needs a messages array');
  validate(conv);

  console.log('  ' + id + ': ' + before + ' -> ' + conv.messages.length + ' lines');
  if (flags['dry-run'] === true) { console.log('  dry run, nothing written'); return; }
  Dialogue.saveConversation(id, conv);
  console.log('  saved ' + id);
}

async function cmdNew(flags) {
  const conv = await readBlob(flags);
  Dialogue.ensureReady();
  if (flags.title) conv.title = String(flags.title);
  if (!Array.isArray(conv.messages)) conv.messages = [];
  // createConversation() assigns the id, so a dry run validates a stand-in.
  validate(Object.assign({}, conv, { id: 'CONV-PROBE' }));
  if (flags['dry-run'] === true) {
    console.log('  dry run: would create a room with ' + conv.messages.length + ' lines');
    return;
  }
  const id = Dialogue.createConversation(conv);
  console.log('  created ' + id + '  (' + conv.messages.length + ' lines, ' +
    (conv.title || '') + ')');
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const cmd = flags._[0];
  if (cmd === 'ls') return cmdLs();
  if (cmd === 'pull') return cmdPull(flags);
  if (cmd === 'push') return cmdPush(flags);
  if (cmd === 'new') return cmdNew(flags);
  usage(1);
}

main().catch((e) => die(e && e.message ? e.message : String(e)));