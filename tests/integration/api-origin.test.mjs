// tests/integration/api-origin.test.mjs — защита API от чужих страниц и доменов.
//
// Требование: REQ-API-AUTH (docs/SPEC.md §6). Сценарий S-08.
// Проверяемый файл: server/auth.mjs. Утверждение UI-SPEC: U-18.
// Токен и его файл — в tests/integration/api-auth.test.mjs.
//
// Выделено из api-auth.test.mjs, когда тот вышел за 300 строк. Разделение по
// смыслу, а не по числу строк: там — «знает ли обратившийся секрет», здесь —
// «откуда он обратился». Это разные классы атак и разные механизмы защиты.
//
// Токена недостаточно по двум причинам:
//   1. он лежит в файле, а папка проекта может синхронизироваться;
//   2. порт на 127.0.0.1 виден любой открытой в браузере странице.
// Поэтому проверяются ещё два слоя:
//   Host   — DNS rebinding, когда внешний домен резолвится в 127.0.0.1;
//   Origin — запрос со стороннего сайта, даже если он угадал токен.

import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';

import { HEADER } from '../../server/index.mjs';
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

/** Запрос через fetch: годится, пока заголовки обычные. */
const raw = (up, path, headers = {}) => fetch(`${up.url}${path.replace(/^\//, '')}`, { headers });

/**
 * Запрос через node:http с полным контролем заголовков.
 *
 * `fetch` для проверки Host не годится, и это выяснилось отказом теста: Host —
 * запрещённое имя заголовка в fetch, оно молча заменяется настоящим адресом.
 * Запрос уходил правильным, сервер отвечал 200, и проверка выглядела как
 * «защиты нет». Защита была — проверка не умела её обойти.
 *
 * Тот же путь использует настоящая атака: DNS rebinding работает не через fetch
 * со подменённым заголовком, а через настоящий домен, который резолвится в
 * 127.0.0.1. Заголовок Host при этом остаётся доменом злоумышленника.
 */
const lowLevel = (up, path, headers = {}) => new Promise((done, fail) => {
  const req = request({
    host: '127.0.0.1',
    port: up.port,
    path,
    method: 'GET',
    headers,
    // Заголовок Host задаём сами: иначе Node подставит свой и перезапишет наш.
    setHost: !Object.keys(headers).some((k) => k.toLowerCase() === 'host'),
  }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      let data = null;
      try {
        data = body ? JSON.parse(body) : null;
      } catch {
        data = { raw: body };
      }
      done({ status: res.statusCode, data, body });
    });
  });
  req.on('error', fail);
  req.end();
});

// ── Host: DNS rebinding ──────────────────────────────────────────────────────

test('запрос с чужим Host отвергается', async () => {
  // DNS rebinding: домен злоумышленника указывает на 127.0.0.1, браузер считает
  // запрос своим, но Host остаётся чужим.
  await withServer(async (up) => {
    const res = await lowLevel(up, '/api/system', {
      Host: 'evil.example.com',
      [HEADER]: up.token,
    });

    assert.equal(res.status, 403);
    assert.equal(res.data.error, 'bad_host');
    assert.match(res.data.message, /evil\.example\.com/, 'чужой Host назван');
  });
});

test('localhost и 127.0.0.1 равноправны', async () => {
  // Мост и браузер могут обращаться по-разному, и это не должно быть отказом.
  await withServer(async (up) => {
    const res = await lowLevel(up, '/api/system', {
      Host: `localhost:${up.port}`,
      [HEADER]: up.token,
    });

    assert.equal(res.status, 200);
  });
});

test('правильный адрес с чужим портом отвергается', async () => {
  // Два экземпляра приложения на одной машине не должны видеть друг друга.
  await withServer(async (up) => {
    const res = await lowLevel(up, '/api/system', {
      Host: '127.0.0.1:9999',
      [HEADER]: up.token,
    });

    assert.equal(res.status, 403);
  });
});

test('Host без порта отвергается', async () => {
  // `127.0.0.1` без порта означает 80: там сервис не слушает, и такой запрос
  // приходит не от нашего интерфейса.
  await withServer(async (up) => {
    const res = await lowLevel(up, '/api/system', {
      Host: '127.0.0.1',
      [HEADER]: up.token,
    });

    assert.equal(res.status, 403);
  });
});

// ── Origin: сторонний сайт ───────────────────────────────────────────────────

test('запрос со стороннего Origin отвергается даже с токеном', async () => {
  // Токен мог утечь через синхронизацию папки. Origin — второй замок.
  await withServer(async (up) => {
    const res = await raw(up, '/api/clips', {
      Origin: 'https://evil.example.com',
      [HEADER]: up.token,
    });
    const data = await res.json();

    assert.equal(res.status, 403);
    assert.equal(data.error, 'bad_origin');
  });
});

test('свой Origin пропускается', async () => {
  await withServer(async (up) => {
    const res = await raw(up, '/api/system', {
      Origin: `http://127.0.0.1:${up.port}`,
      [HEADER]: up.token,
    });

    assert.equal(res.status, 200);
  });
});

test('отсутствие Origin не считается нарушением', async () => {
  // Мост AutoHotkey заголовок Origin не ставит, и требовать его нельзя.
  await withServer(async (up) => {
    assert.equal((await up.call('/api/system')).status, 200);
  });
});

test('нечитаемый Origin отвергается, а не пропускается', async () => {
  // «Не разобрали — значит можно» — это дыра, а не снисходительность.
  //
  // Значение из латиницы: заголовки HTTP передаются как ByteString, и русский
  // текст в них не проходит на уровне клиента, не доходя до сервера. Проверять
  // надо то, что сервер может получить.
  await withServer(async (up) => {
    const res = await lowLevel(up, '/api/system', {
      Origin: 'not-a-url',
      [HEADER]: up.token,
    });

    assert.equal(res.status, 403);
    assert.equal(res.data.error, 'bad_origin');
  });
});

// ── что доступно без токена ──────────────────────────────────────────────────

test('страница и статика открыты, данные закрыты', async () => {
  // Браузер не может добавить заголовок к запросу навигации и к <link>/<script>,
  // поэтому разметка и стили публичны. Данные — нет.
  await withServer(async (up) => {
    for (const path of ['', 'index.html', 'styles/tokens.css', 'views/app.js']) {
      const res = await raw(up, `/${path}`);
      assert.equal(res.status, 200, `/${path}: закрыт, интерфейс не загрузится`);
    }
    assert.equal((await raw(up, '/api/clips')).status, 401, 'журнал открыт без токена');
  });
});

test('токен попадает в страницу подстановкой, а не остаётся меткой', async () => {
  // Браузер не читает файловую систему. Если метка осталась, интерфейс получит
  // 401 на каждом запросе и будет выглядеть пустым без объяснения.
  await withServer(async (up) => {
    const html = await (await raw(up, '/')).text();

    assert.equal(html.includes('__DECK_TOKEN__'), false, 'метка осталась в разметке');
    assert.equal(html.includes(up.token), true, 'токен не подставлен');
  });
});
