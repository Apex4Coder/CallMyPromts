// tests/integration/api-settings.test.mjs — настройки и заявка на вставку по HTTP.
//
// Требования: REQ-API-SETTINGS, REQ-API-PASTE (docs/SPEC.md §6).
// Сценарии: S-09 (смена оформления), S-01 (вставка), S-13 (первый запуск).
// Схема настроек: docs/DATA-CONTRACTS.md §3.
//
// Настройки — единственное место, где человек задаёт значения руками, поэтому
// главное здесь не «сохраняется ли», а что происходит с неверным значением.
// Молча подменённая настройка выглядит как «приложение меня не слушает», а
// принятая опечатка — как «функция не работает». Ни то, ни другое не должно
// оставаться без объяснения (docs/RULES.md §4).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tempRoot, cleanup, startServer } from '../helpers/harness.mjs';

const withServer = async (fn, { settings = null } = {}) => {
  const root = tempRoot();

  if (settings) {
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'state', 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
  }

  const up = await startServer(root);
  try {
    await fn(up, { root });
  } finally {
    await up.close();
    cleanup(root);
  }
};

const readSaved = (root) => JSON.parse(readFileSync(join(root, 'state', 'settings.json'), 'utf8'));

// ── чтение ───────────────────────────────────────────────────────────────────

test('первый запуск отдаёт значения по умолчанию без ошибок', async () => {
  // S-13: файла настроек ещё нет, и это нормальное состояние.
  await withServer(async (up) => {
    const res = await up.call('/api/settings');

    assert.equal(res.status, 200);
    assert.equal(res.data.settings.ui.layout, 'hybrid');
    assert.deepEqual(res.data.issues, [], 'на чистом старте замечаний быть не должно');
  });
});

test('все варианты оформления присутствуют в схеме', async () => {
  // Владелец просил сделать сразу все варианты, чтобы выбирать самому.
  await withServer(async (up) => {
    const ui = (await up.call('/api/settings')).data.settings.ui;

    for (const key of ['layout', 'theme', 'motion', 'accent', 'density', 'position', 'font_scale']) {
      assert.notEqual(ui[key], undefined, `${key}: нет в настройках`);
    }
  });
});

// ── запись ───────────────────────────────────────────────────────────────────

test('смена оформления сохраняется и читается обратно', async () => {
  // S-09: тема меняется без перезапуска сервиса.
  await withServer(async (up, { root }) => {
    const put = await up.call('/api/settings', {
      method: 'PUT',
      body: { ui: { theme: 'dark', layout: 'palette', accent: 'rose' } },
    });

    assert.equal(put.status, 200);
    assert.equal(put.data.settings.ui.theme, 'dark');
    assert.equal(readSaved(root).ui.layout, 'palette', 'на диск не записано');
    assert.equal((await up.call('/api/settings')).data.settings.ui.accent, 'rose');
  });
});

test('незаданные поля остаются прежними, а не сбрасываются', async () => {
  // Правка одного поля не должна стирать остальные: иначе смена темы обнуляла бы
  // настроенные хоткеи.
  await withServer(async (up) => {
    await up.call('/api/settings', { method: 'PUT', body: { hotkeys: { open_picker: '^!p' } } });
    const after = (await up.call('/api/settings', { method: 'PUT', body: { ui: { theme: 'dark' } } })).data;

    assert.equal(after.settings.hotkeys.open_picker, '^!p', 'хоткей потерян при смене темы');
  });
});

test('все три раскладки принимаются', async () => {
  await withServer(async (up) => {
    for (const layout of ['palette', 'panels', 'hybrid']) {
      const res = await up.call('/api/settings', { method: 'PUT', body: { ui: { layout } } });
      assert.equal(res.status, 200, `${layout}: отвергнута`);
    }
  });
});

test('все пять акцентов принимаются', async () => {
  await withServer(async (up) => {
    for (const accent of ['teal', 'indigo', 'amber', 'rose', 'slate']) {
      const res = await up.call('/api/settings', { method: 'PUT', body: { ui: { accent } } });
      assert.equal(res.status, 200, `${accent}: отвергнут`);
    }
  });
});

// ── неверные значения ────────────────────────────────────────────────────────

test('неизвестный ключ отвергается с путём к нему', async () => {
  // Опечатка в настройке иначе выглядит как «функция не работает» (V-S-1).
  await withServer(async (up) => {
    const res = await up.call('/api/settings', { method: 'PUT', body: { ui: { thema: 'dark' } } });

    assert.equal(res.status, 400);
    assert.equal(res.data.field, 'ui.thema');
    assert.match(res.data.message, /неизвестный ключ/);
  });
});

test('недопустимое значение отвергается со списком допустимых', async () => {
  // Без списка человек угадывает, а угадывать он не должен.
  await withServer(async (up) => {
    const res = await up.call('/api/settings', { method: 'PUT', body: { ui: { theme: 'сиреневая' } } });

    assert.equal(res.status, 400);
    assert.equal(res.data.field, 'ui.theme');
    assert.match(res.data.expected, /light \| dark \| system/);
  });
});

test('число вне диапазона отвергается с границами', async () => {
  await withServer(async (up) => {
    const res = await up.call('/api/settings', { method: 'PUT', body: { clipboard: { limit: 100000 } } });

    assert.equal(res.status, 400);
    assert.match(res.data.expected, /целое \d+\.\.\d+/);
  });
});

test('отвергнутая правка не портит сохранённые настройки', async () => {
  // Частично применённая настройка хуже отклонённой: половина изменений
  // молча уходит на диск.
  await withServer(async (up, { root }) => {
    await up.call('/api/settings', { method: 'PUT', body: { ui: { theme: 'dark' } } });
    await up.call('/api/settings', { method: 'PUT', body: { ui: { theme: 'light', layout: 'нет-такой' } } });

    assert.equal(readSaved(root).ui.theme, 'dark', 'отклонённая правка всё же применилась');
  });
});

test('пустой хоткей допустим: это «не назначено»', async () => {
  // V-S-5. Отсутствие горячей клавиши — выбор человека, а не ошибка.
  await withServer(async (up) => {
    const res = await up.call('/api/settings', { method: 'PUT', body: { hotkeys: { toggle_watch: '' } } });

    assert.equal(res.status, 200);
  });
});

test('хоткей не по форме отвергается с примером', async () => {
  await withServer(async (up) => {
    const res = await up.call('/api/settings', { method: 'PUT', body: { hotkeys: { open_picker: 'Ctrl+Alt+Q' } } });

    assert.equal(res.status, 400);
    assert.match(res.data.expected, /\^!q/, 'в подсказке нет примера верной записи');
  });
});

// ── битый файл настроек ──────────────────────────────────────────────────────

test('битый файл настроек не мешает старту и объясняет сброс', async () => {
  // V-S-4: приложение обязано запуститься. Молчаливый сброс выглядел бы так,
  // будто настройки не сохранялись никогда.
  const root = tempRoot();
  try {
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'state', 'settings.json'), '{ это не json', 'utf8');

    const up = await startServer(root);
    try {
      const res = await up.call('/api/settings');

      assert.equal(res.status, 200);
      assert.equal(res.data.settings.ui.layout, 'hybrid', 'умолчания не применены');
      assert.equal(res.data.issues.length >= 1, true, 'причина сброса не названа');
      assert.match(res.data.issues[0].message, /по умолчанию/);
    } finally {
      await up.close();
    }
  } finally { cleanup(root); }
});

test('неизвестный ключ в файле не блокирует старт, но виден', async () => {
  // Файл мог прийти от новой версии через синхронизацию.
  await withServer(async (up) => {
    const res = await up.call('/api/settings');

    assert.equal(res.status, 200);
    assert.equal(res.data.issues.some((i) => i.field === 'ui.несуществующее'), true);
  }, { settings: { ui: { theme: 'dark', 'несуществующее': 1 } } });
});

// ── заявка на вставку ────────────────────────────────────────────────────────

test('без моста заявка отвечает «не вставлено» с причиной', async () => {
  // S-01, плохой путь 5. Мост не запущен: текст остаётся в буфере, и человек
  // должен это узнать, а не увидеть «Вставлено».
  await withServer(async (up) => {
    const res = await up.call('/api/paste', { method: 'POST', body: { text: 'Текст промпта' } });

    assert.equal(res.status, 200);
    assert.equal(res.data.pasted, false);
    assert.match(res.data.why, /нет подтверждения нативной вставки/);
  });
});

/**
 * Опрос, как его ведёт мост: повторно, пока заявка не появится.
 *
 * Один опрос сразу после отправки — это гонка, и она сработала против первой
 * версии этого теста: HTTP-запрос POST успевал уйти, но не успевал дойти до
 * обработчика, и GET возвращал `has: false`. Настоящий мост опрашивает каждые
 * 250 мс и такой гонки не имеет, поэтому проверка воспроизводит именно его
 * поведение, а не мгновенный снимок.
 */
const pollUntilTaken = async (up, { tries = 20, everyMs = 20 } = {}) => {
  for (let i = 0; i < tries; i += 1) {
    const res = await up.call('/api/paste');
    if (res.data.has) return res;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return { data: { has: false, text: null } };
};

test('мост забирает текст, и заявка подтверждается', async () => {
  // Полный путь: интерфейс кладёт, мост забирает опросом.
  await withServer(async (up) => {
    const asked = up.call('/api/paste', { method: 'POST', body: { text: 'Ревью кода\nвторая строка' } });

    // Опрос идёт параллельно: сервер держит ответ интерфейсу до забора.
    const taken = await pollUntilTaken(up);
    assert.equal((await up.call('/api/paste/ack', { method: 'POST', body: { id: taken.data.id, success: true } })).status, 200);
    const answer = await asked;

    assert.equal(taken.data.has, true, 'мост не увидел заявку');
    assert.equal(taken.data.text, 'Ревью кода\nвторая строка');
    assert.equal(answer.data.pasted, true, 'интерфейсу не подтвердили вставку');
  });
});

test('второй опрос моста ничего не отдаёт', async () => {
  // Иначе один выбор вставился бы столько раз, сколько мост успел спросить.
  await withServer(async (up) => {
    const asked = up.call('/api/paste', { method: 'POST', body: { text: 'Один раз' } });
    const taken = await pollUntilTaken(up);
    await asked;

    assert.equal(taken.data.text, 'Один раз', 'первый опрос должен отдать текст');

    const again = await up.call('/api/paste');
    assert.equal(again.data.has, false);
    assert.equal(again.data.text, null);
  });
});

test('пустой текст на вставку отвергается', async () => {
  // Вставка пустоты в чужое окно — это нажатие Ctrl+V без содержимого.
  await withServer(async (up) => {
    const res = await up.call('/api/paste', { method: 'POST', body: { text: '' } });

    assert.equal(res.status, 400);
    assert.equal(res.data.error, 'empty_text');
  });
});

test('опрос без заявки не блокирует мост', async () => {
  // Мост опрашивает каждые 250 мс; ответ обязан приходить сразу.
  await withServer(async (up) => {
    const started = Date.now();
    const res = await up.call('/api/paste');
    const spent = Date.now() - started;

    assert.equal(res.data.has, false);
    assert.equal(spent < 500, true, `опрос занял ${spent} мс`);
  });
});
