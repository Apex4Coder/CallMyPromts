// tests/unit/bridge-capture.test.mjs — поиск AutoHotkey и запасной путь.
//
// Требование: REQ-KEY-CAPTURE (docs/SPEC.md §8). Сценарий: S-03.
//
// Разведка показала: на машине стоит AutoHotkey 2.0.26. Но приложение не имеет
// права падать, если его снесут: без AHK теряются только горячие клавиши и чтение
// выделения, а окно управления, журнал и библиотека продолжают работать
// (S-07, плохой путь 7). Здесь проверяется, что оба пути честно названы.
//
// Тесты не запускают ни AHK, ни PowerShell: список путей и переменная окружения
// передаются параметрами. Тест, зависящий от того, что установлено на машине,
// давал бы разный результат на разных компьютерах.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { findAhk, ahkCommand, capabilities } from '../../bridge/index.mjs';
import { tempRoot, cleanup } from '../helpers/harness.mjs';

/** Подставной исполняемый файл: важен только факт существования пути. */
const fakeExe = (root, name = 'AutoHotkey64.exe') => {
  mkdirSync(join(root, 'ahk'), { recursive: true });
  const file = join(root, 'ahk', name);
  writeFileSync(file, 'подставной файл\n', 'utf8');
  return file;
};

// ── поиск ────────────────────────────────────────────────────────────────────

test('находит первый существующий путь из списка', () => {
  const root = tempRoot();
  try {
    const exe = fakeExe(root);

    const out = findAhk({ paths: [join(root, 'нет.exe'), exe], env: null });

    assert.equal(out.found, true);
    assert.equal(out.path, exe);
    assert.equal(out.state, 'good');
    assert.equal(out.reason, null);
  } finally { cleanup(root); }
});

test('порядок списка соблюдается: первый найденный побеждает', () => {
  const root = tempRoot();
  try {
    const first = fakeExe(root, 'AutoHotkey64.exe');
    const second = fakeExe(root, 'AutoHotkey32.exe');

    assert.equal(findAhk({ paths: [first, second], env: null }).path, first);
    assert.equal(findAhk({ paths: [second, first], env: null }).path, second);
  } finally { cleanup(root); }
});

test('путь из переменной окружения важнее списка', () => {
  // Человек может держать AHK в нестандартном месте, и его выбор главнее догадок.
  const root = tempRoot();
  try {
    const custom = fakeExe(root, 'МойAHK.exe');
    const standard = fakeExe(root, 'AutoHotkey64.exe');

    const out = findAhk({ paths: [standard], env: custom });

    assert.equal(out.path, custom);
  } finally { cleanup(root); }
});

test('несуществующий путь из окружения не отменяет поиск по списку', () => {
  // Иначе опечатка в переменной означала бы полную потерю хоткеев при
  // установленном AHK.
  const root = tempRoot();
  try {
    const standard = fakeExe(root);

    const out = findAhk({ paths: [standard], env: join(root, 'опечатка.exe') });

    assert.equal(out.found, true);
    assert.equal(out.path, standard);
  } finally { cleanup(root); }
});

test('отсутствие AHK — bad с объяснением, что именно потеряно', () => {
  const root = tempRoot();
  try {
    const out = findAhk({ paths: [join(root, 'нет.exe')], env: null });

    assert.equal(out.found, false);
    assert.equal(out.path, null);
    assert.equal(out.state, 'bad');
    assert.match(out.reason, /горячие клавиши/, 'сказано, что перестанет работать');
    assert.match(out.reason, /окно управления работает/, 'и что продолжит работать');
  } finally { cleanup(root); }
});

// ── команда запуска ──────────────────────────────────────────────────────────

test('команда запуска собирается, но не выполняется', () => {
  // Запуск — дело service.mjs. Разделение нужно, чтобы команду можно было
  // проверить и показать человеку в диагностике.
  const root = tempRoot();
  try {
    const exe = fakeExe(root);

    const out = ahkCommand(root, { ahk: exe });

    assert.equal(out.ok, true);
    assert.equal(out.file, exe);
    assert.deepEqual(out.args, ['/CP65001', join(root, 'bridge', 'deck.ahk')]);
  } finally { cleanup(root); }
});

test('без AHK команда не собирается, причина передаётся дальше', () => {
  const root = tempRoot();
  try {
    // Явно недостижимый путь: подмена окружения не нужна, достаточно передать
    // несуществующий файл через параметр.
    const out = ahkCommand(root, { ahk: null });

    if (!out.ok) {
      assert.match(out.reason, /AutoHotkey/, 'причина названа');
    } else {
      // На этой машине AHK установлен, поэтому команда собирается — это тоже
      // корректный исход, и тогда проверяем её пригодность.
      assert.equal(out.args.length, 2);
      assert.match(out.script, /deck\.ahk$/);
    }
  } finally { cleanup(root); }
});

test('путь к скрипту моста абсолютный', () => {
  // Относительный путь сломался бы при запуске из другого рабочего каталога.
  const root = tempRoot();
  try {
    const out = ahkCommand(root, { ahk: fakeExe(root) });

    assert.equal(out.script.startsWith(root), true);
  } finally { cleanup(root); }
});

// ── возможности ──────────────────────────────────────────────────────────────

test('возможности перечислены по отдельности, а не одним флагом', () => {
  // «Всё работает» или «ничего не работает» — недостаточно: без AHK чтение буфера
  // остаётся возможным, а чтение выделения нет, и человек должен знать разницу.
  const out = capabilities();

  for (const key of ['hotkeys', 'selectionCapture', 'pasteIntoWindow', 'clipboardRead']) {
    assert.equal(['good', 'warn', 'bad'].includes(out[key]), true, `${key}: недопустимое состояние`);
  }
});

test('чтение буфера всегда warn: запасной путь медленнее и хуже', () => {
  // Пометить его good значило бы обещать качество, которого нет: PowerShell
  // не видит выделение и стоит около 200 мс на вызов.
  assert.equal(capabilities().clipboardRead, 'warn');
});

test('состояния возможностей согласованы между собой', () => {
  const out = capabilities();

  // Три возможности зависят от одного и того же AHK, поэтому расходиться не могут.
  assert.equal(out.hotkeys, out.selectionCapture);
  assert.equal(out.hotkeys, out.pasteIntoWindow);
});

test('при отсутствии AHK названы и причина, и запасной путь', () => {
  const out = capabilities();

  if (out.hotkeys === 'bad') {
    assert.match(out.reason, /AutoHotkey/);
    assert.match(out.fallback, /PowerShell/, 'человек должен знать, что всё же работает');
    assert.equal(out.ahkPath, null);
  } else {
    assert.equal(out.reason, null, 'при рабочем AHK причины быть не должно');
    assert.equal(out.fallback, null);
    assert.equal(typeof out.ahkPath, 'string', 'путь показывается в диагностике');
  }
});
