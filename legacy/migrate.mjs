// legacy/migrate.mjs — точка входа миграции библиотеки промптов.
//
// Требования: REQ-MIG-REPORT, REQ-MIG-APPLY (docs/SPEC.md §11). Сценарий S-11.
// Тест: tests/unit/migrate.test.mjs.
//
// Запуск:
//   npm run migrate:report   — только читает и печатает план
//   npm run migrate:apply    — делает копию источников и пишет слитую библиотеку
//
// Флаг обязателен и без него ничего не происходит. Это не удобство, а защита:
// команда без аргументов, которая сливает три копии библиотеки, однажды будет
// запущена случайно.
//
// Пути источников можно переопределить переменными окружения — так работают тесты
// и так можно перенести чужую копию:
//   DECK_MIG_PROJECT, DECK_MIG_HOME, DECK_MIG_ESPANSO, DECK_MIG_TARGET

import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { plan, printable } from './plan.mjs';
import { apply, verifyApplied } from './apply.mjs';

const projectRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * Где прежний пайплайн оставил копии.
 *
 * `espanso` по умолчанию отсутствует: путь зависит от версии и в этой установке
 * промпты лежат в `match/`, а не отдельной папкой с группами. Пустая строка
 * означает «источник не найден» и просто исключается из плана — молча, потому что
 * его отсутствие не ошибка.
 */
export const defaultRoots = (env = process.env) => ({
  project: env.DECK_MIG_PROJECT ?? join(projectRoot, 'prompts'),
  home: env.DECK_MIG_HOME ?? join(homedir(), 'prompts'),
  espanso: env.DECK_MIG_ESPANSO ?? '',
});

export const defaultTarget = (env = process.env) => (
  env.DECK_MIG_TARGET ?? join(projectRoot, 'prompts')
);

/**
 * Разбор аргументов.
 * Неизвестный флаг — отказ с перечислением известных: молча проигнорировать
 * `--aply` значило бы сделать вид, что команда выполнена.
 */
export const parseArgs = (argv) => {
  const flags = argv.filter((a) => a.startsWith('--'));
  const known = ['--report', '--apply'];
  const bad = flags.filter((f) => !known.includes(f));

  if (bad.length > 0) {
    return { ok: false, why: `неизвестный флаг ${bad.join(', ')} — известны: ${known.join(', ')}` };
  }
  if (flags.includes('--apply')) return { ok: true, mode: 'apply' };
  if (flags.includes('--report')) return { ok: true, mode: 'report' };

  return { ok: false, why: 'нужен флаг --report (только посмотреть) или --apply (выполнить)' };
};

const runReport = (roots) => {
  const p = plan(roots);
  console.log(printable(p));
  console.log('');
  console.log('Ничего не изменено: это отчёт. Для выполнения — npm run migrate:apply');
  return 0;
};

const runApply = (roots, target, backupRoot) => {
  const out = apply(roots, target, backupRoot);
  if (!out.ok && out.written === undefined) {
    console.error(`✕ ${out.why}`);
    return 1;
  }

  console.log(`Резервная копия: ${out.backup.dir}`);
  for (const b of out.backup.sources) console.log(`  ${b.kind}: ${b.copied} файлов`);
  console.log(`Записано промптов: ${out.written.length}`);

  const cleaned = out.written.filter((w) => w.cleaned.length > 0);
  if (cleaned.length > 0) console.log(`Очищено при переносе: ${cleaned.length}`);

  for (const f of out.failed) console.error(`  ✕ ${f.id}: ${f.why}`);

  // Сверка читает диск, а не верит отчёту функции, которая писала.
  const check = verifyApplied(target, out.plan);
  for (const m of check.missing) console.error(`  ✕ не создан: ${m}`);
  for (const u of check.unreadable) console.error(`  ✕ ${u}`);

  console.log(check.ok && out.ok
    ? `✓ миграция завершена: ${check.expected} промптов на месте`
    : '✕ миграция завершена с ошибками — источники и копия не тронуты');

  /**
   * Остатки после переименования — решение человека, не миграции.
   *
   * Когда цель и источник совпадают (`prompts/` читается и пишется), переименованный
   * файл не заменяет старый, а ложится рядом. Сервер видит два промпта с одним `id`
   * и помечает оба сломанными — это нашёл живой запуск.
   *
   * Удалять сам не буду (docs/RULES.md §5): файл может отличаться по телу, и его
   * содержимое кто-то писал руками. Печатается список и готовая команда — человек
   * видит, что предлагается убрать и почему.
   */
  if (check.leftovers.length > 0) {
    console.log('');
    console.log('ОСТАЛИСЬ ИСХОДНИКИ ПОД ПРЕЖНИМИ ИМЕНАМИ');
    console.log('  Они дают дубликат id, и промпты помечены сломанными.');
    console.log('  Копия каждого лежит в резервной папке выше. Решение за вами:');
    console.log('');
    for (const l of check.leftovers) console.log(`  ${l.rel} — ${l.why}`);
    console.log('');
    console.log('  Удалить все перечисленные:');
    for (const l of check.leftovers) console.log(`    del "${l.file}"`);
  }

  return check.ok && out.ok ? 0 : 1;
};

export const main = (argv = process.argv.slice(2), env = process.env) => {
  const args = parseArgs(argv);
  if (!args.ok) {
    console.error(`✕ ${args.why}`);
    return 2;
  }

  const roots = defaultRoots(env);
  const target = defaultTarget(env);
  const backupRoot = env.DECK_MIG_BACKUP ?? join(projectRoot, 'state', 'backup');

  return args.mode === 'report'
    ? runReport(roots)
    : runApply(roots, target, backupRoot);
};

// Прямой запуск, но не импорт: тест вызывает main() сам и проверяет код возврата.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  process.exitCode = main();
}
