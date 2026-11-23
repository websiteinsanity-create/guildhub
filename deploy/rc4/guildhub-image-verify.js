// GuildHub - READ-ONLY check that the code inside an image matches RELEASE_FILES.sha256 of this package.
// Files that .dockerignore keeps out of the image (tests, deploy/, .github/, top-level *.md) are skipped.
// Usage: docker run --rm --network none -v <release>/deploy/rc4:/s:ro --entrypoint node <image> /s/guildhub-image-verify.js /app
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = process.argv[2] || '/app';
const skip = (p) => /^(test|deploy|\.github|\.git|data|demo-data|node_modules)\//.test(p) || /^[^/]+\.md$/.test(p);
let ok = 0, bad = 0, skipped = 0;
for (const line of fs.readFileSync(path.join(root, 'RELEASE_FILES.sha256'), 'utf8').split('\n')) {
  const m = line.match(/^([a-f0-9]{64}) {2}(.+)$/); if (!m) continue;
  if (skip(m[2])) { skipped++; continue; }
  let h = null; try { h = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, m[2]))).digest('hex'); } catch {}
  if (h === m[1]) ok++; else { bad++; console.log((h ? 'DIFFERENT ' : 'MISSING   ') + m[2]); }
}
console.log(bad ? `IMAGE CODE MISMATCH: ${bad} file(s), ${ok} ok` : `IMAGE CODE OK: ${ok} files match, ${skipped} not shipped in the image (docs/tests)`);
process.exit(bad ? 1 : 0);
