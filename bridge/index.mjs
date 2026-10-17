// bridge/index.mjs — публичный барьер модуля bridge.
//
// Мост в операционную систему: горячие клавиши, слежка за буфером, вставка, трей.
// Зависит только от contracts (arch.yaml): мост не читает библиотеку и не открывает
// базу журнала — он общается с сервером по HTTP, как и интерфейс.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { startService } from './service.mjs';

export {
  MODS,
  SYSTEM_COMBOS,
  KNOWN_TAKEN,
  parseCombo,
  checkHotkeys,
  suggestFree,
  worstState,
} from './hotkeys.mjs';

export {
  findAhk,
  ahkCommand,
  readClipboard,
  activeProcess,
  capabilities,
} from './capture.mjs';

export {
  alive,
  readRuntime,
  verifyRuntime,
  clearStale,
  startService,
  stopService,
  restartService,
  serviceStatus,
} from './service.mjs';

export {
  POLL_MS,
  ClipboardWatcher,
  sendClip,
} from './watch.mjs';

export {
  MENU,
  trayState,
  tooltip,
  menuFor,
  menuScript,
} from './tray.mjs';

/**
 * CLI-запуск полного приложения. Detached-процессы нужны, чтобы `npm start`
 * мог завершиться, не закрывая сервис и tray-иконку. Node-сервис и AHK запускаются
 * одной операцией startService; при уже работающем runtime второй экземпляр не
 * создаётся (REQ-SVC-GUARD).
 */
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const started = await startService(root);
  process.stdout.write(`${started.message}\n`);
  if (!started.ok && !started.already) process.exit(1);
}
