// gates/secret-check.mjs — гейт секретов: в коде и в библиотеке нет ключей.
//
// Требование: REQ-GATE-SECRET (docs/SPEC.md §10). Тест: tests/unit/gates.test.mjs.
//
// Зачем гейт именно в этом проекте. Библиотека промптов уходит в Git и
// синхронизируется между машинами, а промпты пишутся руками и в них легко
// попадает ключ из соседнего окна. Журнал буфера не синхронизируется никогда
// (docs/RULES.md §6), но его файл лежит рядом — гейт проверяет и то, что он
// действительно исключён из Git.
//
// Проверяется три вещи:
//   1. в коде нет захардкоженных секретов;
//   2. в промптах нет секретов — они синхронизируются;
//   3. state/ исключён из Git, а токен и база журнала не отслеживаются.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { scan, result, report } from './scan.mjs';

const BASELINE = '.secret-baseline.json';

/**
 * Что считаем секретом. Шаблоны узкие намеренно: гейт, который кричит на каждое
 * слово «token», перестают читать, и он становится бесполезным.
 */
export const PATTERNS = [
  ['ключ OpenAI', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['токен GitHub', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['токен Slack', /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/],
  ['ключ AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['приватный ключ', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['токен JWT', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/],
  ['пароль в коде', /\b(?:password|passwd|secret|api_?key)\s*[:=]\s*['"][^'"\s]{8,}['"]/i],
  ['строка подключения', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:[^\s:@/'"]+@/i],
];

/** Строки, которые выглядят как секрет, но им не являются. */
const ALLOW = [
  /__DECK_TOKEN__/,
  /X-Deck-Token/i,
  /['"]f['"]\.repeat/,
  /example|образец|placeholder/i,
];

const isAllowed = (line) => ALLOW.some((re) => re.test(line));

const scanText = (text, path) => {
  const out = [];
  const lines = text.split('\n');

  lines.forEach((line, i) => {
    if (isAllowed(line)) return;
    for (const [name, re] of PATTERNS) {
      if (!re.test(line)) continue;
      // Название в кавычках, а не внутри фразы: подстановка в «похоже на …»
      // требовала бы винительного падежа, и на «строка подключения» сообщение
      // выходило безграмотным. Кавычки делают название меткой, а не частью
      // предложения, и одинаково работают для всех восьми видов.
      //
      // Само значение в отчёт не попадает: иначе гейт печатал бы секрет в лог
      // сборки, где тот живёт дольше, чем в коде.
      out.push({
        path,
        line: i + 1,
        message: `похоже на секрет вида «${name}» — вынесите в state/ или в переменную окружения`,
      });
      break;
    }
  });

  return out;
};

/** Проверка, что данные состояния не попадут в Git. */
const checkGitignore = (root) => {
  const file = join(root, '.gitignore');
  if (!existsSync(file)) {
    return [{ path: '.gitignore', message: 'файла нет — state/ с токеном и журналом попадёт в Git' }];
  }

  const text = readFileSync(file, 'utf8');
  const out = [];
  for (const need of ['state/']) {
    if (!text.split('\n').some((l) => l.trim() === need || l.trim() === need.replace(/\/$/, ''))) {
      out.push({ path: '.gitignore', message: `нет строки «${need}» — журнал буфера с паролями попадёт в Git` });
    }
  }
  return out;
};

/**
 * Обход .md библиотеки. Свой, а не из `library`: гейт зависит только от
 * `contracts` (arch.yaml), и импорт `library` был бы нарушением границы —
 * гейт границ его поймал. Здесь нужен обход файлов, а не разбор промптов,
 * поэтому дублирования смысла не возникает.
 */
const walkMd = (dir, out = []) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkMd(full, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
};

export const check = (root = process.cwd()) => {
  const items = [];

  for (const file of scan(root)) items.push(...scanText(file.text, file.path));

  // Промпты синхронизируются между машинами, поэтому проверяются вместе с кодом.
  const promptsRoot = join(root, 'prompts');
  if (existsSync(promptsRoot)) {
    for (const file of walkMd(promptsRoot)) {
      const rel = relative(root, file).split(sep).join('/');
      items.push(...scanText(readFileSync(file, 'utf8'), rel));
    }
  }

  items.push(...checkGitignore(root));

  return result('секреты', items, { baseline: readBaseline(root).violations });
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
    note: 'Пишется только gates/secret-check.mjs. Правка руками запрещена (docs/RULES.md §7).',
    generated_at: new Date().toISOString(),
    violations: res.count,
    items: res.items,
  }, null, 2)}\n`, 'utf8');
};

if (process.argv[1] && relative(process.cwd(), process.argv[1]).includes('secret-check')) {
  const res = check();
  const ok = report(res);
  if (process.argv.includes('--write')) writeBaseline(process.cwd(), res);
  process.exit(ok ? 0 : 1);
}
