// tests/unit/migrate.test.mjs — миграция библиотеки: чтение источников и отчёт.
//
// Требование: REQ-MIG-REPORT (docs/SPEC.md §11). Сценарий S-11.
// Проверяемые файлы: legacy/sources.mjs, legacy/plan.mjs, legacy/migrate.mjs.
// Исполнение и сверка — в tests/unit/migrate-apply.test.mjs,
// перенос клипов — в tests/unit/migrate-clips.test.mjs.
//
// Миграция — единственная операция во всём приложении, которая сводит три версии
// одного текста в одну. Ошибка здесь стоит дороже любой другой: потерянный текст
// не восстановить из интерфейса. Поэтому главное свойство отчёта проверяется
// прямо: он НИЧЕГО не пишет на диск, и каждое решение объяснено словами.
//
// Все проверки на временных папках. Тест, который трогает настоящую библиотеку,
// однажды сотрёт рабочий промпт.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { plan, printable, readSource, parseArgs } from '../../legacy/index.mjs';
import { tempRoot, cleanup } from '../helpers/harness.mjs';
import { oldPrompt as oldFile, bareFile, migRoots as roots } from '../helpers/legacyfix.mjs';

// ── чтение источников ────────────────────────────────────────────────────────

test('источник читается с группами и метаданными', () => {
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'code', 'c-review');
    oldFile(join(root, 'proj'), 'core', 'x-plan');

    const src = readSource(join(root, 'proj'), 'project');

    assert.equal(src.exists, true);
    assert.equal(src.items.length, 2);
    assert.equal(src.items.every((i) => i.broken === false), true);
  } finally { cleanup(root); }
});

test('отсутствующая папка — не ошибка, а «источника нет»', () => {
  // espanso в этой установке хранит промпты иначе, и его отсутствие нормально.
  const src = readSource(join(tempRoot(), 'нет-такой'), 'espanso');

  assert.equal(src.exists, false);
  assert.deepEqual(src.items, []);
});

test('файл без frontmatter не роняет чтение, а помечается причиной', () => {
  // REQ-LIB-ISOLATE применительно к миграции: один битый файл не останавливает
  // остальные 29.
  const root = tempRoot();
  try {
    bareFile(join(root, 'proj'), 'inbox', 's-ses.md', 'просто текст без метаданных\n');
    oldFile(join(root, 'proj'), 'code', 'c-bug');

    const src = readSource(join(root, 'proj'), 'project');
    const broken = src.items.find((i) => i.id === 's-ses');

    assert.equal(src.items.length, 2, 'битый файл остановил чтение');
    assert.equal(broken.broken, true);
    assert.match(broken.why, /нет frontmatter/, 'причина не названа словами');
  } finally { cleanup(root); }
});

test('метаданные разбираются, а не остаются текстом блока', () => {
  // Первая версия вызывала парсер повторно поверх уже разобранного объекта и
  // получала «text.split is not a function» на КАЖДОМ файле: отчёт объявил
  // испорченными все 30 промптов и показал «label → title: 0» при 26 файлах с
  // label. Поймано первым запуском на настоящих данных.
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'code', 'c-review', { label: 'Код — ревью', version: 3 });

    const item = readSource(join(root, 'proj'), 'project').items[0];

    assert.equal(item.broken, false, item.why ?? '');
    assert.equal(item.meta.label, 'Код — ревью');
    assert.equal(item.meta.version, 3);
  } finally { cleanup(root); }
});

// ── план ─────────────────────────────────────────────────────────────────────

test('план не пишет на диск ни одного файла', () => {
  // Главное свойство отчёта. Проверяется по факту: снимок папки до и после.
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'code', 'c-review');
    const target = join(root, 'proj', 'code');
    const before = readdirSync(target).sort();

    plan(roots(root));

    assert.deepEqual(readdirSync(target).sort(), before, 'план изменил содержимое папки');
  } finally { cleanup(root); }
});

test('расхождение тел названо: версия останется только в копии', () => {
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'code', 'c-review', { body: 'TODO: вставить текст промпта' });
    oldFile(join(root, 'home'), 'code', 'c-review', { body: 'Проведи ревью кода ниже.', version: 1 });

    const p = plan(roots(root));
    const one = p.entries.find((e) => e.id === 'c-review');

    assert.equal(one.from, 'home', 'выиграла заглушка вместо настоящего текста');
    assert.equal(one.notes.some((n) => n.includes('останется только в резервной копии')), true);
  } finally { cleanup(root); }
});

test('label назван в плане до записи', () => {
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'code', 'c-bug');

    const p = plan(roots(root));
    assert.equal(p.summary.relabeled, 1);
    assert.equal(p.entries[0].notes.some((n) => n.includes('label')), true);
  } finally { cleanup(root); }
});

test('прочерк вместо значения назван с полем и объяснением', () => {
  // score: - стоит в 22 файлах домашней копии и давал «NaN» на весь экран.
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'code', 'c-bug', { score: '-' });

    const p = plan(roots(root));
    const note = p.entries[0].notes.find((n) => n.includes('прочерк'));

    assert.notEqual(note, undefined, 'прочерк не назван');
    assert.match(note, /score/);
    assert.match(note, /NaN/, 'не сказано, чем это грозило');
    assert.equal(p.summary.dashed, 1);
  } finally { cleanup(root); }
});

test('одинаковый id в двух группах: inbox переименовывается, а не удаляется', () => {
  // Живой случай: s-hagent, s-ndoc, s-ses лежат и в chatbox/, и в inbox/.
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'chatbox', 's-ses');
    oldFile(join(root, 'proj'), 'inbox', 's-ses', { body: 'другой текст' });

    const p = plan(roots(root));
    const ids = p.entries.map((e) => `${e.group}/${e.id}`).sort();

    assert.deepEqual(ids, ['chatbox/s-ses', 'inbox/s-ses-inbox']);
    assert.equal(p.entries.length, 2, 'один из промптов потерян');
    assert.equal(p.summary.renamed, 1);
  } finally { cleanup(root); }
});

/**
 * Разрешение конфликта имён идемпотентно.
 *
 * Дефект найден ПОВТОРНЫМ ЗАПУСКОМ на настоящих данных: файлы превратились в
 * `s-hagent-inbox-inbox.md`. Миграция читает `prompts/` и пишет в `prompts/`, то
 * есть второй прогон видит свой же результат как источник — и добавляет суффикс к
 * уже переименованному имени. Третий прогон дал бы `-inbox-inbox-inbox`.
 *
 * Тест «повторный запуск не портит уже слитую библиотеку» существовал и проходил, но
 * проверял ОДИН файл без конфликта имён. Дыра была в непроверенной комбинации:
 * повтор + конфликт.
 */
test('повторный план не наращивает суффикс на уже переименованном', () => {
  const root = tempRoot();
  try {
    // Так выглядит библиотека ПОСЛЕ первой миграции: имя уже с суффиксом.
    oldFile(join(root, 'proj'), 'chatbox', 's-ses');
    oldFile(join(root, 'proj'), 'inbox', 's-ses-inbox');

    const ids = plan(roots(root)).entries.map((e) => `${e.group}/${e.id}`).sort();

    assert.deepEqual(ids, ['chatbox/s-ses', 'inbox/s-ses-inbox'], 'суффикс наращён повторно');
  } finally { cleanup(root); }
});

test('третий прогон тоже ничего не меняет', () => {
  // Идемпотентность проверяется не на словах: план строится трижды на своём же
  // результате, и имена обязаны совпасть.
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'chatbox', 's-ses');
    oldFile(join(root, 'proj'), 'inbox', 's-ses-inbox');

    const once = plan(roots(root)).entries.map((e) => e.id).sort();
    const twice = plan(roots(root)).entries.map((e) => e.id).sort();

    assert.deepEqual(twice, once);
    assert.equal(once.some((id) => id.includes('-inbox-inbox')), false, 'двойной суффикс');
  } finally { cleanup(root); }
});

test('первое переименование всё ещё работает', () => {
  // Обратная сторона: защита от повтора не должна отменить саму функцию.
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'chatbox', 's-ses');
    oldFile(join(root, 'proj'), 'inbox', 's-ses', { body: 'другой текст' });

    const p = plan(roots(root));
    const ids = p.entries.map((e) => `${e.group}/${e.id}`).sort();

    assert.deepEqual(ids, ['chatbox/s-ses', 'inbox/s-ses-inbox']);
    assert.equal(p.summary.renamed, 1);
  } finally { cleanup(root); }
});

test('id не по форме назван, а не исправлен молча', () => {
  // AGENTS.md в templates/: заглавные буквы не проходят контракт, и это шаблон,
  // а не промпт. Решает человек.
  const root = tempRoot();
  try {
    bareFile(join(root, 'proj'), 'templates', 'AGENTS.md', 'текст шаблона\n');

    const p = plan(roots(root));
    assert.equal(p.entries[0].notes.some((n) => n.includes('не по форме')), true);
  } finally { cleanup(root); }
});

test('порядок записей не зависит от порядка чтения файловой системы', () => {
  // Иначе разбор конфликта id давал бы разные имена на разных прогонах.
  const root = tempRoot();
  try {
    for (const id of ['c-review', 'c-bug', 'c-algo']) oldFile(join(root, 'proj'), 'code', id);

    const first = plan(roots(root)).entries.map((e) => e.id);
    const second = plan(roots(root)).entries.map((e) => e.id);

    assert.deepEqual(first, second);
    assert.deepEqual(first, [...first].sort(), 'порядок не детерминирован');
  } finally { cleanup(root); }
});

test('пустое имя заменяется именем файла, а не остаётся пустым', () => {
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'code', 'c-empty', { label: '' });

    assert.equal(plan(roots(root)).entries[0].title, 'c-empty');
  } finally { cleanup(root); }
});

test('отчёт читается человеком: источники, числа, причины', () => {
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'code', 'c-review');
    const text = printable(plan(roots(root)));

    assert.match(text, /ИСТОЧНИКИ/);
    assert.match(text, /промптов после слияния: 1/);
    assert.match(text, /берётся из/);
  } finally { cleanup(root); }
});

test('пустой отчёт говорит, что папок не найдено', () => {
  const root = tempRoot();
  try {
    assert.match(printable(plan(roots(root))), /ни одной папки не найдено/);
  } finally { cleanup(root); }
});

// ── аргументы командной строки ───────────────────────────────────────────────

test('без флага миграция не запускается и объясняет, какие есть', () => {
  const out = parseArgs([]);

  assert.equal(out.ok, false);
  assert.match(out.why, /--report/);
  assert.match(out.why, /--apply/);
});

test('неизвестный флаг отвергается, а не игнорируется', () => {
  // Молча проигнорировать «--aply» значило бы сделать вид, что команда выполнена.
  const out = parseArgs(['--aply']);

  assert.equal(out.ok, false);
  assert.match(out.why, /--aply/);
});

test('--report и --apply распознаются', () => {
  assert.equal(parseArgs(['--report']).mode, 'report');
  assert.equal(parseArgs(['--apply']).mode, 'apply');
});
