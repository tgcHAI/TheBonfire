// TheBonfire - minimal local server (zero-dependency Node).
// Serves the project 1:1 so HTML/CSS/JSON relative links keep working.
// POST /api/entries rewrites json/entries.json in place on Save/Delete.
// Run with: node server.js -> http://localhost:4173/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
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

const server = http.createServer((req, res) => {
  const urlPath = urlPathOf(req.url);

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

  // Only GET/HEAD may read static files.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  const rel = urlPath === '/' ? 'HTML/TheBonfire.html' : urlPath.replace(/^\//, '');
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
});
