// bridge/hotkeys.mjs — разбор, проверка и конфликты горячих клавиш.
//
// Требования: REQ-KEY-BIND, REQ-KEY-CONFLICT (docs/SPEC.md §8). Сценарий S-07.
// Тесты: tests/unit/bridge-keys.test.mjs, tests/unit/bridge-conflict.test.mjs.
//
// Формат — нотация AutoHotkey: ^ Ctrl, ! Alt, + Shift, # Win. Она выбрана не из
// вкуса, а потому что мост — это AHK-скрипт, и любой другой формат пришлось бы
// переводить в неё же, добавив ещё одно место для ошибки.
//
// Ключевой принцип взят у ClipClip: красная строка вместо тихого отказа. Клавиша,
// которая не работает и никто не сказал почему, — худший из вариантов (S-07).

export const MODS = { '^': 'Ctrl', '!': 'Alt', '+': 'Shift', '#': 'Win' };

/**
 * Комбинации, которые перехватывает сама Windows: регистрация невозможна,
 * и попытка выглядела бы как необъяснимый отказ.
 */
export const SYSTEM_COMBOS = new Set([
  '#l', '#d', '#e', '#r', '#tab', '^!del', '^+esc', '!tab', '#p',
]);

/** Комбинации, занятые известными приложениями на этой машине. */
export const KNOWN_TAKEN = {
  '^q': 'ClipClip — выбор закреплённых клипов',
  '^+v': 'ClipClip — меню вставки',
  '^!v': 'Punto Switcher (в некоторых сборках)',
};

const KEY_RE = /^[a-z0-9]$|^f[1-9]$|^f1[0-2]$|^(?:space|tab|enter|esc|del|ins|home|end|pgup|pgdn|up|down|left|right)$/;

/**
 * Разбор комбинации.
 * @returns {{ok: boolean, mods: string[], key: string|null, human: string, reason: string|null}}
 */
export const parseCombo = (combo) => {
  const raw = String(combo ?? '').trim();
  if (raw === '') {
    return { ok: true, empty: true, mods: [], key: null, human: 'не назначена', reason: null };
  }

  const mods = [];
  let i = 0;
  while (i < raw.length && MODS[raw[i]]) {
    if (mods.includes(MODS[raw[i]])) {
      return { ok: false, mods, key: null, human: raw, reason: `модификатор ${MODS[raw[i]]} указан дважды` };
    }
    mods.push(MODS[raw[i]]);
    i += 1;
  }

  const key = raw.slice(i).toLowerCase();

  if (mods.length === 0) {
    return { ok: false, mods, key, human: raw, reason: 'нужен минимум один модификатор: Ctrl, Alt, Shift или Win' };
  }
  if (!KEY_RE.test(key)) {
    return { ok: false, mods, key, human: raw, reason: `клавиша «${key}» не поддерживается` };
  }
  if (SYSTEM_COMBOS.has(raw.toLowerCase())) {
    return { ok: false, mods, key, human: raw, reason: 'комбинацию перехватывает Windows' };
  }

  return {
    ok: true,
    empty: false,
    mods,
    key,
    human: [...mods, key.toUpperCase()].join(' + '),
    reason: null,
  };
};

/**
 * Проверка набора хоткеев целиком: формат, внутренние дубли, известные занятые.
 * @returns {Object<string, {combo, state, reason, human}>} по одному на каждое действие
 */
export const checkHotkeys = (hotkeys = {}) => {
  const out = {};
  const used = new Map();

  for (const [action, combo] of Object.entries(hotkeys)) {
    const parsed = parseCombo(combo);
    const norm = String(combo ?? '').trim().toLowerCase();

    if (parsed.empty) {
      out[action] = { combo: '', state: 'none', reason: 'не назначена', human: 'не назначена' };
      continue;
    }
    if (!parsed.ok) {
      out[action] = { combo, state: 'bad', reason: parsed.reason, human: parsed.human };
      continue;
    }

    // Внутренний конфликт виден до попытки регистрации (S-07, плохой путь 2).
    if (used.has(norm)) {
      out[action] = {
        combo,
        state: 'bad',
        reason: `та же комбинация уже назначена на «${used.get(norm)}»`,
        human: parsed.human,
      };
      continue;
    }
    used.set(norm, action);

    if (KNOWN_TAKEN[norm]) {
      out[action] = {
        combo,
        state: 'warn',
        reason: `вероятно занята: ${KNOWN_TAKEN[norm]}`,
        human: parsed.human,
      };
      continue;
    }

    out[action] = { combo, state: 'good', reason: null, human: parsed.human };
  }

  return out;
};

/** Свободные варианты для замены: предлагаем, а не назначаем сами. */
export const suggestFree = (taken = [], count = 3) => {
  const busy = new Set([
    ...taken.map((c) => String(c).trim().toLowerCase()),
    ...Object.keys(KNOWN_TAKEN),
    ...SYSTEM_COMBOS,
  ]);

  const out = [];
  for (const mod of ['^!', '^+', '!+', '#!']) {
    for (const key of 'qwertyudpjkl123456789') {
      const combo = `${mod}${key}`;
      if (busy.has(combo)) continue;
      out.push({ combo, human: parseCombo(combo).human });
      if (out.length >= count) return out;
    }
  }
  return out;
};

/** Сводное состояние для трея: худшее из состояний хоткеев. */
export const worstState = (checked = {}) => {
  const levels = Object.values(checked).map((x) => x.state);
  if (levels.includes('bad')) return 'bad';
  if (levels.includes('warn')) return 'warn';
  if (levels.length === 0 || levels.every((l) => l === 'none')) return 'none';
  return 'good';
};
