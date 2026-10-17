// server/http.mjs — примитивы HTTP: ответы, чтение тела, отдача статики.
//
// Требование: REQ-API-BIND (docs/SPEC.md §6). Формат ошибок: DATA-CONTRACTS §6.
//
// Отдельный файл, потому что это единственное место, где проект знает про
// заголовки и коды. Обработчики маршрутов возвращают данные, а не пишут в поток.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

export const MAX_BODY = 2 * 1024 * 1024;

/** Метка в разметке, на место которой встаёт токен. */
export const TOKEN_MARK = '__DECK_TOKEN__';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Заголовки безопасности на каждом ответе.
 * `no-store` — потому что журнал буфера не должен оставаться в кэше диска.
 * CSP без `unsafe-inline` для скриптов: содержимое промптов попадает в страницу,
 * и подстановка скрипта через текст файла не должна выполняться.
 */
export const SAFE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'",
};

export const sendJson = (res, status, data) => {
  const body = JSON.stringify(data ?? null);
  res.writeHead(status, {
    ...SAFE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  });
  res.end(body);
};

/** Ошибка в едином формате: error и message обязательны (DATA-CONTRACTS §6). */
export const sendError = (res, status, error, message, extra = {}) => {
  sendJson(res, status, { error, message, ...extra });
};

export const sendText = (res, status, text, type = 'text/plain; charset=utf-8') => {
  const body = String(text);
  res.writeHead(status, {
    ...SAFE_HEADERS,
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  });
  res.end(body);
};

/**
 * Чтение тела запроса с ограничением размера.
 * Без ограничения один запрос мог бы занять всю память процесса.
 */
export const readBody = (req) => new Promise((done, fail) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      fail(new Error(`тело запроса больше ${MAX_BODY} байт`));
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
  req.on('error', fail);
});

/** Разбор JSON тела. Пустое тело — это `{}`, а не ошибка. */
export const readJsonBody = async (req) => {
  const raw = await readBody(req);
  if (raw.trim() === '') return { ok: true, data: {} };
  try {
    const data = JSON.parse(raw);
    if (data === null || typeof data !== 'object') {
      return { ok: false, message: 'ожидался объект JSON' };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, message: `тело не разобрано как JSON: ${err.message}` };
  }
};

/**
 * Отдача файла из папки интерфейса.
 * Путь нормализуется и проверяется на выход за корень: `../../state/token`
 * не должен превратиться в чтение токена.
 */
export const sendFile = async (res, uiRoot, urlPath, { inject = null } = {}) => {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const full = resolve(join(uiRoot, clean));
  const rootAbs = resolve(uiRoot);

  if (full !== rootAbs && !full.startsWith(rootAbs + sep)) {
    sendError(res, 403, 'path_escape', 'запрошен файл вне папки интерфейса', { file: clean });
    return false;
  }

  let info;
  try {
    info = await stat(full);
    if (!info.isFile()) throw new Error('не файл');
  } catch {
    sendError(res, 404, 'not_found', 'файл не найден', { file: clean });
    return false;
  }

  const type = TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream';

  // Подстановка токена в HTML: браузер не читает файловую систему,
  // поэтому токен попадает в страницу здесь (docs/DATA-CONTRACTS.md §5).
  //
  // replaceAll, а не replace: строковый replace меняет только первое вхождение,
  // и когда метка встречалась ещё и в комментарии разметки, в сам скрипт токен
  // не попадал — интерфейс получал 401 на каждом запросе.
  if (inject && type.startsWith('text/html')) {
    const { readFile } = await import('node:fs/promises');
    const html = (await readFile(full, 'utf8')).replaceAll(TOKEN_MARK, inject);
    if (html.includes(TOKEN_MARK)) {
      sendError(res, 500, 'token_not_injected', 'метка токена осталась в разметке');
      return false;
    }
    sendText(res, 200, html, type);
    return true;
  }

  res.writeHead(200, { ...SAFE_HEADERS, 'Content-Type': type, 'Content-Length': info.size });
  createReadStream(full).pipe(res);
  return true;
};

/**
 * Путь в виде, пригодном для сообщения человеку.
 *
 * Сопоставление маршрутов идёт по СЫРОМУ пути, и это не изменится:
 * декодирование до сопоставления превратило бы `%2F` в разделитель и изменило
 * число сегментов, а на нём держится вся таблица маршрутов.
 *
 * Но в тексте ошибки сырой путь бесполезен. Русское имя промпта в адресе даёт
 * «нет маршрута GET /api/%D0%BD%D0%B5%D1%82-%D1%82%D0%B0%D0%BA%D0%BE%D0%B3%D0%BE»,
 * и человек не понимает, что именно он запросил. Причина, которую нельзя
 * прочитать, — это отсутствие причины (docs/RULES.md §4).
 */
const readable = (path) => {
  try {
    return decodeURIComponent(path);
  } catch {
    // Ломаная escape-последовательность: показываем как пришло, а не падаем.
    return path;
  }
};

/** Разбор пути и параметров запроса. `shown` — путь для сообщений человеку. */
export const parseUrl = (req) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const path = u.pathname.replace(/\/+$/, '') || '/';
  return { path, params: u.searchParams, shown: readable(path) };
};

/** Сопоставление шаблона `/api/prompt/:id/used` с реальным путём. */
export const matchPath = (pattern, path) => {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return null;

  const out = {};
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].startsWith(':')) {
      out[a[i].slice(1)] = decodeURIComponent(b[i]);
    } else if (a[i] !== b[i]) {
      return null;
    }
  }
  return out;
};
