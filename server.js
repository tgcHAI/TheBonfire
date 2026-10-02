// TheBonfire - minimal local server (zero-dependency Node).
// Serves the project 1:1 so HTML/CSS/JSON relative links keep working.
// POST /api/entries rewrites json/entries.json in place on Save/Delete.
// Run with: node server.js -> http://localhost:4173/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const Dialogue = require('./js/dialogue.js');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// URL path portion (before any ?query), decoded once.
function urlPathOf(rawUrl) {
  return decodeURIComponent(rawUrl.split('?')[0]);
}

// Resolve a URL path to a file inside ROOT, rejecting any ../ escape.
function resolveInsideRoot(urlPath) {
  try {
    const abs = path.normalize(path.join(ROOT, urlPath));
    const inside = abs === ROOT || abs.startsWith(ROOT + path.sep);
    return inside ? abs : null;
  } catch (e) {
    return null;
  }
}

// CORS (development convenience). The page is often previewed by a static
// live-reload host such as VS Code Live Server on :5500, which cannot serve
// /api/*, so the client then reaches this server cross-origin. Only loopback
// origins are reflected by default: reflecting an arbitrary Origin would let
// any site on the network read AND rewrite the archive. Extra hosts (a LAN or
// phone preview host) are opted in with CORS_ORIGIN, a comma-separated list.
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const EXTRA_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(function (s) { return s.trim(); })
  .filter(Boolean);

function applyCors(req, res) {
  // Vary is required, or a cache can hand one origin's ACAO to another.
  res.setHeader('Vary', 'Origin');
  const origin = req.headers.origin;
  if (!origin) return;                                  // same-origin: nothing to add
  if (!LOOPBACK_ORIGIN.test(origin) && EXTRA_ORIGINS.indexOf(origin) < 0) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Atomically replace json/entries.json; rejects non-array or malformed
// entry shapes so a bad payload cannot wipe or corrupt the archive.
function saveEntries(text) {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected a JSON array of entries');
  }
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('Every entry must be a JSON object');
    }
  }
  const file = path.join(ROOT, 'json', 'entries.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

// Atomically replace json/conversations.json — the single source of truth.
// The page loads this file over HTTP; there is no embedded copy in the HTML.
function saveConversations(text) {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected a JSON array of conversations');
  }
  for (const conv of parsed) {
    if (!conv || typeof conv !== 'object') {
      throw new Error('Every conversation must be a JSON object');
    }
    if (!conv.id || !conv.title || !Array.isArray(conv.messages)) {
      throw new Error('Every conversation needs id, title and a messages array');
    }
    if (!conv.messages.length || conv.messages[0].type !== 'divider') {
      throw new Error('Every conversation must open with a divider');
    }
    for (const msg of conv.messages) {
      if (!msg || typeof msg !== 'object' || (msg.type !== 'divider' && (typeof msg.text !== 'string' || !msg.text))) {
        throw new Error('Every message needs a text field');
      }
      if (msg.type !== 'action' && msg.type !== 'divider' && !(typeof msg.screenName === 'string' && msg.screenName)) {
        throw new Error('Chat messages need a screenName');
      }
      if (msg.delayMs !== undefined && !(Number(msg.delayMs) >= 0)) {
        throw new Error('delayMs must be a non-negative number');
      }
    }
  }

  const file = path.join(ROOT, 'json', 'conversations.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

// Atomically replace json/gate.json — the gate panel's runtime settings (code,
// title, hints). The gate script loads this file over HTTP and POSTs it back on
// Save from the panel's Edit mode, mirroring the entries/conversations saves.
// Only the known string fields are accepted so a bad payload cannot break it.
function saveGateConfig(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object for gate settings');
  }
  const clean = {};
  for (const key of ['code', 'title', 'hintLocked', 'hintOpen', 'placeholder', 'error']) {
    if (typeof parsed[key] !== 'string') {
      throw new Error('Gate setting "' + key + '" must be a string');
    }
    clean[key] = parsed[key];
  }
  if (!clean.code) {
    throw new Error('Gate access code cannot be empty');
  }
  const file = path.join(ROOT, 'json', 'gate.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

// Conversation Pit dialogue API. The editor stores each conversation as a
// folder holding one file per message (see js/dialogue.js), so these routes do
// granular conversation/message CRUD instead of the whole-array replace that
// /api/conversations above performs (which stays as a rollback path).
//   GET    /api/dialogue                       list every conversation
//   POST   /api/dialogue                       create a conversation
//   GET    /api/dialogue/:id                   read one conversation
//   PUT    /api/dialogue/:id                   replace one conversation
//   PATCH  /api/dialogue/:id                   update conversation metadata
//   DELETE /api/dialogue/:id                   delete a conversation
//   POST   /api/dialogue/:id/messages          append a message
//   PUT    /api/dialogue/:id/messages/:i       replace message i
//   DELETE /api/dialogue/:id/messages/:i       delete message i
//   POST   /api/dialogue/:id/messages/:i/move  move message i ({to} or {dir})
function handleDialogue(req, res, urlPath) {
  const rest = urlPath.slice('/api/dialogue'.length).replace(/^\/+/, '');
  const parts = rest ? rest.split('/').map(decodeURIComponent) : [];
  const method = req.method;

  // Parse the JSON body then hand the value to fn; a bad body is a 400.
  const withBody = (fn) => {
    readBody(req, 10 * 1024 * 1024).then(
      text => {
        try { fn(JSON.parse(text)); }
        catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
      },
      err => sendJson(res, 400, { ok: false, error: err.message })
    );
  };

  try {
    // /api/dialogue
    if (!parts.length) {
      if (method === 'GET' || method === 'HEAD') { sendJson(res, 200, Dialogue.listConversations()); return; }
      if (method === 'POST') { withBody(conv => sendJson(res, 200, { ok: true, id: Dialogue.createConversation(conv) })); return; }
      res.writeHead(405); res.end('Method Not Allowed'); return;
    }

    const id = parts[0];

    // /api/dialogue/:id
    if (parts.length === 1) {
      if (method === 'GET' || method === 'HEAD') { sendJson(res, 200, Dialogue.readConversation(id)); return; }
      if (method === 'PUT') { withBody(conv => sendJson(res, 200, { ok: true, id: Dialogue.saveConversation(id, conv) })); return; }
      if (method === 'PATCH') { withBody(patch => sendJson(res, 200, { ok: true, id: Dialogue.updateMeta(id, patch).id })); return; }
      if (method === 'DELETE') { Dialogue.deleteConversation(id); sendJson(res, 200, { ok: true }); return; }
      res.writeHead(405); res.end('Method Not Allowed'); return;
    }

    // /api/dialogue/:id/messages
    if (parts.length === 2 && parts[1] === 'messages') {
      if (method === 'POST') { withBody(msg => sendJson(res, 200, { ok: true, index: Dialogue.addMessage(id, msg) })); return; }
      res.writeHead(405); res.end('Method Not Allowed'); return;
    }

    // /api/dialogue/:id/messages/:index
    if (parts.length === 3 && parts[1] === 'messages') {
      const index = Number(parts[2]);
      if (method === 'PUT') { withBody(msg => sendJson(res, 200, { ok: true, index: Dialogue.updateMessage(id, index, msg) })); return; }
      if (method === 'DELETE') { Dialogue.deleteMessage(id, index); sendJson(res, 200, { ok: true }); return; }
      res.writeHead(405); res.end('Method Not Allowed'); return;
    }

    // /api/dialogue/:id/messages/:index/move
    if (parts.length === 4 && parts[1] === 'messages' && parts[3] === 'move') {
      const index = Number(parts[2]);
      if (method === 'POST') {
        withBody(opt => {
          const dir = Number(opt && opt.dir);
          const to = opt && opt.to != null ? Number(opt.to) : index + (dir >= 0 ? 1 : -1);
          sendJson(res, 200, { ok: true, index: Dialogue.moveMessage(id, index, to) });
        });
        return;
      }
      res.writeHead(405); res.end('Method Not Allowed'); return;
    }

    res.writeHead(404); res.end('Not Found');
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message });
  }
}

const server = http.createServer((req, res) => {
  const urlPath = urlPathOf(req.url);

  // CORS headers ride along on every response - JSON, errors and static alike -
  // because setHeader merges into any later writeHead, so one call covers all.
  applyCors(req, res);

  // Preflight for the editor's JSON writes. Without this the browser refuses
  // cross-origin POST/PUT/DELETE before they ever reach the routes below.
  if (req.method === 'OPTIONS' && urlPath.indexOf('/api/') === 0) {
    res.writeHead(204);
    res.end();
    return;
  }

  // API: replace the archive in place (Save/Delete POST the full array).
  if (req.method === 'POST' && urlPath === '/api/entries') {
    readBody(req, 10 * 1024 * 1024).then(
      body => {
        try {
          saveEntries(body);
          sendJson(res, 200, { ok: true });
        } catch (e) {
          sendJson(res, 400, { ok: false, error: e.message });
        }
      },
      err => sendJson(res, 400, { ok: false, error: err.message })
    );
    return;
  }

  // API: replace the conversation archive in place (editor Save/Delete).
  // Mirrors the entries route: same readBody/atomic-write flow.
  if (req.method === 'POST' && urlPath === '/api/conversations') {
    readBody(req, 10 * 1024 * 1024).then(
      body => {
        try {
          saveConversations(body);
          sendJson(res, 200, { ok: true });
        } catch (e) {
          sendJson(res, 400, { ok: false, error: e.message });
        }
      },
      err => sendJson(res, 400, { ok: false, error: err.message })
    );
    return;
  }

  // API: persist the gate panel settings (Edit mode in the gate panel).
  // Mirrors the other saves: full-object POST, atomic write, 400 on bad shape.
  if (req.method === 'POST' && urlPath === '/api/gate') {
    readBody(req, 1 * 1024 * 1024).then(
      body => {
        try {
          saveGateConfig(body);
          sendJson(res, 200, { ok: true });
        } catch (e) {
          sendJson(res, 400, { ok: false, error: e.message });
        }
      },
      err => sendJson(res, 400, { ok: false, error: err.message })
    );
    return;
  }

  // API: the Conversation Pit's dialogue store (per-conversation folders with
  // one file per message under json/dialogue/). Full CRUD for conversations and
  // their messages; /api/conversations above stays as a rollback path.
  if (urlPath === '/api/dialogue' || urlPath.indexOf('/api/dialogue/') === 0) {
    handleDialogue(req, res, urlPath);
    return;
  }

  // Only GET/HEAD may read static files.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  let rel = urlPath === '/' ? 'HTML/TheBonfire.html' : urlPath.replace(/^\//, '');
  // The top bar's relative links (e.g. href="ConversationPit.html") resolve from
  // the / boot page to root-relative paths, so fall back to HTML/ when a bare
  // page name has no matching file in the repo root.
  if (rel.indexOf('/') < 0 && !fs.existsSync(path.join(ROOT, rel))) {
    rel = 'HTML/' + rel;
  }
  const file = resolveInsideRoot(rel);
  if (!file) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// Idempotent start: if the port is already taken (server already running),
// report it and exit cleanly so the preLaunchTask / manual start doesn't fail.
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log('TheBonfire server already running on http://localhost:' + PORT + '/');
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log('TheBonfire server running on http://localhost:' + PORT + '/');
  console.log('CORS: loopback origins allowed'
    + (EXTRA_ORIGINS.length ? ', plus ' + EXTRA_ORIGINS.join(', ') : ''));
});
