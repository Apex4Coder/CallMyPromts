// gates/scan.mjs — общий обход файлов проекта для всех гейтов.
//
// Требование: REQ-GATE-CHUNK и остальные гейты (docs/SPEC.md §10).
//
// Один обход вместо четырёх: иначе каждый гейт имел бы своё мнение о том, какие
// файлы относятся к проекту, и правило «пропускать state/» приходилось бы
// исправлять в четырёх местах (docs/RULES.md §1).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Не наш код или не код вовсе. state/ и backup/ содержат данные пользователя. */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'state', 'backup', 'test-results',
  'playwright-report', '.vscode', 'prompts',
]);

/** Файлы прежней системы: выведены из пайплайна, гейтами не проверяются. */
export const LEGACY_FILES = new Set([
  'fill.py', 'items.py', 'doctor.py', 'stats.py', 'force.py', 'sync_menu.py',
  'start1_tree.py', 'start2_files.py', 'start3_espanso.py', 'start4_link.py', 'start5_hotkeys.py',
  'guide.html', 'RUN_ALL.bat', 'SYNC_MENU.bat', 'README.txt',
]);

export const CODE_EXT = /\.(mjs|js|css|html|ahk)$/;

/** Все файлы проекта с содержимым. Путь всегда с прямыми слэшами. */
export const scan = (root = process.cwd(), { ext = CODE_EXT, skipLegacy = true } = {}) => {
  const out = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.gitignore') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full);
        continue;
      }
      if (!e.isFile() || !ext.test(e.name)) continue;
      if (skipLegacy && LEGACY_FILES.has(e.name)) continue;

      const rel = relative(root, full).split(sep).join('/');
      out.push({ path: rel, full, text: readFileSync(full, 'utf8'), bytes: statSync(full).size });
    }
  };

  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
};

/** К какому модулю относится файл. Порядок по длине пути: `.` не съедает всё. */
export const moduleOf = (path, modules) => {
  const sorted = Object.entries(modules)
    .map(([name, m]) => ({ name, path: m.path === '.' ? '' : m.path }))
    .sort((a, b) => b.path.length - a.path.length);

  for (const m of sorted) {
    if (m.path === '' || path === m.path || path.startsWith(`${m.path}/`)) return m.name;
  }
  return null;
};

/** Импорты файла: только относительные — внешних зависимостей в рантайме нет. */
export const importsOf = (text) => {
  const out = [];
  const re = /(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m = re.exec(text);
  while (m) {
    out.push(m[1] ?? m[2]);
    m = re.exec(text);
  }
  return out;
};

/** Единый формат результата гейта: ответ на «прошло или нет» и почему. */
export const result = (name, items, { baseline = 0, note = null } = {}) => ({
  gate: name,
  count: items.length,
  baseline,
  ok: items.length <= baseline,
  worse: Math.max(0, items.length - baseline),
  better: Math.max(0, baseline - items.length),
  items,
  note,
});

/** Печать результата. Каждое нарушение с местом: без места отладка — угадывание. */
export const report = (res, { limit = 25 } = {}) => {
  const head = res.ok ? '✓' : '✕';
  process.stdout.write(`${head} ${res.gate}: ${res.count} (порог ${res.baseline})\n`);

  for (const it of res.items.slice(0, limit)) {
    const where = it.line ? `${it.path}:${it.line}` : it.path;
    process.stdout.write(`    ${where} — ${it.message}\n`);
  }
  if (res.items.length > limit) {
    process.stdout.write(`    …и ещё ${res.items.length - limit}\n`);
  }
  if (res.better > 0) {
    process.stdout.write(`    стало лучше на ${res.better}: обновите базовую линию\n`);
  }
  if (res.note) process.stdout.write(`    ${res.note}\n`);

  return res.ok;
};
