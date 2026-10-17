// Browser-safe dynamic ports: avoid OS ephemeral ranges containing blocked ports.
import { randomInt } from 'node:crypto';
const choose = () => randomInt(49152, 65536);
export async function listenLoopback(server, { pickPort = choose, attempts = 16 } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 32) throw Error('Invalid bind attempt limit');
  let last;
  for (let n = 0; n < attempts; n++) {
    const port = pickPort();
    if (!Number.isInteger(port) || port < 49152 || port > 65535) throw Error('Invalid safe loopback port');
    try { return await bind(server, port); }
    catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
      last = error;
    }
  }
  throw last;
}
function bind(server, port) {
  return new Promise((resolve, reject) => {
    const failed = error => { server.off('listening', listening); reject(error); };
    const listening = () => { server.off('error', failed); resolve(server.address().port); };
    server.once('error', failed); server.once('listening', listening);
    server.listen(port, '127.0.0.1');
  });
}
