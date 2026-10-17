// rank/usage.mjs — учёт использований: единственное место, где растёт счётчик.
//
// Требование: REQ-RANK-USE (docs/SPEC.md §5). Сценарий S-01, шаг 4.
// Тест: tests/unit/rank-usage.test.mjs.
//
// Проблема прежней системы: поля `used` во всех 26 файлах остались нулями, потому
// что счётчик надо было править руками. Метрика, которую ведёт человек, — это не
// метрика. Здесь счётчик растёт как побочный эффект вставки, и никак иначе.
//
// Границы: сами поля принадлежат library (docs/ENTITY-MAP.md §1), файл пишет
// только `library.markUsed`. Этот модуль — прикладной слой: он решает, КОГДА
// считать использование и что показать человеку.

import { num, counter } from '../contracts/index.mjs';
import { markUsed } from '../library/index.mjs';
import { describeTemperature, humanDays, daysSince } from './temperature.mjs';

/**
 * Окно защиты от двойного счёта, мс.
 * Вставка одного и того же промпта дважды за две секунды — это почти всегда
 * дребезг хоткея или повторное нажатие, а не два обращения к промпту.
 */
export const DEBOUNCE_MS = 2000;

/** Учёт использований. Хранит только последние отметки в памяти процесса. */
export class UsageTracker {
  #last = new Map();

  #root;

  constructor(root, { debounceMs = DEBOUNCE_MS } = {}) {
    this.#root = root;
    this.debounceMs = debounceMs;
  }

  /**
   * Отметить использование промпта.
   * @returns {{ ok: boolean, counted: boolean, used?: number, reason?: string }}
   */
  async count(id, group, { now = Date.now() } = {}) {
    const key = `${group}/${id}`;
    const prev = this.#last.get(key) ?? 0;
    if (now - prev < this.debounceMs) {
      return { ok: true, counted: false, reason: 'повтор в пределах защитного окна' };
    }
    this.#last.set(key, now);

    const res = await markUsed(this.#root, id, group);
    if (!res.ok) return { ok: false, counted: false, reason: res.issues?.[0]?.message ?? 'не удалось обновить файл' };

    return { ok: true, counted: true, used: res.used, last_used: res.last_used };
  }

  /** Сброс окна: нужен тестам и после смены библиотеки. */
  reset() {
    this.#last.clear();
  }
}

/**
 * Бейдж счётчика для строки списка.
 * До трёх использований бейдж не показывается: «1» рядом с каждым названием —
 * это шум, который не помогает выбирать (docs/UI-SPEC.md §1.3).
 */
export const usageBadge = (item, { min = 3 } = {}) => {
  const used = counter(item?.used);
  if (used < min) return null;
  return {
    text: used > 999 ? '999+' : String(used),
    title: `использован ${used} раз`,
  };
};

/** Полная сводка по одному промпту: для превью и подсказок. */
export const describeUsage = (item, now = Date.now()) => {
  const temp = describeTemperature(item, now);
  return {
    used: counter(item?.used),
    lastUsed: item?.last_used ?? null,
    lastUsedHuman: humanDays(daysSince(item?.last_used, now)),
    temperature: temp.level,
    temperatureLabel: temp.label,
    badge: usageBadge(item),
    why: temp.why,
  };
};

/**
 * Сводка по библиотеке для панели: сколько промптов вообще ни разу не открывали.
 * Это честный ответ на вопрос «сколько из библиотеки реально работает».
 *
 * Все числа проходят через counter: битое значение в одном файле не имеет права
 * превратить сводку в «NaN из 26» (REQ-LIB-ISOLATE).
 */
export const usageStats = (items = []) => {
  const used = items.filter((i) => counter(i?.used) > 0);
  const total = items.length;
  const sum = items.reduce((a, i) => a + counter(i?.used), 0);
  return {
    total,
    everUsed: used.length,
    neverUsed: total - used.length,
    totalInsertions: sum,
    share: total === 0 ? 0 : Math.round((used.length / total) * 100),
  };
};

/** Топ по использованию — для подсказок о закреплении и для отчётов. */
export const topUsed = (items = [], n = 10) => [...items]
  .sort((a, b) => counter(b?.used) - counter(a?.used))
  .slice(0, num(n, 10))
  .map((i) => ({ id: i.id, group: i.group, title: i.title ?? i.id, used: counter(i?.used) }));
