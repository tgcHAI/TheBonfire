const fs = require('fs');
const src = fs.readFileSync('HTML/TheBonfire.html', 'utf8').replace(/\r\n/g, '\n');
const m = src.match(/<script[\s\S]*?<\/script>/);
if (!m) { console.error('NO_SCRIPT'); process.exit(1); }
try {
  new Function(m[0].replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''));
  console.log('EMBED_SYNTAX_OK');
} catch (e) {
  console.error('EMBED_SYNTAX_FAIL: ' + e.message);
  process.exit(1);
}
