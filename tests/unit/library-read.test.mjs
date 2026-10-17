// tests/unit/library-read.test.mjs — чтение библиотеки промптов.
//
// Требование: REQ-LIB-READ (docs/SPEC.md §3). Сценарий S-01.
//
// Проверяется главное свойство чтения: оно никогда не выбрасывает. Библиотека —
// это папка, в которую человек пишет руками, и любой файл может оказаться любым.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tempRoot, cleanup, promptFile, rawFile, library } from '../helpers/harness.mjs';
import { listPromptFiles, readPromptFile, readLibrary, usableItems } from '../../library/index.mjs';

test('собирает .md рекурсивно, пропуская README и служебные папки', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-one');
    promptFile(root, 'core', 'x-one');
    rawFile(root, 'code', 'README.md', '# описание группы');
    rawFile(root, '_bench', 'b.md', 'служебное');
    rawFile(root, 'archive', 'a.md', 'архив');
    rawFile(root, 'code', 'notes.txt', 'не промпт');

    const files = await listPromptFiles(root);

    assert.equal(files.length, 2, `нашлось: ${files.join(', ')}`);
    assert.equal(files.some((f) => f.includes('README')), false);
    assert.equal(files.some((f) => f.includes('_bench')), false);
  } finally {
    cleanup(root);
  }
});

test('отсутствующая папка даёт пустой список, а не исключение', async () => {
  const files = await listPromptFiles(join(tempRoot(), 'нет-такой-папки'));
  assert.deepEqual(files, []);
});

test('пустая библиотека — это состояние «нет данных», а не сбой', async () => {
  const root = tempRoot();
  try {
    const lib = await readLibrary(root);
    assert.equal(lib.stats.total, 0);
    assert.deepEqual(lib.items, []);
    assert.deepEqual(lib.groups, []);
  } finally {
    cleanup(root);
  }
});

test('группа берётся из папки, id из имени файла', async () => {
  const root = tempRoot();
  try {
    const file = promptFile(root, 'research', 'r-deep');
    const item = await readPromptFile(root, file);

    assert.equal(item.group, 'research');
    assert.equal(item.id, 'r-deep');
    assert.equal(item.path, 'research/r-deep.md');
  } finally {
    cleanup(root);
  }
});

test('нечитаемый файл становится записью с причиной, а не исчезает', async () => {
  const root = tempRoot();
  try {
    const item = await readPromptFile(root, join(root, 'code', 'нет-файла.md'));

    assert.equal(item.state, 'bad');
    assert.equal(item.issues[0].code, 'read_failed');
    assert.match(item.issues[0].message, /ENOENT|не удалось/);
    assert.equal(item.path, 'code/нет-файла.md', 'путь назван, чтобы файл можно было найти');
  } finally {
    cleanup(root);
  }
});

test('битый frontmatter не роняет чтение: ошибка становится issue', async () => {
  const root = tempRoot();
  try {
    const file = rawFile(root, 'code', 'c-bad.md', '---\nid: "a"\n  сдвинуто: 1\n---\nтело\n');
    const item = await readPromptFile(root, file);

    assert.equal(item.state, 'bad');
    assert.ok(item.issues.some((i) => i.code.startsWith('yaml_')), JSON.stringify(item.issues));
  } finally {
    cleanup(root);
  }
});

test('REQ-LIB-ISOLATE: один битый файл не выводит из строя остальные', async () => {
  const root = tempRoot();
  try {
    library(root, [
      { group: 'code', id: 'c-one' },
      { group: 'code', id: 'c-two' },
      { group: 'code', id: 'c-three' },
      { group: 'code', id: 'c-four' },
    ]);
    rawFile(root, 'code', 'c-broken.md', 'ни frontmatter, ни смысла');

    const lib = await readLibrary(root);

    assert.equal(lib.stats.total, 5);
    assert.equal(lib.stats.bad, 1, 'сломан ровно один');
    assert.equal(lib.stats.good, 4, 'остальные четыре работают');
    assert.equal(usableItems(lib.items).length, 4);
  } finally {
    cleanup(root);
  }
});

test('пустой файл ломает только себя — прежде это убивало все 26 триггеров', async () => {
  const root = tempRoot();
  try {
    library(root, [{ group: 'code', id: 'c-ok' }, { group: 'core', id: 'x-ok' }]);
    rawFile(root, 'code', 'c-empty.md', '');

    const lib = await readLibrary(root);
    assert.equal(lib.stats.good, 2);
    assert.equal(lib.stats.bad, 1);
  } finally {
    cleanup(root);
  }
});

test('дубликат id помечает оба файла и называет второй', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-dup');
    promptFile(root, 'inbox', 'c-dup');

    const lib = await readLibrary(root);
    const both = lib.items.filter((i) => i.id === 'c-dup');

    assert.equal(both.length, 2);
    for (const item of both) {
      assert.equal(item.state, 'bad');
      const dup = item.issues.find((i) => i.code === 'V-P-2');
      assert.ok(dup, `нет V-P-2 в ${item.path}`);
      assert.ok(dup.message.includes('.md'), 'в сообщении должен быть путь другого файла');
    }
  } finally {
    cleanup(root);
  }
});

test('статистика считает группы и закреплённые', async () => {
  const root = tempRoot();
  try {
    library(root, [
      { group: 'code', id: 'c-one', pin: 1 },
      { group: 'code', id: 'c-two' },
      { group: 'core', id: 'x-one', pin: 2 },
      { group: 'core', id: 'x-arch', pin: 3, status: 'archived' },
    ]);

    const lib = await readLibrary(root);

    assert.equal(lib.stats.total, 4);
    assert.equal(lib.stats.pinned, 2, 'архивный закреплённый не считается');
    assert.deepEqual(lib.groups.map((g) => g.name), ['code', 'core']);
    assert.deepEqual(lib.groups.map((g) => g.count), [2, 2]);
  } finally {
    cleanup(root);
  }
});

test('HTML в теле чистится при чтении и это отмечено', async () => {
  const root = tempRoot();
  try {
    const file = rawFile(root, 'code', 'c-html.md',
      '---\nid: "c-html"\ntitle: "Из Google Docs"\ngroup: "code"\n---\n<p>Текст промпта.</p>\n');
    const item = await readPromptFile(root, file);

    assert.equal(item.body, 'Текст промпта.');
    assert.ok(item.cleaned.includes('html'), 'изменение должно быть названо');
  } finally {
    cleanup(root);
  }
});

// Очистка идёт ДО валидации, поэтому валидатор видит текст без тегов и правило
// V-P-10 по тексту не срабатывает. Без передачи факта очистки предупреждение
// было недостижимо на этом пути: человек не узнавал, что файл чинится при
// каждом чтении. Найдено E2E-тестом состояний.
test('очищенный HTML остаётся предупреждением: файл всё ещё с разметкой', async () => {
  const root = tempRoot();
  try {
    const file = rawFile(root, 'code', 'c-html.md',
      '---\nid: "c-html"\ntitle: "Из Google Docs"\ngroup: "code"\n---\n<p>Текст промпта.</p>\n');
    const item = await readPromptFile(root, file);

    assert.equal(item.state, 'warn', 'состояние обязано отражать порчу файла');
    const issue = item.issues.find((i) => i.code === 'V-P-10');
    assert.ok(issue, `V-P-10 не выставлено: ${JSON.stringify(item.issues)}`);
    assert.equal(issue.level, 'warn', 'промпт рабочий: блокировать нельзя');
    assert.match(issue.message, /в файле остался HTML/);
  } finally {
    cleanup(root);
  }
});

test('чистый файл после очистки краёв остаётся good', async () => {
  const root = tempRoot();
  try {
    const file = rawFile(root, 'code', 'c-pad.md',
      '---\nid: "c-pad"\ntitle: "С пустыми строками"\ngroup: "code"\n---\n\n\nТекст промпта.\n\n\n');
    const item = await readPromptFile(root, file);

    assert.equal(item.state, 'good', JSON.stringify(item.issues));
    assert.equal(item.body, 'Текст промпта.');
  } finally {
    cleanup(root);
  }
});

test('usableItems исключает битые и архивные', async () => {
  const root = tempRoot();
  try {
    library(root, [
      { group: 'code', id: 'c-ok' },
      { group: 'code', id: 'c-arch', status: 'archived' },
    ]);
    rawFile(root, 'code', 'c-bad.md', 'мусор');

    const lib = await readLibrary(root);
    const usable = usableItems(lib.items);

    assert.deepEqual(usable.map((i) => i.id), ['c-ok']);
  } finally {
    cleanup(root);
  }
});

test('файл в корне библиотеки, без группы, попадает в inbox', async () => {
  const root = tempRoot();
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'loose.md'), '---\nid: "loose"\ntitle: "Без группы"\n---\nтело\n', 'utf8');

    const lib = await readLibrary(root);
    assert.equal(lib.items[0].group, 'inbox');
  } finally {
    cleanup(root);
  }
});
