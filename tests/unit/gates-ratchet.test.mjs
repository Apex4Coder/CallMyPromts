// tests/unit/gates-ratchet.test.mjs — храповик: долг только уменьшается.
//
// Требование: REQ-GATE-RATCHET (docs/SPEC.md §10).
// Проверяемый файл: gates/verify.mjs.
// Трасса — в tests/unit/gates-trace.test.mjs, границы — в gates.test.mjs,
// размер — в gates-chunk.test.mjs, секреты — в gates-secret.test.mjs.
//
// Выделено из gates-trace.test.mjs, когда тот вышел за 300 строк вслед за
// добавлением проверки «требование в трассе без описания в спеке».
//
// Базовая линия — это зафиксированный долг, и она обязана работать в ОБЕ стороны:
// стало хуже — красный, стало лучше — зелёный с просьбой обновить линию. Линия,
// которая только растёт, — это не храповик, а кнопка «сделать зелёным».
//
// Второе свойство, которое здесь закрепляется: линию нельзя править руками
// (docs/RULES.md §7). Её пишет только гейт, и только по факту прогона.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkTrace, result } from '../../gates/verify.mjs';

import { tempRoot, cleanup } from '../helpers/harness.mjs';
import { traceRow, traceCsv, specMd, cleanProject } from '../helpers/project.mjs';

// ── нарушения против линии ───────────────────────────────────────────────────

test('нарушений столько же, сколько в линии — гейт зелёный', () => {
  // Зафиксированный долг не блокирует работу: он блокирует его рост.
  const res = result('проба', [{ path: 'a', message: 'раз' }, { path: 'b', message: 'два' }], { baseline: 2 });

  assert.equal(res.ok, true);
  assert.equal(res.worse, 0);
  assert.equal(res.better, 0);
});

test('нарушений больше — гейт красный и говорит насколько', () => {
  const res = result('проба', [{ path: 'a', message: 'раз' }], { baseline: 0 });

  assert.equal(res.ok, false);
  assert.equal(res.worse, 1);
});

test('нарушений меньше — гейт зелёный и просит обновить линию', () => {
  // Без этого линия оставалась бы завышенной, и вернувшееся нарушение прошло бы.
  const res = result('проба', [], { baseline: 3 });

  assert.equal(res.ok, true);
  assert.equal(res.better, 3);
});

test('ноль нарушений при нулевой линии — не повод просить обновление', () => {
  // Иначе гейт на здоровом проекте вечно печатал бы просьбу, и её перестали бы
  // читать — вместе с настоящими сообщениями.
  const res = result('проба', [], { baseline: 0 });

  assert.equal(res.ok, true);
  assert.equal(res.better, 0);
});

// ── долг по тестам ───────────────────────────────────────────────────────────

test('непокрытых требований не должно становиться больше', () => {
  // Отдельный храповик поверх нарушений: новое требование без теста — это
  // рост долга, даже если формально трасса корректна.
  const root = tempRoot();
  try {
    cleanProject(root);
    writeFileSync(join(root, '.trace-baseline.json'),
      JSON.stringify({ violations: 0, untested: 0 }), 'utf8');

    traceCsv(root, [
      traceRow({ req: 'REQ-CORE-ONE' }),
      traceRow({ req: 'REQ-APP-ONE', module: 'app', file: 'app/index.mjs', test: 'tests/unit/будет.test.mjs' }),
    ]);
    specMd(root, [['REQ-CORE-ONE', 'planned'], ['REQ-APP-ONE', 'planned']]);

    const res = checkTrace(root);
    assert.equal(res.ok, false, 'рост числа требований без теста должен быть красным');
    assert.match(res.note, /добавлено без теста/);
  } finally { cleanup(root); }
});

test('уменьшение долга по тестам названо прямо', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    writeFileSync(join(root, '.trace-baseline.json'),
      JSON.stringify({ violations: 0, untested: 5 }), 'utf8');

    const res = checkTrace(root);
    assert.equal(res.ok, true);
    assert.match(res.note, /обновите базовую линию/);
  } finally { cleanup(root); }
});

test('отсутствие файла линии не роняет гейт: первый прогон возможен', () => {
  // На чистой копии проекта линии ещё нет, и падение здесь означало бы, что
  // проверки нельзя запустить, пока кто-то не создаст файл руками.
  const root = tempRoot();
  try {
    cleanProject(root);
    const res = checkTrace(root);

    assert.equal(typeof res.ok, 'boolean');
    assert.equal(typeof res.count, 'number');
  } finally { cleanup(root); }
});
