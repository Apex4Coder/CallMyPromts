// tests/unit/bridge-tray.test.mjs — сводное состояние значка в трее.
//
// Требование: REQ-SVC-TRAY (docs/SPEC.md §8). Сценарий S-08.
// Проверяемый файл: bridge/tray.mjs. Состав меню: tests/unit/bridge-menu.test.mjs.
//
// Главное правило здесь одно: значок показывает ХУДШЕЕ из состояний частей.
// Зелёный значок при незарегистрированном хоткее — это ложь, из-за которой
// человек будет жать клавишу и думать, что сломалось приложение, а не что
// клавишу занял Punto Switcher (docs/RULES.md §4).
//
// Состояние читается из state/runtime.json, поэтому все проверки работают на
// временных корнях: настоящий рабочий сервис на результат не влияет.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { trayState, tooltip } from '../../bridge/index.mjs';
import { tempRoot, cleanup } from '../helpers/harness.mjs';

/** Живой сервис: pid текущего процесса заведомо существует. */
const running = (root, hotkeys = {}) => {
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'runtime.json'), JSON.stringify({
    pid: process.pid,
    port: 8791,
    started_at: '2026-09-05T10:00:00.000Z',
    library_path: join(root, 'prompts'),
    hotkeys,
  }), 'utf8');
  return root;
};

const key = (combo, state, reason = null) => ({ combo, state, reason });

/**
 * Установлен ли AHK на этой машине.
 *
 * Часть проверок зависит от ответа, и это честнее, чем подменять поиск: без AHK
 * значок ОБЯЗАН быть красным, с AHK — зелёным при исправных клавишах. Оба
 * утверждения верны, просто разные, и каждое проверяется в своих условиях.
 */
const withAhk = (root) => trayState(root).parts.bridge.state === 'good';

// ── сервис остановлен ────────────────────────────────────────────────────────

test('без runtime.json значок показывает «остановлен» с причиной', () => {
  const root = tempRoot();
  try {
    const t = trayState(root);

    assert.equal(t.state, 'none');
    assert.equal(t.word, 'остановлен');
    assert.match(t.reason, /не запущен/);
  } finally { cleanup(root); }
});

test('остановленный сервис — это «нет данных», а не «сломано»', () => {
  // Разница смысловая: «сломано» требует ремонта, «остановлено» — запуска.
  const root = tempRoot();
  try {
    assert.equal(trayState(root).state, 'none');
  } finally { cleanup(root); }
});

test('файл от упавшего процесса не выдаётся за работающий сервис', () => {
  // S-08, путь 3: после падения runtime.json остаётся, но процесса нет.
  const root = tempRoot();
  try {
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'state', 'runtime.json'),
      JSON.stringify({ pid: 4194304, port: 8791 }), 'utf8');

    const t = trayState(root);
    assert.equal(t.state, 'none');
    assert.match(t.reason, /4194304/, 'в причине назван pid, которого нет');
  } finally { cleanup(root); }
});

test('битый runtime.json не выдаётся за работающий сервис', () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'state', 'runtime.json'), '{ порча', 'utf8');

    const t = trayState(root);
    assert.equal(t.state, 'none');
    assert.match(t.reason, /не читается/);
  } finally { cleanup(root); }
});

// ── худшее из частей ─────────────────────────────────────────────────────────

test('все хоткеи в норме — значок зелёный', () => {
  const root = tempRoot();
  try {
    running(root, { open_picker: key('^!q', 'good'), save_clip: key('^+s', 'good') });

    if (withAhk(root)) {
      assert.equal(trayState(root).state, 'good');
      assert.equal(trayState(root).reason, null);
    } else {
      assert.equal(trayState(root).state, 'bad', 'без AHK значок обязан быть красным');
    }
  } finally { cleanup(root); }
});

test('один занятый хоткей делает значок красным', () => {
  const root = tempRoot();
  try {
    running(root, {
      open_picker: key('^!q', 'good'),
      open_clips: key('^!v', 'bad', 'занята Punto Switcher'),
    });

    assert.equal(trayState(root).state, 'bad');
  } finally { cleanup(root); }
});

test('причина занятости попадает в состояние значка', () => {
  // Без имени перехватчика человек не знает, что делать (REQ-KEY-CONFLICT).
  const root = tempRoot();
  try {
    running(root, { open_clips: key('^!v', 'bad', 'занята Punto Switcher') });
    const t = trayState(root);

    assert.match(t.reason, /Punto Switcher/);
    assert.match(t.reason, /open_clips/, 'названо и действие');
  } finally { cleanup(root); }
});

test('замечание без поломки даёт жёлтый, а не красный', () => {
  const root = tempRoot();
  try {
    running(root, { toggle_watch: key('^!w', 'warn', 'редко используется системой') });

    if (withAhk(root)) assert.equal(trayState(root).state, 'warn');
  } finally { cleanup(root); }
});

test('поломка сильнее замечания', () => {
  // Смешанное состояние не должно смягчаться до жёлтого: сломанное важнее.
  const root = tempRoot();
  try {
    running(root, {
      open_picker: key('^!q', 'warn', 'необычное сочетание'),
      open_clips: key('^!v', 'bad', 'занята'),
    });

    assert.equal(trayState(root).state, 'bad');
  } finally { cleanup(root); }
});

test('«не назначено» не портит состояние', () => {
  // Пустая комбинация — допустимое значение (V-S-5), а не проблема.
  const root = tempRoot();
  try {
    running(root, { toggle_watch: key('', 'none', 'не назначена') });

    if (withAhk(root)) assert.equal(trayState(root).state, 'good');
  } finally { cleanup(root); }
});

test('состояние частей видно по отдельности', () => {
  // Раздел «Сервис» показывает три строки: сервер, мост, клавиши. Сводка нужна
  // значку, подробности — человеку.
  const root = tempRoot();
  try {
    running(root, { open_picker: key('^!q', 'good') });
    const parts = trayState(root).parts;

    assert.equal(typeof parts.server.state, 'string');
    assert.equal(typeof parts.bridge.state, 'string');
    assert.equal(typeof parts.hotkeys, 'object');
  } finally { cleanup(root); }
});

test('порт и время старта доходят до значка', () => {
  // По ним человек отличает «запущено сейчас» от «висит с прошлой недели».
  const root = tempRoot();
  try {
    running(root);
    const server = trayState(root).parts.server;

    assert.equal(server.port, 8791);
    assert.equal(server.startedAt, '2026-09-05T10:00:00.000Z');
  } finally { cleanup(root); }
});

// ── подсказка ────────────────────────────────────────────────────────────────

test('подсказка объясняет состояние словами', () => {
  // Наведение на значок — самый быстрый способ понять, что происходит.
  const root = tempRoot();
  try {
    assert.match(tooltip(root), /CallMyPromts/);
    assert.match(tooltip(root), /остановлен/);
  } finally { cleanup(root); }
});

test('подсказка называет порт работающего сервиса', () => {
  const root = tempRoot();
  try {
    running(root);
    assert.match(tooltip(root), /порт 8791/);
  } finally { cleanup(root); }
});

test('подсказка не содержит undefined и NaN', () => {
  // Утверждение U-14: технические значения не доходят до экрана никогда.
  const root = tempRoot();
  try {
    running(root, { open_picker: key('^!q', 'bad') });
    const text = tooltip(root);

    assert.equal(/undefined|NaN|\[object/.test(text), false, text);
  } finally { cleanup(root); }
});

test('хоткей без причины не даёт пустого объяснения', () => {
  // Мост обязан сообщать причину, но если не сообщил — это тоже надо назвать,
  // а не показать «open_picker: ».
  const root = tempRoot();
  try {
    running(root, { open_picker: key('^!q', 'bad') });

    assert.match(trayState(root).reason, /причина не сообщена/);
  } finally { cleanup(root); }
});

test('подсказка остаётся одной строкой', () => {
  // Многострочная подсказка в трее Windows обрезается, и причина исчезает.
  const root = tempRoot();
  try {
    running(root, {
      open_picker: key('^!q', 'bad', 'занята'),
      open_clips: key('^!v', 'bad', 'занята'),
    });

    assert.equal(tooltip(root).includes('\n'), false);
  } finally { cleanup(root); }
});
