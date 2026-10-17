// gates/ready-gate.mjs — G24: критерий успеха деплоя не врёт.
//
// Требование: REQ-GATE-READY (docs/SPEC.md §10). Концепция: gld/gold.md §1.1, §9.
// Тест: tests/unit/gates-ready.test.mjs.
//
// Гейт проверяет две вещи, и обе про один класс дефекта — «зелёный вердикт без
// оснований».
//
// 1. ДЕПЛОЙ НЕ ПРИЗНАЁТСЯ УСПЕШНЫМ ПО СЛАБОМУ ПРИЗНАКУ.
//    «Порт занят» и «процесс ответил» означают только то, что что-то живёт на этом
//    порту. Старый процесс, который не умер, удовлетворяет обоим — и деплой
//    рапортует успех при работающем прежнем коде. Успех обязан требовать три
//    условия ОДНОВРЕМЕННО: `/readyz` == 200, `code_version` == ожидаемый,
//    `release_id` == устанавливаемый.
//
// 2. В GUI-РЕЖИМЕ НЕТ ЗАПИСИ В КОНСОЛЬ.
//    У процесса с GUI-подсистемой нет stdout: запись либо теряется, либо валит
//    процесс. Поэтому `console.log` на боевом пути — не стилистика, а дефект.
//    Гейты, тесты и CLI-скрипты печатать обязаны — там консоль есть.
//
// Про сам гейт. Проверка, которая не может покраснеть, хуже отсутствия проверки:
// она даёт уверенность без оснований. Поэтому здесь есть `selfTest()` — он
// подкладывает нарушение и требует, чтобы гейт его нашёл. Красный `selfTest` делает
// гейт красным целиком, даже если проект чист.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

import { scan, result, report } from './scan.mjs';

const BASELINE = '.ready-baseline.json';

/** Модули боевого пути: они исполняются в процессе сервиса. */
export const RUNTIME_DIRS = ['server', 'library', 'clipboard', 'rank', 'contracts', 'ui/views'];

/**
 * Где печатать РАЗРЕШЕНО и почему.
 *
 * `gates/` и `legacy/` запускает человек из терминала — там консоль есть и вывод
 * является их продуктом. `bridge/` печатает при запуске из командной строки, до
 * перехода в GUI-режим. `tests/` очевидно.
 */
export const CONSOLE_OK = ['gates', 'legacy', 'tests', 'bridge'];

const CONSOLE_RE = /\bconsole\.(log|info|warn|error|debug|table|dir|trace)\s*\(/;

/** Слабые признаки успеха: каждый из них по отдельности ничего не доказывает. */
export const WEAK_SIGNS = [
  ['порт занят', /порт\s+занят|EADDRINUSE/i],
  ['процесс ответил', /ответил|responded/i],
];

/** Три условия, без которых деплой не имеет права рапортовать успех. */
export const STRONG_SIGNS = ['readyz', 'code_version', 'release_id'];

/**
 * Проверка: печать в консоль на боевом пути.
 *
 * Строки в комментариях не считаются: гейт, который краснеет на упоминании
 * `console.log` в объяснении, заставляет писать объяснения загадками.
 */
const consoleCalls = (root) => {
  const items = [];

  for (const file of scan(root)) {
    const dir = file.path.split('/')[0];
    if (CONSOLE_OK.includes(dir)) continue;
    if (!RUNTIME_DIRS.some((d) => file.path.startsWith(`${d}/`))) continue;

    const lines = file.text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      if (!CONSOLE_RE.test(code)) continue;

      items.push({
        path: file.path,
        line: i + 1,
        message: 'печать в консоль на боевом пути: в GUI-режиме stdout нет, вывод потеряется',
      });
    }
  }
  return items;
};

/**
 * Проверка: чем деплой считает успех.
 *
 * Ищется файл деплоя и в нём — три сильных признака. Отсутствие файла деплоя не
 * нарушение: слой релизов ставится тикетом `T-115.1`, и до него проверять нечего.
 * Но если файл есть, а признаков нет — это ложно-зелёный критерий.
 */
const deployCriteria = (root) => {
  const file = join(root, 'deploy.mjs');
  if (!existsSync(file)) return [];

  const text = readFileSync(file, 'utf8');
  const items = [];

  for (const sign of STRONG_SIGNS) {
    if (!text.includes(sign)) {
      items.push({
        path: 'deploy.mjs',
        message: `успех деплоя не сверяет «${sign}» — критерий может выдать старый код за новый`,
      });
    }
  }

  for (const [name, re] of WEAK_SIGNS) {
    if (re.test(text) && !STRONG_SIGNS.every((s) => text.includes(s))) {
      items.push({
        path: 'deploy.mjs',
        message: `«${name}» как признак успеха без сверки версии — этому признаку удовлетворяет и старый процесс`,
      });
    }
  }

  return items;
};

/**
 * Проверка эндпоинтов: они обязаны существовать и быть публичными.
 *
 * Без этого сам критерий деплоя недостижим: скрипт не знает токена, и `/readyz`
 * под токеном для него всё равно что отсутствует.
 */
const endpoints = (root) => {
  const items = [];
  const readyFile = join(root, 'server', 'ready.mjs');
  if (!existsSync(readyFile)) {
    return [{ path: 'server/ready.mjs', message: 'нет модуля готовности — деплой нечем принимать' }];
  }

  const index = readFileSync(join(root, 'server', 'index.mjs'), 'utf8');

  // Сравниваются позиции ВЫЗОВОВ, а не любых упоминаний.
  //
  // Первая версия искала `indexOf('handleReady')` и `indexOf('checkRequest')` по
  // всему тексту — и попадала на строки импортов, где `checkRequest` объявлен
  // раньше. Гейт покраснел на верном коде: порядок вызовов был правильный, а
  // сравнивались строки import. Ложное срабатывание опаснее пропуска: гейт, который
  // краснеет без причины, отключают, и тогда он не поймает настоящее нарушение.
  const atReady = index.search(/\bhandleReady\s*\(\s*req/);
  const atAuth = index.search(/\bcheckRequest\s*\(\s*req/);

  if (atReady === -1) {
    items.push({ path: 'server/index.mjs', message: 'маршруты готовности не подключены' });
  } else if (atAuth !== -1 && atReady > atAuth) {
    items.push({
      path: 'server/index.mjs',
      message: 'готовность проверяется после токена — супервизор получит 401 вместо состояния',
    });
  }

  return items;
};

/**
 * Самопроверка: гейт обязан уметь покраснеть.
 *
 * Подкладывается заведомое нарушение — и требуется, чтобы проверка его назвала.
 * Провал здесь означает, что гейт слеп, и это красный вердикт независимо от
 * состояния проекта (gld/gold.md §9: «гейт, который не может покраснеть, — не гейт»).
 */
export const selfTest = () => {
  const fake = [{ path: 'server/x.mjs', text: 'export const f = () => {\n  console.log("боевой путь");\n};\n' }];
  const found = fake.flatMap((f) => {
    const lines = f.text.split('\n');
    return lines
      .map((l, i) => ({ l: l.replace(/\/\/.*$/, ''), i }))
      .filter(({ l }) => CONSOLE_RE.test(l))
      .map(({ i }) => ({ path: f.path, line: i + 1 }));
  });

  return found.length === 1
    ? { ok: true, why: null }
    : { ok: false, why: `самопроверка не нашла подложенный console.log (найдено ${found.length})` };
};

const readBaseline = (root) => {
  try {
    return JSON.parse(readFileSync(join(root, BASELINE), 'utf8'));
  } catch {
    // Файла нет при первом прогоне. Ноль, а не «сколько найдём»: линия, которая
    // подстраивается под текущее состояние, ничего не держит.
    return { violations: 0 };
  }
};

export const writeBaseline = (root, res) => {
  writeFileSync(join(root, BASELINE), `${JSON.stringify({
    note: 'Пишется только gates/ready-gate.mjs. Правка руками запрещена (docs/RULES.md §7).',
    generated_at: new Date().toISOString(),
    violations: res.count,
    items: res.items.map((i) => ({ path: i.path, line: i.line ?? null, message: i.message })),
  }, null, 2)}\n`, 'utf8');
};

export const check = (root = process.cwd()) => {
  const items = [...consoleCalls(root), ...deployCriteria(root), ...endpoints(root)];

  const self = selfTest();
  if (!self.ok) items.push({ path: 'gates/ready-gate.mjs', message: self.why });

  const res = result('критерий готовности', items, { baseline: readBaseline(root).violations });
  res.selfTested = self.ok;
  return res;
};

if (process.argv[1] && relative(process.cwd(), process.argv[1]).includes('ready-gate')) {
  const res = check();
  const ok = report(res);
  if (process.argv.includes('--write')) writeBaseline(process.cwd(), res);
  process.exit(ok ? 0 : 1);
}
