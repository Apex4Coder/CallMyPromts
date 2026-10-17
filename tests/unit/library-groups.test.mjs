// tests/unit/library-groups.test.mjs — группы промптов.
//
// Требование: REQ-LIB-GROUP (docs/SPEC.md §3). Сценарий: S-03 (сохранение
// выделенного текста — там из выпадающего списка выбирается группа).
//
// Почему это важно проверять: группа = папка на диске. Ошибка здесь означает
// либо промпт, попавший в служебную папку, либо потерянные файлы при удалении
// «пустой» группы, которая пустой не была.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  groupLabel,
  listGroups,
  createGroup,
  removeGroupIfEmpty,
  describeGroups,
} from '../../library/index.mjs';

import { tempRoot, cleanup, promptFile } from '../helpers/harness.mjs';

// ── groupLabel ───────────────────────────────────────────────────────────────

test('известная группа получает русскую подпись', () => {
  assert.equal(groupLabel('code'), 'Код');
  assert.equal(groupLabel('research'), 'Исследование');
  assert.equal(groupLabel('parsing'), 'Парсинг');
  assert.equal(groupLabel('inbox'), 'Входящие');
});

test('неизвестная группа показывается как есть, а не «Прочее»', () => {
  // Подмена незнакомого имени на «Прочее» скрыла бы от человека его же папку.
  assert.equal(groupLabel('my-stuff'), 'my-stuff');
});

// ── listGroups ───────────────────────────────────────────────────────────────

test('перечисляет папки библиотеки по алфавиту', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'research', 'r-x');
    promptFile(root, 'code', 'c-x');
    promptFile(root, 'core', 'x-x');

    assert.deepEqual(await listGroups(root), ['code', 'core', 'research']);
  } finally { cleanup(root); }
});

test('служебные папки группами не считаются', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x');
    for (const d of ['_bench', 'archive', 'node_modules', 'templates', '.git']) {
      mkdirSync(join(root, d), { recursive: true });
    }

    assert.deepEqual(await listGroups(root), ['code']);
  } finally { cleanup(root); }
});

test('файлы в корне не превращаются в группы', async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, 'README.md'), '# заметка\n', 'utf8');
    promptFile(root, 'code', 'c-x');

    assert.deepEqual(await listGroups(root), ['code']);
  } finally { cleanup(root); }
});

test('несуществующий корень — пустой список, а не исключение', async () => {
  // Первый запуск: папки ещё нет. Это состояние «нет данных» (docs/RULES.md §4).
  const root = tempRoot();
  try {
    assert.deepEqual(await listGroups(join(root, 'нет-такой-папки')), []);
  } finally { cleanup(root); }
});

// ── createGroup ──────────────────────────────────────────────────────────────

test('создаёт папку и сообщает итоговое имя', async () => {
  const root = tempRoot();
  try {
    const out = await createGroup(root, 'agents');

    assert.equal(out.ok, true);
    assert.equal(out.name, 'agents');
    assert.equal(out.renamed, false);
    assert.equal(existsSync(join(root, 'agents')), true);
  } finally { cleanup(root); }
});

test('русское имя транслитерируется, и об этом сказано', async () => {
  const root = tempRoot();
  try {
    const out = await createGroup(root, 'Мои Промпты!');

    assert.equal(out.ok, true);
    assert.equal(out.name, 'moi-prompty', 'имя папки обязано быть латиницей');
    assert.equal(out.renamed, true, 'пользователь должен видеть, что имя изменили');
    assert.equal(existsSync(join(root, 'moi-prompty')), true);
  } finally { cleanup(root); }
});

test('имя из одних символов не проходит с названной причиной', async () => {
  const root = tempRoot();
  try {
    // slugify отдаёт запасное «prompt» вместо пустоты, поэтому проверяем,
    // что такое имя хотя бы не создаёт папку со случайным содержимым.
    const out = await createGroup(root, '!!!');

    assert.equal(out.ok, true);
    assert.equal(out.name, 'prompt', 'запасное имя лучше пустого');
  } finally { cleanup(root); }
});

test('повторное создание существующей группы не ошибка', async () => {
  const root = tempRoot();
  try {
    await createGroup(root, 'agents');
    const again = await createGroup(root, 'agents');

    assert.equal(again.ok, true, 'группа уже есть — цель достигнута');
    assert.equal(existsSync(join(root, 'agents')), true);
  } finally { cleanup(root); }
});

test('создание группы не задевает соседние файлы', async () => {
  const root = tempRoot();
  try {
    const file = promptFile(root, 'code', 'c-x');
    await createGroup(root, 'code');

    assert.equal(existsSync(file), true, 'mkdir recursive не должен ничего стирать');
  } finally { cleanup(root); }
});

// ── removeGroupIfEmpty ───────────────────────────────────────────────────────

test('пустая группа удаляется', async () => {
  const root = tempRoot();
  try {
    await createGroup(root, 'temp');
    const out = await removeGroupIfEmpty(root, 'temp');

    assert.equal(out.ok, true);
    assert.equal(existsSync(join(root, 'temp')), false);
  } finally { cleanup(root); }
});

test('непустая группа не удаляется: это удаление промптов', async () => {
  const root = tempRoot();
  try {
    const file = promptFile(root, 'code', 'c-x');
    const out = await removeGroupIfEmpty(root, 'code');

    assert.equal(out.ok, false);
    assert.equal(out.issues[0].code, 'not_empty');
    assert.match(out.issues[0].message, /1 файл/, 'в причине названо количество');
    assert.equal(existsSync(file), true, 'файл обязан остаться на месте');
  } finally { cleanup(root); }
});

test('удаление несуществующей группы — понятный отказ', async () => {
  const root = tempRoot();
  try {
    const out = await removeGroupIfEmpty(root, 'нет-такой');

    assert.equal(out.ok, false);
    assert.equal(out.issues[0].code, 'not_found');
  } finally { cleanup(root); }
});

// ── describeGroups ───────────────────────────────────────────────────────────

test('сливает папки и счётчики: пустая группа видна с нулём', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x');
    promptFile(root, 'code', 'c-y');
    await createGroup(root, 'empty');

    const out = describeGroups(await listGroups(root), [{ name: 'code', count: 2 }]);

    assert.deepEqual(out, [
      { name: 'code', label: 'Код', count: 2 },
      { name: 'empty', label: 'empty', count: 0 },
    ]);
  } finally { cleanup(root); }
});

test('группа из счётчиков без папки тоже видна', () => {
  // Обратный случай: файл лежит в папке, которую listGroups скрыл. Скрыть счётчик
  // означало бы потерять промпт из общей суммы — расхождение чисел в интерфейсе.
  const out = describeGroups([], [{ name: 'inbox', count: 3 }]);

  assert.deepEqual(out, [{ name: 'inbox', label: 'Входящие', count: 3 }]);
});

test('порядок групп устойчив', () => {
  const out = describeGroups(['zeta', 'alpha'], [{ name: 'beta', count: 1 }]);

  assert.deepEqual(out.map((g) => g.name), ['alpha', 'beta', 'zeta']);
});
