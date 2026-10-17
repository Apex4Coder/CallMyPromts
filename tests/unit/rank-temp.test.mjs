// tests/unit/rank-temp.test.mjs — температура промпта.
//
// Требование: REQ-RANK-TEMP (docs/SPEC.md §5). Сценарий: S-01.
//
// Главное правило, которое здесь закрепляется: свежесть важнее частоты. Промпт с
// сорока использованиями год назад относится к закрытой задаче; промпт с шестью
// использованиями на прошлой неделе — к текущей. Именно на этом правиле уже был
// найден дефект: холодный `p-parse` (40 раз год назад) вставал на вторую позицию
// списка выше тёплого `c-bug` (6 раз на прошлой неделе).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEVELS,
  LEVEL_VIEW,
  FRESH_DAYS,
  OFTEN,
  DAY_MS,
  daysSince,
  temperature,
  describeTemperature,
  humanDays,
  temperatureStats,
} from '../../rank/index.mjs';

/** Фиксированная точка отсчёта: тест не должен зависеть от времени запуска. */
const NOW = Date.parse('2026-09-05T12:00:00Z');

/** Промпт, использованный `used` раз, последний раз `days` дней назад. */
const item = (used, days) => ({
  used,
  last_used: days === null ? null : new Date(NOW - days * DAY_MS).toISOString(),
});

// ── уровни и подписи ─────────────────────────────────────────────────────────

test('уровней ровно четыре, как и состояний', () => {
  // Пятый уровень пришлось бы отличать глазами, а предел различимости достигнут
  // (docs/RULES.md §5).
  assert.deepEqual(LEVELS, ['hot', 'warm', 'cool', 'cold']);
});

test('у каждого уровня есть слово, глиф и объяснение', () => {
  for (const l of LEVELS) {
    assert.equal(typeof LEVEL_VIEW[l].label, 'string');
    assert.equal(LEVEL_VIEW[l].label.trim() !== '', true, `${l}: нет подписи`);
    assert.equal(LEVEL_VIEW[l].glyph.trim() !== '', true, `${l}: нет глифа`);
    assert.equal(LEVEL_VIEW[l].hint.trim() !== '', true, `${l}: нет объяснения`);
  }
});

test('порядок уровней задан числом, а не позицией в объекте', () => {
  // Сортировка по порядку ключей объекта — молчаливая зависимость от того, кто
  // и как объект собрал.
  assert.deepEqual(LEVELS.map((l) => LEVEL_VIEW[l].rank), [0, 1, 2, 3]);
});

test('глифы различимы без цвета', () => {
  // Полосы читаются при чёрно-белой печати и при протанопии.
  const glyphs = LEVELS.map((l) => LEVEL_VIEW[l].glyph);

  assert.equal(new Set(glyphs).size, 4);
  for (const l of LEVELS) assert.equal('color' in LEVEL_VIEW[l], false, `${l}: цвет недопустим`);
});

// ── daysSince ────────────────────────────────────────────────────────────────

test('считает дни с последнего использования', () => {
  assert.equal(daysSince(new Date(NOW).toISOString(), NOW), 0);
  assert.equal(daysSince(new Date(NOW - 3 * DAY_MS).toISOString(), NOW), 3);
  assert.equal(daysSince(new Date(NOW - 400 * DAY_MS).toISOString(), NOW), 400);
});

test('отсутствие даты — это null, а не ноль дней', () => {
  // Ноль означал бы «использован сегодня» — прямо противоположный смысл.
  assert.equal(daysSince(null, NOW), null);
  assert.equal(daysSince(undefined, NOW), null);
  assert.equal(daysSince('', NOW), null);
});

test('непонятная дата тоже null, а не NaN', () => {
  assert.equal(daysSince('вчера', NOW), null);
  assert.equal(daysSince('2026-13-45', NOW), null);
});

test('дата из будущего не даёт отрицательных дней', () => {
  // Рассинхронизация часов между компьютерами — обычное дело, и «-3 дня назад»
  // выглядело бы как поломка.
  assert.equal(daysSince(new Date(NOW + 5 * DAY_MS).toISOString(), NOW), 0);
});

// ── температура ──────────────────────────────────────────────────────────────

test('ни разу не использованный — холодный', () => {
  assert.equal(temperature({ used: 0, last_used: null }, NOW), 'cold');
  assert.equal(temperature({}, NOW), 'cold');
  assert.equal(temperature(null, NOW), 'cold');
});

test('частый и свежий — горячий', () => {
  assert.equal(temperature(item(OFTEN.hot, 1), NOW), 'hot');
  assert.equal(temperature(item(30, 0), NOW), 'hot');
});

test('свежесть не поднимает выше того, что разрешает частота', () => {
  // Одно использование вчера — это «попробовал», а не «работаю этим каждый день».
  // Частота задаёт предел сверху, свежесть решает внутри предела.
  assert.equal(temperature(item(1, 1), NOW), 'cool', 'один раз — предел «прохладный»');
  assert.equal(temperature(item(OFTEN.warm, 1), NOW), 'warm', `${OFTEN.warm} раза — предел «тёплый»`);
  assert.equal(temperature(item(OFTEN.warm - 1, 1), NOW), 'cool', 'на единицу ниже порога — прохладный');
  assert.equal(temperature(item(OFTEN.hot, 1), NOW), 'hot', `${OFTEN.hot} раз и свежий — горячий`);
  assert.equal(temperature(item(OFTEN.hot - 1, 1), NOW), 'warm', 'на единицу ниже — только тёплый');
});

test('порог по частоте действует: таблица OFTEN управляет поведением', () => {
  // Объявленная таблица, которая ни на что не влияет, — это второе мнение
  // о правиле (docs/RULES.md §1). Прежняя версия не использовала OFTEN.hot вовсе.
  const fresh = 1;

  assert.equal(temperature(item(OFTEN.hot, fresh), NOW), 'hot');
  assert.equal(temperature(item(OFTEN.warm, fresh), NOW), 'warm');
  assert.equal(temperature(item(OFTEN.cool, fresh), NOW), 'cool');
});

test('частый, но давний — холодный: задача закрыта', () => {
  // Тот самый дефект: 40 использований год назад не делают промпт актуальным.
  assert.equal(temperature(item(40, 365), NOW), 'cold');
  assert.equal(temperature(item(100, 200), NOW), 'cold');
});

test('свежесть побеждает частоту при прямом сравнении', () => {
  const oldFrequent = item(40, 365);
  const newRare = item(6, 5);

  assert.equal(LEVEL_VIEW[temperature(newRare, NOW)].rank < LEVEL_VIEW[temperature(oldFrequent, NOW)].rank,
    true, 'свежий и умеренно частый обязан быть выше давнего и частого');
});

test('границы порогов по свежести проверяются точно', () => {
  assert.equal(temperature(item(20, FRESH_DAYS.hot), NOW), 'hot', 'на границе ещё горячий');
  assert.equal(temperature(item(20, FRESH_DAYS.hot + 1), NOW), 'warm', 'на день позже уже тёплый');
  assert.equal(temperature(item(20, FRESH_DAYS.warm), NOW), 'warm');
  assert.equal(temperature(item(20, FRESH_DAYS.warm + 1), NOW), 'cool');
  assert.equal(temperature(item(20, FRESH_DAYS.cool), NOW), 'cool');
  assert.equal(temperature(item(20, FRESH_DAYS.cool + 1), NOW), 'cold');
});

test('частота понижает уровень, но никогда не повышает', () => {
  // Иначе счётчик стал бы способом «поднять» промпт вопреки свежести.
  for (let days = 0; days <= 400; days += 7) {
    for (const used of [1, 2, 5, 10, 100]) {
      const withFew = LEVEL_VIEW[temperature(item(1, days), NOW)].rank;
      const withMany = LEVEL_VIEW[temperature(item(used, days), NOW)].rank;
      assert.equal(withMany <= withFew, true, `дней ${days}, раз ${used}: частота повысила уровень`);
    }
  }
});

test('счётчик без даты — холодный: данные противоречивы', () => {
  // used > 0 при last_used = null означает потерянную дату. Показывать такой
  // промпт горячим значило бы доверять половине данных.
  assert.equal(temperature({ used: 50, last_used: null }, NOW), 'cold');
});

test('дата без счётчика — тоже холодный', () => {
  assert.equal(temperature({ used: 0, last_used: new Date(NOW).toISOString() }, NOW), 'cold');
});

test('мусор в полях не роняет расчёт', () => {
  assert.equal(LEVELS.includes(temperature({ used: 'много', last_used: 'вчера' }, NOW)), true);
  assert.equal(LEVELS.includes(temperature({ used: -5, last_used: null }, NOW)), true);
});

// ── описание ─────────────────────────────────────────────────────────────────

test('описание объясняет, почему уровень такой', () => {
  const out = describeTemperature(item(12, 3), NOW);

  assert.equal(out.level, 'hot');
  assert.equal(out.label, 'горячий');
  assert.equal(out.used, 12);
  assert.equal(out.days, 3);
  assert.match(out.why, /12 раз/);
  assert.match(out.why, /3 дня назад/);
});

test('неиспользованный промпт объяснён прямо', () => {
  const out = describeTemperature({ used: 0, last_used: null }, NOW);

  assert.equal(out.level, 'cold');
  assert.equal(out.why, 'ни разу не использован');
});

// ── человеческие сроки ───────────────────────────────────────────────────────

test('сроки читаются по-русски с правильными окончаниями', () => {
  assert.equal(humanDays(0), 'сегодня');
  assert.equal(humanDays(1), 'вчера');
  assert.equal(humanDays(2), '2 дня назад');
  assert.equal(humanDays(5), '5 дней назад');
  assert.equal(humanDays(7), '1 неделю назад');
  assert.equal(humanDays(14), '2 недели назад');
  assert.equal(humanDays(21), '3 недели назад');
  assert.equal(humanDays(30), '1 месяц назад');
  assert.equal(humanDays(60), '2 месяца назад');
  assert.equal(humanDays(150), '5 месяцев назад');
  assert.equal(humanDays(365), '1 год назад');
  assert.equal(humanDays(730), '2 года назад');
  assert.equal(humanDays(2000), '5 лет назад');
});

test('никогда — это слово, а не пустота', () => {
  assert.equal(humanDays(null), 'никогда');
});

test('одиннадцать и двенадцать не получают окончание «одного»', () => {
  // Классическая ошибка русской плюрализации: 11 дней, а не «11 день».
  assert.equal(humanDays(11), '1 неделю назад');
  assert.match(describeTemperature(item(11, 0), NOW).why, /11 раз/);
  assert.match(describeTemperature(item(21, 0), NOW).why, /21 раз/);
  assert.match(describeTemperature(item(22, 0), NOW).why, /22 раза/);
  assert.match(describeTemperature(item(2, 0), NOW).why, /2 раза/);
  assert.match(describeTemperature(item(1, 0), NOW).why, /1 раз/);
});

// ── сводка ───────────────────────────────────────────────────────────────────

test('сводка отвечает на вопрос «сколько из библиотеки живо»', () => {
  const out = temperatureStats([
    item(20, 1), item(15, 2),
    item(5, 20),
    item(3, 60),
    item(0, null), item(40, 400),
  ], NOW);

  assert.equal(out.total, 6);
  assert.equal(out.hot, 2);
  assert.equal(out.warm, 1);
  assert.equal(out.cool, 1);
  assert.equal(out.cold, 2);
});

test('сводка сходится: сумма уровней равна общему числу', () => {
  const items = Array.from({ length: 30 }, (_, i) => item(i, i * 13));

  const out = temperatureStats(items, NOW);

  assert.equal(out.hot + out.warm + out.cool + out.cold, out.total);
});

test('сводка по пустой библиотеке — нули, а не пустой объект', () => {
  const out = temperatureStats([], NOW);

  assert.deepEqual(out, { hot: 0, warm: 0, cool: 0, cold: 0, total: 0 });
});
