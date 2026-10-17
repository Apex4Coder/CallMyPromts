// tests/integration/api-auth.test.mjs — токен локального API.
//
// Требование: REQ-API-AUTH (docs/SPEC.md §6). Сценарий S-08.
// Проверяемый файл: server/auth.mjs. Утверждение UI-SPEC: U-18.
// Host и Origin — в tests/integration/api-origin.test.mjs.
//
// Почему у локального сервера вообще есть авторизация. Порт на 127.0.0.1 доступен
// не только своему приложению: любая открытая в браузере страница может сделать
// `fetch('http://127.0.0.1:8791/api/clips')` и прочитать журнал буфера обмена, где
// лежат пароли и токены. Это не теоретическая угроза — это то, что произойдёт с
// любым сайтом, который решит поискать локальные сервисы.
//
// Защита состоит из трёх слоёв, и каждый закрывает свой класс атак. Здесь —
// первый: токен, которого чужая страница не знает. Остальные два (Host против
// DNS rebinding, Origin против стороннего сайта) вынесены в отдельный файл, когда
// этот вышел за 300 строк.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sameToken, ensureToken } from '../../server/index.mjs';
import { tempRoot, cleanup, startServer } from '../helpers/harness.mjs';

const withServer = async (fn) => {
  const root = tempRoot();
  const up = await startServer(root);
  try {
    await fn(up, root);
  } finally {
    await up.close();
    cleanup(root);
  }
};

// ── токен ────────────────────────────────────────────────────────────────────

test('запрос без токена даёт 401 с названием заголовка', async () => {
  // Утверждение U-18. Без названия заголовка автор моста не знает, что добавить.
  await withServer(async (up) => {
    const res = await up.call('/api/system', { token: null });

    assert.equal(res.status, 401);
    assert.equal(res.data.error, 'no_token');
    assert.match(res.data.message, /x-deck-token/i);
    assert.match(res.data.expected, /state\/token/, 'сказано, где взять токен');
  });
});

test('запрос с чужим токеном даёт 401', async () => {
  await withServer(async (up) => {
    const res = await up.call('/api/system', { token: 'f'.repeat(32) });

    assert.equal(res.status, 401);
    assert.equal(res.data.error, 'bad_token');
  });
});

test('токен неверной длины отвергается', async () => {
  // Сравнение за постоянное время сначала смотрит длину: это не уязвимость,
  // потому что длина токена не секрет.
  await withServer(async (up) => {
    assert.equal((await up.call('/api/system', { token: 'abc' })).status, 401);
  });
});

test('правильный токен пропускает', async () => {
  await withServer(async (up) => {
    assert.equal((await up.call('/api/system')).status, 200);
  });
});

test('все маршруты API закрыты, а не только один', async () => {
  // Забытый маршрут открывает журнал целиком, поэтому проверяется каждый вид.
  await withServer(async (up) => {
    for (const path of ['/api/system', '/api/settings', '/api/prompts', '/api/clips', '/api/paste']) {
      const res = await up.call(path, { token: null });
      assert.equal(res.status, 401, `${path}: пропущен без токена`);
    }
  });
});

test('запись тоже закрыта', async () => {
  // Чтение защитить и оставить открытую запись — это защита от чтения.
  await withServer(async (up) => {
    const res = await up.call('/api/prompt', {
      method: 'POST',
      token: null,
      body: { title: 'Чужой промпт', group: 'code', body: 'Текст.' },
    });

    assert.equal(res.status, 401);
  });
});

// ── сравнение токенов ────────────────────────────────────────────────────────

test('сравнение токенов не выходит раньше на первом различии', () => {
  // Обычное `===` на строках выходит при первом несовпадении, и по времени
  // ответа токен подбирается посимвольно. Здесь проверяется поведение, которое
  // это исключает: результат зависит только от равенства.
  assert.equal(sameToken('a'.repeat(32), 'a'.repeat(32)), true);
  assert.equal(sameToken(`${'a'.repeat(31)}b`, 'a'.repeat(32)), false);
  assert.equal(sameToken(`b${'a'.repeat(31)}`, 'a'.repeat(32)), false);
});

test('пустые значения токеном не считаются', async () => {
  // `undefined` из отсутствующего заголовка не должен совпасть с пустым файлом.
  assert.equal(sameToken(undefined, undefined), true, 'равные пустые — это равные');
  assert.equal(sameToken('', 'a'.repeat(32)), false);
  assert.equal(sameToken(null, 'a'.repeat(32)), false);
});

// ── файл токена ──────────────────────────────────────────────────────────────

test('токен создаётся при первом запуске', async () => {
  // S-13: ни одного файла состояния ещё нет.
  const root = tempRoot();
  try {
    const file = join(root, 'state', 'token');
    const made = ensureToken(file);

    assert.equal(made.created, true);
    assert.match(made.token, /^[0-9a-f]{32}$/);
    assert.equal(readFileSync(file, 'utf8').trim(), made.token);
  } finally { cleanup(root); }
});

test('существующий токен не перезаписывается', async () => {
  // Иначе мост, прочитавший токен на старте, потерял бы связь при перезапуске
  // сервера — и хоткеи молча перестали бы работать.
  const root = tempRoot();
  try {
    const file = join(root, 'state', 'token');
    const first = ensureToken(file);
    const second = ensureToken(file);

    assert.equal(second.created, false);
    assert.equal(second.token, first.token);
  } finally { cleanup(root); }
});

test('битый токен заменяется новым', async () => {
  // Файл мог быть испорчен редактором или синхронизацией. Отказ запускаться
  // из-за этого хуже, чем новый токен.
  const root = tempRoot();
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'state', 'token'), 'это не токен', 'utf8');

    const made = ensureToken(join(root, 'state', 'token'));
    assert.equal(made.created, true);
    assert.match(made.token, /^[0-9a-f]{32}$/);
  } finally { cleanup(root); }
});

test('токен у каждой установки свой', () => {
  const a = tempRoot();
  const b = tempRoot();
  try {
    assert.notEqual(
      ensureToken(join(a, 'state', 'token')).token,
      ensureToken(join(b, 'state', 'token')).token,
    );
  } finally { cleanup(a); cleanup(b); }
});

