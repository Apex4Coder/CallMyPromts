// tests/unit/gates-ready.test.mjs — G24: критерий готовности не врёт.
//
// Требование: REQ-GATE-READY (docs/SPEC.md §10). Концепция: gld/gold.md §1.1, §9.
// Проверяемый файл: gates/ready-gate.mjs.
//
// Приёмка этого гейта по концепции звучит так: «G24 зелёный И доказано, что умеет
// краснеть». Второе здесь важнее первого. Прошлый урок проекта — `CONTRACT_VIOLATIONS
// = 0` при нулевом покрытии: гейт был зелёным, потому что ничего не проверял.
// Поэтому каждая проверка ниже сначала подкладывает нарушение и требует, чтобы гейт
// его назвал, и только потом убеждается, что на чистом проекте он молчит.
//
// Второй урок — из этой же сессии: гейт покраснел на ВЕРНОМ коде, потому что
// сравнивал позиции строк `import`, а не вызовов. Ложное срабатывание опаснее
// пропуска: гейт, который краснеет без причины, отключают, и тогда он не поймает
// настоящее нарушение. Поэтому проверяется и обратное — что верный порядок вызовов
// признаётся верным.

import test from 'node:test';
import assert from 'node:assert/strict';

import { checkReady, selfTestReady, CONSOLE_OK, STRONG_SIGNS } from '../../gates/verify.mjs';
import { tempRoot, cleanup } from '../helpers/harness.mjs';
import { put, cleanProject } from '../helpers/project.mjs';

const said = (res) => res.items.map((i) => `${i.path}:${i.line ?? '-'} ${i.message}`).join('\n');

/**
 * Минимальный проект с подключённой готовностью.
 * Гейт читает `server/index.mjs` и `server/ready.mjs`: без них он справедливо
 * жалуется, и проверить что-то другое было бы нельзя.
 */
const withReady = (root, { order = 'right', extra = {} } = {}) => {
  cleanProject(root);
  put(root, 'server/ready.mjs', 'export const UNKNOWN = "unknown";\n');

  const readyLine = '  if (handleReady(req, res, { path, ready })) return;';
  const authLine = '  const auth = checkRequest(req, { token, port, path });';
  const body = order === 'right' ? [readyLine, authLine] : [authLine, readyLine];

  put(root, 'server/index.mjs', [
    "import { handleReady } from './routes-ready.mjs';",
    "import { checkRequest } from './auth.mjs';",
    '',
    'const handler = (req, res) => {',
    ...body,
    '};',
    '',
    'export default handler;',
    '',
  ].join('\n'));

  for (const [path, text] of Object.entries(extra)) put(root, path, text);
};

// ── самопроверка гейта ───────────────────────────────────────────────────────

test('гейт умеет краснеть: самопроверка находит подложенный вызов', () => {
  // Это и есть ответ на «гейт, который не может покраснеть, — не гейт». Проверка
  // встроена в сам гейт и делает его красным, если он ослеп.
  const out = selfTestReady();

  assert.equal(out.ok, true, out.why ?? '');
});

// ── печать в консоль ─────────────────────────────────────────────────────────

test('console.log на боевом пути поймана с местом', () => {
  // В GUI-режиме у процесса нет stdout: запись либо теряется, либо валит процесс.
  const root = tempRoot();
  try {
    withReady(root, {
      extra: { 'server/loud.mjs': 'export const f = () => {\n  console.log("состояние");\n};\n' },
    });

    const res = checkReady(root);
    assert.match(said(res), /server\/loud\.mjs:2/);
    assert.match(said(res), /stdout нет/, 'не сказано, чем это грозит');
  } finally { cleanup(root); }
});

test('печать в гейтах и тестах нарушением не считается', () => {
  // Их запускает человек из терминала — там консоль есть, и вывод является их
  // продуктом. Запрет на печать в гейте сделал бы гейты бесполезными.
  const root = tempRoot();
  try {
    withReady(root, {
      extra: {
        'gates/my-gate.mjs': 'console.log("отчёт гейта");\n',
        'tests/unit/x.test.mjs': 'console.log("подробности провала");\n',
        'legacy/migrate.mjs': 'console.log("план миграции");\n',
      },
    });

    assert.equal(checkReady(root).count, 0, said(checkReady(root)));
  } finally { cleanup(root); }
});

test('упоминание console.log в комментарии не краснеет', () => {
  // Иначе объяснение запрета приходилось бы писать загадками.
  const root = tempRoot();
  try {
    withReady(root, {
      extra: { 'server/ok.mjs': '// здесь нельзя console.log(x): нет stdout\nexport const f = () => 1;\n' },
    });

    assert.equal(checkReady(root).count, 0, said(checkReady(root)));
  } finally { cleanup(root); }
});

test('список разрешённых на печать назван явно', () => {
  // Молчаливое исключение однажды разрастётся. Список — данные, его видно.
  for (const dir of ['gates', 'legacy', 'tests', 'bridge']) {
    assert.equal(CONSOLE_OK.includes(dir), true, `${dir} обязан быть в списке`);
  }
  assert.equal(CONSOLE_OK.includes('server'), false, 'боевой путь не может печатать');
});

// ── порядок: готовность до токена ────────────────────────────────────────────

test('готовность после проверки токена поймана', () => {
  // Супервизор и деплой токена не знают. `/readyz` под токеном для них всё равно
  // что отсутствует, и критерий успеха деплоя становится недостижим.
  const root = tempRoot();
  try {
    withReady(root, { order: 'wrong' });

    assert.match(said(checkReady(root)), /готовность проверяется после токена/);
  } finally { cleanup(root); }
});

test('верный порядок вызовов признаётся верным', () => {
  // Обратная сторона: первая версия гейта сравнивала позиции строк `import`, где
  // `checkRequest` объявлен раньше, и краснела на правильном коде. Ложное
  // срабатывание опаснее пропуска — гейт отключают, и он не ловит уже ничего.
  const root = tempRoot();
  try {
    withReady(root, { order: 'right' });

    assert.equal(checkReady(root).count, 0, said(checkReady(root)));
  } finally { cleanup(root); }
});

test('отсутствие маршрутов готовности поймано', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'server/ready.mjs', 'export const UNKNOWN = "unknown";\n');
    put(root, 'server/index.mjs', 'const handler = () => 1;\nexport default handler;\n');

    assert.match(said(checkReady(root)), /маршруты готовности не подключены/);
  } finally { cleanup(root); }
});

test('отсутствие модуля готовности названо отдельно', () => {
  // «Нечем принимать деплой» — другая проблема, чем «маршрут не подключён», и
  // чинится по-другому.
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'server/index.mjs', 'const handler = () => 1;\nexport default handler;\n');

    assert.match(said(checkReady(root)), /нет модуля готовности/);
  } finally { cleanup(root); }
});

// ── критерий деплоя ─────────────────────────────────────────────────────────

test('деплой без сверки версии пойман', () => {
  // Главная проверка гейта. «Порт занят» удовлетворяется старым процессом, который
  // не умер, — и деплой рапортует успех при работающем прежнем коде.
  const root = tempRoot();
  try {
    withReady(root, {
      extra: {
        'deploy.mjs': [
          'export const deploy = async () => {',
          '  // успех: порт занят',
          '  const ok = await portBusy(8791);',
          '  return ok;',
          '};',
          '',
        ].join('\n'),
      },
    });

    const res = checkReady(root);
    const text = said(res);

    for (const sign of STRONG_SIGNS) {
      assert.match(text, new RegExp(`«${sign}»`), `не назван пропущенный признак ${sign}`);
    }
    assert.match(text, /этому признаку удовлетворяет и старый процесс/);
  } finally { cleanup(root); }
});

test('деплой со всеми тремя признаками проходит', () => {
  const root = tempRoot();
  try {
    withReady(root, {
      extra: {
        'deploy.mjs': [
          'export const deploy = async (expect) => {',
          '  const res = await fetch(url + "readyz");',
          '  const data = await res.json();',
          '  return res.status === 200',
          '    && data.code_version === expect.code_version',
          '    && data.release_id === expect.release_id;',
          '};',
          '',
        ].join('\n'),
      },
    });

    assert.equal(checkReady(root).count, 0, said(checkReady(root)));
  } finally { cleanup(root); }
});

test('отсутствие deploy.mjs нарушением не считается', () => {
  // Слой релизов ставится тикетом T-115.1. До него проверять нечего, и красный
  // гейт здесь означал бы «сделай всё сразу».
  const root = tempRoot();
  try {
    withReady(root);

    assert.equal(checkReady(root).count, 0, said(checkReady(root)));
  } finally { cleanup(root); }
});

// ── чистый проект ────────────────────────────────────────────────────────────

test('на настоящем проекте гейт зелёный', () => {
  // Последняя проверка, а не первая: зелёный на чистом проекте ничего не значит,
  // пока не доказано, что гейт умеет краснеть.
  const res = checkReady(process.cwd());

  assert.equal(res.count, 0, said(res));
  assert.equal(res.selfTested, true, 'гейт не прошёл самопроверку');
});
