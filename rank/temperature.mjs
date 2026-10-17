// rank/temperature.mjs — температура промпта: насколько он живой.
//
// Требование: REQ-RANK-TEMP (docs/SPEC.md §5). Тест: tests/unit/rank-temp.test.mjs.
// Носитель смысла — слово и глиф, цвет только усиление (docs/UI-SPEC.md §1.3).
//
// Зачем вообще температура: в библиотеке 26 промптов, из них реально работают
// пять-шесть. Без метки все строки выглядят одинаково важными, и человек каждый
// раз перечитывает весь список. Температура — это ответ на вопрос
// «этим я пользуюсь или это лежит с прошлого года».
//
// Считается из двух чисел, которые ведёт программа: `used` и `last_used`
// (docs/ENTITY-MAP.md §1 — оба поля принадлежат library, здесь только читаются).

export const LEVELS = ['hot', 'warm', 'cool', 'cold'];

/**
 * Подписи. Порядок в объекте — порядок в легенде настроек.
 * `rank` = позиция для сортировки по температуре: 0 — самый горячий.
 */
export const LEVEL_VIEW = {
  hot: { label: 'горячий', glyph: '▰▰▰', rank: 0, hint: 'частый и свежий' },
  warm: { label: 'тёплый', glyph: '▰▰▱', rank: 1, hint: 'в работе' },
  cool: { label: 'прохладный', glyph: '▰▱▱', rank: 2, hint: 'давно не открывали' },
  cold: { label: 'холодный', glyph: '▱▱▱', rank: 3, hint: 'ни разу или очень давно' },
};

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Порог по свежести в днях: не позже такого числа дней — этот уровень. */
export const FRESH_DAYS = { hot: 7, warm: 30, cool: 90 };

/**
 * Порог по частоте: сколько использований нужно, чтобы уровень стал доступен.
 * Шкала намеренно низкая — двадцать использований промпта это уже много.
 */
export const OFTEN = { hot: 10, warm: 4, cool: 1 };

/** Дней с последнего использования. `null` — не использовался никогда. */
export const daysSince = (iso, now = Date.now()) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
};

/** Уровень по свежести. */
const bySpeed = (days) => {
  if (days <= FRESH_DAYS.hot) return 'hot';
  if (days <= FRESH_DAYS.warm) return 'warm';
  if (days <= FRESH_DAYS.cool) return 'cool';
  return 'cold';
};

/** Предел, который частота разрешает. Выше этого уровня промпт не поднимется. */
const byCount = (used) => {
  if (used >= OFTEN.hot) return 'hot';
  if (used >= OFTEN.warm) return 'warm';
  if (used >= OFTEN.cool) return 'cool';
  return 'cold';
};

/** Более прохладный из двух уровней. Больший `rank` — более холодный. */
const cooler = (a, b) => (LEVEL_VIEW[a].rank >= LEVEL_VIEW[b].rank ? a : b);

/**
 * Температура из частоты и свежести.
 *
 * Правило: свежесть важнее частоты. Промпт с шестью использованиями на прошлой
 * неделе нужнее, чем промпт с сорока использованиями год назад — второй относится
 * к закрытой задаче. Формально: частота задаёт предел сверху, свежесть решает
 * внутри предела, итог — более прохладный из двух.
 *
 * Прежняя версия понижала уровень на один шаг цепочкой условий, и таблица OFTEN
 * при этом не работала: порог `hot: 10` не использовался нигде, а проверка
 * `used < OFTEN.cool` была мёртвой — ноль использований отсекается раньше. Из-за
 * этого одно использование вчера давало «тёплый» вместо «прохладного», то есть
 * «попробовал один раз» выглядело как «в работе». Объявленная таблица, не
 * управляющая поведением, — это второе мнение о правиле (docs/RULES.md §1).
 */
export const temperature = (item, now = Date.now()) => {
  const used = Number(item?.used ?? 0);
  const days = daysSince(item?.last_used, now);

  // Данные противоречивы (счётчик без даты или наоборот) — не выдаём желаемое
  // за действительное.
  if (!Number.isFinite(used) || used <= 0 || days === null) return 'cold';

  return cooler(bySpeed(days), byCount(used));
};

/** Полное описание для интерфейса: слово, глиф, объяснение «почему такой». */
export const describeTemperature = (item, now = Date.now()) => {
  const level = temperature(item, now);
  const view = LEVEL_VIEW[level];
  const used = Number(item?.used ?? 0);
  const days = daysSince(item?.last_used, now);

  return {
    level,
    label: view.label,
    glyph: view.glyph,
    rank: view.rank,
    used,
    days,
    why: days === null
      ? 'ни разу не использован'
      : `${used} ${plural(used, 'раз', 'раза', 'раз')}, последний ${humanDays(days)}`,
  };
};

const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};

/** Человеческий срок: «сегодня», «вчера», «3 дня назад», «2 месяца назад». */
export const humanDays = (days) => {
  if (days === null) return 'никогда';
  if (days === 0) return 'сегодня';
  if (days === 1) return 'вчера';
  if (days < 7) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  if (days < 30) {
    const w = Math.floor(days / 7);
    return `${w} ${plural(w, 'неделю', 'недели', 'недель')} назад`;
  }
  if (days < 365) {
    const m = Math.floor(days / 30);
    return `${m} ${plural(m, 'месяц', 'месяца', 'месяцев')} назад`;
  }
  const y = Math.floor(days / 365);
  return `${y} ${plural(y, 'год', 'года', 'лет')} назад`;
};

/** Сводка по библиотеке для панели: сколько промптов какого уровня. */
export const temperatureStats = (items = [], now = Date.now()) => {
  const out = { hot: 0, warm: 0, cool: 0, cold: 0 };
  for (const it of items) out[temperature(it, now)] += 1;
  return { ...out, total: items.length };
};
