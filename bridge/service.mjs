// bridge/service.mjs — запуск и остановка сервиса как единого целого.
//
// Требования: REQ-SVC-GUARD, REQ-SVC-TRAY (docs/SPEC.md §8). Сценарий S-08.
// Тест: tests/unit/bridge-guard.test.mjs.
//
// «Сервис» — это две части: HTTP-сервер на Node и мост AHK. Останавливать нужно
// обе, иначе горячие клавиши продолжат стучаться в мёртвый порт, а человек будет
// видеть окно, которое не открывается.
//
// Второй экземпляр не поднимается никогда: два процесса на одной библиотеке дают
// расхождение счётчиков и гонку записи одного и того же .md.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { ahkCommand, findAhk } from './capture.mjs';

const runtimeFile = (root) => join(root, 'state', 'runtime.json');

/** Живёт ли процесс. Сигнал 0 ничего не делает, но проверяет существование. */
export const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Чтение runtime.json с проверкой живости.
 * Файл, оставшийся от аварийно завершённого процесса, не должен блокировать
 * запуск — иначе после падения приложение больше не стартует (S-08, путь 3).
 */
export const readRuntime = (root) => {
  const file = runtimeFile(root);
  if (!existsSync(file)) return { running: false, reason: 'сервис не запущен', runtime: null };

  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { running: false, reason: `runtime.json не читается: ${err.message}`, runtime: null, stale: true };
  }

  if (!alive(data.pid)) {
    return {
      running: false,
      reason: `процесс ${data.pid} не существует — файл остался от прошлого запуска`,
      runtime: data,
      stale: true,
    };
  }

  return { running: true, reason: null, runtime: data };
};

/**
 * Проверяет не только существование PID, но и HTTP-идентичность сервиса.
 * PID в Windows может быть повторно использован другим процессом, поэтому один
 * `process.kill(pid, 0)` способен ошибочно объявить чужой процесс нашим.
 */
export const verifyRuntime = async (root, { timeoutMs = 500 } = {}) => {
  const state = readRuntime(root);
  if (!state.running) return state;

  const port = Number(state.runtime?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      ...state,
      running: false,
      stale: true,
      reason: 'runtime.json содержит недопустимый порт',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const body = await response.json().catch(() => null);
    if ((response.status !== 200 && response.status !== 503)
      || typeof body?.ready !== 'boolean'
      || body.port !== port) {
      return {
        ...state,
        running: false,
        stale: true,
        reason: `процесс ${state.runtime.pid} на порту ${port} — не CallMyPromts`,
      };
    }
    return state;
  } catch {
    return {
      ...state,
      running: false,
      stale: true,
      reason: `процесс ${state.runtime.pid} существует, но CallMyPromts на порту ${port} не отвечает`,
    };
  } finally {
    clearTimeout(timer);
  }
};

/** Отвод устаревшего файла в сторону: удалять чужие данные молча нельзя. */
export const clearStale = (root) => {
  const file = runtimeFile(root);
  if (!existsSync(file)) return false;
  try {
    renameSync(file, `${file}.stale-${Date.now()}`);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ожидание именно готового сервера, а не только появления runtime.json. */
const waitForServer = async (root, { waitMs = 5000, pollMs = 50 } = {}) => {
  const deadline = Date.now() + waitMs;
  let last = { reason: 'runtime.json ещё не создан' };

  while (Date.now() < deadline) {
    last = await verifyRuntime(root, { timeoutMs: Math.min(500, waitMs) });
    if (last.running) return last;
    await sleep(pollMs);
  }

  return {
    running: false,
    stale: true,
    runtime: last.runtime ?? null,
    reason: `сервер не стал готов за ${waitMs} мс: ${last.reason}`,
  };
};

/**
 * Запуск сервера и моста как одной последовательности. AHK стартует только после
 * готовности HTTP-сервера, иначе он читает отсутствующий runtime.json и навсегда
 * остаётся на порту 8791, когда сервер выбрал запасной порт.
 */
export const startService = async (root, { detached = true, waitMs = 5000 } = {}) => {
  const state = await verifyRuntime(root);
  if (state.running) {
    let focusQueued = false;
    try {
      const token = readFileSync(join(root, 'state', 'token'), 'utf8').trim();
      const response = await fetch(`http://127.0.0.1:${state.runtime.port}/api/window`, {
        method: 'POST', headers: { 'X-Deck-Token': token }, signal: AbortSignal.timeout(1000),
      });
      focusQueued = response.status === 202;
    } catch { /* existing service is not replaced on an unconfirmed focus request */ }
    return {
      focusQueued,
      ok: false,
      already: true,
      state: 'warn',
      message: `сервис уже запущен: pid ${state.runtime.pid}, порт ${state.runtime.port}`,
      runtime: state.runtime,
    };
  }
  if (state.stale) clearStale(root);

  const server = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {
    cwd: root,
    detached,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (detached) server.unref();

  const ready = await waitForServer(root, { waitMs });
  if (!ready.running) {
    if (alive(server.pid)) {
      try { process.kill(server.pid, 'SIGTERM'); } catch { /* процесс уже завершился */ }
    }
    return {
      ok: false,
      state: 'bad',
      message: ready.reason,
      serverPid: server.pid,
      bridgePid: null,
      bridgeReason: 'мост не запущен: сервер не готов',
    };
  }

  const ahk = ahkCommand(root);
  let bridge = null;
  let bridgeState = 'good';
  let bridgeReason = null;

  if (ahk.ok) {
    bridge = spawn(ahk.file, ahk.args, { cwd: root, detached, stdio: 'ignore', windowsHide: true });
    if (detached) bridge.unref();
  } else {
    // Без AHK приложение работает, но без хоткеев. Это называется прямо.
    bridgeState = 'bad';
    bridgeReason = ahk.reason;
  }

  return {
    ok: true,
    state: bridgeState,
    message: bridgeReason ?? 'сервис запущен',
    serverPid: ready.runtime.pid,
    bridgePid: bridge?.pid ?? null,
    bridgeReason,
    runtime: ready.runtime,
  };
};

/**
 * Остановка. Сначала мягкий сигнал: сервер закрывает базу и снимает runtime.json
 * сам. Жёсткое убийство оставило бы SQLite с открытой транзакцией (S-08, путь 4).
 */
export const stopService = async (root, { waitMs = 1500 } = {}) => {
  const state = readRuntime(root);
  if (!state.running) {
    return { ok: true, alreadyStopped: true, state: 'none', message: state.reason };
  }

  const { pid } = state.runtime;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    return { ok: false, state: 'bad', message: `не удалось остановить процесс ${pid}: ${err.message}` };
  }

  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (!alive(pid)) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  if (alive(pid)) {
    return {
      ok: false,
      state: 'warn',
      message: `процесс ${pid} не завершился за ${waitMs} мс — остановите вручную, чтобы не оборвать запись в базу`,
    };
  }

  clearStale(root);
  return { ok: true, state: 'none', message: 'сервис остановлен' };
};

export const restartService = async (root, opts = {}) => {
  const stopped = await stopService(root, opts);
  if (!stopped.ok) return stopped;
  await new Promise((r) => setTimeout(r, 200));
  return startService(root, opts);
};

/** Сводка для трея и раздела «Сервис»: состояние каждой части по отдельности. */
export const serviceStatus = (root) => {
  const state = readRuntime(root);
  const ahk = findAhk();

  return {
    server: state.running
      ? { state: 'good', pid: state.runtime.pid, port: state.runtime.port, startedAt: state.runtime.started_at }
      : { state: 'none', reason: state.reason },
    bridge: ahk.found
      ? { state: state.running ? 'good' : 'none', path: ahk.path }
      : { state: 'bad', reason: ahk.reason },
    hotkeys: state.running ? (state.runtime.hotkeys ?? {}) : {},
  };
};
