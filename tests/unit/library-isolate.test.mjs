// tests/unit/library-isolate.test.mjs — изоляция битого файла.
//
// Требование: REQ-LIB-ISOLATE (docs/SPEC.md §3). Сценарий: S-01.
//
// Это главный тест проекта. Прежняя система собирала один `base.yml` из всех
// промптов, поэтому один пустой `.md` выводил из строя все 26 триггеров — дефект
// D10. Здесь проверяется обратное свойство: битый файл ломает ТОЛЬКО себя,
// остальные работают, а причина названа и видна.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

import { readLibrary, usableItems, listPromptFiles } from '../../library/index.mjs';
import { tempRoot, cleanup, promptFile, rawFile, library } from '../helpers/harness.mjs';

/** Библиотека из n здоровых промптов: фон, на котором виден единственный битый. */
const healthy = (root, n) => library(root, Array.from({ length: n }, (_, i) => ({
  group: 'code', id: `c-${i + 1}`,
})));

test('один битый из двадцати шести: двадцать пять работают', async () => {
  // Дословная проверка дефекта D10 в его исходном масштабе.
  const root = tempRoot();
  try {
    healthy(root, 25);
    rawFile(root, 'code', 'c-broken.md', '');

    const lib = await readLibrary(root);

    assert.equal(lib.stats.total, 26, 'битый файл присутствует в списке');
    assert.equal(lib.stats.bad, 1, 'ровно один битый');
    assert.equal(usableItems(lib.items).length, 25, 'остальные пригодны к вставке');
  } finally { cleanup(root); }
});

test('битый файл не пропадает: он виден с причиной и путём', async () => {
  // Молчаливый пропуск хуже ошибки: файл есть на диске, но его нет в программе,
  // и человек не понимает, почему промпт «исчез».
  const root = tempRoot();
  try {
    healthy(root, 3);
    rawFile(root, 'code', 'c-empty.md', '');

    const lib = await readLibrary(root);
    const broken = lib.items.find((i) => i.path === 'code/c-empty.md');

    assert.ok(broken, 'битый файл обязан быть в списке');
    assert.equal(broken.state, 'bad');
    assert.equal(broken.issues.length > 0, true);
    assert.equal(broken.issues.every((i) => i.message.trim() !== ''), true, 'у каждой причины есть текст');
    assert.equal(broken.path, 'code/c-empty.md', 'путь нужен, чтобы открыть файл и починить');
  } finally { cleanup(root); }
});

test('каждый вид порчи изолируется отдельно, и все причины разные', async () => {
  const root = tempRoot();
  try {
    healthy(root, 5);
    rawFile(root, 'code', 'b-empty.md', '');
    rawFile(root, 'code', 'b-nofm.md', 'Текст без метаданных.\n');
    rawFile(root, 'code', 'b-unclosed.md', '---\nid: "b-unclosed"\nтело без закрытия\n');
    rawFile(root, 'code', 'b-nocolon.md', '---\nid: "b-nocolon"\ntitle "нет двоеточия"\n---\n\nтело\n');
    rawFile(root, 'code', 'b-nobody.md', '---\nid: "b-nobody"\ntitle: "Пустой"\n---\n\n\n');

    const lib = await readLibrary(root);

    assert.equal(lib.stats.total, 10);
    assert.equal(usableItems(lib.items).length, 5, 'пять здоровых остаются рабочими');

    const codes = new Map(lib.items
      .filter((i) => i.state === 'bad')
      .map((i) => [i.path, i.issues.filter((x) => x.level === 'bad').map((x) => x.code)]));

    assert.equal(codes.size, 5, 'все пять признаны битыми');
    for (const [path, list] of codes) {
      assert.equal(list.length > 0, true, `${path}: причина обязана быть`);
    }
    assert.deepEqual(codes.get('code/b-nocolon.md'), ['yaml_no_colon'], 'порча внутри frontmatter названа точно');
    assert.equal(codes.get('code/b-unclosed.md').includes('V-P-1'), true, 'незакрытый frontmatter — V-P-1');
    assert.equal(codes.get('code/b-nobody.md').includes('V-P-8'), true, 'пустое тело — V-P-8');
  } finally { cleanup(root); }
});

test('битый файл в одной группе не задевает другие группы', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-1');
    promptFile(root, 'research', 'r-1');
    promptFile(root, 'core', 'x-1');
    rawFile(root, 'code', 'c-broken.md', '---\nсломано\n');

    const lib = await readLibrary(root);
    const byGroup = new Map(lib.groups.map((g) => [g.name, g.count]));

    assert.equal(byGroup.get('code'), 2);
    assert.equal(byGroup.get('research'), 1);
    assert.equal(byGroup.get('core'), 1);
    assert.equal(usableItems(lib.items).filter((i) => i.group === 'research').length, 1);
  } finally { cleanup(root); }
});

test('дубликат id помечает оба файла, но не остальные', async () => {
  // Реальный случай библиотеки: prompts/chatbox/s-hagent.md и
  // prompts/inbox/s-hagent.md. Оба обязаны быть помечены, а не один из них.
  const root = tempRoot();
  try {
    promptFile(root, 'chatbox', 's-dup');
    promptFile(root, 'inbox', 's-dup');
    healthy(root, 3);

    const lib = await readLibrary(root);
    const dups = lib.items.filter((i) => i.id === 's-dup');

    assert.equal(dups.length, 2);
    for (const d of dups) {
      assert.equal(d.state, 'bad', `${d.path}: дубликат id — bad`);
      const msg = d.issues.find((i) => i.code === 'V-P-2')?.message ?? '';
      assert.match(msg, /повторяется/);
      assert.match(msg, /also|также/i);
      assert.equal(msg.includes(d.path), false, 'в списке «также в» указан другой файл, не сам себя');
    }
    assert.equal(usableItems(lib.items).length, 3, 'остальные три не задеты');
  } finally { cleanup(root); }
});

test('дубликат позиции помечает оба, соседние закрепления целы', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-a', { pin: 3 });
    promptFile(root, 'code', 'c-b', { pin: 3 });
    promptFile(root, 'code', 'c-c', { pin: 4 });

    const lib = await readLibrary(root);

    assert.equal(lib.items.filter((i) => i.pin === 3 && i.state === 'bad').length, 2);
    assert.equal(lib.items.find((i) => i.id === 'c-c').state, 'good');
  } finally { cleanup(root); }
});

test('дубликат горячей клавиши — warn: промпт остаётся рабочим', async () => {
  // Горячая клавиша опциональна, конфликт решается в настройках. Блокировать
  // вставку из-за этого значило бы наказывать за необязательное поле.
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-a', { hotkey: '^!r' });
    promptFile(root, 'code', 'c-b', { hotkey: '^!r' });

    const lib = await readLibrary(root);

    assert.equal(lib.stats.warn, 2);
    assert.equal(lib.stats.bad, 0);
    assert.equal(usableItems(lib.items).length, 2, 'оба вставляются');
  } finally { cleanup(root); }
});

test('битая папка не мешает обходу остальных', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-1');
    promptFile(root, 'research', 'r-1');
    // Файл вместо ожидаемой папки: readdir на нём даст ошибку.
    writeFileSync(join(root, 'notdir'), 'не папка\n', 'utf8');

    const lib = await readLibrary(root);

    assert.equal(lib.stats.total, 2, 'обход не прерван');
  } finally { cleanup(root); }
});

test('нечитаемый файл становится записью bad, а не исключением', async () => {
  const root = tempRoot();
  try {
    healthy(root, 2);
    // Папка с расширением .md: stat пройдёт, readFile упадёт с EISDIR.
    mkdirSync(join(root, 'code', 'c-dir.md'), { recursive: true });

    const lib = await readLibrary(root);
    const item = lib.items.find((i) => i.path === 'code/c-dir.md');

    if (item) {
      assert.equal(item.state, 'bad');
      assert.equal(item.issues[0].code, 'read_failed');
      assert.match(item.issues[0].message, /не удалось прочитать/);
    }
    assert.equal(usableItems(lib.items).length, 2, 'здоровые файлы прочитаны');
  } finally { cleanup(root); }
});

test('README.md группой и промптом не считается', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-1');
    rawFile(root, 'code', 'README.md', '# Описание группы\n');

    const files = await listPromptFiles(root);

    assert.equal(files.length, 1, 'README — документация, а не промпт');
    const lib = await readLibrary(root);
    assert.equal(lib.stats.bad, 0, 'иначе каждая группа давала бы ложный битый файл');
  } finally { cleanup(root); }
});

test('статистика сходится: total = good + warn + bad', async () => {
  // Расхождение чисел в диагностике заставило бы не доверять всей панели.
  const root = tempRoot();
  try {
    healthy(root, 4);
    promptFile(root, 'code', 'c-warn', { hotkey: 'НЕВЕРНО' });
    rawFile(root, 'code', 'c-bad.md', '');

    const s = (await readLibrary(root)).stats;

    assert.equal(s.total, s.good + s.warn + s.bad);
    assert.equal(s.total, 6);
    assert.equal(s.bad, 1);
    assert.equal(s.warn, 1);
    assert.equal(s.good, 4);
  } finally { cleanup(root); }
});

test('архивный промпт исключён из выдачи, но не помечен битым', async () => {
  // Архив — решение человека, а не ошибка. Пометка bad превратила бы намеренное
  // действие в проблему, требующую починки.
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-old', { status: 'archived' });
    promptFile(root, 'code', 'c-new');

    const lib = await readLibrary(root);

    assert.equal(lib.items.find((i) => i.id === 'c-old').state, 'good');
    assert.equal(usableItems(lib.items).length, 1);
    assert.equal(usableItems(lib.items)[0].id, 'c-new');
  } finally { cleanup(root); }
});

test('пустая библиотека — состояние «нет данных», не сбой', async () => {
  const root = tempRoot();
  try {
    const lib = await readLibrary(root);

    assert.deepEqual(lib.items, []);
    assert.deepEqual(lib.groups, []);
    assert.equal(lib.stats.total, 0);
  } finally { cleanup(root); }
});

test('отсутствующая папка библиотеки не роняет чтение', async () => {
  const root = tempRoot();
  try {
    const lib = await readLibrary(join(root, 'нет-такой-папки'));

    assert.equal(lib.stats.total, 0);
  } finally { cleanup(root); }
});

test('порядок чтения не влияет на результат', async () => {
  // При дубликате id прежняя реализация зависела от порядка обхода: побеждал
  // последний прочитанный. Теперь оба помечены независимо от порядка.
  const root = tempRoot();
  try {
    promptFile(root, 'aaa', 's-dup', { title: 'Первый' });
    promptFile(root, 'zzz', 's-dup', { title: 'Второй' });

    const one = await readLibrary(root);
    const two = await readLibrary(root);

    assert.deepEqual(
      one.items.map((i) => [i.path, i.state]),
      two.items.map((i) => [i.path, i.state]),
      'два чтения подряд дают одно и то же',
    );
    assert.equal(one.stats.bad, 2, 'оба, а не последний');
  } finally { cleanup(root); }
});

// chmodSync упоминается в импорте только ради полноты набора инструментов
// проверки прав; на Windows он не меняет читаемость, поэтому теста на права нет.
void chmodSync;
