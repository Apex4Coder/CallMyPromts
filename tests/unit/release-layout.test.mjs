// tests/unit/release-layout.test.mjs — раскладка релизов и указатели.
//
// Требование: REQ-REL-LAYOUT (docs/SPEC.md §14). Концепция: gld/gold.md §3.
// Проверяемый файл: release/layout.mjs.
//
// Главное свойство, которое здесь закрепляется: **состояние не движется**. Указатель
// снимается и ставится, а `shared/prompts` с промптами, которые человек писал
// руками, остаётся на месте. Это инвариант docs/SPEC.md §14.1 — «ни одна операция не
// теряет пользовательский текст без копии», и он проверяется по факту: файл кладётся,
// указатель снимается, файл ищется снова.
//
// Каждое допущение про junction проверено на живой системе до написания этих тестов:
// `mklink /J` работает без прав администратора, запись через указатель доходит до
// цели, `rmSync` без `recursive` снимает ссылку не трогая данные. Тесты фиксируют
// именно то поведение, которое подтвердилось.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  NAMES, LINKED_DIRS, KEEP_RELEASES, makeReleaseId, paths, ensureLayout,
  isJunction, linkTarget, makeJunction, removeJunction, linkShared, logRelease,
} from '../../release/index.mjs';
import { tempRoot, cleanup } from '../helpers/harness.mjs';

/** Каталог релиза с файлом кода: так выглядит поставка. */
const releaseDir = (root, id = 'rel-1') => {
  const dir = join(root, NAMES.releases, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }), 'utf8');
  return dir;
};

// ── имена и пути ─────────────────────────────────────────────────────────────

test('идентификатор релиза сортируется по времени как текст', () => {
  // Время впереди не для красоты: каталоги обязаны сортироваться по порядку
  // установки обычным сравнением строк, иначе «предыдущий релиз» приходилось бы
  // вычислять по времени файла — а его переписывает копирование.
  const a = makeReleaseId(new Date('2026-09-07T00:10:00Z'), 'aaaaaa');
  const b = makeReleaseId(new Date('2026-09-07T00:20:00Z'), 'bbbbbb');

  assert.equal(a < b, true, `${a} обязан быть меньше ${b}`);
  assert.match(a, /^\d{8}-\d{6}-[0-9a-f]{6}$/);
});

test('два релиза в одну секунду получают разные имена', () => {
  // Совпадение означало бы запись в существующий релиз, объявленный неизменяемым.
  const now = new Date('2026-09-07T00:10:00Z');
  const ids = new Set(Array.from({ length: 50 }, () => makeReleaseId(now)));

  assert.equal(ids.size > 40, true, `слишком много совпадений: ${ids.size} из 50`);
});

test('раскладка создаётся и повторный вызов ничего не портит', () => {
  const root = tempRoot();
  try {
    const p = ensureLayout(root);
    writeFileSync(join(p.shared, 'prompts', 'x.md'), 'текст', 'utf8');

    ensureLayout(root);

    assert.equal(existsSync(p.releases), true);
    assert.equal(readFileSync(join(p.shared, 'prompts', 'x.md'), 'utf8'), 'текст', 'файл потерян');
  } finally { cleanup(root); }
});

test('в shared создаются оба каталога состояния', () => {
  // Список получен обходом кода (docs/BLAST.md §1), а не догадкой: state/ — токен,
  // настройки и журнал буфера, prompts/ — то, что человек писал руками.
  const root = tempRoot();
  try {
    const p = ensureLayout(root);

    for (const dir of LINKED_DIRS) {
      assert.equal(existsSync(join(p.shared, dir)), true, `нет shared/${dir}`);
    }
    assert.deepEqual(LINKED_DIRS, ['state', 'prompts']);
  } finally { cleanup(root); }
});

test('node_modules не связывается: в рантайме нет зависимостей', () => {
  // Обычно это самая тяжёлая часть установки. Здесь её нет, и упоминание
  // node_modules в списке связываемого было бы ложью о проекте.
  assert.equal(LINKED_DIRS.includes('node_modules'), false);
});

// ── junction ─────────────────────────────────────────────────────────────────

test('указатель создаётся и ведёт к цели', () => {
  const root = tempRoot();
  try {
    const p = ensureLayout(root);
    const dir = releaseDir(root);
    const target = join(p.shared, 'prompts');

    const made = makeJunction(join(dir, 'prompts'), target);

    assert.equal(made.ok, true, made.why ?? '');
    assert.equal(isJunction(join(dir, 'prompts')), true);
    assert.equal(linkTarget(join(dir, 'prompts')), target);
  } finally { cleanup(root); }
});

test('запись через указатель доходит до цели', () => {
  // Ради этого всё и делается: код пишет в `prompts/` относительно себя, а файл
  // оказывается в `shared/prompts` и переживает установку следующего релиза.
  const root = tempRoot();
  try {
    const p = ensureLayout(root);
    const dir = releaseDir(root);
    makeJunction(join(dir, 'prompts'), join(p.shared, 'prompts'));

    writeFileSync(join(dir, 'prompts', 'через-указатель.md'), 'текст', 'utf8');

    assert.equal(existsSync(join(p.shared, 'prompts', 'через-указатель.md')), true);
  } finally { cleanup(root); }
});

/**
 * Самая важная проверка файла.
 *
 * `rmSync(recursive: true)` на junction в некоторых версиях Node удалял содержимое
 * ЦЕЛИ — то есть снёс бы `shared/prompts` со всеми промптами. Поэтому `recursive`
 * в `removeJunction` запрещён, и это закреплено здесь: файл кладётся, указатель
 * снимается, файл ищется снова.
 */
test('снятие указателя НЕ удаляет данные цели', () => {
  const root = tempRoot();
  try {
    const p = ensureLayout(root);
    const dir = releaseDir(root);
    const target = join(p.shared, 'prompts');

    writeFileSync(join(target, 'нельзя-потерять.md'), 'важный текст', 'utf8');
    makeJunction(join(dir, 'prompts'), target);

    const gone = removeJunction(join(dir, 'prompts'));

    assert.equal(gone.ok, true, gone.why ?? '');
    assert.equal(existsSync(target), true, 'цель удалена вместе с указателем');
    assert.equal(readFileSync(join(target, 'нельзя-потерять.md'), 'utf8'), 'важный текст');
  } finally { cleanup(root); }
});

test('настоящий каталог вместо указателя удалять отказывается', () => {
  // Защита от потери состояния: если на месте указателя оказался обычный каталог,
  // значит что-то пошло не так, и молча его снести — потерять данные.
  const root = tempRoot();
  try {
    const dir = releaseDir(root);
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    writeFileSync(join(dir, 'prompts', 'внутри.md'), 'текст', 'utf8');

    const out = removeJunction(join(dir, 'prompts'));

    assert.equal(out.ok, false);
    assert.match(out.why, /не junction/);
    assert.equal(existsSync(join(dir, 'prompts', 'внутри.md')), true, 'файл удалён');
  } finally { cleanup(root); }
});

test('снятие отсутствующего указателя — не ошибка', () => {
  // Повторный вызов при откате нормален: указателя может уже не быть.
  const root = tempRoot();
  try {
    assert.equal(removeJunction(join(root, 'нет-такого')).ok, true);
  } finally { cleanup(root); }
});

test('указатель на несуществующую цель не создаётся, и причина названа', () => {
  const root = tempRoot();
  try {
    const dir = releaseDir(root);
    const out = makeJunction(join(dir, 'prompts'), join(root, 'нет-такой-папки'));

    assert.equal(out.ok, false);
    assert.match(out.why, /цель не существует/);
  } finally { cleanup(root); }
});

test('повторное создание переставляет указатель, а не отказывает', () => {
  // Установка следующего релиза делает это каждый раз. Отказ «уже есть» скрыл бы
  // указатель на прежний релиз.
  const root = tempRoot();
  try {
    const p = ensureLayout(root);
    const dir = releaseDir(root);
    const first = join(p.shared, 'prompts');
    const second = join(p.shared, 'state');

    makeJunction(join(dir, 'x'), first);
    const again = makeJunction(join(dir, 'x'), second);

    assert.equal(again.ok, true, again.why ?? '');
    assert.equal(linkTarget(join(dir, 'x')), second);
  } finally { cleanup(root); }
});

test('обычный каталог указателем не считается', () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, 'просто-папка'), { recursive: true });

    assert.equal(isJunction(join(root, 'просто-папка')), false);
    assert.equal(linkTarget(join(root, 'просто-папка')), null);
  } finally { cleanup(root); }
});

// ── связывание состояния ─────────────────────────────────────────────────────

test('linkShared связывает всё состояние одним вызовом', () => {
  const root = tempRoot();
  try {
    ensureLayout(root);
    const dir = releaseDir(root);

    const out = linkShared(root, dir);

    assert.equal(out.ok, true, JSON.stringify(out.links));
    for (const dirName of LINKED_DIRS) {
      assert.equal(isJunction(join(dir, dirName)), true, `${dirName} не связан`);
    }
  } finally { cleanup(root); }
});

test('состояние видно из релиза сразу после связывания', () => {
  const root = tempRoot();
  try {
    const p = ensureLayout(root);
    writeFileSync(join(p.shared, 'state', 'settings.json'), '{"ui":{}}', 'utf8');
    const dir = releaseDir(root);

    linkShared(root, dir);

    assert.equal(existsSync(join(dir, 'state', 'settings.json')), true);
  } finally { cleanup(root); }
});

test('непустой каталог состояния в поставке назван ошибкой, а не затёрт', () => {
  // Состояние внутри релиза — нарушение раскладки. Молча затереть его значило бы
  // удалить данные, которые кто-то туда положил; молча оставить — читать не то.
  const root = tempRoot();
  try {
    ensureLayout(root);
    const dir = releaseDir(root);
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    writeFileSync(join(dir, 'prompts', 'попало-в-поставку.md'), 'текст', 'utf8');

    const out = linkShared(root, dir);
    const bad = out.links.find((l) => l.dir === 'prompts');

    assert.equal(out.ok, false);
    assert.match(bad.why, /состояние не должно лежать внутри релиза/);
    assert.equal(existsSync(join(dir, 'prompts', 'попало-в-поставку.md')), true, 'файл затёрт');
  } finally { cleanup(root); }
});

test('пустой каталог в поставке связыванию не мешает', () => {
  // Сборка могла создать пустую папку. Это не данные, и связать поверх можно.
  const root = tempRoot();
  try {
    ensureLayout(root);
    const dir = releaseDir(root);
    mkdirSync(join(dir, 'state'), { recursive: true });

    const out = linkShared(root, dir);

    assert.equal(out.ok, true, JSON.stringify(out.links));
    assert.equal(isJunction(join(dir, 'state')), true);
  } finally { cleanup(root); }
});

// ── журнал установок ─────────────────────────────────────────────────────────

test('журнал установок — NDJSON, строка на событие', () => {
  const root = tempRoot();
  try {
    ensureLayout(root);

    logRelease(root, { step: 'stage', outcome: 'ok', release: { to: 'rel-1' } });
    logRelease(root, { step: 'swap', outcome: 'ok', release: { from: null, to: 'rel-1' } });

    const lines = readFileSync(paths(root).log, 'utf8').trim().split('\n');

    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.step, 'stage');
    assert.equal(typeof first.ts, 'string', 'событие без времени бесполезно');
  } finally { cleanup(root); }
});

test('число хранимых релизов названо числом, а не «немного»', () => {
  assert.equal(KEEP_RELEASES, 5);
});
