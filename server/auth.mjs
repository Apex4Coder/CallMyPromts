// server/auth.mjs — токен доступа и защита локального API.
//
// Требование: REQ-API-AUTH (docs/SPEC.md §6). Контракт токена: DATA-CONTRACTS §5.
// Тест: tests/integration/api-auth.test.mjs.
//
// Почему у локального сервера вообще есть авторизация. Порт на 127.0.0.1 доступен
// не только своему приложению: любая открытая в браузере страница может сделать
// `fetch('http://127.0.0.1:8791/api/clips')` и прочитать журнал буфера обмена, где
// лежат пароли и токены. Один заголовок закрывает этот класс атак целиком.
//
// Вторая защита — проверка `Origin` и `Host`: она отсекает DNS rebinding, когда
// внешний домен указывает на 127.0.0.1 и обходит проверку источника браузером.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export const HEADER = 'x-deck-token';
export const TOKEN_LEN = 32;

const TOKEN_RE = /^[0-9a-f]{32}$/;

/** Чтение токена или создание нового при первом старте. */
export const ensureToken = (file) => {
  try {
    const got = readFileSync(file, 'utf8').trim();
    if (TOKEN_RE.test(got)) return { token: got, created: false };
  } catch { /* файла нет — создадим ниже */ }

  const token = randomBytes(16).toString('hex');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token, { encoding: 'utf8' });
  try {
    // На Windows режим игнорируется, на других системах закрывает файл от чужих.
    chmodSync(file, 0o600);
  } catch { /* не критично: файл всё равно внутри профиля пользователя */ }

  return { token, created: true };
};

/**
 * Сравнение за постоянное время. Обычное `===` на строках выходит раньше при
 * первом несовпадении, и по времени ответа токен можно подбирать посимвольно.
 */
export const sameToken = (a, b) => {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
};

/** Разрешённые источники: только свой порт на петлевом адресе. */
const allowedHosts = (port) => new Set([
  `127.0.0.1:${port}`,
  `localhost:${port}`,
  `[::1]:${port}`,
]);

/**
 * Проверка запроса.
 * @returns {{ ok: true } | { ok: false, status: number, error: string, message: string }}
 */
export const checkRequest = (req, { token, port, path = '' }) => {
  const hosts = allowedHosts(port);

  const host = String(req.headers.host ?? '');
  if (!hosts.has(host)) {
    return {
      ok: false,
      status: 403,
      error: 'bad_host',
      message: `запрос с чужим Host: «${host}»`,
    };
  }

  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = '';
    }
    if (!hosts.has(originHost)) {
      return {
        ok: false,
        status: 403,
        error: 'bad_origin',
        message: `запрос со стороннего источника: «${origin}»`,
      };
    }
  }

  const got = req.headers[HEADER];
  if (!got) {
    return {
      ok: false,
      status: 401,
      error: 'no_token',
      message: `нет заголовка ${HEADER}`,
      expected: 'заголовок X-Deck-Token из state/token',
    };
  }
  if (!sameToken(got, token)) {
    return { ok: false, status: 401, error: 'bad_token', message: 'токен не совпадает' };
  }

  return { ok: true, path };
};

/** Пути, доступные без токена: сама страница и её статика. */
export const isPublicPath = (path) => path === '/'
  || path === '/index.html'
  || path.startsWith('/styles/')
  || path.startsWith('/views/')
  || path === '/favicon.ico';
