// rank/order.mjs — порядок списка и подсказка о закреплении.
//
// Требования: REQ-RANK-ORDER, REQ-RANK-SUGGEST (docs/SPEC.md §5). Сценарий S-06.
// Тесты: tests/unit/rank-order.test.mjs, tests/unit/rank-suggest.test.mjs.
//
// Главное свойство порядка — предсказуемость. В ClipClip два режима («сохранить
// позицию» и «переместить в начало»), и это правильное решение: список, который
// сам себя переставляет, ломает мышечную память, а список, который не реагирует
// на частоту, заставляет искать одно и то же каждый день.
//
// Здесь тот же выбор, но строже:
//   • позиции 1..9 (`pin`) НЕ двигаются никогда, ни в одном режиме;
//   • всё остальное либо сортируется по частоте, либо остаётся как в файлах.

import { temperature, LEVEL_VIEW } from './temperature.mjs';

export const MODES = ['pinned-frequency', 'manual'];
export const PIN_MIN = 1;
export const PIN_MAX = 9;

const pinOf = (i) => {
  const n = Number(i?.pin);
  return Number.isInteger(n) && n >= PIN_MIN && n <= PIN_MAX ? n : null;
};

const isUsable = (i) => i?.state !== 'bad' && i?.status !== 'archived';

/** Закреплённые по возрастанию позиции. Дубли позиций идут по id — до исправления V-P-4. */
export const pinned = (items = []) => items
  .filter((i) => pinOf(i) !== null)
  .sort((a, b) => pinOf(a) - pinOf(b) || String(a.id).localeCompare(String(b.id), 'ru'));

export const unpinned = (items = []) => items.filter((i) => pinOf(i) === null);

/**
 * Вес внутри одной температуры. Только частота: свежесть уже учтена тем,
 * что сравниваются промпты одного уровня.
 *
 * Поправочный коэффициент здесь был ошибкой: `p-parse` с 40 использованиями
 * год назад получал вес 6.0 и обгонял `c-bug` с 6 использованиями на прошлой
 * неделе (вес 4.2), то есть холодный промпт вставал на вторую позицию списка.
 * Это прямо противоречит правилу «свежесть важнее частоты», поэтому температура
 * стала первым ключом сортировки, а частота — вторым.
 */
export const weight = (item) => Number(item?.used ?? 0);

/**
 * Итоговый порядок.
 * @param {object[]} items промпты из library
 * @param {object} opts.mode 'pinned-frequency' | 'manual'
 * @returns {object[]} закреплённые сверху в порядке позиций, далее остальные
 */
export const order = (items = [], { mode = 'pinned-frequency', now = Date.now() } = {}) => {
  const head = pinned(items);
  const tail = unpinned(items);

  if (mode === 'manual') {
    // Порядок как в библиотеке: группа, затем имя. Ничего не переставляется
    // между запусками, даже если частота изменилась.
    tail.sort((a, b) => String(a.group ?? '').localeCompare(String(b.group ?? ''), 'ru')
      || String(a.title ?? a.id).localeCompare(String(b.title ?? b.id), 'ru'));
  } else {
    // Сначала температура (свежесть), внутри уровня — частота, затем имя.
    tail.sort((a, b) => LEVEL_VIEW[temperature(a, now)].rank - LEVEL_VIEW[temperature(b, now)].rank
      || weight(b) - weight(a)
      || String(a.title ?? a.id).localeCompare(String(b.title ?? b.id), 'ru'));
  }

  // Битые в конец: они видны и объяснены, но не мешают выбирать рабочие.
  const good = [...head, ...tail].filter(isUsable);
  const broken = [...head, ...tail].filter((i) => !isUsable(i));

  return [...good, ...broken].map((item, idx) => ({
    ...item,
    _pos: idx + 1,
    _pin: pinOf(item),
    _digit: pinOf(item) ?? null,
  }));
};

/** Первая свободная позиция 1..9 либо `null`, если заняты все (S-06). */
export const firstFreePin = (items = []) => {
  const taken = new Set(items.map(pinOf).filter((p) => p !== null));
  for (let n = PIN_MIN; n <= PIN_MAX; n += 1) if (!taken.has(n)) return n;
  return null;
};

/** Кто занимает позицию — чтобы предложить обмен, а не молча перезаписать. */
export const occupantOf = (items = [], pin) => items.find((i) => pinOf(i) === Number(pin)) ?? null;

/**
 * Проверка перед закреплением. Решение остаётся за человеком: функция только
 * объясняет последствие.
 */
export const planPin = (items = [], id, wanted = null) => {
  const target = items.find((i) => i.id === id);
  if (!target) return { ok: false, reason: 'промпт не найден' };
  if (target.status === 'archived') return { ok: false, reason: 'архивный промпт нельзя закрепить' };

  const pin = wanted === null ? firstFreePin(items) : Number(wanted);
  if (pin === null) {
    return {
      ok: false,
      reason: 'свободных позиций нет',
      occupied: pinned(items).map((i) => ({ pin: pinOf(i), id: i.id, title: i.title })),
    };
  }
  if (!Number.isInteger(pin) || pin < PIN_MIN || pin > PIN_MAX) {
    return { ok: false, reason: `позиция должна быть ${PIN_MIN}..${PIN_MAX}` };
  }

  const occupant = occupantOf(items, pin);
  if (!occupant || occupant.id === id) {
    return { ok: true, pin, swapWith: null, note: `будет закреплён на ${pin}` };
  }

  // Если у выбранного промпта своей позиции нет, обменивать нечего: занимающий
  // её просто перестанет быть закреплённым. Называем это прямо, иначе слово
  // «обмен» скрывает потерю закрепления (docs/RULES.md §4).
  const to = pinOf(target) ?? null;
  const name = occupant.title ?? occupant.id;
  return {
    ok: true,
    pin,
    swapWith: { id: occupant.id, title: occupant.title, from: pin, to },
    note: to === null
      ? `позиция ${pin} занята «${name}» — он потеряет закрепление`
      : `позиция ${pin} занята «${name}» — он перейдёт на ${to}`,
  };
};

/**
 * Подсказка «закрепить?» — REQ-RANK-SUGGEST.
 * Порог настраиваемый (`order.suggest_pin_after`, по умолчанию 5). Подсказка
 * не закрепляет ничего сама: правило docs/RULES.md §5 — решение за человеком.
 */
export const suggestPin = (items = [], { after = 5, now = Date.now() } = {}) => {
  const free = firstFreePin(items);
  const candidates = unpinned(items)
    .filter(isUsable)
    .filter((i) => Number(i.used ?? 0) >= after)
    .filter((i) => temperature(i, now) === 'hot' || temperature(i, now) === 'warm')
    .sort((a, b) => Number(b.used ?? 0) - Number(a.used ?? 0));

  if (candidates.length === 0) return null;

  const top = candidates[0];
  return {
    id: top.id,
    title: top.title ?? top.id,
    used: Number(top.used ?? 0),
    pin: free,
    text: free === null
      ? `«${top.title ?? top.id}» использован ${top.used} раз — позиции заняты, можно заменить`
      : `«${top.title ?? top.id}» использован ${top.used} раз — закрепить на ${free}?`,
  };
};

/** Раскладка позиций 1..9 для окна выбора: пустые слоты показываются как свободные. */
export const pinSlots = (items = []) => {
  const map = new Map(pinned(items).map((i) => [pinOf(i), i]));
  const slots = [];
  for (let n = PIN_MIN; n <= PIN_MAX; n += 1) {
    const it = map.get(n) ?? null;
    slots.push({ pin: n, id: it?.id ?? null, title: it?.title ?? null, free: it === null });
  }
  return slots;
};
