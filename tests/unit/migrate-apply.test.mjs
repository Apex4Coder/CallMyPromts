// tests/unit/migrate-apply.test.mjs — исполнение миграции: копия, запись, сверка.
//
// Требование: REQ-MIG-APPLY (docs/SPEC.md §11). Сценарий S-11.
// Проверяемые файлы: legacy/apply.mjs, legacy/sources.mjs.
// Отчёт и разбор конфликтов — в tests/unit/migrate.test.mjs. Выбор старшей копии и
// нормализация полей без диска — в tests/unit/migrate-meta.test.mjs.
//
// Выделено из migrate.test.mjs, когда тот вышел за 300 строк. Разделение по
// смыслу: там — «что миграция ОБЕЩАЕТ сделать», здесь — «что она СДЕЛАЛА» на диске.
//
// Порядок «копия → запись → сверка» проверяется по результату, а не по вызовам:
// после прогона на диске обязана лежать проигравшая версия текста. Если решение о
// старшинстве неверно, человек должен иметь возможность её достать
// (инвариант docs/SPEC.md §13.1).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  apply, verifyApplied, plan, leftoverSources,
} from '../../legacy/index.mjs';
import { tempRoot, cleanup } from '../helpers/harness.mjs';
import { oldPrompt as oldFile, bareFile, migRoots as roots } from '../helpers/legacyfix.mjs';

// ── резервная копия ──────────────────────────────────────────────────────────

test('копия делается до записи и включает проигравшую версию', () => {
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'code', 'c-review', { body: 'TODO: заглушка' });
    oldFile(join(root, 'home'), 'code', 'c-review', { body: 'настоящий текст', version: 1 });

    const out = apply(roots(root), join(root, 'out'), join(root, 'backup'));

    assert.equal(out.ok, true, JSON.stringify(out.failed));
    const lost = join(out.backup.dir, 'project', 'code', 'c-review.md');
    assert.equal(existsSync(lost), true, 'проигравшая версия не сохранена');
    assert.match(readFileSync(lost, 'utf8'), /TODO: заглушка/);
  } finally { cleanup(root); }
});

test('в копию попадает и битый файл: решение «это мусор» принимает человек', () => {
  const root = tempRoot();
  try {
    bareFile(join(root, 'proj'), 'inbox', 's-ses.md', 'текст без метаданных\n');

    const out = apply(roots(root), join(root, 'out'), join(root, 'backup'));

    assert.equal(existsSync(join(out.backup.dir, 'project', 'inbox', 's-ses.md')), true);
  } finally { cleanup(root); }
});

// ── запись ───────────────────────────────────────────────────────────────────

test('слитая библиотека содержит title, а не label', () => {
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'code', 'c-review', { label: 'Код — ревью' });

    apply(roots(root), join(root, 'out'), join(root, 'backup'));
    const text = readFileSync(join(root, 'out', 'code', 'c-review.md'), 'utf8');

    assert.match(text, /^title: Код — ревью$/m);
    assert.equal(/^label:/m.test(text), false, 'прежнее имя поля осталось');
  } finally { cleanup(root); }
});

test('прочерк не доезжает до новой библиотеки', () => {
  // score: - стоял в 22 файлах и давал «NaN» на весь экран.
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'code', 'c-bug', { score: '-' });

    apply(roots(root), join(root, 'out'), join(root, 'backup'));
    const text = readFileSync(join(root, 'out', 'code', 'c-bug.md'), 'utf8');

    assert.match(text, /^score: null$/m);
    assert.equal(/score: -$/m.test(text), false);
  } finally { cleanup(root); }
});

test('перенос не оставляет промптов с нарушенной хронологией', () => {
  // Проверка по результату на диске, а не по возвращённому объекту: именно так
  // дефект и проявился — в файлах, которые прочитал сервер.
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'code', 'c-old', { updated: '2026-08-07' });
    oldFile(join(root, 'proj'), 'code', 'c-new', { created: '2026-01-01', updated: '2026-08-07' });

    apply(roots(root), join(root, 'out'), join(root, 'backup'));

    for (const id of ['c-old', 'c-new']) {
      const text = readFileSync(join(root, 'out', 'code', `${id}.md`), 'utf8');
      const created = /^created: "?([\d-]+)"?$/m.exec(text)?.[1];
      const updated = /^updated: "?([\d-]+)"?$/m.exec(text)?.[1];

      assert.equal(updated >= created, true, `${id}: updated ${updated} раньше created ${created}`);
    }
  } finally { cleanup(root); }
});

/**
 * Исходники под прежними именами называются, а не удаляются молча.
 *
 * Дефект найден живым запуском: `inbox/s-hagent.md` переименован в
 * `s-hagent-inbox.md`, но исходный файл остался рядом — сервер увидел ДВА промпта с
 * одним `id` и пометил оба сломанными.
 *
 * Причина в столкновении двух верных правил: миграция не удаляет источники, но здесь
 * цель и источник совпали — `prompts/` читается и пишется одновременно.
 *
 * Удалять сама не должна: файл мог отличаться по телу, и решение за человеком
 * (docs/RULES.md §5). Обязана НАЗВАТЬ.
 */
test('остатки под прежними именами перечислены с причиной', () => {
  const root = tempRoot();
  try {
    const target = join(root, 'proj');
    oldFile(target, 'chatbox', 's-ses');
    bareFile(target, 'inbox', 's-ses.md', 'текст без метаданных');

    const p = plan({ project: target, home: '', espanso: '' });
    apply({ project: target, home: '', espanso: '' }, target, join(root, 'backup'));

    const left = leftoverSources(target, p);
    const one = left.find((l) => l.rel === 'inbox/s-ses.md');

    assert.notEqual(one, undefined, `остаток не назван: ${JSON.stringify(left)}`);
    assert.match(one.why, /дубликат id/);
    assert.equal(existsSync(one.file), true, 'файл удалён — решение принято за человека');
  } finally { cleanup(root); }
});

test('когда переименований не было, остатков нет', () => {
  const root = tempRoot();
  try {
    const target = join(root, 'proj');
    oldFile(target, 'code', 'c-review');

    const p = plan({ project: target, home: '', espanso: '' });
    apply({ project: target, home: '', espanso: '' }, target, join(root, 'backup'));

    assert.deepEqual(leftoverSources(target, p), []);
  } finally { cleanup(root); }
});

test('сверка сообщает об остатках вместе с проверкой файлов', () => {
  // Иначе человек прочитает «миграция завершена» и не узнает про дубликаты.
  const root = tempRoot();
  try {
    const target = join(root, 'proj');
    oldFile(target, 'chatbox', 's-ses');
    bareFile(target, 'inbox', 's-ses.md', 'текст');

    const out = apply({ project: target, home: '', espanso: '' }, target, join(root, 'backup'));
    const check = verifyApplied(target, out.plan);

    assert.equal(Array.isArray(check.leftovers), true);
    assert.equal(check.leftovers.length, 1);
  } finally { cleanup(root); }
});

test('статистика использований переносится, а не обнуляется', () => {
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'code', 'c-hot', { used: 42, last_used: '2026-09-01T10:00:00Z' });

    apply(roots(root), join(root, 'out'), join(root, 'backup'));
    const text = readFileSync(join(root, 'out', 'code', 'c-hot.md'), 'utf8');

    assert.match(text, /^used: 42$/m, 'счётчик обнулён — история порядка потеряна');
    assert.match(text, /2026-09-01/);
  } finally { cleanup(root); }
});

test('HTML в теле снимается при переносе', () => {
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'code', 'c-html', {
      body: '<html><body><p style="color:red">Текст из документа</p></body></html>',
    });

    const out = apply(roots(root), join(root, 'out'), join(root, 'backup'));
    const text = readFileSync(join(root, 'out', 'code', 'c-html.md'), 'utf8');

    assert.match(text, /Текст из документа/);
    assert.equal(text.includes('<p'), false, 'разметка доехала до новой библиотеки');
    assert.equal(out.written[0].cleaned.includes('html'), true, 'очистка не отмечена');
  } finally { cleanup(root); }
});

test('порядок ключей в записанном файле стабилен', () => {
  // От этого зависит читаемость diff в git: перемешанные ключи превращают правку
  // одного поля в изменение всего блока.
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'code', 'c-a');
    oldFile(join(root, 'proj'), 'code', 'c-b');

    apply(roots(root), join(root, 'out'), join(root, 'backup'));

    const keys = (id) => readFileSync(join(root, 'out', 'code', `${id}.md`), 'utf8')
      .split('---')[1].trim().split('\n').map((l) => l.split(':')[0]);

    assert.deepEqual(keys('c-a'), keys('c-b'));
    assert.equal(keys('c-a')[0], 'id', 'файл начинается не с id');
  } finally { cleanup(root); }
});

test('источники после миграции остаются на месте', () => {
  // Миграция создаёт новую библиотеку, а не переносит старую. Удаление —
  // отдельное решение человека (docs/RULES.md §5).
  const root = tempRoot();
  try {
    const src = oldFile(join(root, 'proj'), 'code', 'c-review');

    apply(roots(root), join(root, 'out'), join(root, 'backup'));

    assert.equal(existsSync(src), true, 'источник удалён');
  } finally { cleanup(root); }
});

// ── сверка ───────────────────────────────────────────────────────────────────

test('сверка читает диск, а не верит отчёту записи', () => {
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'code', 'c-review');
    const out = apply(roots(root), join(root, 'out'), join(root, 'backup'));

    const check = verifyApplied(join(root, 'out'), out.plan);
    assert.equal(check.ok, true);
    assert.equal(check.expected, 1);
    assert.deepEqual(check.missing, []);
  } finally { cleanup(root); }
});

test('сверка называет недостающий файл, а не молчит', () => {
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'code', 'c-review');
    const p = plan(roots(root));

    // Ничего не записано: сверка обязана это увидеть.
    const check = verifyApplied(join(root, 'пусто'), p);

    assert.equal(check.ok, false);
    assert.deepEqual(check.missing, ['code/c-review.md']);
  } finally { cleanup(root); }
});

test('пустые источники дают отказ с причиной, а не пустую библиотеку', () => {
  const root = tempRoot();
  try {
    const out = apply(roots(root), join(root, 'out'), join(root, 'backup'));

    assert.equal(out.ok, false);
    assert.match(out.why, /ни одного промпта/);
    assert.equal(existsSync(join(root, 'out')), false, 'создана пустая библиотека');
  } finally { cleanup(root); }
});

test('повторный запуск не портит уже слитую библиотеку', () => {
  // Миграция может быть запущена дважды — например, после того как человек
  // поправил один файл руками. Второй прогон обязан дать тот же результат.
  const root = tempRoot();
  try {
    oldFile(join(root, 'proj'), 'code', 'c-review', { label: 'Код — ревью' });

    apply(roots(root), join(root, 'out'), join(root, 'backup'));
    const first = readFileSync(join(root, 'out', 'code', 'c-review.md'), 'utf8');

    apply(roots(root), join(root, 'out'), join(root, 'backup'));
    const second = readFileSync(join(root, 'out', 'code', 'c-review.md'), 'utf8');

    assert.equal(second, first, 'повторный прогон изменил файл');
  } finally { cleanup(root); }
});
