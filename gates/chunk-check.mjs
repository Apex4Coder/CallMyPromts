// gates/chunk-check.mjs — гейт размера: файлы, функции, строки, вложенность.
//
// Требование: REQ-GATE-CHUNK (docs/SPEC.md §10). Лимиты: docs/RULES.md §3.
// Тест: tests/unit/gates.test.mjs.
//
// Зачем машинная проверка размера. Прежняя система держала тексты 25 промптов
// внутри fill.py на 425 строках, и одна ошибка в условии `stub()` молча стирала
// содержимое файла. Такие ошибки живут именно в больших файлах: их не видно
// целиком, и правка делается «вслепую».
//
// Лимиты не абсолютная истина, а порог внимания. Файл на 320 строк не хуже файла
// на 280 — но привычка не смотреть на размер заканчивается файлом на 1200.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { scan, result, report } from './scan.mjs';

const BASELINE = '.chunk-baseline.json';

export const LIMITS = {
  fileLines: 300,
  funcLines: 60,
  lineChars: 400,
  nesting: 3,
};

/** Разметка и стили меряются свободнее: там нет ветвлений, которые надо держать в голове. */
const SOFT_EXT = /\.(css|html|ahk)$/;
const SOFT_FILE_LINES = 400;

// Подсчёт фигурных скобок для этой задачи не годится: он не отличает блок кода от
// объекта-литерала и от многострочной сигнатуры, и две попытки его настроить дали
// ложные срабатывания. Здесь признак другой — ОТСТУП. В проекте единый стиль
// форматирования, поэтому уровень вложенности виден по отступу надёжнее, чем по
// скобкам, и не требует парсера.

const CONTROL_START = /^\s*(?:\}\s*)?(?:if|for|while|switch|try|catch|do|else)\b/;

/**
 * Признаки начала функции. Стрелочные функции, присвоенные в const, — основная
 * форма в этом проекте, и первая версия шаблона их не видела: гейт показывал
 * «0 функций» на файлах, состоящих из функций. Зелёный гейт из-за слепоты хуже
 * красного (docs/RULES.md §4), поэтому форма перечислена явно.
 */
const FUNC_FORMS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?(?:function\b|[^=]*=>)/,
  /^\s*(?:static\s+)?(?:async\s+)?(?:get|set)\s+[\w$]+\s*\(/,
  /^\s*constructor\s*\(/,
  /^\s*(?:static\s+)?(?:async\s+)?[#\w$]+\s*\([^)]*\)\s*\{\s*$/,
];

/** Закрывающая строка блока: только скобка и знаки после неё. */
const CLOSER = /^\}[;,)\s]*$/;

/** Хвост многострочной сигнатуры: `} = {}) {` — тело начинается здесь. */
const SIGN_TAIL = /^\s*\}[^{]*\)\s*\{\s*$/;

const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, '  ').length;

const meaningful = (line) => {
  const s = line.trim();
  return s !== '' && !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*');
};

const isFuncStart = (line) => {
  const s = line.trimEnd();
  if (!s.endsWith('{')) return false;
  if (s.trimStart().startsWith('}')) return false;
  if (CONTROL_START.test(s)) return false;
  return FUNC_FORMS.some((re) => re.test(s));
};

const isControlStart = (line) => line.trimEnd().endsWith('{') && CONTROL_START.test(line);

/**
 * Длина функций и глубина ветвления по отступам.
 *
 * Функция: строка-сигнатура, оканчивающаяся на `{`, до первой строки с тем же
 * отступом, состоящей только из закрывающей скобки. Многострочная сигнатура
 * опознаётся по хвосту `} = {}) {`, началом считается строка с тем же отступом
 * выше — иначе методы с разнесёнными параметрами не измерялись бы вовсе.
 *
 * Вложенность: считаются ТОЛЬКО ветвления (if, for, while, switch, try). Тело
 * модуля, класса и объекта уровней не добавляет — иначе объект с вложенным
 * объектом выглядел бы как код глубиной 3, и метрика перестала бы что-то значить.
 */
export const measure = (text) => {
  const lines = text.split('\n');
  const funcs = [];

  const findEnd = (from, indent) => {
    for (let i = from + 1; i < lines.length; i += 1) {
      if (!meaningful(lines[i])) continue;
      if (indentOf(lines[i]) === indent && CLOSER.test(lines[i].trim())) return i;
      if (indentOf(lines[i]) < indent) return i - 1; // блок закончился без своей скобки
    }
    return lines.length - 1;
  };

  const findSignStart = (from, indent) => {
    for (let i = from - 1; i >= 0; i -= 1) {
      if (!meaningful(lines[i])) continue;
      if (indentOf(lines[i]) === indent) return i;
      if (indentOf(lines[i]) < indent) return from;
    }
    return from;
  };

  const stack = [];
  let maxDepth = 0;
  let maxDepthLine = 0;

  lines.forEach((raw, i) => {
    if (!meaningful(raw)) return;
    const indent = indentOf(raw);

    while (stack.length > 0 && indent <= stack.at(-1)) stack.pop();

    if (isControlStart(raw)) {
      stack.push(indent);
      if (stack.length > maxDepth) {
        maxDepth = stack.length;
        maxDepthLine = i + 1;
      }
      return;
    }

    if (SIGN_TAIL.test(raw)) {
      const start = findSignStart(i, indent);
      const end = findEnd(i, indent);
      funcs.push({ start: start + 1, end: end + 1, lines: end - start + 1 });
      return;
    }

    if (isFuncStart(raw)) {
      const end = findEnd(i, indent);
      funcs.push({ start: i + 1, end: end + 1, lines: end - i + 1 });
    }
  });

  return { lines: lines.length, funcs, maxDepth, maxDepthLine };
};

export const check = (root = process.cwd()) => {
  const files = scan(root);
  const items = [];

  for (const file of files) {
    const soft = SOFT_EXT.test(file.path);
    const limit = soft ? SOFT_FILE_LINES : LIMITS.fileLines;
    const m = measure(file.text);

    if (m.lines > limit) {
      items.push({ path: file.path, line: limit + 1, message: `${m.lines} строк, порог ${limit} — разделите по смыслу` });
    }

    const lines = file.text.split('\n');
    lines.forEach((l, i) => {
      if (l.length > LIMITS.lineChars) {
        items.push({ path: file.path, line: i + 1, message: `строка ${l.length} знаков, порог ${LIMITS.lineChars}` });
      }
    });

    if (soft) continue;

    for (const f of m.funcs) {
      if (f.lines > LIMITS.funcLines) {
        items.push({ path: file.path, line: f.start, message: `функция ${f.lines} строк, порог ${LIMITS.funcLines}` });
      }
    }

    if (m.maxDepth > LIMITS.nesting) {
      items.push({ path: file.path, line: m.maxDepthLine, message: `вложенность ветвлений ${m.maxDepth}, порог ${LIMITS.nesting}` });
    }
  }

  return result('размер чанков', items, { baseline: readBaseline(root).violations });
};

const readBaseline = (root) => {
  try {
    return JSON.parse(readFileSync(join(root, BASELINE), 'utf8'));
  } catch {
    return { violations: 0, items: [] };
  }
};

export const writeBaseline = (root, res) => {
  writeFileSync(join(root, BASELINE), `${JSON.stringify({
    note: 'Пишется только gates/chunk-check.mjs. Правка руками запрещена (docs/RULES.md §7).',
    generated_at: new Date().toISOString(),
    limits: LIMITS,
    violations: res.count,
    items: res.items,
  }, null, 2)}\n`, 'utf8');
};

if (process.argv[1] && relative(process.cwd(), process.argv[1]).includes('chunk-check')) {
  const res = check();
  const ok = report(res);
  if (process.argv.includes('--write')) writeBaseline(process.cwd(), res);
  process.exit(ok ? 0 : 1);
}
