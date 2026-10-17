// tests/unit/gates-trace.test.mjs — гейт трассы: «готово» только с тестом.
//
// Требование: REQ-GATE-TRACE (docs/SPEC.md §10).
// Проверяемый файл: gates/trace-check.mjs.
// Храповик — в tests/unit/gates-ratchet.test.mjs, секреты — в gates-secret.test.mjs,
// границы — в gates.test.mjs, размер — в gates-chunk.test.mjs.
//
// Гейт существует ради одного запрета: слово «готово» без запускаемого теста
// (docs/RULES.md §4). Второе его назначение — держать два источника правды,
// docs/SPEC.md и trace.csv, в согласии между собой. Расхождение проверяется в ОБЕ
// стороны, и второе направление добавлено после того, как числа разошлись на
// настоящем проекте.

import test from 'node:test';
import assert from 'node:assert/strict';

import { checkTrace, readTrace, readSpecReqs } from '../../gates/verify.mjs';

import { tempRoot, cleanup } from '../helpers/harness.mjs';
import {
  traceRow, traceCsv, specMd, cleanProject,
} from '../helpers/project.mjs';

const said = (res) => res.items.map((i) => `${i.path}:${i.line ?? '-'} ${i.message}`).join('\n');

// ── чистый проект ────────────────────────────────────────────────────────────

test('на чистом проекте гейт трассы молчит', () => {
  const root = tempRoot();
  try {
    cleanProject(root);

    assert.equal(checkTrace(root).count, 0, said(checkTrace(root)));
  } finally { cleanup(root); }
});

// ── разбор трассы и спеки ────────────────────────────────────────────────────

test('трасса читается со всеми столбцами', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    const rows = readTrace(root);

    assert.equal(rows.length, 2);
    assert.equal(rows[0]['REQ-ID'], 'REQ-CORE-ONE');
    assert.equal(rows[0].module, 'core');
    assert.equal(rows[0].status, 'planned');
  } finally { cleanup(root); }
});

test('номер строки трассы сохраняется', () => {
  // Без номера сообщение гейта не говорит, где искать: файл на 58 строк
  // просматривается глазами, файл на 300 — нет.
  const root = tempRoot();
  try {
    cleanProject(root);
    const rows = readTrace(root);

    assert.equal(rows[0]._line, 2, 'первая строка данных идёт после заголовка');
    assert.equal(rows[1]._line, 3);
  } finally { cleanup(root); }
});

test('требования спеки читаются вместе со статусом', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    const spec = readSpecReqs(root);

    assert.equal(spec.get('REQ-CORE-ONE'), 'planned');
    assert.equal(spec.size, 2);
  } finally { cleanup(root); }
});

// ── трасса: «готово» без теста ───────────────────────────────────────────────

test('статус done без файла теста поймана', () => {
  // Главная проверка гейта: «готово» без exit 0 — это обещание, а не результат.
  const root = tempRoot();
  try {
    cleanProject(root);
    traceCsv(root, [
      traceRow({ req: 'REQ-CORE-ONE', test: 'tests/unit/нет-такого.test.mjs', status: 'done' }),
    ]);
    specMd(root, [['REQ-CORE-ONE', 'done']]);

    assert.match(said(checkTrace(root)), /статус done, но теста .* нет/);
  } finally { cleanup(root); }
});

test('статус planned без теста нарушением не считается', () => {
  // Запланированное требование ещё не обещано готовым.
  const root = tempRoot();
  try {
    cleanProject(root);
    traceCsv(root, [traceRow({ req: 'REQ-CORE-ONE', test: 'tests/unit/будет.test.mjs' })]);
    specMd(root, [['REQ-CORE-ONE', 'planned']]);

    const complaints = checkTrace(root).items.filter((i) => i.message.includes('done'));
    assert.equal(complaints.length, 0);
  } finally { cleanup(root); }
});

test('несуществующий файл реализации поймана', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    traceCsv(root, [traceRow({ req: 'REQ-CORE-ONE', file: 'core/нет-файла.mjs' })]);
    specMd(root, [['REQ-CORE-ONE', 'planned']]);

    assert.match(said(checkTrace(root)), /файл «core\/нет-файла\.mjs» не существует/);
  } finally { cleanup(root); }
});

test('прочерк вместо файла допустим', () => {
  // Требование может не иметь одного файла — например, правило оформления.
  const root = tempRoot();
  try {
    cleanProject(root);
    traceCsv(root, [traceRow({ req: 'REQ-CORE-ONE', file: '-', test: '-' })]);
    specMd(root, [['REQ-CORE-ONE', 'planned']]);

    const complaints = checkTrace(root).items.filter((i) => i.message.includes('не существует'));
    assert.equal(complaints.length, 0);
  } finally { cleanup(root); }
});

// ── трасса: расхождение источников ───────────────────────────────────────────

test('расхождение статусов между спекой и трассой поймано', () => {
  // Два источника правды об одном требовании — это отсутствие правды.
  const root = tempRoot();
  try {
    cleanProject(root);
    traceCsv(root, [traceRow({ req: 'REQ-CORE-ONE', status: 'planned' })]);
    specMd(root, [['REQ-CORE-ONE', 'partial']]);

    assert.match(said(checkTrace(root)), /в спеке «partial», в трассе «planned»/);
  } finally { cleanup(root); }
});

test('расхождение статусов указано со строкой трассы', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    traceCsv(root, [
      traceRow({ req: 'REQ-CORE-ONE', status: 'planned' }),
      traceRow({ req: 'REQ-APP-ONE', module: 'app', file: 'app/index.mjs', test: 'tests/unit/app.test.mjs', status: 'planned' }),
    ]);
    specMd(root, [['REQ-CORE-ONE', 'planned'], ['REQ-APP-ONE', 'done']]);

    const bad = checkTrace(root).items.find((i) => i.message.includes('расхождение'));
    assert.equal(bad.line, 3, 'номер строки должен указывать на REQ-APP-ONE');
  } finally { cleanup(root); }
});

/**
 * Обратное направление: требование в трассе без описания в спеке.
 *
 * Проверка добавлена после того, как разошлись числа при переводе статусов в
 * `done`: 61 строка в трассе против 60 в спеке. Гейт молчал, потому что смотрел
 * только «спека → трасса», и `REQ-CFG-ROOT` жил в трассе без формулировки
 * требования. Односторонняя проверка выглядела полной и пропускала худший случай:
 * поведение реализовано и покрыто тестом, а человек, читающий спеку, о нём не
 * знает.
 */
test('требование из трассы, отсутствующее в спеке, поймано', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    traceCsv(root, [
      traceRow({ req: 'REQ-CORE-ONE' }),
      traceRow({ req: 'REQ-CFG-ROOT', module: 'config', file: 'package.json', test: '-' }),
    ]);
    specMd(root, [['REQ-CORE-ONE', 'planned']]);

    const res = checkTrace(root);
    assert.match(said(res), /REQ-CFG-ROOT есть в trace\.csv, но не описан в docs\/SPEC\.md/);
  } finally { cleanup(root); }
});

test('расхождение в трассе указано со строкой: иначе искать негде', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    traceCsv(root, [
      traceRow({ req: 'REQ-CORE-ONE' }),
      traceRow({ req: 'REQ-NEW-ONE', module: 'core', file: 'core/index.mjs', test: '-' }),
    ]);
    specMd(root, [['REQ-CORE-ONE', 'planned']]);

    const bad = checkTrace(root).items.find((i) => i.message.includes('не описан'));
    assert.equal(bad.line, 3, 'номер строки должен указывать на REQ-NEW-ONE');
  } finally { cleanup(root); }
});

test('требование из спеки, отсутствующее в трассе, поймано', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    specMd(root, [['REQ-CORE-ONE', 'planned'], ['REQ-APP-ONE', 'planned'], ['REQ-NEW-ONE', 'planned']]);

    assert.match(said(checkTrace(root)), /REQ-NEW-ONE есть в спеке, но отсутствует в trace\.csv/);
  } finally { cleanup(root); }
});

test('повтор требования в трассе поймана', () => {
  // Две строки об одном требовании расходятся при первой же правке.
  const root = tempRoot();
  try {
    cleanProject(root);
    traceCsv(root, [
      traceRow({ req: 'REQ-CORE-ONE' }),
      traceRow({ req: 'REQ-CORE-ONE' }),
    ]);
    specMd(root, [['REQ-CORE-ONE', 'planned']]);

    assert.match(said(checkTrace(root)), /REQ-CORE-ONE встречается второй раз/);
  } finally { cleanup(root); }
});

test('статус не из списка поймана', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    traceCsv(root, [traceRow({ req: 'REQ-CORE-ONE', status: 'почти' })]);
    specMd(root, [['REQ-CORE-ONE', 'planned']]);

    assert.match(said(checkTrace(root)), /статус «почти» не из списка/);
  } finally { cleanup(root); }
});

test('идентификатор не по форме поймана', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    traceCsv(root, [traceRow({ req: 'core-one' })]);
    specMd(root, []);

    assert.match(said(checkTrace(root)), /не похож на идентификатор требования/);
  } finally { cleanup(root); }
});

