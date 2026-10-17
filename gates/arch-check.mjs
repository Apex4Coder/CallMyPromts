// gates/arch-check.mjs — гейт границ: соблюдается ли карта arch.yaml.
//
// Требование: REQ-GATE-ARCH (docs/SPEC.md §10). Карта: arch.yaml.
// Тест: tests/unit/gates.test.mjs.
//
// Проверяет три вещи:
//   1. импорт разрешён картой (`may_depend_on`);
//   2. импорт идёт через публичный барьер модуля, а не в его внутренности;
//   3. в графе нет циклов.
//
// Карта не подгоняется под код. Если нарушение реальное — его исправляют или
// вносят в базовую линию с датой, но не переписывают may_depend_on «чтобы прошло»
// (docs/RULES.md §7).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';

import { parseFlatYaml } from '../contracts/index.mjs';
import { scan, moduleOf, importsOf, result, report } from './scan.mjs';

const BASELINE = '.arch-baseline.json';

/**
 * Разбор arch.yaml. Свой парсер понимает только плоские отображения, поэтому
 * вложенная структура читается построчно по отступам — этого достаточно для
 * формата карты и не тянет зависимость (docs/DATA-CONTRACTS.md §7).
 */
export const readArch = (root = process.cwd()) => {
  const text = readFileSync(join(root, 'arch.yaml'), 'utf8');
  const lines = text.split('\n');

  const modules = {};
  let layers = [];
  let current = null;
  let inModules = false;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    if (/^layers:/.test(line)) {
      layers = parseFlatYaml(line).layers ?? [];
      continue;
    }
    if (/^modules:\s*$/.test(line)) {
      inModules = true;
      continue;
    }
    if (!inModules) continue;

    const head = line.match(/^ {2}([a-z][\w-]*):\s*$/);
    if (head) {
      current = head[1];
      modules[current] = { path: current, entry: null, layer: null, may_depend_on: [], owns_req: [] };
      continue;
    }

    const field = line.match(/^ {4}(\w+):\s*(.*)$/);
    if (field && current) {
      const [, key, value] = field;
      modules[current][key] = parseFlatYaml(`${key}: ${value}`)[key];
    }
  }

  return { layers, modules };
};

/** Куда ведёт относительный импорт: путь от корня проекта. */
const resolveImport = (fromPath, spec) => {
  if (!spec.startsWith('.')) return null; // node:* и пакеты — не наша граница
  const joined = normalize(join(dirname(fromPath), spec)).split(sep).join('/');
  return joined.replace(/^\.\//, '');
};

/** Поиск циклов обходом в глубину. Возвращает первый найденный цикл. */
export const findCycle = (modules) => {
  const grey = new Set();
  const black = new Set();

  const walk = (name, trail) => {
    if (grey.has(name)) return [...trail, name];
    if (black.has(name)) return null;
    grey.add(name);

    for (const next of modules[name]?.may_depend_on ?? []) {
      if (!modules[next]) continue;
      const found = walk(next, [...trail, name]);
      if (found) return found;
    }

    grey.delete(name);
    black.add(name);
    return null;
  };

  for (const name of Object.keys(modules)) {
    const found = walk(name, []);
    if (found) return found;
  }
  return null;
};

export const check = (root = process.cwd()) => {
  const { modules } = readArch(root);
  const files = scan(root);
  const items = [];

  const cycle = findCycle(modules);
  if (cycle) {
    items.push({ path: 'arch.yaml', message: `цикл в графе зависимостей: ${cycle.join(' → ')}` });
  }

  for (const file of files) {
    const owner = moduleOf(file.path, modules);
    if (!owner) continue;

    const lines = file.text.split('\n');

    for (const spec of importsOf(file.text)) {
      const target = resolveImport(file.path, spec);
      if (!target) continue;

      const targetModule = moduleOf(target, modules);
      if (!targetModule || targetModule === owner) continue;

      const line = lines.findIndex((l) => l.includes(spec)) + 1;
      const allowed = modules[owner]?.may_depend_on ?? [];

      if (!allowed.includes(targetModule)) {
        items.push({
          path: file.path,
          line,
          message: `«${owner}» не имеет права зависеть от «${targetModule}» (разрешено: ${allowed.join(', ') || 'ничего'})`,
        });
        continue;
      }

      // Барьер: импортировать можно только entry модуля.
      const entry = modules[targetModule]?.entry;
      if (entry && target !== entry && !target.startsWith(`${entry}/`)) {
        items.push({
          path: file.path,
          line,
          message: `импорт мимо барьера: «${target}» вместо «${entry}»`,
        });
      }
    }
  }

  return result('границы', items, { baseline: readBaseline(root).violations });
};

const readBaseline = (root) => {
  try {
    return JSON.parse(readFileSync(join(root, BASELINE), 'utf8'));
  } catch {
    return { violations: 0, items: [] };
  }
};

/** Запись базовой линии. Только этот файл её пишет (docs/RULES.md §7). */
export const writeBaseline = (root, res) => {
  writeFileSync(join(root, BASELINE), `${JSON.stringify({
    note: 'Пишется только gates/arch-check.mjs. Правка руками запрещена (docs/RULES.md §7).',
    generated_at: new Date().toISOString(),
    violations: res.count,
    items: res.items,
  }, null, 2)}\n`, 'utf8');
};

if (process.argv[1] && relative(process.cwd(), process.argv[1]).includes('arch-check')) {
  const res = check();
  const ok = report(res);
  if (process.argv.includes('--write')) writeBaseline(process.cwd(), res);
  process.exit(ok ? 0 : 1);
}
