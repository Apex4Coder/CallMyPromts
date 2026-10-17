// tests/unit/library-broken.test.mjs — работа с испорченными файлами промптов.
//
// Требование: REQ-LIB-SAFE (docs/SPEC.md §3). Сценарий: S-10, плохие пути.
// Отделено от tests/unit/library-safe.test.mjs по размеру чанка (docs/RULES.md §3).
//
// Тема файла: что делает запись, когда frontmatter существующего файла не читается.
// Три возможных ответа, и выбран третий:
//   1) упасть с исключением — теряется контекст, операция не объяснена;
//   2) перезаписать молча — теряются used, created, pin;
//   3) отказать с указанием строки и потребовать подтверждения — выбрано.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  promptPath,
  updatePrompt,
  markUsed,
  readPromptFile,
} from '../../library/index.mjs';

import { tempRoot, cleanup } from '../helpers/harness.mjs';

/** Файл с заведомо испорченным frontmatter: строка 3 без двоеточия. */
const brokenFile = (root, id, extra = '') => {
  mkdirSync(join(root, 'code'), { recursive: true });
  const file = promptPath(root, 'code', id);
  writeFileSync(file, `---\nid: "${id}"\n${extra}title "нет двоеточия"\n---\n\nтело\n`, 'utf8');
  return file;
};

test('битый frontmatter не роняет операцию, а объясняет причину', async () => {
  // Прежняя версия бросала здесь ContractError, и правка одного испорченного
  // файла валила вызов целиком вместо того, чтобы назвать строку с ошибкой.
  const root = tempRoot();
  try {
    const file = brokenFile(root, 'c-broken');

    const out = await updatePrompt(root, 'c-broken', 'code', { title: 'Починено', body: 'Тело.' });

    assert.equal(out.ok, false);
    assert.equal(out.broken, true);
    assert.equal(out.issues[0].code, 'yaml_no_colon');
    assert.equal(out.issues[0].line, 3, 'номер строки обязателен: иначе искать наугад');
    assert.equal(out.issues[1].code, 'needs_force', 'перезапись битого файла требует подтверждения');
    assert.match(readFileSync(file, 'utf8'), /нет двоеточия/, 'без подтверждения файл не тронут');
  } finally { cleanup(root); }
});

test('в отказе названо, что именно будет потеряно', async () => {
  // «Не могу записать» без цены решения заставляет угадывать. Человек должен
  // знать, что подтверждение стоит счётчика и даты создания.
  const root = tempRoot();
  try {
    brokenFile(root, 'c-broken');

    const out = await updatePrompt(root, 'c-broken', 'code', { body: 'Тело.' });

    assert.match(out.issues[1].message, /счётчик использований/);
    assert.match(out.issues[1].message, /дату создания/);
  } finally { cleanup(root); }
});

test('с подтверждением битый файл перезаписывается и становится читаемым', async () => {
  const root = tempRoot();
  try {
    const file = brokenFile(root, 'c-broken', 'used: 99\n');

    const out = await updatePrompt(
      root, 'c-broken', 'code',
      { title: 'Починено', body: 'Восстановленное тело.' },
      { force: true },
    );

    assert.equal(out.ok, true, JSON.stringify(out.issues));
    assert.equal(out.recovered, true, 'вызывающий должен знать, что файл был битым');

    const item = await readPromptFile(root, file);
    assert.equal(item.state, 'good', JSON.stringify(item.issues));
    assert.equal(item.title, 'Починено');
    assert.equal(item.body, 'Восстановленное тело.');
    assert.equal(item.used, 0, 'мусорные служебные поля не переносятся');
  } finally { cleanup(root); }
});

test('подтверждение без тела не проходит: испорченный frontmatter ушёл бы в текст', async () => {
  // При нечитаемом frontmatter парсер не может отделить метаданные от тела, и
  // «сохранить как есть» означало бы записать строки `id:` внутрь промпта.
  const root = tempRoot();
  try {
    brokenFile(root, 'c-broken');

    const out = await updatePrompt(root, 'c-broken', 'code', { title: 'Починено' }, { force: true });

    assert.equal(out.ok, false);
    assert.equal(out.issues[1].code, 'body_required');
    assert.equal(out.issues[1].field, 'body');
  } finally { cleanup(root); }
});

test('markUsed на битом файле отказывает, а не перезаписывает', async () => {
  // Битый промпт не вставляется, значит и считать нечего. Перезапись потеряла бы
  // метаданные ради счётчика — цена несоразмерна выгоде.
  const root = tempRoot();
  try {
    const file = brokenFile(root, 'c-broken');
    const before = readFileSync(file, 'utf8');

    const out = await markUsed(root, 'c-broken', 'code');

    assert.equal(out.ok, false);
    assert.equal(out.issues[0].code, 'yaml_no_colon');
    assert.equal(readFileSync(file, 'utf8'), before, 'файл побайтово тот же');
  } finally { cleanup(root); }
});

test('вложенность во frontmatter объяснена как таковая', async () => {
  // Парсер понимает только плоское подмножество (docs/DATA-CONTRACTS.md §7).
  // Отступ — частая ошибка при ручной правке, и причина должна быть точной.
  const root = tempRoot();
  try {
    mkdirSync(join(root, 'code'), { recursive: true });
    const file = promptPath(root, 'code', 'c-nested');
    writeFileSync(file, '---\nid: "c-nested"\nmeta:\n  key: 1\n---\n\nтело\n', 'utf8');

    const out = await updatePrompt(root, 'c-nested', 'code', { body: 'Тело.' });

    assert.equal(out.ok, false);
    assert.equal(out.issues[0].code, 'yaml_indent');
    assert.equal(out.issues[0].line, 4);
  } finally { cleanup(root); }
});

test('отсутствие frontmatter — не порча: запись идёт с нуля', async () => {
  // Файл без метаданных читается как заметка: тело есть, метаданных нет.
  // Это отличается от порчи и не требует подтверждения.
  const root = tempRoot();
  try {
    mkdirSync(join(root, 'code'), { recursive: true });
    const file = promptPath(root, 'code', 'c-plain');
    writeFileSync(file, 'Просто текст без метаданных.\n', 'utf8');

    const out = await updatePrompt(root, 'c-plain', 'code', { title: 'Заметка' });

    assert.equal(out.ok, true, JSON.stringify(out.issues));

    const item = await readPromptFile(root, file);
    assert.equal(item.state, 'good', JSON.stringify(item.issues));
    assert.equal(item.title, 'Заметка');
    assert.equal(item.body, 'Просто текст без метаданных.', 'тело сохранено как было');
  } finally { cleanup(root); }
});

test('битый файл читается как запись с состоянием bad, а не пропускается', async () => {
  // REQ-LIB-ISOLATE: он должен быть виден в диагностике с причиной.
  const root = tempRoot();
  try {
    const file = brokenFile(root, 'c-broken');

    const item = await readPromptFile(root, file);

    assert.equal(item.state, 'bad');
    assert.equal(item.issues[0].code, 'yaml_no_colon');
    assert.equal(item.path, 'code/c-broken.md', 'путь нужен, чтобы файл можно было открыть');
  } finally { cleanup(root); }
});
