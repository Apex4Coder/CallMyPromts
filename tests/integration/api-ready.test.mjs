// tests/integration/api-ready.test.mjs — три эндпоинта готовности.
//
// Требование: REQ-API-READY (docs/SPEC.md §6). Концепция: gld/gold.md §7.1.
// Проверяемые файлы: server/ready.mjs, server/routes-ready.mjs.
// Версия кода и номер релиза — в tests/integration/api-release.test.mjs.
//
// Главное здесь: `/livez` и `/readyz` отвечают на РАЗНЫЕ вопросы. Тест, который
// проверяет только «сервер ответил 200», не отличил бы одно от другого — и не
// заметил бы, что эндпоинты слиты в один. А слиты они означало бы, что во время
// слива работы супервизор считает процесс мёртвым и убивает его посреди дела.

import test from 'node:test';
import assert from 'node:assert/strict';

import { UNKNOWN, InFlight, worstOf } from '../../server/index.mjs';
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

/** Запрос без токена: эндпоинты готовности публичные. */
const bare = (up, path) => fetch(`${up.url}${path.replace(/^\//, '')}`);

// ── публичность ──────────────────────────────────────────────────────────────

test('все три эндпоинта отвечают без токена', async () => {
  // Их спрашивают супервизор и скрипт деплоя, которые токена не знают и знать не
  // должны. Требование токена сделало бы деплой невозможным без секрета.
  await withServer(async (up) => {
    for (const path of ['/livez', '/readyz', '/healthz']) {
      const res = await bare(up, path);
      assert.equal(res.status, 200, `${path}: ответ ${res.status} без токена`);
    }
  });
});

/**
 * Публичность оправдана только тем, что секретов в теле нет.
 *
 * Проверяются ЗНАЧЕНИЯ, а не слова. Первая версия искала подстроку `prompt` и
 * падала на пути `…\prompt-system` в поле `code_root` — то есть ловила имя проекта
 * вместо утечки. Такая проверка хуже отсутствия: она краснеет на безобидном и
 * молчит на настоящем секрете, потому что токен слова «token» не содержит.
 */
test('в ответах готовности нет ни токена, ни содержимого промптов', async () => {
  await withServer(async (up) => {
    // Промпт и запись журнала с узнаваемым текстом: если они утекут, это видно.
    await up.call('/api/prompt', {
      method: 'POST',
      body: { title: 'Секретный промпт', group: 'code', body: 'СОДЕРЖИМОЕ-ПРОМПТА-XYZ' },
    });
    await up.call('/api/clips', { method: 'POST', body: { text: 'ЗАПИСЬ-ЖУРНАЛА-XYZ' } });

    for (const path of ['/livez', '/readyz', '/healthz']) {
      const text = await (await bare(up, path)).text();

      assert.equal(text.includes(up.token), false, `${path}: в ответе токен`);
      assert.equal(text.includes('СОДЕРЖИМОЕ-ПРОМПТА-XYZ'), false, `${path}: тело промпта`);
      assert.equal(text.includes('ЗАПИСЬ-ЖУРНАЛА-XYZ'), false, `${path}: запись журнала`);
    }
  });
});

test('заголовки безопасности стоят и на эндпоинтах готовности', async () => {
  await withServer(async (up) => {
    const res = await bare(up, '/readyz');

    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});

// ── /livez против /readyz ────────────────────────────────────────────────────

test('/livez отвечает про процесс, а не про готовность', async () => {
  await withServer(async (up) => {
    const data = await (await bare(up, '/livez')).json();

    assert.equal(data.alive, true);
    assert.equal(typeof data.uptime_sec, 'number');
    // Готовность в /livez не сообщается: это другой вопрос и другой адрес.
    assert.equal('ready' in data, false, 'два вопроса слиты в один ответ');
    assert.equal('in_flight' in data, false);
  });
});

test('/readyz отвечает про готовность и называет версию', async () => {
  await withServer(async (up) => {
    const res = await bare(up, '/readyz');
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.ready, true);
    assert.equal(typeof data.code_version, 'string');
    assert.equal(typeof data.release_id, 'string');
    assert.equal(data.in_flight, 0);
    assert.equal(data.drain.active, false);
  });
});

test('/livez остаётся 200 при снятой готовности', async () => {
  // Различие, ради которого эндпоинты разделены: во время drain процесс жив и
  // здоров, он просто не принимает нового. `/livez` 503 означал бы «убей меня».
  await withServer(async (up) => {
    up.ready.drain = {
      active: true, startedAt: new Date().toISOString(), deadlineAt: null, reason: 'проба',
    };

    assert.equal((await bare(up, '/livez')).status, 200, 'живой процесс объявлен мёртвым');
    assert.equal((await bare(up, '/readyz')).status, 503);
  });
});

test('503 несёт причину, а не только код', async () => {
  await withServer(async (up) => {
    up.ready.drain = {
      active: true,
      startedAt: '2026-09-07T00:00:00.000Z',
      deadlineAt: '2026-09-07T00:02:00.000Z',
      reason: 'подготовка к обновлению',
    };

    const data = await (await bare(up, '/readyz')).json();

    assert.equal(data.ready, false);
    assert.equal(data.drain.reason, 'подготовка к обновлению');
    assert.equal(data.drain.deadline_at, '2026-09-07T00:02:00.000Z');
  });
});

// ── in_flight ────────────────────────────────────────────────────────────────

test('запросы к готовности не считаются работой', async () => {
  // Иначе опрос супервизора каждые 5 секунд держал бы in_flight выше нуля вечно,
  // и drain никогда бы не дождался тишины.
  await withServer(async (up) => {
    await bare(up, '/livez');
    await bare(up, '/healthz');

    const data = await (await bare(up, '/readyz')).json();
    assert.equal(data.in_flight, 0, 'опрос готовности посчитан работой');
  });
});

test('обычный запрос учитывается и отпускается по завершении', async () => {
  await withServer(async (up) => {
    await up.call('/api/system');

    const data = await (await bare(up, '/readyz')).json();
    assert.equal(data.in_flight, 0, 'счётчик не отпущен после ответа');
    assert.equal(up.ready.inFlight.peak >= 1, true, 'запрос не был учтён вовсе');
  });
});

test('двойное завершение не уводит счётчик в минус', () => {
  // `finish` и `close` могут прийти оба. Без защиты счётчик стал бы отрицательным,
  // и drain завершился бы раньше срока — на живой работе.
  const f = new InFlight();
  const leave = f.enter();

  assert.equal(f.count, 1);
  leave();
  leave();
  assert.equal(f.count, 0, 'счётчик ушёл в минус');
});

// ── /healthz ─────────────────────────────────────────────────────────────────

test('/healthz перечисляет проверки, и у каждой есть слово', async () => {
  // Значок в трее красится по худшему состоянию, но человек обязан видеть, что
  // именно не так (docs/RULES.md §4): состояние + слово, никогда только цвет.
  await withServer(async (up) => {
    const data = await (await bare(up, '/healthz')).json();

    assert.equal(Array.isArray(data.checks), true);
    assert.equal(data.checks.length >= 3, true);
    for (const c of data.checks) {
      assert.equal(typeof c.name, 'string');
      assert.equal(['good', 'warn', 'bad', 'none'].includes(c.state), true, `${c.name}: ${c.state}`);
      assert.equal(typeof c.word === 'string' && c.word !== '', true, `${c.name}: нет слова`);
    }
  });
});

test('запуск из рабочей копии — состояние none, а не ошибка', async () => {
  // Отсутствие релиза при разработке нормально. `bad` здесь означало бы «сломано»
  // и красил трей красным на каждом запуске из исходников.
  await withServer(async (up) => {
    const data = await (await bare(up, '/healthz')).json();
    const release = data.checks.find((c) => c.name === 'релиз');

    assert.equal(release.state, 'none');
    assert.match(release.word, /рабочей копии/);
  });
});

test('сводное состояние — худшее из проверок', () => {
  assert.equal(worstOf([{ state: 'good' }, { state: 'warn' }, { state: 'good' }]), 'warn');
  assert.equal(worstOf([{ state: 'warn' }, { state: 'bad' }]), 'bad');
  assert.equal(worstOf([{ state: 'good' }, { state: 'none' }]), 'none');
  assert.equal(worstOf([{ state: 'good' }]), 'good');
});

test('во время drain сводка это показывает', async () => {
  await withServer(async (up) => {
    up.ready.drain = {
      active: true, startedAt: new Date().toISOString(), deadlineAt: null, reason: 'слив перед обновлением',
    };

    const data = await (await bare(up, '/healthz')).json();

    assert.equal(data.status, 'warn', 'слив работы не отражён в сводке');
    assert.match(JSON.stringify(data.checks), /слив перед обновлением/);
  });
});

// ── метод ────────────────────────────────────────────────────────────────────

test('POST на эндпоинт готовности даёт 405 с разрешённым методом', async () => {
  // 404 здесь соврал бы: путь существует, недопустим метод. Разница важна тому,
  // кто отлаживает супервизор.
  await withServer(async (up) => {
    const res = await fetch(`${up.url}readyz`, { method: 'POST' });
    const data = await res.json();

    assert.equal(res.status, 405);
    assert.equal(data.error, 'bad_method');
    assert.match(data.message, /только GET/);
  });
});

