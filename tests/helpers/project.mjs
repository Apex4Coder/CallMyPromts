// tests/helpers/project.mjs — временный проект-фикстура для тестов гейтов.
//
// Требования: REQ-GATE-ARCH, REQ-GATE-CHUNK, REQ-GATE-TRACE, REQ-GATE-SECRET.
// Используют: tests/unit/gates.test.mjs, tests/unit/gates-trace.test.mjs.
//
// Гейты читают файлы проекта: arch.yaml, trace.csv, docs/SPEC.md, .gitignore.
// Проверять их на настоящем проекте нельзя по двум причинам: результат зависел бы
// от текущего состояния кода, и нарушение пришлось бы вносить в рабочие файлы.
// Здесь собирается маленький проект, в котором нарушение делается намеренно.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Файл с автоматическим созданием папок. Путь — от корня фикстуры. */
export const put = (root, rel, text) => {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text, 'utf8');
  return full;
};

/**
 * Карта границ. Отступы важны: разбор в gates/arch-check.mjs построчный, два
 * пробела — имя модуля, четыре — поле.
 *
 * @param {Record<string, {path?: string, entry?: string, layer?: string,
 *   may_depend_on?: string[], owns_req?: string[]}>} modules
 */
export const archYaml = (root, modules, { layers = ['ui', 'app', 'domain'] } = {}) => {
  const lines = [`layers: [${layers.join(', ')}]`, '', 'modules:'];

  for (const [name, m] of Object.entries(modules)) {
    lines.push(`  ${name}:`);
    lines.push(`    path: ${m.path ?? name}`);
    lines.push(`    entry: ${m.entry ?? `${name}/index.mjs`}`);
    lines.push(`    layer: ${m.layer ?? 'domain'}`);
    lines.push(`    may_depend_on: [${(m.may_depend_on ?? []).join(', ')}]`);
    lines.push(`    owns_req: [${(m.owns_req ?? []).join(', ')}]`);
  }

  return put(root, 'arch.yaml', `${lines.join('\n')}\n`);
};

/** Строка трассы. Порядок столбцов — как в trace.csv проекта. */
export const traceRow = ({
  req, module: mod = 'core', file = 'core/index.mjs',
  test = 'tests/unit/core.test.mjs', scenario = '-', status = 'planned',
}) => `${req},${mod},${file},${test},${scenario},${status}`;

export const traceCsv = (root, rows) => put(
  root,
  'trace.csv',
  `REQ-ID,module,file,test,scenario,status\n${rows.join('\n')}\n`,
);

/**
 * Спека с таблицей требований. Формат строки задан разбором в
 * gates/trace-check.mjs: `| REQ-* | описание | критерий | статус |`.
 *
 * @param {Array<[string, string]>} reqs пары «требование, статус»
 */
export const specMd = (root, reqs) => {
  const lines = [
    '# SPEC — тестовая спека',
    '',
    '| ID | Требование | Критерий | Статус |',
    '|---|---|---|---|',
    ...reqs.map(([req, status]) => `| ${req} | описание | критерий | ${status} |`),
    '',
  ];
  return put(root, 'docs/SPEC.md', `${lines.join('\n')}\n`);
};

/** Минимальный проект, на котором все гейты зелёные. Основа для порчи. */
export const cleanProject = (root) => {
  archYaml(root, {
    core: { layer: 'domain', may_depend_on: [], owns_req: ['REQ-CORE-ONE'] },
    app: { layer: 'app', may_depend_on: ['core'], owns_req: ['REQ-APP-ONE'] },
  });

  put(root, 'core/index.mjs', 'export const one = () => 1;\n');
  put(root, 'app/index.mjs', "import { one } from '../core/index.mjs';\n\nexport const two = () => one() + 1;\n");

  traceCsv(root, [
    traceRow({ req: 'REQ-CORE-ONE', module: 'core', file: 'core/index.mjs', test: 'tests/unit/core.test.mjs' }),
    traceRow({ req: 'REQ-APP-ONE', module: 'app', file: 'app/index.mjs', test: 'tests/unit/app.test.mjs' }),
  ]);
  specMd(root, [['REQ-CORE-ONE', 'planned'], ['REQ-APP-ONE', 'planned']]);

  put(root, 'tests/unit/core.test.mjs', '// пусто\n');
  put(root, 'tests/unit/app.test.mjs', '// пусто\n');
  put(root, '.gitignore', 'state/\nnode_modules/\n');

  return root;
};
