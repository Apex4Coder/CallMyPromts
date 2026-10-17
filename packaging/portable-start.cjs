// Separate immutable code from the application's persistent library and settings.
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
function rejectLinkedParents(dir) {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink()) throw Error('Linked installation home is not supported');
    if (at === path.dirname(at)) break;
  }
}
async function main() {
  if (process.platform !== 'win32') throw Error('Windows is required');
  const home = process.env.CALLMYPROMPTS_HOME;
  if (!home || !path.isAbsolute(home)) throw Error('Missing installation home');
  for (const name of ['state', 'prompts']) {
    const shared = path.join(home, 'shared', name), link = path.join(root, name);
    rejectLinkedParents(shared);
    fs.mkdirSync(shared, { recursive: true });
    if (!fs.existsSync(link)) fs.symlinkSync(shared, link, 'junction');
    if (!fs.lstatSync(link).isSymbolicLink() || fs.realpathSync(link).toLowerCase() !== fs.realpathSync(shared).toLowerCase())
      throw Error('Existing data path does not belong to this installation');
  }
  const { startService } = await import(pathToFileURL(path.join(root, 'bridge', 'index.mjs')));
  const started = await startService(root);
  if (!started.ok && !started.already) throw Error('Service failed to start');
  if (!started.already) {
    const token = fs.readFileSync(path.join(root, 'state', 'token'), 'utf8').trim();
    const result = await fetch(`http://127.0.0.1:${started.runtime.port}/api/window`, {
      method: 'POST', headers: { 'X-Deck-Token': token }, signal: AbortSignal.timeout(1500),
    });
    if (result.status !== 202) throw Error('Service started; open Mini-CRM from the tray');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
