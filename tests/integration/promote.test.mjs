// tests/integration/promote.test.mjs — запись журнала становится промптом (S-05).
//
// Требования: REQ-CLIP-PROMOTE, REQ-API-CLIPS (docs/SPEC.md §4, §6).
// Проверяемые файлы: clipboard/promote.mjs, server/routes-clips.mjs.
//
// Почему это интеграционный тест, а не unit. Здесь встречаются два модуля,
// которым запрещено знать друг о друге: `clipboard` готовит решение, `library`
// его исполняет, а связывает их только `server` (docs/ENTITY-MAP.md §6). Проверять
// такое по частям бессмысленно — ломается именно связка.
//
// Сохранение идёт в два шага: первый запрос возвращает план (имя файла, что будет
// очищено, предупреждения), второй с `confirm: true` создаёт файл. Молчаливое
// создание файла с придуманным именем — это изменение, которого не просили
// (docs/RULES.md §5).

import test from 'node:test';
import assert from 'node:assert/strict';

import { tempRoot, cleanup, promptFile, startServer, exists } from '../helpers/harness.mjs';

const withServer = async (fn, { prompts = [] } = {}) => {
  const root = tempRoot();
  const libRoot = `${root}/prompts`;

  for (const p of prompts) promptFile(libRoot, p.group ?? 'code', p.id, p);

  const up = await startServer(root);
  try {
    await fn(up, { root, libRoot });
  } finally {
    await up.close();
    cleanup(root);
  }
};

/** Запись в журнал через API: так же, как это делает мост. */
const addClip = async (up, text, sourceApp = 'code') => {
  const res = await up.call('/api/clips', { method: 'POST', body: { text, sourceApp } });
  assert.equal(res.status, 201, `запись не добавлена: ${JSON.stringify(res.data)}`);
  return res.data.id;
};

const plan = (up, id, body) => up.call(`/api/clips/${id}/promote`, { method: 'POST', body });

// ── план ─────────────────────────────────────────────────────────────────────

test('первый запрос возвращает план, а файл не создаётся', async () => {
  await withServer(async (up, { libRoot }) => {
    const id = await addClip(up, 'Проверь этот код на ошибки и предложи улучшения.');
    const res = await plan(up, id, { group: 'code' });

    assert.equal(res.status, 200);
    assert.equal(typeof res.data.plan.id, 'string');
    assert.equal(exists(`${libRoot}/code/${res.data.plan.id}.md`), false, 'файл создан без подтверждения');
  });
});

test('в плане видно итоговое имя файла до создания', async () => {
  // S-03, плохой путь 3: человек должен увидеть, как будет назван файл.
  await withServer(async (up) => {
    const id = await addClip(up, 'Ревью кода по чеклисту.');
    const res = await plan(up, id, { group: 'code', title: 'Моё Ревью!' });

    assert.match(res.data.plan.id, /^[a-z][a-z0-9-]*$/, `имя «${res.data.plan.id}» не годится для файла`);
    assert.equal(res.data.plan.title, 'Моё Ревью!', 'название человека сохранено как есть');
  });
});

test('имя берётся из текста, если человек его не дал', async () => {
  await withServer(async (up) => {
    const id = await addClip(up, 'Найди утечку памяти в этом коде\n\nПодробности ниже.');
    const res = await plan(up, id, { group: 'code' });

    assert.equal(res.data.plan.title.length > 0, true);
    assert.match(res.data.plan.title, /утечк/i, 'имя не связано с текстом');
  });
});

test('план перечисляет группы для выпадающего списка', async () => {
  // Прямая просьба владельца: при сохранении показывать список групп.
  await withServer(async (up) => {
    const id = await addClip(up, 'Текст для сохранения.');
    const res = await plan(up, id, { group: 'code' });
    const ids = res.data.groups.map((g) => g.id);

    assert.equal(ids.includes('code'), true);
    assert.equal(ids.at(-1), '__new__', '«Новая группа» должна быть последней');
  }, { prompts: [{ id: 'c-review', group: 'code', title: 'Ревью' }] });
});

test('разметка из документа снимается, и это показано', async () => {
  // S-03: текст, скопированный из Google Docs, приходит с HTML.
  await withServer(async (up) => {
    const id = await addClip(up, '<p>Проверь <b>код</b> и объясни ошибки.</p>');
    const res = await plan(up, id, { group: 'code' });

    assert.equal(res.data.plan.body.includes('<b>'), false, 'разметка осталась');
    assert.match(res.data.plan.body, /Проверь код/);
    assert.equal(res.data.plan.cleaned.length > 0, true, 'факт очистки не показан');
  });
});

// ── создание ─────────────────────────────────────────────────────────────────

test('подтверждение создаёт файл и он сразу в списке', async () => {
  await withServer(async (up, { libRoot }) => {
    const id = await addClip(up, 'Составь план рефакторинга модуля.');
    const made = await plan(up, id, { group: 'code', title: 'План рефакторинга', confirm: true });

    assert.equal(made.status, 201);
    assert.equal(exists(`${libRoot}/code/${made.data.created.id}.md`), true, 'файл не создан');

    const list = await up.call('/api/prompts');
    assert.equal(list.data.items.some((i) => i.id === made.data.created.id), true, 'нет в списке');
  });
});

test('созданный промпт читается обратно с тем же телом', async () => {
  await withServer(async (up) => {
    const text = 'Опиши архитектуру и назови слабые места.';
    const id = await addClip(up, text);
    const made = await plan(up, id, { group: 'code', title: 'Обзор архитектуры', confirm: true });

    const got = await up.call(`/api/prompt/${made.data.created.id}`);
    assert.equal(got.data.item.body.trim(), text);
  });
});

test('источник записывается в промпт', async () => {
  // По нему потом видно, что промпт пришёл из буфера, а не написан руками.
  await withServer(async (up) => {
    const id = await addClip(up, 'Текст из редактора.', 'Code.exe');
    const made = await plan(up, id, { group: 'code', title: 'Из редактора', confirm: true });

    const got = await up.call(`/api/prompt/${made.data.created.id}`);
    assert.match(got.data.item.source, /clipboard/);
  });
});

test('запись помечается сохранённой', async () => {
  // Отметка нужна не для отчётности: помеченная запись перестаёт вытесняться
  // лимитом журнала (V-C-3).
  await withServer(async (up) => {
    const id = await addClip(up, 'Текст, который станет промптом.');
    const made = await plan(up, id, { group: 'code', title: 'Заготовка', confirm: true });

    assert.equal(made.data.marked, true, 'отметка не поставлена');

    const clip = await up.call(`/api/clip/${id}`);
    assert.equal(clip.data.item.promotedTo, made.data.created.id);
  });
});

test('русское название превращается в латинское имя файла', async () => {
  // Кириллица в имени файла работает, но ломает синхронизацию между системами
  // и набор триггера с клавиатуры.
  await withServer(async (up, { libRoot }) => {
    const id = await addClip(up, 'Текст промпта.');
    const made = await plan(up, id, { group: 'code', title: 'Проверка Кода Начисто', confirm: true });

    assert.match(made.data.created.id, /^[a-z][a-z0-9-]*$/);
    assert.equal(exists(`${libRoot}/code/${made.data.created.id}.md`), true);
  });
});

// ── новая группа ─────────────────────────────────────────────────────────────

test('сохранение в новую группу создаёт папку', async () => {
  await withServer(async (up, { libRoot }) => {
    const group = await up.call('/api/group', { method: 'POST', body: { name: 'Мои Промпты!' } });

    assert.equal(group.status, 201);
    assert.equal(group.data.renamed, true, 'приведение имени не показано');
    assert.match(group.data.name, /^[a-z][a-z0-9-]*$/);

    const id = await addClip(up, 'Текст в новую группу.');
    const made = await plan(up, id, { group: group.data.name, title: 'Первый', confirm: true });

    assert.equal(exists(`${libRoot}/${group.data.name}/${made.data.created.id}.md`), true);
  });
});

// ── предупреждения, а не запреты ─────────────────────────────────────────────

test('повторное сохранение той же записи предупреждает, но не запрещает', async () => {
  // S-05, плохой путь 2. Человек имеет право на две похожие заготовки.
  await withServer(async (up) => {
    const id = await addClip(up, 'Текст для двух промптов.');
    await plan(up, id, { group: 'code', title: 'Первый вариант', confirm: true });

    const again = await plan(up, id, { group: 'code' });
    assert.equal(again.status, 200, 'повтор запрещён');
    assert.equal(again.data.issues.some((i) => i.level === 'warn'), true, 'нет предупреждения');
    assert.match(again.data.issues.find((i) => i.level === 'warn').message, /уже сохранена/);
  });
});

test('совпадение текста с существующим промптом предупреждает', async () => {
  await withServer(async (up) => {
    const body = 'Тело промпта c-twin.';
    const id = await addClip(up, body);
    const res = await plan(up, id, { group: 'code' });

    assert.equal(res.data.issues.some((i) => /совпадает с промптом/.test(i.message)), true);
  }, { prompts: [{ id: 'c-twin', group: 'code', title: 'Двойник', body: 'Тело промпта c-twin.' }] });
});

test('секрет в тексте предупреждает про синхронизацию', async () => {
  // Библиотека уходит в Git, журнал — нет. Разница названа прямо.
  await withServer(async (up) => {
    const secret = ['sk', '-', 'a'.repeat(32)].join('');
    const id = await addClip(up, `Ключ для примера: ${secret}`);
    const res = await plan(up, id, { group: 'code' });

    const found = res.data.issues.find((i) => /секрет/.test(i.message));
    assert.notEqual(found, undefined, 'секрет не замечен');
    assert.match(found.message, /синхронизируется/, 'причина не названа');
  });
});

// ── отказы ───────────────────────────────────────────────────────────────────

test('сохранение без группы отвергается с указанием поля', async () => {
  await withServer(async (up) => {
    const id = await addClip(up, 'Текст.');
    const res = await plan(up, id, {});

    assert.equal(res.status, 400);
    assert.equal(res.data.field, 'group');
  });
});

test('несуществующая запись даёт 404 с номером', async () => {
  await withServer(async (up) => {
    const res = await plan(up, 999999, { group: 'code' });

    assert.equal(res.status, 404);
    assert.match(res.data.message, /999999/);
  });
});

test('запись из одних пробелов не сохраняется', async () => {
  // Пустой промпт в библиотеке — это мусор, который потом ищут глазами.
  await withServer(async (up) => {
    const res = await up.call('/api/clips', { method: 'POST', body: { text: '   \n  \t ' } });

    // Журнал сам отказывается от пустого: до сохранения дело не доходит.
    assert.equal(res.data.ok === false || res.data.skipped !== undefined, true,
      `пустая запись принята: ${JSON.stringify(res.data)}`);
  });
});

// ── удаление и очистка ───────────────────────────────────────────────────────

test('запись удаляется по номеру', async () => {
  await withServer(async (up) => {
    const id = await addClip(up, 'Запись на удаление.');
    const gone = await up.call(`/api/clip/${id}`, { method: 'DELETE' });

    assert.equal(gone.status, 200);
    assert.equal((await up.call(`/api/clip/${id}`)).status, 404);
  });
});

test('очистка журнала сохраняет отмеченные записи', async () => {
  // Сохранённая как промпт запись — это связь с файлом, и терять её нельзя.
  await withServer(async (up) => {
    const keep = await addClip(up, 'Эта станет промптом.');
    await addClip(up, 'А эта просто копия.');
    await plan(up, keep, { group: 'code', title: 'Сохранённая', confirm: true });

    const cleared = await up.call('/api/clips/clear', { method: 'POST', body: { keepPromoted: true } });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.keptPromoted, true);

    assert.equal((await up.call(`/api/clip/${keep}`)).status, 200, 'отмеченная запись удалена');
  });
});

test('пауза слежки видна в списке журнала', async () => {
  // S-04: «слежка приостановлена» — это состояние с причиной, а не пустой список.
  await withServer(async (up) => {
    await up.call('/api/watch', { method: 'POST', body: { enabled: false } });
    const res = await up.call('/api/clips');

    assert.equal(res.data.paused, true);
  });
});
