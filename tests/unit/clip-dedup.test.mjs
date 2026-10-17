// tests/unit/clip-dedup.test.mjs — защита от повторов в журнале.
//
// Требование: REQ-CLIP-DEDUP (docs/SPEC.md §4). Правило V-C-2: docs/DATA-CONTRACTS.md §2.2.
// Сценарий: S-04.
//
// Правило узкое намеренно: отбрасывается повтор ТОЛЬКО верхней записи. Так ведёт
// себя ClipClip, и это соответствует тому, зачем нужен журнал: «моя задача только
// вытащить эту запись». Копирование одного и того же дважды подряд — почти всегда
// промах (двойное Ctrl+C, повторное нажатие в неактивном окне). А тот же текст,
// скопированный через десять других записей, — намеренное возвращение к нему, и
// стирать его из истории значило бы переписывать хронологию.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { ClipStore } from '../../clipboard/index.mjs';
import { tempRoot, cleanup } from '../helpers/harness.mjs';

const store = (root) => new ClipStore(join(root, 'state', 'clips.db'));

test('повтор верхней записи отбрасывается', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    const first = db.add('один и тот же текст');
    const second = db.add('один и тот же текст');

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.skipped, 'duplicate');
    assert.equal(db.count(), 1);
  } finally { db.close(); cleanup(root); }
});

test('в ответе указан номер существующей записи: её нужно подсветить в списке', () => {
  // «Отброшено» без ссылки на запись оставляет человека в неведении, куда смотреть.
  const root = tempRoot();
  const db = store(root);
  try {
    const first = db.add('один и тот же текст');
    const second = db.add('один и тот же текст');

    assert.equal(second.id, first.id);
  } finally { db.close(); cleanup(root); }
});

test('десять нажатий Ctrl+C подряд дают одну запись', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    for (let i = 0; i < 10; i += 1) db.add('текст, скопированный много раз');

    assert.equal(db.count(), 1);
  } finally { db.close(); cleanup(root); }
});

test('повтор не верхней записи сохраняется: это возвращение к тексту', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    db.add('первый текст');
    db.add('второй текст');
    const again = db.add('первый текст');

    assert.equal(again.ok, true, 'история не переписывается');
    assert.equal(db.count(), 3);
    assert.equal(db.list()[0].preview, 'первый текст', 'и он снова сверху');
  } finally { db.close(); cleanup(root); }
});

test('сравнение по содержимому, а не по источнику', () => {
  // Тот же текст из другого приложения — тот же текст. Разделение по источнику
  // засоряло бы журнал парами одинаковых записей.
  const root = tempRoot();
  const db = store(root);
  try {
    db.add('одинаковый текст', { sourceApp: 'chrome.exe' });
    const second = db.add('одинаковый текст', { sourceApp: 'Code.exe' });

    assert.equal(second.skipped, 'duplicate');
  } finally { db.close(); cleanup(root); }
});

test('различие в пробелах — это различие: код чувствителен к отступам', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    db.add('function f() {\n  return 1;\n}');
    const second = db.add('function f() {\n    return 1;\n}');

    assert.equal(second.ok, true, 'отступ в четыре пробела — другой текст');
    assert.equal(db.count(), 2);
  } finally { db.close(); cleanup(root); }
});

test('регистр учитывается: «ОК» и «ок» — разные тексты', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    db.add('Пароль принят');
    const second = db.add('пароль принят');

    assert.equal(second.ok, true);
  } finally { db.close(); cleanup(root); }
});

test('обрезанное длинное содержимое сравнивается после обрезки', () => {
  // Иначе два одинаковых огромных текста давали бы два одинаковых обрезанных.
  const root = tempRoot();
  const db = store(root);
  try {
    const huge = 'я'.repeat(2 * 1024 * 1024);
    db.add(huge);
    const second = db.add(huge);

    assert.equal(second.skipped, 'duplicate');
    assert.equal(db.count(), 1);
  } finally { db.close(); cleanup(root); }
});

test('одинаковое начало при разном хвосте — разные записи', () => {
  // Проверка, что сравнение идёт по всему содержимому, а не по preview.
  const root = tempRoot();
  const db = store(root);
  try {
    const head = 'одинаковое начало '.repeat(20);
    db.add(`${head}первый хвост`);
    const second = db.add(`${head}второй хвост`);

    assert.equal(second.ok, true);
    assert.equal(db.count(), 2);
  } finally { db.close(); cleanup(root); }
});

test('после удаления верхней записи её текст снова записывается', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    const first = db.add('текст для удаления');
    db.remove(first.id);

    const again = db.add('текст для удаления');

    assert.equal(again.ok, true);
    assert.equal(db.count(), 1);
  } finally { db.close(); cleanup(root); }
});

test('отброшенный повтор не сдвигает порядок и не меняет время', () => {
  // Иначе повторное нажатие Ctrl+C «поднимало» бы запись, и список выглядел бы
  // живущим своей жизнью.
  const root = tempRoot();
  const db = store(root);
  try {
    db.add('первый текст');
    db.add('второй текст');
    const before = db.list().map((r) => [r.id, r.created_at]);

    db.add('второй текст');

    assert.deepEqual(db.list().map((r) => [r.id, r.created_at]), before);
  } finally { db.close(); cleanup(root); }
});

test('повтор защищённой записи не снимает защиту', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    const first = db.add('текст, ставший промптом');
    db.markPromoted(first.id, 'c-saved');

    db.add('текст, ставший промптом');

    assert.equal(db.get(first.id).promoted_to, 'c-saved');
  } finally { db.close(); cleanup(root); }
});
