// tests/unit/clip-store.test.mjs — журнал буфера обмена: запись и чтение.
//
// Требование: REQ-CLIP-LOG (docs/SPEC.md §4). Сценарий: S-04.
//
// Модель журнала взята из ClipClip и подтверждена владельцем: «буфер работает как
// логирование, все записи идут друг за другом, моя задача только вытащить эту
// запись». Отсюда главные свойства: новое сверху, ничего не группируется,
// содержимое доступно целиком.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ClipStore } from '../../clipboard/index.mjs';
import { tempRoot, cleanup } from '../helpers/harness.mjs';

/** Журнал во временной папке. Настоящий state/clips.db тесты не трогают. */
const store = (root) => new ClipStore(join(root, 'state', 'clips.db'));

test('запись создаётся и получает номер', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    const out = db.add('Текст из буфера обмена.');

    assert.equal(out.ok, true);
    assert.equal(typeof out.id, 'number');
    assert.equal(db.count(), 1);
  } finally { db.close(); cleanup(root); }
});

test('новое сверху: порядок как в журнале, а не по алфавиту', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    db.add('первая запись');
    db.add('вторая запись');
    db.add('третья запись');

    const list = db.list();

    assert.deepEqual(list.map((r) => r.preview), ['третья запись', 'вторая запись', 'первая запись']);
  } finally { db.close(); cleanup(root); }
});

test('в списке preview, а не полный текст: иначе список весит мегабайты', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    db.add(`Начало. ${'х'.repeat(5000)}`);

    const row = db.list()[0];

    assert.equal(row.text, undefined, 'полный текст в списке не выдаётся');
    assert.equal(row.preview.length <= 200, true);
    assert.equal(row.bytes > 5000, true, 'но размер известен');
  } finally { db.close(); cleanup(root); }
});

test('get отдаёт запись целиком: за полным текстом обращаются отдельно', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    const text = 'Полный текст.\nВторая строка.';
    const { id } = db.add(text);

    const row = db.get(id);

    assert.equal(row.text, text);
    assert.equal(row.lines, 2);
  } finally { db.close(); cleanup(root); }
});

test('get несуществующего номера — null, а не исключение', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    assert.equal(db.get(99999), null);
    assert.equal(db.get('мусор'), null);
  } finally { db.close(); cleanup(root); }
});

test('источник записи сохраняется: по нему видно, откуда пришёл текст', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    db.add('текст из редактора', { sourceApp: 'Code.exe' });

    assert.equal(db.list()[0].source_app, 'Code.exe');
  } finally { db.close(); cleanup(root); }
});

test('слишком короткое содержимое не записывается', () => {
  // Одиночные символы засоряют журнал: выделение мышью часто задевает один знак.
  const root = tempRoot();
  const db = store(root);
  try {
    const out = db.add('a');

    assert.equal(out.ok, false);
    assert.equal(out.skipped, 'too_short');
    assert.equal(db.count(), 0);
  } finally { db.close(); cleanup(root); }
});

test('слишком длинное содержимое обрезается, и об этом сказано', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    const out = db.add('я'.repeat(2 * 1024 * 1024));

    assert.equal(out.ok, true);
    assert.equal(out.truncated, true, 'молчаливая обрезка выглядела бы как потеря данных');
    assert.equal(out.issues.some((i) => i.code === 'V-C-6'), true);
  } finally { db.close(); cleanup(root); }
});

test('удаление записи убирает именно её', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    const a = db.add('первая запись');
    const b = db.add('вторая запись');

    assert.equal(db.remove(a.id), true);
    assert.equal(db.count(), 1);
    assert.equal(db.get(b.id).preview, 'вторая запись');
  } finally { db.close(); cleanup(root); }
});

test('удаление несуществующей записи возвращает false без сбоя', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    assert.equal(db.remove(12345), false);
  } finally { db.close(); cleanup(root); }
});

test('фильтр по типу отбирает только свой тип', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    db.add('обычный текст записи');
    db.add('https://example.com/page');
    db.add('function f() {\n  return 1;\n}\nconst x = f();');

    assert.equal(db.list({ kind: 'url' }).length, 1);
    assert.equal(db.list({ kind: 'url' })[0].preview, 'https://example.com/page');
    assert.equal(db.list({ kind: 'code' }).length, 1);
  } finally { db.close(); cleanup(root); }
});

test('поиск ищет по полному тексту, а не по preview', () => {
  // Слово может быть за пределами preview. Поиск только по preview выглядел бы
  // как «журнал теряет записи».
  const root = tempRoot();
  const db = store(root);
  try {
    db.add(`${'начало '.repeat(60)}иголка в конце`);
    db.add('другая запись без иголки');

    const found = db.list({ query: 'иголка в конце' });

    assert.equal(found.length, 1);
  } finally { db.close(); cleanup(root); }
});

test('пустой поиск возвращает всё: это не фильтр', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    db.add('первая запись');
    db.add('вторая запись');

    assert.equal(db.list({ query: null }).length, 2);
  } finally { db.close(); cleanup(root); }
});

test('процент в запросе ищется буквально, а не как шаблон LIKE', () => {
  // Без экранирования «%» находил бы все записи — поиск выглядел бы сломанным.
  const root = tempRoot();
  const db = store(root);
  try {
    db.add('скидка 50% на всё');
    db.add('обычная запись без процентов');

    const found = db.list({ query: '50%' });

    assert.equal(found.length, 1, 'найдена только запись с процентом');
    assert.match(found[0].preview, /50%/);
  } finally { db.close(); cleanup(root); }
});

test('подчёркивание в запросе тоже буквально', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    db.add('переменная user_name в коде');
    db.add('переменная username без знака');

    const found = db.list({ query: 'user_name' });

    assert.equal(found.length, 1);
  } finally { db.close(); cleanup(root); }
});

test('постраничный вывод не повторяет и не пропускает записи', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    for (let i = 1; i <= 25; i += 1) db.add(`запись номер ${i}`);

    const first = db.list({ limit: 10, offset: 0 });
    const second = db.list({ limit: 10, offset: 10 });
    const third = db.list({ limit: 10, offset: 20 });

    assert.equal(first.length, 10);
    assert.equal(second.length, 10);
    assert.equal(third.length, 5);

    const ids = [...first, ...second, ...third].map((r) => r.id);
    assert.equal(new Set(ids).size, 25, 'ни одна запись не выдана дважды');
  } finally { db.close(); cleanup(root); }
});

test('статистика считает записи по типам', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    db.add('обычный текст записи');
    db.add('ещё один обычный текст');
    db.add('https://example.com/page');

    const s = db.stats();

    assert.equal(s.total, 3);
    assert.equal(s.byKind.text, 2);
    assert.equal(s.byKind.url, 1);
  } finally { db.close(); cleanup(root); }
});

test('clear сохраняет сохранённые как промпт', () => {
  // Запись, ставшая частью библиотеки, не должна исчезать при очистке журнала.
  const root = tempRoot();
  const db = store(root);
  try {
    const keep = db.add('этот текст стал промптом');
    db.add('этот текст просто в буфере');
    db.markPromoted(keep.id, 'c-new');

    const removed = db.clear();

    assert.equal(removed, 1);
    assert.equal(db.count(), 1);
    assert.equal(db.get(keep.id).promoted_to, 'c-new');
  } finally { db.close(); cleanup(root); }
});

test('clear с keepPromoted: false удаляет всё — по явной команде', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    const a = db.add('этот текст стал промптом');
    db.markPromoted(a.id, 'c-new');

    db.clear({ keepPromoted: false });

    assert.equal(db.count(), 0);
  } finally { db.close(); cleanup(root); }
});

test('битая база отводится в сторону, приложение стартует', () => {
  // Приложение, не запускающееся из-за повреждённого журнала, хуже приложения
  // с пустым журналом.
  const root = tempRoot();
  const file = join(root, 'state', 'clips.db');
  try {
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(file, 'это не база данных, а мусор', 'utf8');

    const db = new ClipStore(file);
    try {
      const out = db.add('журнал работает после восстановления');
      assert.equal(out.ok, true);
      assert.equal(db.stats().recovered !== null, true, 'подмена базы обязана быть названа');

      const left = readdirSync(join(root, 'state')).filter((n) => n.includes('.broken-'));
      assert.equal(left.length, 1, 'битый файл сохранён рядом, а не удалён');
    } finally { db.close(); }
  } finally { cleanup(root); }
});
