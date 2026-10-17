// tests/unit/gates.test.mjs — гейт границ между модулями.
//
// Требование: REQ-GATE-ARCH (docs/SPEC.md §10).
// Проверяемый файл: gates/arch-check.mjs.
// Размер чанков — в tests/unit/gates-chunk.test.mjs, трасса и секреты — в
// tests/unit/gates-trace.test.mjs.
//
// Гейт, который ничего не ловит, хуже отсутствия гейта: он даёт уверенность без
// оснований. Поэтому каждая проверка здесь делает нарушение НАМЕРЕННО и требует,
// чтобы гейт его назвал с местом. Проверять «на чистом проекте зелено» —
// недостаточно: слепой гейт зелёный всегда.
//
// Все проверки работают на временном проекте-фикстуре (tests/helpers/project.mjs),
// а не на настоящем: иначе результат зависел бы от текущего состояния кода.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkArch, readArch, findCycle,
  scan, moduleOf, importsOf,
} from '../../gates/verify.mjs';

import { tempRoot, cleanup } from '../helpers/harness.mjs';
import { put, archYaml, cleanProject } from '../helpers/project.mjs';

/** Сообщения одной строкой: искать подстроку удобнее, чем обходить массив. */
const said = (res) => res.items.map((i) => `${i.path}:${i.line ?? '-'} ${i.message}`).join('\n');

// ── чистый проект ────────────────────────────────────────────────────────────

test('на чистом проекте гейт границ молчит', () => {
  const root = tempRoot();
  try {
    cleanProject(root);

    assert.equal(checkArch(root).count, 0, said(checkArch(root)));
  } finally { cleanup(root); }
});

// ── разбор карты ─────────────────────────────────────────────────────────────

test('карта читается: модули, слои, разрешения', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    const { layers, modules } = readArch(root);

    assert.deepEqual(layers, ['ui', 'app', 'domain']);
    assert.deepEqual(Object.keys(modules), ['core', 'app']);
    assert.deepEqual(modules.app.may_depend_on, ['core']);
    assert.equal(modules.core.entry, 'core/index.mjs');
  } finally { cleanup(root); }
});

test('пустой список разрешений читается как пустой, а не как null', () => {
  // От этого зависит сообщение «разрешено: ничего»: null дал бы падение на
  // `.includes`, и гейт умер бы вместо того, чтобы назвать нарушение.
  const root = tempRoot();
  try {
    cleanProject(root);
    assert.deepEqual(readArch(root).modules.core.may_depend_on, []);
  } finally { cleanup(root); }
});

// ── границы: запрещённая зависимость ─────────────────────────────────────────

test('запрещённая зависимость поймана с именами модулей', () => {
  // Живой случай, который этот гейт уже поймал: gates/secret-check.mjs
  // импортировал library. Файл был переписан, карта — нет.
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'core/index.mjs', "import { two } from '../app/index.mjs';\n\nexport const one = () => two();\n");

    const res = checkArch(root);
    assert.equal(res.count >= 1, true, 'нарушение не поймано');
    assert.match(said(res), /«core» не имеет права зависеть от «app»/);
  } finally { cleanup(root); }
});

test('в сообщении названо, что именно разрешено', () => {
  // Без списка разрешённого человек не знает, куда двигать код.
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'core/index.mjs', "import { two } from '../app/index.mjs';\n");

    assert.match(said(checkArch(root)), /разрешено: ничего/);
  } finally { cleanup(root); }
});

test('нарушение указано со строкой', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'core/index.mjs', `// первая строка\n// вторая\nimport { two } from '../app/index.mjs';\n`);

    const bad = checkArch(root).items.find((i) => i.message.includes('не имеет права'));
    assert.equal(bad.line, 3, 'номер строки должен указывать на импорт');
  } finally { cleanup(root); }
});

test('разрешённая зависимость не считается нарушением', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    assert.equal(checkArch(root).count, 0);
  } finally { cleanup(root); }
});

// ── границы: барьер ──────────────────────────────────────────────────────────

test('импорт мимо барьера поймана', () => {
  // Барьер существует, чтобы внутренности модуля можно было менять. Импорт
  // «так короче» превращает любой внутренний файл в публичный контракт.
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'core/deep.mjs', 'export const deep = () => 0;\n');
    put(root, 'app/index.mjs', "import { deep } from '../core/deep.mjs';\n");

    assert.match(said(checkArch(root)), /импорт мимо барьера: «core\/deep\.mjs» вместо «core\/index\.mjs»/);
  } finally { cleanup(root); }
});

test('импорт внутри своего модуля барьером не ограничен', () => {
  // Иначе модуль не мог бы состоять более чем из одного файла.
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'core/deep.mjs', 'export const deep = () => 0;\n');
    put(root, 'core/index.mjs', "export { deep } from './deep.mjs';\n");

    assert.equal(checkArch(root).count, 0, said(checkArch(root)));
  } finally { cleanup(root); }
});

test('встроенные модули Node границей не считаются', () => {
  // `node:fs` — не наша граница, и жалоба на него сделала бы гейт бесполезным.
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'core/index.mjs', "import { readFileSync } from 'node:fs';\n\nexport const one = () => readFileSync;\n");

    assert.equal(checkArch(root).count, 0, said(checkArch(root)));
  } finally { cleanup(root); }
});

test('динамический импорт проверяется тоже', () => {
  // Иначе запрет обходился бы одной строкой `await import(...)`.
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'core/index.mjs', "export const one = async () => (await import('../app/index.mjs')).two();\n");

    assert.match(said(checkArch(root)), /«core» не имеет права зависеть от «app»/);
  } finally { cleanup(root); }
});

// ── границы: цикл ────────────────────────────────────────────────────────────

test('цикл в карте назван полным путём', () => {
  // Цикл означает, что модули нельзя ни собрать, ни проверить по отдельности.
  const root = tempRoot();
  try {
    archYaml(root, {
      core: { may_depend_on: ['app'] },
      app: { may_depend_on: ['core'] },
    });
    put(root, 'core/index.mjs', '// пусто\n');
    put(root, 'app/index.mjs', '// пусто\n');

    const res = checkArch(root);
    assert.match(said(res), /цикл в графе зависимостей/);
    assert.match(said(res), /→/, 'путь цикла показан');
  } finally { cleanup(root); }
});

test('цикл ищется и в трёх шагах', () => {
  const cycle = findCycle({
    a: { may_depend_on: ['b'] },
    b: { may_depend_on: ['c'] },
    c: { may_depend_on: ['a'] },
  });

  assert.notEqual(cycle, null);
  assert.equal(cycle.length >= 3, true, `путь слишком короткий: ${cycle?.join(' → ')}`);
});

test('дерево без циклов циклом не объявляется', () => {
  // Ромб — не цикл: два пути к одному модулю допустимы.
  assert.equal(findCycle({
    ui: { may_depend_on: ['app', 'core'] },
    app: { may_depend_on: ['core'] },
    core: { may_depend_on: [] },
  }), null);
});

// ── обход файлов ─────────────────────────────────────────────────────────────

test('обход не заходит в state и prompts', () => {
  // state/ — токен и журнал буфера с паролями, prompts/ — данные пользователя.
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'state/secret.mjs', '// сюда гейты не смотрят\n');
    put(root, 'prompts/code/x.mjs', '// и сюда\n');

    const paths = scan(root).map((f) => f.path);
    assert.equal(paths.some((p) => p.startsWith('state/')), false);
    assert.equal(paths.some((p) => p.startsWith('prompts/')), false);
  } finally { cleanup(root); }
});

test('пути всегда с прямыми слэшами', () => {
  // На Windows разделитель обратный, и сравнение с «core/index.mjs» ломалось бы.
  const root = tempRoot();
  try {
    cleanProject(root);
    for (const f of scan(root)) {
      assert.equal(f.path.includes('\\'), false, f.path);
    }
  } finally { cleanup(root); }
});

test('модуль определяется по самому длинному совпадению пути', () => {
  // Модуль config имеет путь «.» и без этого правила поглотил бы всё дерево.
  const modules = {
    config: { path: '.' },
    core: { path: 'core' },
  };

  assert.equal(moduleOf('core/index.mjs', modules), 'core');
  assert.equal(moduleOf('package.json', modules), 'config');
});

test('импорты вынимаются из всех форм записи', () => {
  const text = [
    "import a from './a.mjs';",
    "import { b } from './b.mjs';",
    "export { c } from './c.mjs';",
    "export * from './d.mjs';",
    "const e = await import('./e.mjs');",
  ].join('\n');

  assert.deepEqual(importsOf(text).sort(), ['./a.mjs', './b.mjs', './c.mjs', './d.mjs', './e.mjs']);
});

