// gates/trace-check.mjs — гейт трассы: у каждого требования есть файл и тест.
//
// Требование: REQ-GATE-TRACE (docs/SPEC.md §10). Трасса: trace.csv.
// Тест: tests/unit/gates.test.mjs.
//
// Что проверяется:
//   1. каждое REQ-* из docs/SPEC.md есть в trace.csv;
//   2. файл, указанный в трассе, существует;
//   3. тест, указанный в трассе, существует;
//   4. статус `done` подтверждён существующим тестом — иначе это обещание.
//
// Смысл гейта: не дать написать «готово» там, где нечего запустить.
// Слово «готово» без exit 0 запрещено (docs/RULES.md §4).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { result, report } from './scan.mjs';

const BASELINE = '.trace-baseline.json';
const STATUSES = ['planned', 'partial', 'done', 'blocked'];

/** Разбор trace.csv. Формат простой: запятые внутри полей не допускаются. */
export const readTrace = (root = process.cwd()) => {
  const text = readFileSync(join(root, 'trace.csv'), 'utf8');
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const head = lines.shift().split(',').map((s) => s.trim());

  return lines.map((line, i) => {
    const cells = line.split(',').map((s) => s.trim());
    const row = { _line: i + 2 };
    head.forEach((key, n) => { row[key] = cells[n] ?? ''; });
    return row;
  });
};

/** Требования из SPEC: они перечислены в таблицах первым столбцом. */
export const readSpecReqs = (root = process.cwd()) => {
  const text = readFileSync(join(root, 'docs', 'SPEC.md'), 'utf8');
  const out = new Map();

  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*(REQ-[A-Z]+-[A-Z0-9]+)\s*\|(.*)\|\s*(\w+)\s*\|\s*$/);
    if (m) out.set(m[1], m[3]);
  }
  return out;
};

const checkRow = (root, row, seen) => {
  const items = [];
  const where = { path: 'trace.csv', line: row._line };

  if (!/^REQ-[A-Z]+-[A-Z0-9]+$/.test(row['REQ-ID'])) {
    items.push({ ...where, message: `«${row['REQ-ID']}» не похож на идентификатор требования` });
    return items;
  }
  if (seen.has(row['REQ-ID'])) {
    items.push({ ...where, message: `${row['REQ-ID']} встречается второй раз` });
  }
  seen.add(row['REQ-ID']);

  if (!STATUSES.includes(row.status)) {
    items.push({ ...where, message: `статус «${row.status}» не из списка ${STATUSES.join(' | ')}` });
  }

  const fileExists = row.file === '-' || existsSync(join(root, row.file));
  if (!fileExists) {
    items.push({ ...where, message: `${row['REQ-ID']}: файл «${row.file}» не существует` });
  }

  const testExists = row.test === '-' || existsSync(join(root, row.test));
  if (!testExists && row.status === 'done') {
    // Главная проверка: «готово» без запускаемого теста — это обещание.
    items.push({ ...where, message: `${row['REQ-ID']}: статус done, но теста «${row.test}» нет` });
  }

  return items;
};

export const check = (root = process.cwd()) => {
  const rows = readTrace(root);
  const spec = readSpecReqs(root);
  const items = [];
  const seen = new Set();

  for (const row of rows) items.push(...checkRow(root, row, seen));

  /**
   * Требование в трассе, которого нет в спеке.
   *
   * Проверка добавлена после того, как разошлись числа: 61 строка `done` в трассе
   * против 60 в спеке. Гейт молчал, потому что смотрел только в одну сторону —
   * «спека → трасса». Разница ровно и была дефектом: `REQ-CFG-ROOT` жил в трассе,
   * а требования к нему никто не формулировал.
   *
   * Одностороннюю проверку легко принять за полную: она ловит забытую строку в
   * трассе, но не ловит требование, которое существует в коде и тестах, а в спеке
   * не описано. Второе хуже: человек читает спеку и не знает, что такое поведение
   * вообще обещано.
   */
  for (const req of seen) {
    if (!spec.has(req)) {
      items.push({
        path: 'trace.csv',
        line: rows.find((r) => r['REQ-ID'] === req)?._line ?? null,
        message: `${req} есть в trace.csv, но не описан в docs/SPEC.md`,
      });
    }
  }

  for (const [req, status] of spec) {
    if (!seen.has(req)) {
      items.push({ path: 'docs/SPEC.md', message: `${req} есть в спеке, но отсутствует в trace.csv` });
      continue;
    }
    const row = rows.find((r) => r['REQ-ID'] === req);
    if (row && row.status !== status) {
      items.push({
        path: 'trace.csv',
        // `row._line`, а не `row.line`: поля с таким именем в строке трассы нет,
        // и гейт печатал «trace.csv» без номера. Ошибка тихая — гейт срабатывал
        // верно, но не говорил, где искать, а он существует именно для того,
        // чтобы два источника правды не разъезжались молча.
        line: row._line,
        message: `${req}: в спеке «${status}», в трассе «${row.status}» — расхождение источников правды`,
      });
    }
  }

  const untested = rows.filter((r) => r.test === '-' || !existsSync(join(root, r.test)));
  const base = readBaseline(root);

  const res = result('трасса', items, { baseline: base.violations });
  res.untested = untested.length;
  res.untestedBaseline = base.untested ?? 0;
  res.total = rows.length;

  // Непокрытых требований не должно становиться больше — это храповик.
  if (untested.length > res.untestedBaseline) {
    res.ok = false;
    res.note = `без теста ${untested.length}, было ${res.untestedBaseline}: новое требование добавлено без теста`;
  } else if (untested.length < res.untestedBaseline) {
    res.note = `без теста ${untested.length}, было ${res.untestedBaseline} — обновите базовую линию`;
  } else {
    res.note = `без теста ${untested.length} из ${rows.length}`;
  }

  return res;
};

const readBaseline = (root) => {
  try {
    return JSON.parse(readFileSync(join(root, BASELINE), 'utf8'));
  } catch {
    return { violations: 0, untested: 0 };
  }
};

export const writeBaseline = (root, res) => {
  writeFileSync(join(root, BASELINE), `${JSON.stringify({
    note: 'Пишется только gates/trace-check.mjs. Правка руками запрещена (docs/RULES.md §7).',
    generated_at: new Date().toISOString(),
    total: res.total,
    violations: res.count,
    untested: res.untested,
    items: res.items,
  }, null, 2)}\n`, 'utf8');
};

if (process.argv[1] && relative(process.cwd(), process.argv[1]).includes('trace-check')) {
  const res = check();
  const ok = report(res);
  if (process.argv.includes('--write')) writeBaseline(process.cwd(), res);
  process.exit(ok ? 0 : 1);
}
