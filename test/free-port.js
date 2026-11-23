'use strict';
// Ask the OS, rather than guessing a random port in the outgoing ephemeral range.
// Child-server fixtures release it immediately before spawning; PORT=0 is preferred
// for fixtures that do not need PUBLIC_URL in the child's environment in advance.
module.exports = () => new Promise((resolve,reject)=>{
  const server=require('node:net').createServer();server.once('error',reject);
  server.listen(0,()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});
});
