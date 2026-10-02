// js/dialogue.js - storage layer for the Conversation Pit's chatroom editor.
//
// Each conversation owns a folder under json/dialogue/:
//   json/dialogue/index.json            ordered list of conversation ids
//   json/dialogue/<CONV-ID>/meta.json   conversation metadata (id, title, status, ...)
//   json/dialogue/<CONV-ID>/0001.json   one file per message, ordered by filename
//
// The first read lazily migrates the legacy flat json/conversations.json into
// this layout. The legacy file is left untouched so /api/conversations (and the
// old file) remain a rollback path. Required by server.js; never runs in a page.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LEGACY_FILE = path.join(ROOT, 'json', 'conversations.json');
const DIALOGUE_DIR = path.join(ROOT, 'json', 'dialogue');
const INDEX_FILE = path.join(DIALOGUE_DIR, 'index.json');
const MESSAGE_FILE = /^\d+\.json$/;

// Conversation ids double as folder names, so keep them filesystem-safe.
function safeId(id) {
  return String(id == null ? '' : id).trim().replace(/[^A-Za-z0-9._-]/g, '_');
}

function conversationDir(id) {
  return path.join(DIALOGUE_DIR, safeId(id));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Write through a temp file + rename so a crash cannot leave half a JSON object.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function readIndex() {
  try {
    const ids = readJson(INDEX_FILE);
    return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [];
  } catch (e) {
    return [];
  }
}

function writeIndex(ids) {
  writeJson(INDEX_FILE, ids);
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Message files are zero-padded so lexical order matches playback order.
function messageName(index, count) {
  const width = Math.max(4, String(Math.max(count, 1)).length);
  return String(index + 1).padStart(width, '0') + '.json';
}

// A message is valid when the renderer could draw it: non-divider lines carry
// text, chat lines carry a screenName, and delayMs is a non-negative number.
function validateMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    throw new Error('Every message must be a JSON object');
  }
  if (msg.type !== 'divider' && (typeof msg.text !== 'string' || !msg.text)) {
    throw new Error('Every message needs a text field');
  }
  if (msg.type !== 'action' && msg.type !== 'divider' && (typeof msg.screenName !== 'string' || !msg.screenName)) {
    throw new Error('Chat messages need a screenName');
  }
  if (msg.delayMs !== undefined && !(Number(msg.delayMs) >= 0)) {
    throw new Error('delayMs must be a non-negative number');
  }
}

function validateConversation(conv) {
  if (!conv || typeof conv !== 'object' || Array.isArray(conv)) {
    throw new Error('A conversation must be a JSON object');
  }
  if (typeof conv.id !== 'string' || !conv.id.trim()) {
    throw new Error('Every conversation needs an id');
  }
  if (typeof conv.title !== 'string' || !conv.title.trim()) {
    throw new Error('Every conversation needs a title');
  }
  if (!Array.isArray(conv.messages)) {
    throw new Error('Every conversation needs a messages array');
  }
  conv.messages.forEach(validateMessage);
}

// Write meta.json plus one file per message. The index is left to the callers
// so a half-built migration never publishes a partial list.
function writeFiles(conv) {
  const dir = conversationDir(conv.id);
  fs.mkdirSync(dir, { recursive: true });

  const meta = {};
  for (const key of Object.keys(conv)) {
    if (key !== 'messages') meta[key] = conv[key];
  }
  writeJson(path.join(dir, 'meta.json'), meta);

  const keep = new Set();
  conv.messages.forEach((msg, i) => {
    const name = messageName(i, conv.messages.length);
    keep.add(name);
    writeJson(path.join(dir, name), msg);
  });
  // Drop message files left over from a previously longer conversation.
  for (const entry of fs.readdirSync(dir)) {
    if (MESSAGE_FILE.test(entry) && !keep.has(entry)) fs.unlinkSync(path.join(dir, entry));
  }
}

// Rebuild the flat shape the pages render ({ id, title, status, ..., messages }).
function readConversation(id) {
  ensureReady();
  const dir = conversationDir(id);
  const meta = readJson(path.join(dir, 'meta.json'));
  const files = fs.readdirSync(dir).filter(f => MESSAGE_FILE.test(f));
  files.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const messages = files.map(f => readJson(path.join(dir, f)));
  return Object.assign({}, meta, { messages });
}

function listConversations() {
  ensureReady();
  const out = [];
  for (const id of readIndex()) {
    try { out.push(readConversation(id)); }
    catch (e) { /* skip a folder that is missing or unreadable */ }
  }
  return out;
}

// Insert/replace a conversation at the position its old id held, keeping the
// author's ordering; a changed id renames the folder.
function saveConversation(id, conv) {
  ensureReady();
  validateConversation(conv);
  const oldSafe = safeId(id);
  const newSafe = safeId(conv.id);
  writeFiles(conv);
  let placed = false;
  const ids = readIndex().map(x => {
    if (safeId(x) === oldSafe) { placed = true; return conv.id; }
    return x;
  }).filter((x, i, arr) => arr.findIndex(y => safeId(y) === safeId(x)) === i);
  if (!placed) ids.push(conv.id);
  writeIndex(ids);
  if (oldSafe !== newSafe) removeDir(conversationDir(id));
  return conv.id;
}

function nextConversationId() {
  const taken = new Set(readIndex().map(safeId));
  let n = taken.size + 1;
  let id;
  do { id = 'CONV-' + String(n).padStart(3, '0'); n += 1; } while (taken.has(id));
  return id;
}

function createConversation(conv) {
  ensureReady();
  const next = Object.assign({}, conv || {});
  if (typeof next.id !== 'string' || !next.id.trim()) next.id = nextConversationId();
  if (typeof next.title !== 'string' || !next.title.trim()) next.title = 'New Conversation';
  if (typeof next.status !== 'string' || !next.status) next.status = 'Online';
  if (!Array.isArray(next.messages)) next.messages = [];
  // A chatroom always opens on a divider card, so seed one for a fresh room.
  if (!next.messages.length) next.messages.push({ type: 'divider', label: next.title });
  validateConversation(next);
  writeFiles(next);
  const ids = readIndex().filter(x => safeId(x) !== safeId(next.id));
  ids.push(next.id);
  writeIndex(ids);
  return next.id;
}

function updateMeta(id, patch) {
  ensureReady();
  const conv = readConversation(id);
  for (const key of Object.keys(patch || {})) {
    if (key !== 'messages') conv[key] = patch[key];
  }
  saveConversation(id, conv);
  return conv;
}

function deleteConversation(id) {
  ensureReady();
  removeDir(conversationDir(id));
  writeIndex(readIndex().filter(x => safeId(x) !== safeId(id)));
}

function assertIndex(conv, index) {
  if (!Number.isInteger(index) || index < 0 || index >= conv.messages.length) {
    throw new Error('Message index ' + index + ' is out of range');
  }
}

function addMessage(id, msg) {
  ensureReady();
  validateMessage(msg);
  const conv = readConversation(id);
  conv.messages.push(msg);
  saveConversation(id, conv);
  return conv.messages.length - 1;
}

function updateMessage(id, index, msg) {
  ensureReady();
  validateMessage(msg);
  const conv = readConversation(id);
  assertIndex(conv, index);
  conv.messages[index] = msg;
  saveConversation(id, conv);
  return index;
}

function deleteMessage(id, index) {
  ensureReady();
  const conv = readConversation(id);
  assertIndex(conv, index);
  const removed = conv.messages.splice(index, 1)[0];
  saveConversation(id, conv);
  return removed;
}

function moveMessage(id, index, to) {
  ensureReady();
  const conv = readConversation(id);
  assertIndex(conv, index);
  const dest = Math.max(0, Math.min(conv.messages.length - 1, to));
  const msg = conv.messages.splice(index, 1)[0];
  conv.messages.splice(dest, 0, msg);
  saveConversation(id, conv);
  return dest;
}

// One-time migration from the legacy flat archive. Guarded by index.json so it
// is a no-op after the first call; ids that would collide are suffixed.
function migrateIfNeeded() {
  fs.mkdirSync(DIALOGUE_DIR, { recursive: true });
  if (fs.existsSync(INDEX_FILE)) return false;
  let legacy = [];
  try { legacy = readJson(LEGACY_FILE); } catch (e) { legacy = []; }
  if (!Array.isArray(legacy)) legacy = [];
  const used = new Set();
  const ids = [];
  for (const conv of legacy) {
    if (!conv || typeof conv !== 'object' || typeof conv.id !== 'string' || !conv.id) continue;
    let id = conv.id;
    let suffix = 2;
    while (used.has(safeId(id))) { id = conv.id + '-' + suffix; suffix += 1; }
    used.add(safeId(id));
    const copy = Object.assign({}, conv, { id, messages: Array.isArray(conv.messages) ? conv.messages : [] });
    writeFiles(copy);
    ids.push(id);
  }
  writeIndex(ids);
  return true;
}

let ready = false;
function ensureReady() {
  if (ready) return;
  migrateIfNeeded();
  ready = true;
}

module.exports = {
  DIALOGUE_DIR,
  INDEX_FILE,
  ensureReady,
  migrateIfNeeded,
  listConversations,
  readConversation,
  createConversation,
  saveConversation,
  updateMeta,
  deleteConversation,
  addMessage,
  updateMessage,
  deleteMessage,
  moveMessage,
  validateConversation,
};

