'use strict';
// Linux flock locks the shared open file description inherited as descriptor 3.
// The Node owner retains that description; SIGKILL/OOM closes it in the kernel.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
function acquire(file, strict, { allowLegacy = false, readOnly = false } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, (readOnly ? fs.constants.O_RDONLY : fs.constants.O_RDWR | fs.constants.O_CREAT) | fs.constants.O_NOFOLLOW, 0o600);
    strict(file);
    const result = spawnSync('/usr/bin/flock', ['--nonblock', '3'], {
      stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 5000,
    });
    if (result.error || result.status !== 0) throw Error('exclusive kernel lock unavailable (another writer or missing flock)');
    const previous=fs.readFileSync(file,'utf8');
    if(previous && !allowLegacy){let row;try{row=JSON.parse(previous);}catch{}if(row?.v!==2)throw Error('legacy lock ownership cannot be proved; stop RC2 and explicitly acknowledge lock migration');}
    const token = readOnly ? previous : JSON.stringify({v:2,token:crypto.randomUUID()});
    if(!readOnly){fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, token); fs.fsyncSync(fd);}
    const inode = fs.fstatSync(fd);
    let closed = false;
    return {
      check() {
        if (closed) throw Error('writer is closed');
        const current = strict(file);
        if (current.ino !== inode.ino || current.dev !== inode.dev || fs.readFileSync(file, 'utf8') !== token) throw Error('lock inode changed');
      },
      close() { if (!closed) { fs.closeSync(fd); closed = true; } },
    };
  } catch (e) { if (fd !== undefined) fs.closeSync(fd); throw Error('Security Ledger: writer lock: ' + e.message); }
}
module.exports = { acquire };
