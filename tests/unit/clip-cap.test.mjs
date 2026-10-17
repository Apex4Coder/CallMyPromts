// tests/unit/clip-cap.test.mjs — предел журнала и вытеснение старых записей.
//
// Требование: REQ-CLIP-CAP (docs/SPEC.md §4). Правило V-C-3: docs/DATA-CONTRACTS.md §2.2.
// Сценарий: S-04.
//
// Владелец задал сто записей: «каждое сохранение должно отображаться в списке до
// ста штук». Предел настраиваемый, но не произвольный: слишком маленький журнал
// теряет нужное, слишком большой превращает список в свалку.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { ClipStore } from '../../clipboard/index.mjs';
import { LIMIT_DEFAULT, LIMIT_MIN, LIMIT_MAX, clampLimit } from '../../contracts/index.mjs';
import { tempRoot, cleanup } from '../helpers/harness.mjs';

const store = (root) => new ClipStore(join(root, 'state', 'clips.db'));

/** n записей с различимым содержимым: одинаковый текст был бы отброшен как дубликат. */
const fill = (db, n, opts = {}) => {
  for (let i = 1; i <= n; i += 1) db.add(`запись номер ${i}`, opts);
};

test('предел по умолчанию — сто записей', () => {
  assert.equal(LIMIT_DEFAULT, 100, 'значение задано владельцем, менять его нельзя молча');
});

test('предел зажимается в границы разумного', () => {
  assert.equal(clampLimit(5), LIMIT_MIN, 'журнал из пяти записей бесполезен');
  assert.equal(clampLimit(100000), LIMIT_MAX, 'журнал из ста тысяч записей — свалка');
  assert.equal(clampLimit('мусор'), LIMIT_DEFAULT, 'непонятное значение даёт умолчание, а не ноль');
  assert.equal(clampLimit(100), 100, 'разумное значение проходит как есть');
});

test('журнал не растёт выше предела', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    fill(db, 25, { limit: LIMIT_MIN });

    assert.equal(db.count(), LIMIT_MIN, `в журнале ровно ${LIMIT_MIN}`);
  } finally { db.close(); cleanup(root); }
});

test('вытесняется самое старое, а не случайное', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    fill(db, 25, { limit: LIMIT_MIN });

    const list = db.list({ limit: 100 });

    assert.equal(list[0].preview, 'запись номер 25', 'сверху последняя');
    assert.equal(list.at(-1).preview, 'запись номер 6', 'первые пять вытеснены');
    assert.equal(list.some((r) => r.preview === 'запись номер 1'), false);
  } finally { db.close(); cleanup(root); }
});

test('вытеснение названо в ответе: тихая потеря выглядела бы как сбой', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    fill(db, LIMIT_MIN, { limit: LIMIT_MIN });

    const out = db.add('запись сверх предела', { limit: LIMIT_MIN });

    assert.equal(out.ok, true);
    assert.equal(out.evicted, 1, 'вызывающий знает, что одна запись ушла');
  } finally { db.close(); cleanup(root); }
});

test('пока предел не достигнут, ничего не вытесняется', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    const out = db.add('единственная запись', { limit: LIMIT_MIN });

    assert.equal(out.evicted, 0);
  } finally { db.close(); cleanup(root); }
});

test('сохранённые как промпт не вытесняются', () => {
  // Запись, ставшая частью библиотеки, исчезать не должна: человек уже принял
  // решение оставить её.
  const root = tempRoot();
  const db = store(root);
  try {
    const keep = db.add('этот текст станет промптом', { limit: LIMIT_MIN });
    db.markPromoted(keep.id, 'c-saved');

    fill(db, 40, { limit: LIMIT_MIN });

    assert.equal(db.get(keep.id) !== null, true, 'защищённая запись на месте');
    assert.equal(db.get(keep.id).promoted_to, 'c-saved');
  } finally { db.close(); cleanup(root); }
});

test('журнал из одних защищённых записей превышает предел — и это верно', () => {
  // Иначе пришлось бы выбирать между потерей данных и соблюдением числа.
  // Число — настройка, данные — нет.
  const root = tempRoot();
  const db = store(root);
  try {
    for (let i = 1; i <= 25; i += 1) {
      const r = db.add(`промпт номер ${i}`, { limit: LIMIT_MIN });
      db.markPromoted(r.id, `c-${i}`);
    }

    assert.equal(db.count(), 25, 'все защищённые сохранены');
    assert.equal(db.stats(LIMIT_MIN).promoted, 25);
  } finally { db.close(); cleanup(root); }
});

test('уменьшение предела подрезает журнал при следующей записи', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    fill(db, 60, { limit: 60 });
    assert.equal(db.count(), 60);

    db.add('запись после смены настройки', { limit: LIMIT_MIN });

    assert.equal(db.count(), LIMIT_MIN, 'новый предел применён');
  } finally { db.close(); cleanup(root); }
});

test('trim вызывается напрямую и возвращает число удалённых', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    fill(db, 40, { limit: LIMIT_MAX });

    const removed = db.trim(LIMIT_MIN);

    assert.equal(removed, 20);
    assert.equal(db.count(), LIMIT_MIN);
  } finally { db.close(); cleanup(root); }
});

test('trim на пустом журнале ничего не делает', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    assert.equal(db.trim(LIMIT_DEFAULT), 0);
  } finally { db.close(); cleanup(root); }
});

test('статистика показывает действующий предел, а не запрошенный', () => {
  // В настройках можно ввести 5; показать «5» означало бы соврать о поведении.
  const root = tempRoot();
  const db = store(root);
  try {
    db.add('одна запись');

    assert.equal(db.stats(5).limit, LIMIT_MIN);
  } finally { db.close(); cleanup(root); }
});

test('нумерация не переиспользуется после вытеснения', () => {
  // Повторный номер означал бы, что ссылка на старую запись однажды приведёт
  // к другой записи — молча.
  const root = tempRoot();
  const db = store(root);
  try {
    const first = db.add('самая первая запись', { limit: LIMIT_MIN });
    fill(db, 30, { limit: LIMIT_MIN });

    const ids = db.list({ limit: 100 }).map((r) => r.id);

    assert.equal(ids.includes(first.id), false, 'первая вытеснена');
    assert.equal(Math.min(...ids) > first.id, true, 'номера продолжают расти');
  } finally { db.close(); cleanup(root); }
});
