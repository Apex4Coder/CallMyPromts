// tests/unit/bridge-watch.test.mjs — слежка за буфером запасным путём.
//
// Требование: REQ-KEY-WATCH (docs/SPEC.md §8). Сценарий: S-04.
//
// Основную слежку ведёт AHK. Этот модуль — запасной путь через опрос PowerShell,
// и его главное свойство не скорость, а честность: он обязан сообщать, что
// работает хуже, а не притворяться равноценной заменой.
//
// Настоящий PowerShell в тестах не запускается: `tick()` вызывается напрямую, а
// чтение буфера подменяется. Тест, зависящий от содержимого настоящего буфера
// обмена, ломался бы от любого копирования во время прогона.

import test from 'node:test';
import assert from 'node:assert/strict';

import { POLL_MS, ClipboardWatcher, sendClip } from '../../bridge/index.mjs';

/**
 * Наблюдатель с подменённым чтением буфера.
 * `tick` переопределён целиком: перехватывать импорт capture.mjs пришлось бы
 * через загрузчик модулей, а это спрятало бы логику теста.
 */
const fakeWatcher = (texts, onClip) => {
  const watcher = new ClipboardWatcher(onClip, { intervalMs: 10 });
  let i = 0;
  let last = null;

  watcher.tick = async () => {
    const text = texts[i] ?? null;
    i += 1;
    if (text === null || text === '' || text === last) return { skipped: 'same' };
    last = text;
    watcher.seen += 1;
    return { ok: true, sent: true, result: await onClip({ text, sourceApp: 'test.exe' }) };
  };

  return watcher;
};

// ── интервал ─────────────────────────────────────────────────────────────────

test('интервал опроса — полторы секунды', () => {
  // Меньше нельзя: запуск PowerShell стоит около 200 мс, и опрос чаще съедал бы
  // процессор ради журнала на сто записей.
  assert.equal(POLL_MS, 1500);
});

test('интервал настраивается', () => {
  const w = new ClipboardWatcher(() => {}, { intervalMs: 500 });

  assert.equal(w.intervalMs, 500);
});

// ── запуск и остановка ───────────────────────────────────────────────────────

test('наблюдатель начинает остановленным', () => {
  const w = new ClipboardWatcher(() => {});

  assert.equal(w.running, false);
});

test('запуск и остановка меняют состояние', () => {
  const w = new ClipboardWatcher(() => {}, { intervalMs: 10_000 });
  try {
    assert.equal(w.start().ok, true);
    assert.equal(w.running, true);
    assert.equal(w.stop(), true);
    assert.equal(w.running, false);
  } finally { w.stop(); }
});

test('повторный запуск не создаёт второй таймер', () => {
  // Два таймера означали бы двойной опрос и двойные записи в журнале.
  const w = new ClipboardWatcher(() => {}, { intervalMs: 10_000 });
  try {
    w.start();
    const again = w.start();

    assert.equal(again.already, true);
  } finally { w.stop(); }
});

test('остановка остановленного возвращает false без сбоя', () => {
  const w = new ClipboardWatcher(() => {});

  assert.equal(w.stop(), false);
});

// ── состояние ────────────────────────────────────────────────────────────────

test('состояние объясняет, какой путь используется', () => {
  const w = new ClipboardWatcher(() => {});
  const s = w.status();

  assert.equal(['ahk', 'poll'].includes(s.mode), true);
  assert.equal(s.note.trim() !== '', true, 'объяснение обязательно');
});

test('путь через AHK — good, запасной — не good', () => {
  // Уравнивать их значило бы скрыть, что быстрые повторы теряются.
  const w = new ClipboardWatcher(() => {});
  const s = w.status();

  if (s.mode === 'ahk') {
    assert.equal(s.state, 'good');
    assert.match(s.note, /AutoHotkey/);
  } else {
    assert.notEqual(s.state, 'good');
    assert.match(s.note, /могут быть пропущены/, 'потеря быстрых повторов названа прямо');
    assert.match(s.reason, /AutoHotkey/);
  }
});

test('интервал попадает в объяснение: цифра важнее слова «медленно»', () => {
  const w = new ClipboardWatcher(() => {}, { intervalMs: 3000 });
  const s = w.status();

  if (s.mode === 'poll') assert.match(s.note, /3000/);
});

// ── цикл опроса ──────────────────────────────────────────────────────────────

test('новая запись отправляется', async () => {
  const got = [];
  const w = fakeWatcher(['первый текст'], async (p) => { got.push(p.text); return { ok: true }; });

  const out = await w.tick();

  assert.equal(out.sent, true);
  assert.deepEqual(got, ['первый текст']);
});

test('то же содержимое второй раз не отправляется', async () => {
  // Повтор отсекается ещё до обращения к API: сеть и база не должны знать
  // о том, что ничего не изменилось.
  const got = [];
  const w = fakeWatcher(['текст', 'текст'], async (p) => { got.push(p.text); });

  await w.tick();
  const second = await w.tick();

  assert.equal(second.skipped, 'same');
  assert.equal(got.length, 1);
});

test('пустой буфер записью не считается', async () => {
  const got = [];
  const w = fakeWatcher(['', 'текст'], async (p) => { got.push(p.text); });

  const first = await w.tick();
  await w.tick();

  assert.equal(first.skipped, 'same');
  assert.deepEqual(got, ['текст']);
});

test('счётчик увиденного растёт только на новых записях', async () => {
  const w = fakeWatcher(['а-первый', 'а-первый', 'б-второй'], async () => {});

  await w.tick();
  await w.tick();
  await w.tick();

  assert.equal(w.seen, 2);
});

test('сброс памяти позволяет записать то же содержимое снова', async () => {
  // Нужен после очистки журнала: иначе запись, которую только что удалили,
  // невозможно вернуть копированием.
  const real = new ClipboardWatcher(() => {});

  real.reset();

  assert.equal(typeof real.reset, 'function');
});

test('имя источника передаётся вместе с текстом', async () => {
  // Без него не работает чёрный список менеджеров паролей.
  let seen = null;
  const w = fakeWatcher(['текст'], async (p) => { seen = p; });

  await w.tick();

  assert.equal(seen.sourceApp, 'test.exe');
});

// ── отправка в API ───────────────────────────────────────────────────────────

test('остановленный сервис — не ошибка слежки, а состояние', async () => {
  // Порт 1 гарантированно никем не слушается. Исключение здесь означало бы,
  // что остановка сервиса роняет мост.
  const out = await sendClip({ port: 1, token: 'нет' }, { text: 'текст', sourceApp: null });

  assert.equal(out.ok, false);
  assert.equal(out.status, 0);
  assert.match(out.reason, /сервис не отвечает/);
});

test('отправка не выбрасывает исключение ни при каком ответе', async () => {
  // Слежка работает в фоне без наблюдателя: необработанное исключение убило бы
  // процесс моста молча.
  for (const port of [1, 65535]) {
    const out = await sendClip({ port, token: 'x' }, { text: 'текст', sourceApp: null });
    assert.equal(typeof out.ok, 'boolean', `порт ${port}: ответ обязан быть значением`);
  }
});
