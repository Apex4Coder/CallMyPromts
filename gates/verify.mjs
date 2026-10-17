// gates/verify.mjs — все гейты одной командой и храповик.
//
// Требование: REQ-GATE-RATCHET (docs/SPEC.md §10). Правило храповика: RULES §7.
// Тест: tests/unit/gates.test.mjs.
//
// Храповик работает так: базовая линия — это число нарушений, зафиксированное
// в прошлый раз. Стало больше — гейт красный. Стало меньше — гейт зелёный и
// просит обновить линию. Так долг может только уменьшаться.
//
// Правка файлов `.­*-baseline.json` руками запрещена: линию пишет только гейт
// своей командой `--write`. Иначе храповик превращается в кнопку «сделать зелёным».

import { relative } from 'node:path';

import { report } from './scan.mjs';
import * as arch from './arch-check.mjs';
import * as chunk from './chunk-check.mjs';
import * as trace from './trace-check.mjs';
import * as secret from './secret-check.mjs';
import * as ready from './ready-gate.mjs';
import * as release from './release-gate.mjs';

/** Порядок гейтов: от структуры к содержимому. Первым падает самое важное. */
export const GATES = [
  { name: 'границы', mod: arch },
  { name: 'размер чанков', mod: chunk },
  { name: 'трасса', mod: trace },
  { name: 'секреты', mod: secret },
  { name: 'критерий готовности', mod: ready },
  { name: 'раскладка релизов', mod: release },
];

export const runAll = (root = process.cwd()) => GATES.map((g) => g.mod.check(root));

// Публичный барьер модуля (arch.yaml): всё, что нужно снаружи, перечислено здесь.
// Без этих строк тесты гейтов импортировали бы gates/arch-check.mjs напрямую, и
// гейт границ поймал бы собственные тесты — справедливо, потому что барьер либо
// один для всех, либо его нет.
export { check as checkArch, readArch, findCycle } from './arch-check.mjs';
export { check as checkChunk, measure, LIMITS } from './chunk-check.mjs';
export { check as checkTrace, readTrace, readSpecReqs } from './trace-check.mjs';
export { check as checkSecret, PATTERNS } from './secret-check.mjs';
export {
  check as checkReady,
  selfTest as selfTestReady,
  CONSOLE_OK,
  STRONG_SIGNS,
  RUNTIME_DIRS,
} from './ready-gate.mjs';
export {
  check as checkRelease,
  selfTest as selfTestRelease,
  hasLiveRef,
  isLivePath,
  stripComments,
  POINTERS,
  STATE_DIRS,
  LIVE_OK,
} from './release-gate.mjs';
export { scan, moduleOf, importsOf, result } from './scan.mjs';

/** Печать сводки. Итог одной строкой, чтобы не искать его в выводе. */
export const summary = (results) => {
  const failed = results.filter((r) => !r.ok);
  const better = results.filter((r) => r.better > 0);

  process.stdout.write('\n');
  if (failed.length === 0) {
    process.stdout.write(`✓ все гейты пройдены (${results.length})\n`);
  } else {
    process.stdout.write(`✕ провалено гейтов: ${failed.length} из ${results.length} — ${failed.map((r) => r.gate).join(', ')}\n`);
  }
  if (better.length > 0) {
    process.stdout.write(`  стало лучше: ${better.map((r) => `${r.gate} −${r.better}`).join(', ')}\n`);
    process.stdout.write('  зафиксируйте прогресс: node gates/verify.mjs --write\n');
  }

  return failed.length === 0;
};

/** Фиксация текущего состояния как новой базовой линии. */
export const writeAll = (root, results) => {
  // Порядок соответствует GATES: линия каждого гейта пишется своим модулем.
  // Обход по индексам, а не по имени, был бы тише — и однажды записал бы линию
  // одного гейта в файл другого.
  GATES.forEach((g, i) => g.mod.writeBaseline(root, results[i]));
  process.stdout.write('  базовые линии обновлены\n');
};

if (process.argv[1] && relative(process.cwd(), process.argv[1]).includes('verify')) {
  const root = process.cwd();
  const results = runAll(root);

  for (const res of results) report(res);
  const ok = summary(results);

  if (process.argv.includes('--write')) writeAll(root, results);
  process.exit(ok ? 0 : 1);
}
