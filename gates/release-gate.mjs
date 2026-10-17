// gates/release-gate.mjs — G23: состояние вне релиза, ноль обращений к live.
//
// Требование: REQ-GATE-RELEASE (docs/SPEC.md §9). Концепция: gld/gold.md §3.3, §9.
// Тест: tests/unit/gates-release.test.mjs.
//
// Гейт закрывает три тихих способа сломать раскладку релизов:
//   1. ЗАПИСЬ ВНУТРЬ КАТАЛОГА КОДА — релиз неизменяем, файл исчезнет при установке.
//      Писать можно только в состояние (`state/`, `prompts/`), которое приходит в
//      релиз через junction из `shared/`.
//   2. ОБРАЩЕНИЕ К `live` ИЗ КОДА — указатель меняется под ногами при деплое. Код
//      обязан работать от `APP_ROOT` через `realpath` один раз (INV-13). Чтение
//      через `live` даёт смешанное чтение из двух релизов — ловится месяцами.
//   3. `rmSync` С `recursive` НА УКАЗАТЕЛЕ — в некоторых версиях Node это удаляло
//      содержимое ЦЕЛИ, то есть все промпты.
//
// Как и G24, гейт содержит самопроверку: он обязан уметь покраснеть.
//
// Имена указателей заданы ЛОКАЛЬНЫМ эталоном, а не импортом из release/: гейт
// проверяет весь код, включая сам release/, и импорт проверяемого сделал бы
// проверяющего его частью — нарушение границы (arch.yaml: gates зависит только от
// contracts). Тот же приём, что STRONG_SIGNS в ready-gate.mjs. Расхождение эталона
// с release/layout.mjs ловит тест gates-release.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

import { scan, result, report } from './scan.mjs';

const BASELINE = '.release-baseline.json';

/** Эталон имён указателей. Сверяется с NAMES из release/layout.mjs тестом. */
export const POINTERS = { live: 'live', prev: 'live.prev' };

/** Каталоги состояния: единственное место, куда приложению можно писать. */
export const STATE_DIRS = ['state', 'prompts'];

/** Модули боевого пути: их код исполняется из каталога релиза. */
export const RUNTIME_DIRS = ['server', 'library', 'clipboard', 'rank', 'contracts'];

/**
 * Где обращение к `live` законно. `release/` сам управляет указателем, `gates/`
 * проверяет раскладку, `tests/` проверяет всё. Остальным `live` знать не положено.
 */
export const LIVE_OK = ['release', 'gates', 'tests'];

const WRITE_RE = /\b(writeFileSync|appendFileSync|createWriteStream|mkdirSync|copyFileSync|renameSync)\s*\(/;

/** Строковые литералы строки кода: одинарные, двойные, обратные кавычки. */
const LITERALS_RE = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/**
 * Указатель ли это путь. Разбор структурный, а не regex: «первый сегмент пути» —
 * это структура. Три попытки выразить его шаблоном проваливались по очереди
 * (`aria-live` в разметке, `join(root,'live','server')`, `'live/state/token'` без
 * разделителя впереди). Литерал делится по разделителям, вопрос сводится к
 * сравнению сегментов со списком имён. `aria-live` не проходит: сегмент равен
 * `aria-live`, а не `live`.
 */
export const isLivePath = (literal) => {
  const parts = String(literal).split(/[/\\]/).filter((s) => s !== '');
  return parts.some((seg) => seg === POINTERS.live || seg === POINTERS.prev);
};

/** Есть ли в строке кода обращение к указателю. */
export const hasLiveRef = (code) => {
  if (/\bNAMES\.(live|prev)\b/.test(code)) return true;
  for (const m of code.matchAll(LITERALS_RE)) if (isLivePath(m[2])) return true;
  return false;
};

const RM_RECURSIVE_RE = /rmSync\s*\([^)]*recursive\s*:\s*true/;

/**
 * Строки кода без комментариев — построчно, с учётом блочных. Однострочного снятия
 * `//` мало: первый прогон покраснел на слове `live` внутри `/** *​/`. Разбор
 * построчный, потому что «мы внутри блока» — состояние, переносимое со строки на
 * строку. Возвращает массив той же длины: номера строк сохраняются.
 */
export const stripComments = (text) => {
  const out = [];
  let inBlock = false;

  for (const raw of text.split('\n')) {
    let line = raw;

    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) {
        out.push('');
        continue;
      }
      line = line.slice(end + 2);
      inBlock = false;
    }

    // Блоки, открытые и закрытые в одной строке, убираются целиком.
    line = line.replace(/\/\*.*?\*\//g, ' ');

    const open = line.indexOf('/*');
    if (open !== -1) {
      inBlock = true;
      line = line.slice(0, open);
    }

    out.push(line.replace(/\/\/.*$/, ''));
  }

  return out;
};

/**
 * Проверка 1: запись идёт только в состояние. Ищутся вызовы записи в модулях
 * боевого пути, чей путь НЕ начинается с каталога состояния. Аргумент читается как
 * текст: запись, чей путь не виден глазом, — сама по себе повод для правки.
 */
const writesOutsideState = (root) => {
  const items = [];

  for (const file of scan(root)) {
    if (!RUNTIME_DIRS.some((d) => file.path.startsWith(`${d}/`))) continue;

    const lines = stripComments(file.text);
    for (let i = 0; i < lines.length; i += 1) {
      const code = lines[i];
      if (!WRITE_RE.test(code)) continue;

      // Путь от поля объекта состояния (`this.stateDir`, `deck.libraryRoot`) или
      // от каталога состояния — законная запись.
      const toState = STATE_DIRS.some((d) => code.includes(`'${d}`) || code.includes(`"${d}`))
        || /\b(stateDir|libraryRoot|settingsFile|runtimeFile|tokenFile|promptPath|file|dir|target|dirname)\b/.test(code);

      if (toState) continue;

      items.push({
        path: file.path,
        line: i + 1,
        message: 'запись вне каталога состояния: релиз неизменяем, файл исчезнет при обновлении',
      });
    }
  }

  return items;
};

/** Проверка 2: путь `live` не упоминается там, где его знать не положено. */
const livePathUse = (root) => {
  const items = [];

  for (const file of scan(root)) {
    const dir = file.path.split('/')[0];
    if (LIVE_OK.includes(dir)) continue;

    const lines = stripComments(file.text);
    for (let i = 0; i < lines.length; i += 1) {
      if (!hasLiveRef(lines[i])) continue;

      items.push({
        path: file.path,
        line: i + 1,
        message: 'обращение к пути live: указатель меняется под ногами, работайте от APP_ROOT (INV-13)',
      });
    }
  }

  return items;
};

/** Проверка 3: рекурсивное удаление в слое релизов. */
const recursiveRemoves = (root) => {
  const items = [];

  for (const file of scan(root)) {
    if (!file.path.startsWith('release/')) continue;

    const lines = stripComments(file.text);
    for (let i = 0; i < lines.length; i += 1) {
      const code = lines[i];
      if (!RM_RECURSIVE_RE.test(code)) continue;

      // Удаление каталога релиза целиком законно, но только после явного снятия
      // указателей. Признак: рядом в файле есть removeJunction.
      if (file.text.includes('removeJunction')) continue;

      items.push({
        path: file.path,
        line: i + 1,
        message: 'rmSync с recursive без снятия указателей: может удалить содержимое цели, то есть промпты',
      });
    }
  }

  return items;
};

/**
 * Проверка 4: пин корня на месте. INV-13 существует только если `realpath` вызван
 * при старте — иначе процесс читает через указатель, а гейт раскладки был бы
 * зелёным на сломанном инварианте.
 */
const pinPresent = (root) => {
  const file = join(root, 'server', 'index.mjs');
  if (!existsSync(file)) return [];

  if (/realpathSync\s*\(/.test(readFileSync(file, 'utf8'))) return [];
  return [{
    path: 'server/index.mjs',
    message: 'нет пина корня через realpath — INV-13 не выполняется, процесс читает через указатель',
  }];
};

/**
 * Самопроверка: гейт обязан уметь покраснеть. Каждая строка `liveForms` — след
 * промаха, найденного проверкой: `join` двумя аргументами, `live` первым сегментом,
 * `live` в середине, поле раскладки, `live.prev`. `notLiveForms` — то, чем оно не
 * является: `aria-live` в разметке не должно срабатывать.
 */
export const selfTest = () => {
  const bad = 'writeFileSync(join(APP_ROOT, "отчёт.txt"), text);';
  const good = "writeFileSync(this.settingsFile, JSON.stringify(s), 'utf8');";

  const caughtBad = WRITE_RE.test(bad) && !/\b(stateDir|settingsFile)\b/.test(bad);
  const skippedGood = /\bsettingsFile\b/.test(good);

  const liveForms = [
    'const p = join(root, "live", "server");',
    "readFileSync('live/state/token');",
    "const f = join(root, 'app', 'live', 'x');",
    'const dir = NAMES.live;',
    "rmSync('live.prev');",
  ];
  const notLiveForms = [
    '<div id="toast" role="status" aria-live="polite" hidden></div>',
    "el.setAttribute('aria-live', 'assertive');",
    "const s = 'deliver';",
  ];

  const caughtLive = liveForms.every((s) => hasLiveRef(s));
  const ariaOk = notLiveForms.every((s) => !hasLiveRef(s));
  const caughtRm = RM_RECURSIVE_RE.test('rmSync(dir, { recursive: true, force: true });');

  // Слово в блочном комментарии нарушением быть не может — первый прогон покраснел
  // ровно на объяснении, зачем нужен пин корня.
  const blockText = ['/**', ' * путь вида `live/` меняется', ' */', 'const x = 1;'].join('\n');
  const blockClean = stripComments(blockText).every((l, i) => (i === 3 ? l.includes('const') : !l.includes('live')));

  const fails = [];
  if (!caughtBad) fails.push('не найдена запись вне состояния');
  if (!skippedGood) fails.push('законная запись в состояние признана нарушением');
  if (!caughtLive) fails.push(`не найдено обращение к live: ${liveForms.filter((s) => !hasLiveRef(s)).join(' | ')}`);
  if (!caughtRm) fails.push('не найден rmSync с recursive');
  if (!blockClean) fails.push('слово из блочного комментария принято за код');
  if (!ariaOk) fails.push(`принято за путь к указателю: ${notLiveForms.filter((s) => hasLiveRef(s)).join(' | ')}`);

  return fails.length === 0
    ? { ok: true, why: null }
    : { ok: false, why: `самопроверка: ${fails.join('; ')}` };
};

const readBaseline = (root) => {
  try {
    return JSON.parse(readFileSync(join(root, BASELINE), 'utf8'));
  } catch {
    return { violations: 0 };
  }
};

export const writeBaseline = (root, res) => {
  writeFileSync(join(root, BASELINE), `${JSON.stringify({
    note: 'Пишется только gates/release-gate.mjs. Правка руками запрещена (docs/RULES.md §7).',
    generated_at: new Date().toISOString(),
    violations: res.count,
    items: res.items.map((i) => ({ path: i.path, line: i.line ?? null, message: i.message })),
  }, null, 2)}\n`, 'utf8');
};

export const check = (root = process.cwd()) => {
  const items = [
    ...writesOutsideState(root),
    ...livePathUse(root),
    ...recursiveRemoves(root),
    ...pinPresent(root),
  ];

  const self = selfTest();
  if (!self.ok) items.push({ path: 'gates/release-gate.mjs', message: self.why });

  const res = result('раскладка релизов', items, { baseline: readBaseline(root).violations });
  res.selfTested = self.ok;
  return res;
};

if (process.argv[1] && relative(process.cwd(), process.argv[1]).includes('release-gate')) {
  const res = check();
  const ok = report(res);
  if (process.argv.includes('--write')) writeBaseline(process.cwd(), res);
  process.exit(ok ? 0 : 1);
}
