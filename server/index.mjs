// server/index.mjs — публичный барьер модуля server и точка запуска сервиса.
//
// Требования: REQ-API-BIND, REQ-SVC-GUARD (docs/SPEC.md §6, §8).
// Тест: tests/integration/api.test.mjs.
//
// Привязка строго к 127.0.0.1. Это не настройка: сервер, слушающий 0.0.0.0,
// открыл бы журнал буфера обмена всей локальной сети (docs/RULES.md §6).

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

import { Deck, runningInstance } from './state.mjs';
import { ensureToken, checkRequest, isPublicPath } from './auth.mjs';
import { sendError, sendFile, parseUrl } from './http.mjs';
import { handleApi } from './routes.mjs';
import { Readiness } from './ready.mjs';
import { handleReady } from './routes-ready.mjs';
import { listenLoopback } from './loopback.mjs';

export const HOST = '127.0.0.1';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = resolve(HERE, '..', 'ui');

/**
 * Пин корня — инвариант INV-13 (gld/gold.md §3.3).
 *
 * `realpath` разворачивает junction в физический путь ОДИН раз, при старте. Всё
 * дальнейшее обращение к файлам идёт от результата, а не от пути вида `live/`.
 *
 * Зачем. В целевой раскладке `live` — это junction на один из `releases/<id>/`, и
 * деплой переставляет его, пока процесс работает. Без пина работающий процесс
 * начал бы читать часть файлов из старого релиза, часть из нового — класс дефекта,
 * который ловится месяцами, потому что проявляется случайно.
 *
 * Своё исключение — путь `UI_ROOT`: он вычисляется от `import.meta.url`, то есть от
 * места, откуда этот модуль реально загрузили. Это тот же физический релиз, и
 * подмена junction на него не влияет.
 */
export const pinRoot = (root) => {
  try {
    return realpathSync(root);
  } catch {
    // Папки может не быть при первом запуске: `Deck` её создаст. Возврат исходного
    // пути честнее исключения — запуск в пустом каталоге не ошибка.
    return resolve(root);
  }
};

/**
 * Запуск сервиса.
 *
 * `control` — право процесса остановить себя. Передаёт его только запуск из
 * командной строки (внизу файла): там процесс свой собственный, и завершение
 * означает остановку сервиса. Встроенный запуск (тесты) `control` не получает, и
 * `POST /api/service` честно отвечает «этот процесс не умеет останавливать себя»
 * вместо того, чтобы уронить чужой процесс-исполнитель.
 *
 * @param {object} opts.root корень проекта
 * @param {number|null} opts.port 0 — свободный порт (нужно тестам)
 * @param {object|null} opts.control { shutdown({ restart }) }
 * @returns {Promise<{ port, token, deck, ready, close }>}
 */
export const start = async ({
  root = process.cwd(), port = null, hotkeys = {}, control = null,
} = {}) => {
  const appRoot = pinRoot(root);
  const deck = new Deck(appRoot);

  const already = runningInstance(deck);
  if (already && port === null) {
    // Второй экземпляр не поднимаем: два процесса на одной библиотеке дали бы
    // расхождение счётчиков и гонку записи (REQ-SVC-GUARD).
    deck.close();
    return {
      ok: false,
      already,
      message: `сервис уже запущен: pid ${already.pid}, порт ${already.port}`,
    };
  }

  const { token, created } = ensureToken(deck.tokenFile);
  const wanted = port === null ? deck.settings.server.port : port;
  const runtime = { port: wanted, hotkeys };
  const ready = new Readiness({ root: appRoot, appRoot });

  const server = createServer(async (req, res) => {
    let parsed;
    try { parsed = parseUrl(req); } catch {
      return sendError(res, 400, 'bad_url', 'некорректный URL запроса');
    }
    const { path, params, shown } = parsed;


    // Готовность отвечает ДО проверки токена и НЕ считается работой.
    // Первое — потому что супервизор и деплой токена не знают. Второе — потому что
    // опрос раз в 5 секунд иначе держал бы in_flight выше нуля вечно, и drain
    // никогда бы не дождался тишины.
    if (handleReady(req, res, { path, ready })) return;

    // Static HTML contains the local API token: check Host/Origin before injection.
    const boundary = checkRequest(req, { token, port: runtime.port, path });
    if (!boundary.ok && ['bad_host', 'bad_origin'].includes(boundary.error)) {
      return sendError(res, boundary.status, boundary.error, boundary.message);
    }

    const leave = ready.inFlight.enter();
    // По `finish`, а не в конце функции: ответ может уйти позже возврата из
    // обработчика, и счётчик обнулился бы раньше времени. `close` — на случай
    // оборванного соединения, двойной вызов защищён внутри.
    res.once('finish', leave);
    res.once('close', leave);

    try {
      if (isPublicPath(path)) {
        const file = path === '/' ? 'index.html' : path;
        await sendFile(res, UI_ROOT, file, { inject: token });
        return;
      }

      const auth = checkRequest(req, { token, port: runtime.port, path });
      if (!auth.ok) {
        sendError(res, auth.status, auth.error, auth.message, { expected: auth.expected });
        return;
      }

      const handled = await handleApi(req, res, { deck, path, params, runtime, control });
      // В сообщении — раскодированный путь: сопоставление идёт по сырому, но
      // человеку нужен читаемый (server/http.mjs, parseUrl).
      if (!handled) sendError(res, 404, 'no_route', `нет маршрута ${req.method} ${shown}`);
    } catch (err) {
      if (!res.headersSent) sendError(res, 500, 'internal', err.message, { path: shown });
    }
  });

  // Для рабочего запуска занятый настроенный порт не должен делать приложение
  // недоступным: последовательно пробуем следующие порты. Явно переданный порт
  // (в том числе 0 в тестах) сохраняет строгую семантику и не маскирует ошибки.
  const bind = (candidate) => candidate === 0 ? listenLoopback(server) : new Promise((done, fail) => {
    const onListening = () => {
      server.off('error', onError);
      done(server.address().port);
    };
    const onError = (err) => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE' && port === null && candidate < 65535) {
        bind(candidate + 1).then(done, fail);
        return;
      }
      fail(err.code === 'EADDRINUSE'
        ? new Error(`порт ${candidate} занят${port === null ? ' и свободный порт не найден' : ''}`)
        : err);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(candidate, HOST);
  });

  runtime.port = await bind(wanted);
  ready.port = runtime.port;
  deck.writeRuntime({ port: runtime.port, hotkeys });

  const close = async () => {
    await new Promise((done) => server.close(done));
    deck.close();
  };

  return {
    ok: true,
    port: runtime.port,
    portFallback: runtime.port === wanted ? null : { from: wanted, to: runtime.port },
    token,
    tokenCreated: created,
    deck,
    server,
    ready,
    appRoot,
    close,
    url: `http://${HOST}:${runtime.port}/`,
  };
};

export { Deck, runningInstance } from './state.mjs';
export { ensureToken, checkRequest, sameToken, HEADER } from './auth.mjs';
export { ROUTES } from './routes.mjs';
export { PasteQueue, PASTE_WAIT_MS, PASTE_TTL_MS } from './paste.mjs';
export {
  Readiness, InFlight, READY_PATHS, UNKNOWN, readCodeVersion, readReleaseId, worstOf,
} from './ready.mjs';

/**
 * Запуск из командной строки: `node server/index.mjs`.
 *
 * Здесь и только здесь процесс получает право остановить себя. Перезапуск сделан
 * порождением нового процесса ДО выхода: тот, кто запустил этот сервер
 * (bridge/service.mjs или ярлык), за ним не следит и обратно не поднимет.
 * Новый процесс отвязан (`detached` + `unref`), иначе он умер бы вместе с этим.
 */
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const root = join(HERE, '..');
  const self = fileURLToPath(import.meta.url);

  const control = {
    shutdown: ({ restart = false } = {}) => {
      // Задержка нужна, чтобы ответ дошёл до браузера: закрытие сервера обрывает
      // соединение, и интерфейс увидел бы «нет связи» вместо «остановлено».
      setTimeout(async () => {
        await out.close();
        if (restart) {
          const { spawn } = await import('node:child_process');
          const next = spawn(process.execPath, [self], {
            cwd: root, detached: true, stdio: 'ignore', windowsHide: true,
          });
          next.unref();
        }
        process.exit(0);
      }, 150);
    },
  };

  const out = await start({ root, control });
  if (!out.ok) {
    process.stdout.write(`${out.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`CallMyPromts: ${out.url}\n`);
  process.on('SIGINT', async () => {
    await out.close();
    process.exit(0);
  });
}

// Public test/application boundary for cloud profile contracts.
export { DriveProfiles, portableSettings, settingsHash, PROFILE_FORMAT } from './cloud.mjs';

export { listenLoopback } from './loopback.mjs';
