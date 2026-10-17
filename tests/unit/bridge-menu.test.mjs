// tests/unit/bridge-menu.test.mjs — состав меню трея и доступность пунктов.
//
// Требование: REQ-SVC-TRAY (docs/SPEC.md §8). Сценарий S-08.
// Проверяемый файл: bridge/tray.mjs.
//
// Отделено от tests/unit/bridge-tray.test.mjs: там — сводное состояние значка,
// здесь — что в меню и когда пункт доступен. Разделение по смыслу, а не по
// размеру: состав меню — это контракт с владельцем («правой клавишей сохранить,
// копировать, а больше ничего не надо»), а доступность — защита от пунктов,
// которые молча не срабатывают.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MENU, menuFor, menuScript } from '../../bridge/index.mjs';
import { tempRoot, cleanup } from '../helpers/harness.mjs';

/** Живой сервис: pid текущего процесса заведомо существует. */
const running = (root) => {
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'runtime.json'), JSON.stringify({
    pid: process.pid,
    port: 8791,
    started_at: '2026-09-05T10:00:00.000Z',
    hotkeys: {},
  }), 'utf8');
  return root;
};

// ── состав ───────────────────────────────────────────────────────────────────

test('меню содержит всё, что просил владелец', () => {
  // S-08: открыть, журнал, настройки, пауза, перезапуск, остановка, выход.
  const ids = MENU.filter((i) => !i.separator).map((i) => i.id);

  for (const need of ['picker', 'clips', 'settings', 'watch', 'restart', 'stop', 'exit']) {
    assert.equal(ids.includes(need), true, `нет пункта «${need}»`);
  }
});

test('выход — последний пункт', () => {
  // Случайное нажатие «Выход» вместо «Настройки» стоит дорого: сервис умрёт
  // молча, и человек решит, что приложение упало.
  assert.equal(MENU.at(-1).id, 'exit');
});

test('выход отделён разделителем', () => {
  assert.equal(MENU[MENU.length - 2].separator, true, 'перед «Выход» должен быть разделитель');
});

test('левый клик открывает мини-CRM', () => {
  // Прямая просьба владельца: значок открывает нужное сразу, без промежуточного
  // окна.
  const def = MENU.filter((i) => i.default === true);

  assert.equal(def.length, 1, 'пункт по умолчанию должен быть ровно один');
  assert.equal(def[0].id, 'crm');
});

test('у каждого пункта есть подпись', () => {
  for (const item of MENU.filter((i) => !i.separator)) {
    assert.equal(typeof item.label === 'string' && item.label.trim() !== '', true,
      `${item.id}: нет подписи`);
  }
});

test('идентификаторы пунктов не повторяются', () => {
  // Повтор означал бы, что два разных действия делят одно имя, и меню в трее
  // выполнило бы не то, что подписано.
  const ids = MENU.filter((i) => !i.separator).map((i) => i.id);

  assert.equal(new Set(ids).size, ids.length);
});

// ── доступность ──────────────────────────────────────────────────────────────

test('при остановленном сервисе пункты работы с окнами недоступны', () => {
  // Нажатие «Журнал буфера» без сервиса открыло бы страницу с ошибкой связи.
  // Лучше сказать заранее, чем показать сломанное окно.
  const root = tempRoot();
  try {
    const byId = Object.fromEntries(menuFor(root).filter((i) => !i.separator).map((i) => [i.id, i]));

    for (const id of ['picker', 'clips', 'settings', 'watch', 'restart', 'stop']) {
      assert.equal(byId[id].disabled, true, `${id}: должен быть недоступен`);
      assert.equal(byId[id].why, 'сервис остановлен', `${id}: причина не названа`);
    }
  } finally { cleanup(root); }
});

test('выход доступен всегда', () => {
  // Иначе мост нельзя закрыть из трея после остановки сервера.
  const root = tempRoot();
  try {
    assert.equal(menuFor(root).find((i) => i.id === 'exit').disabled, false);
  } finally { cleanup(root); }
});

test('недоступный пункт всегда объясняет причину', () => {
  // Серый пункт без объяснения — это загадка, а не интерфейс (RULES §4).
  const root = tempRoot();
  try {
    for (const item of menuFor(root).filter((i) => i.disabled)) {
      assert.equal(typeof item.why === 'string' && item.why !== '', true, `${item.id}: причина пуста`);
    }
  } finally { cleanup(root); }
});

test('при работающем сервисе доступно всё', () => {
  const root = tempRoot();
  try {
    running(root);
    for (const item of menuFor(root).filter((i) => !i.separator)) {
      assert.equal(item.disabled, false, `${item.id}: должен быть доступен`);
    }
  } finally { cleanup(root); }
});

test('пункт паузы меняет подпись по состоянию слежки', () => {
  // Одна кнопка на два действия обязана называть то, что произойдёт, а не то,
  // что происходит сейчас.
  const root = tempRoot();
  try {
    running(root);
    const off = menuFor(root, { paused: false }).find((i) => i.id === 'watch');
    const on = menuFor(root, { paused: true }).find((i) => i.id === 'watch');

    assert.equal(off.label, 'Пауза слежки');
    assert.equal(on.label, 'Продолжить слежку');
  } finally { cleanup(root); }
});

test('разделители остаются на своих местах', () => {
  const root = tempRoot();
  try {
    const menu = menuFor(root);

    assert.equal(menu.length, MENU.length, 'пункты не теряются');
    for (let i = 0; i < MENU.length; i += 1) {
      assert.equal(Boolean(menu[i].separator), Boolean(MENU[i].separator), `позиция ${i}`);
    }
  } finally { cleanup(root); }
});

// ── передача в AHK ───────────────────────────────────────────────────────────

test('строка для AHK разбирается по табуляции', () => {
  // Формат простой намеренно: у AHK нет разбора JSON, а меню меняется редко.
  const root = tempRoot();
  try {
    running(root);
    for (const line of menuScript(root).split('\n')) {
      if (line === '---') continue;
      const cells = line.split('\t');
      assert.equal(cells.length, 3, `«${line}»: ожидалось три поля`);
      assert.match(cells[2], /^[01]$/, `«${line}»: доступность не 0 и не 1`);
    }
  } finally { cleanup(root); }
});

test('в подписях нет табуляции и переводов строк', () => {
  // Иначе разбор по табуляции развалится, и меню в трее окажется мусором.
  for (const item of MENU.filter((i) => !i.separator)) {
    assert.equal(item.label.includes('\t'), false, `${item.id}: табуляция в подписи`);
    assert.equal(item.label.includes('\n'), false, `${item.id}: перевод строки в подписи`);
  }
});

test('недоступность доезжает до AHK', () => {
  // Если флаг потеряется, трей покажет доступные пункты при мёртвом сервисе.
  const root = tempRoot();
  try {
    const text = menuScript(root);

    assert.match(text, /picker\t[^\t]+\t0/, 'при остановленном сервисе выбор недоступен');
    assert.match(text, /exit\t[^\t]+\t1/, 'выход доступен');
  } finally { cleanup(root); }
});
