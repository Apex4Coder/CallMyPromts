// ui/views/state.js — четыре состояния, честная пустота, связь с API.
//
// Требования: REQ-UI-STATE, REQ-UI-EMPTY (docs/SPEC.md §7). Правила: RULES §4, §5.
// Тесты: tests/e2e/state.spec.mjs, tests/e2e/empty.spec.mjs.
//
// Здесь собрано всё, что касается «чего-то нет». Прочерк с причиной вместо нуля,
// плашка со значком И словом вместо цветного кружка, `undefined` и `NaN` не
// доходят до экрана никогда (утверждение U-14).

export const STATE_VIEW = {
  good: { glyph: '✓', word: 'в норме' },
  warn: { glyph: '!', word: 'внимание' },
  bad: { glyph: '✕', word: 'сломано' },
  none: { glyph: '–', word: 'нет данных' },
};

/**
 * Токен подставляет сервер при отдаче HTML: браузер не читает файлы
 * (docs/DATA-CONTRACTS.md §5).
 *
 * Читается из `<meta name="deck-token">`, а не из `window.DECK_TOKEN`. Причина:
 * политика безопасности страницы запрещает встроенные скрипты (`script-src
 * 'self'`), поэтому строка `window.DECK_TOKEN = "..."` в разметке не выполнялась
 * — токен оказывался пустым, и каждый запрос получал 401. Ослаблять политику
 * нельзя: в страницу попадает содержимое промптов.
 */
const token = () => {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="deck-token"]')?.content ?? '';
};

/**
 * Запрос к API. Ошибка возвращается как значение, а не как исключение:
 * интерфейс обязан показать причину, а не молча остаться пустым.
 * @returns {Promise<{ok: boolean, data: object|null, error: object|null}>}
 */
export const api = async (path, { method = 'GET', body = null } = {}) => {
  try {
    const res = await fetch(path, {
      method,
      headers: { 'X-Deck-Token': token(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      return { ok: false, data: null, error: { error: 'bad_response', message: 'ответ сервера не разобран' } };
    }

    if (!res.ok) return { ok: false, data, error: data ?? { error: 'http', message: `код ${res.status}` } };
    return { ok: true, data, error: null };
  } catch (err) {
    // Сервис остановлен — самый частый случай, и он не должен выглядеть как «пусто».
    return {
      ok: false,
      data: null,
      error: { error: 'no_service', message: `нет связи с сервисом: ${err.message}` },
    };
  }
};

/**
 * Счётчик заявок: отбрасывает ответ, который пришёл позже более свежего.
 *
 * Зачем. Окно выбора всплывает и человек СРАЗУ печатает — в этом весь смысл
 * хоткея. Первый запрос (пустой поиск) читает библиотеку с диска, второй (с
 * запросом) попадает в кэш и отвечает быстрее. Порядок ответов обратный порядку
 * запросов, и список показывал все промпты при непустом поиске, а Enter вставлял
 * не тот промпт, который человек видел выделенным. Пойман E2E-тестом на Ctrl+Enter.
 *
 * Отмена запроса здесь не нужна и была бы хуже: ответ всё равно придёт, важно
 * лишь не применять устаревший.
 *
 * @returns {{next: () => number, fresh: (n: number) => boolean}}
 */
export const latest = () => {
  let n = 0;
  return {
    next: () => {
      n += 1;
      return n;
    },
    fresh: (mine) => mine === n,
  };
};

/** Плашка состояния: значок и слово обязательны, цвет — только усиление. */
export const setState = (el, level, word = null, title = null) => {
  if (!el) return;
  const view = STATE_VIEW[level] ?? STATE_VIEW.none;
  el.className = `state is-${level}`;
  el.innerHTML = '';

  const glyph = document.createElement('span');
  glyph.className = 'glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = view.glyph;

  const text = document.createElement('span');
  text.className = 'word';
  text.textContent = word ?? view.word;

  el.append(glyph, text);
  if (title) el.title = title;
};

/**
 * Прочерк вместо пустоты. Отдельная функция, потому что `${value}` от undefined
 * даёт строку «undefined» на экране — это ложь о данных (RULES §4).
 */
export const dash = (value, suffix = '') => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number' && !Number.isFinite(value)) return '—';
  return `${value}${suffix}`;
};

/** Безопасная вставка текста: содержимое промпта никогда не становится разметкой. */
export const setText = (el, value) => {
  if (!el) return;
  el.textContent = value === null || value === undefined ? '—' : String(value);
};

/** Подсветка совпадения из частей: разметку строит DOM, не строка. */
export const renderParts = (el, parts, fallback = '') => {
  if (!el) return;
  el.textContent = '';
  if (!Array.isArray(parts) || parts.length === 0) {
    el.textContent = fallback;
    return;
  }
  for (const p of parts) {
    if (p.hit) {
      const mark = document.createElement('span');
      mark.className = 'hit';
      mark.textContent = p.text;
      el.append(mark);
    } else {
      el.append(document.createTextNode(p.text));
    }
  }
};

/** Пустое состояние: причина обязательна, список скрывается. */
export const showEmpty = (listEl, emptyEl, textEl, message) => {
  if (listEl) listEl.hidden = true;
  if (emptyEl) emptyEl.hidden = false;
  setText(textEl, message);
};

export const hideEmpty = (listEl, emptyEl) => {
  if (listEl) listEl.hidden = false;
  if (emptyEl) emptyEl.hidden = true;
};

/** Всплывающее сообщение. Уровень задаёт плашку, а не только цвет. */
let toastTimer = null;
export const toast = (message, level = 'good', ms = 2600) => {
  const el = document.getElementById('toast');
  if (!el) return;

  el.innerHTML = '';
  const badge = document.createElement('span');
  setState(badge, level);
  const text = document.createElement('span');
  text.textContent = ` ${message}`;
  el.append(badge, text);
  el.hidden = false;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
};

/** Температура: полоски и слово. Отключается настройкой show_temperature. */
export const tempChip = (usage) => {
  const box = document.createElement('span');
  box.className = 'temp';
  box.dataset.level = usage?.temperature ?? 'cold';

  const bars = document.createElement('span');
  bars.className = 'bars';
  bars.textContent = { hot: '▰▰▰', warm: '▰▰▱', cool: '▰▱▱', cold: '▱▱▱' }[usage?.temperature] ?? '▱▱▱';

  const word = document.createElement('span');
  word.textContent = usage?.temperatureLabel ?? 'холодный';

  box.append(bars, word);
  box.title = usage?.why ?? '';
  return box;
};

/** Значок счётчика. Возвращает null, когда показывать нечего. */
export const usageBadge = (usage) => {
  if (!usage?.badge) return null;
  const el = document.createElement('span');
  el.className = 'badge';
  el.textContent = `⌗${usage.badge.text}`;
  el.title = usage.badge.title;
  return el;
};

/** Человеческое время «2 минуты назад» для журнала. */
export const ago = (iso) => {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return '—';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return 'только что';
  if (sec < 3600) return `${Math.floor(sec / 60)} мин`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} ч`;
  return `${Math.floor(sec / 86400)} дн`;
};
