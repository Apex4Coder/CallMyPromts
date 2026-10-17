// tests/unit/clip-pause.test.mjs — пауза слежки за буфером.
//
// Требование: REQ-CLIP-PAUSE (docs/SPEC.md §4). Сценарий: S-04.
//
// Зачем пауза: перед работой с паролями человек должен иметь возможность выключить
// журнал одним действием, не разбираясь в чёрных списках. Это последняя защита,
// когда источник неизвестен заранее — например, пароль набран в блокноте.
//
// Требование к паузе: она обязана быть видимой. Незаметно выключенный журнал —
// это молчаливая потеря записей, и человек решит, что приложение сломалось.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { ClipStore } from '../../clipboard/index.mjs';
import { tempRoot, cleanup } from '../helpers/harness.mjs';

const store = (root) => new ClipStore(join(root, 'state', 'clips.db'));

test('журнал начинает работу включённым', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    assert.equal(db.paused, false, 'выключенный по умолчанию журнал не выполнял бы свою задачу');
  } finally { db.close(); cleanup(root); }
});

test('на паузе запись не создаётся, причина названа', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    db.pause();
    const out = db.add('текст во время паузы');

    assert.equal(out.ok, false);
    assert.equal(out.skipped, 'paused', 'причина отличима от «дубликат» и «коротко»');
    assert.equal(db.count(), 0);
  } finally { db.close(); cleanup(root); }
});

test('после снятия паузы запись идёт снова', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    db.pause();
    db.add('текст во время паузы');
    db.resume();

    const out = db.add('текст после паузы');

    assert.equal(out.ok, true);
    assert.equal(db.count(), 1);
    assert.equal(db.list()[0].preview, 'текст после паузы');
  } finally { db.close(); cleanup(root); }
});

test('пропущенное во время паузы не восстанавливается', () => {
  // Иначе пауза была бы отложенной записью, а не защитой: пароль всё равно попал
  // бы в журнал, только позже.
  const root = tempRoot();
  const db = store(root);
  try {
    db.pause();
    db.add('пароль, набранный в блокноте');
    db.resume();

    assert.equal(db.count(), 0, 'ни одной записи из времени паузы');
  } finally { db.close(); cleanup(root); }
});

test('состояние паузы читается и возвращается операциями', () => {
  // Значок в трее и панель показывают состояние; они должны получать его отсюда,
  // а не хранить своё представление.
  const root = tempRoot();
  const db = store(root);
  try {
    assert.equal(db.pause(), true);
    assert.equal(db.paused, true);
    assert.equal(db.resume(), false);
    assert.equal(db.paused, false);
  } finally { db.close(); cleanup(root); }
});

test('пауза попадает в статистику: состояние видно в диагностике', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    db.pause();

    assert.equal(db.stats().paused, true);
  } finally { db.close(); cleanup(root); }
});

test('повторная пауза не ошибка: цель уже достигнута', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    db.pause();
    assert.equal(db.pause(), true);
    assert.equal(db.paused, true);
  } finally { db.close(); cleanup(root); }
});

test('снятие паузы с невключённой паузы тоже не ошибка', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    assert.equal(db.resume(), false);
    assert.equal(db.paused, false);
  } finally { db.close(); cleanup(root); }
});

test('пауза не мешает чтению журнала', () => {
  // Пауза выключает запись, а не доступ. Иначе человек не смог бы достать
  // нужную запись именно тогда, когда осторожничает.
  const root = tempRoot();
  const db = store(root);
  try {
    const before = db.add('запись до паузы');
    db.pause();

    assert.equal(db.count(), 1);
    assert.equal(db.get(before.id).text, 'запись до паузы');
    assert.equal(db.list().length, 1);
  } finally { db.close(); cleanup(root); }
});

test('пауза не мешает удалению и очистке', () => {
  // Обратный случай: человек поставил паузу именно чтобы убрать лишнее.
  const root = tempRoot();
  const db = store(root);
  try {
    const one = db.add('первая запись');
    db.add('вторая запись');
    db.pause();

    assert.equal(db.remove(one.id), true);
    assert.equal(db.clear(), 1);
    assert.equal(db.count(), 0);
  } finally { db.close(); cleanup(root); }
});

test('пауза не мешает отметить запись как промпт', () => {
  const root = tempRoot();
  const db = store(root);
  try {
    const r = db.add('текст, который станет промптом');
    db.pause();

    assert.equal(db.markPromoted(r.id, 'c-new'), true);
  } finally { db.close(); cleanup(root); }
});

test('пауза проверяется раньше чёрного списка и разбора содержимого', () => {
  // На паузе содержимое не читается вовсе: ни на секреты, ни на тип. Меньше
  // работы с чувствительными данными — меньше поводов для утечки.
  const root = tempRoot();
  const db = store(root);
  try {
    db.pause();

    const out = db.add('sk-abcdefghij1234567890abcd', { sourceApp: 'KeePass.exe' });

    assert.equal(out.skipped, 'paused', 'причина именно пауза, а не чёрный список');
    assert.deepEqual(out.issues, [], 'проверки содержимого не запускались');
    assert.equal(out.marks, undefined, 'содержимое не анализировалось');
  } finally { db.close(); cleanup(root); }
});

test('пауза живёт в памяти процесса, а не в базе', () => {
  // Перезапуск сервиса возвращает журнал в рабочее состояние. Пауза, пережившая
  // перезапуск, стала бы невидимой причиной «журнал не пишет» на месяцы вперёд.
  const root = tempRoot();
  const file = join(root, 'state', 'clips.db');
  const first = new ClipStore(file);
  try {
    first.pause();
  } finally { first.close(); }

  const second = new ClipStore(file);
  try {
    assert.equal(second.paused, false, 'после перезапуска журнал работает');
  } finally { second.close(); cleanup(root); }
});
