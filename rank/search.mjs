// rank/search.mjs — поиск по библиотеке с исправлением раскладки.
//
// Требование: REQ-RANK-SEARCH (docs/SPEC.md §5). Сценарий S-02.
// Тест: tests/unit/rank-search.test.mjs.
//
// Задача, которую решает файл: человек помнит слово, но не помнит триггер и номер.
// Три особенности, без которых поиск бесполезен на этой машине:
//   1. Раскладка. Набрано «HTDN» вместо «ревью» — это норма, когда окно всплывает
//      поверх чата. Ищем по обоим вариантам запроса.
//   2. Запрос из одного символа не идёт по телу: иначе совпадёт всё и выдача
//      потеряет смысл (S-02, плохой путь 3).
//   3. Совпадение возвращается с позициями, чтобы интерфейс подсветил именно
//      найденное, а не перекрасил строку целиком.

// Физические клавиши в одном порядке: индекс i латиницы соответствует индексу i кириллицы.
const LAT = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const CYR = 'йцукенгшщзхъфывапролджэячсмитьбюё';

const LAT_TO_CYR = new Map();
const CYR_TO_LAT = new Map();
for (let i = 0; i < LAT.length; i += 1) {
  LAT_TO_CYR.set(LAT[i], CYR[i]);
  CYR_TO_LAT.set(CYR[i], LAT[i]);
}

/** Перевод строки между раскладками. Незнакомый символ остаётся как есть. */
export const swapLayout = (s) => {
  const src = String(s ?? '').toLowerCase();
  let out = '';
  let touched = false;
  for (const ch of src) {
    const mapped = LAT_TO_CYR.get(ch) ?? CYR_TO_LAT.get(ch);
    if (mapped) {
      out += mapped;
      touched = true;
    } else {
      out += ch;
    }
  }
  return touched ? out : src;
};

export const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').trim();

/**
 * Варианты запроса: как набрано и как получилось бы в другой раскладке.
 * Второй вариант добавляется только если он отличается — иначе поиск делал бы
 * двойную работу на каждом кадре набора.
 */
export const queryVariants = (query) => {
  const a = norm(query);
  if (a === '') return [];
  const b = norm(swapLayout(a));
  return b === a ? [a] : [a, b];
};

/** Позиции совпадения для подсветки. Возвращает `null`, когда совпадения нет. */
export const matchSpan = (haystack, needle) => {
  const h = norm(haystack);
  const n = norm(needle);
  if (n === '' || h === '') return null;
  const at = h.indexOf(n);
  return at < 0 ? null : { start: at, end: at + n.length };
};

// Вес поля. Название важнее тела: человек ищет промпт, а не фразу внутри него.
const WEIGHT = {
  idExact: 1000,
  triggerExact: 900,
  titleStart: 500,
  titleWord: 400,
  titleAny: 300,
  idAny: 250,
  tag: 200,
  group: 150,
  bodyAny: 60,
};

const wordStarts = (text, needle) => {
  const h = norm(text);
  const n = norm(needle);
  if (n === '') return false;
  return h.split(/[\s\-_/.,:;()[\]]+/).some((w) => w.startsWith(n));
};

/**
 * Оценка одного промпта против одного варианта запроса.
 * @returns {{ score: number, field: string|null, span: object|null }}
 */
const scoreOne = (item, q, { searchBody }) => {
  const title = item.title ?? '';
  const id = item.id ?? '';
  const trigger = item.trigger ?? '';
  const group = item.group ?? '';
  const tags = Array.isArray(item.tags) ? item.tags : [];

  if (norm(id) === q) return { score: WEIGHT.idExact, field: 'id', span: matchSpan(id, q) };
  if (trigger && norm(trigger).replace(/^:/, '') === q.replace(/^:/, '')) {
    return { score: WEIGHT.triggerExact, field: 'trigger', span: matchSpan(trigger, q) };
  }

  const titleSpan = matchSpan(title, q);
  if (titleSpan && titleSpan.start === 0) return { score: WEIGHT.titleStart, field: 'title', span: titleSpan };
  if (titleSpan && wordStarts(title, q)) return { score: WEIGHT.titleWord, field: 'title', span: titleSpan };
  if (titleSpan) return { score: WEIGHT.titleAny, field: 'title', span: titleSpan };

  const idSpan = matchSpan(id, q);
  if (idSpan) return { score: WEIGHT.idAny, field: 'id', span: idSpan };

  const tag = tags.find((t) => norm(t).includes(q));
  if (tag) return { score: WEIGHT.tag, field: 'tags', span: matchSpan(tag, q) };

  const groupSpan = matchSpan(group, q);
  if (groupSpan) return { score: WEIGHT.group, field: 'group', span: groupSpan };

  if (searchBody && typeof item.body === 'string') {
    const bodySpan = matchSpan(item.body, q);
    if (bodySpan) return { score: WEIGHT.bodyAny, field: 'body', span: bodySpan };
  }

  return { score: 0, field: null, span: null };
};

/**
 * Поиск. Пустой запрос возвращает список без изменений порядка: за порядок
 * отвечает rank/order.mjs, поиск лишь фильтрует и добавляет `_match`.
 *
 * @param {object[]} items промпты из library
 * @param {string} query запрос
 * @param {object} opts.minBodyLen с какой длины запроса искать по телу
 * @returns {object[]} элементы с полями `_score` и `_match`
 */
export const search = (items = [], query = '', { minBodyLen = 2 } = {}) => {
  const variants = queryVariants(query);
  if (variants.length === 0) return items.map((i) => ({ ...i, _score: 0, _match: null }));

  const searchBody = norm(query).length >= minBodyLen;
  const out = [];

  for (const item of items) {
    let best = { score: 0, field: null, span: null, variant: null };
    for (const q of variants) {
      const got = scoreOne(item, q, { searchBody });
      if (got.score > best.score) best = { ...got, variant: q };
    }
    if (best.score > 0) {
      out.push({
        ...item,
        _score: best.score,
        _match: { field: best.field, span: best.span, query: best.variant, corrected: best.variant !== variants[0] },
      });
    }
  }

  // Сортировка по релевантности; равные — по частоте, затем по имени.
  out.sort((a, b) => b._score - a._score
    || Number(b.used ?? 0) - Number(a.used ?? 0)
    || String(a.title ?? a.id).localeCompare(String(b.title ?? b.id), 'ru'));

  return out;
};

/**
 * Разбивка строки на части для подсветки без вставки HTML.
 * Интерфейс получает массив и сам создаёт узлы — так текст промпта не может
 * стать разметкой (защита от подстановки через содержимое файла).
 */
export const highlightParts = (text, span) => {
  const s = String(text ?? '');
  if (!span || span.start < 0 || span.end > s.length) return [{ text: s, hit: false }];
  return [
    { text: s.slice(0, span.start), hit: false },
    { text: s.slice(span.start, span.end), hit: true },
    { text: s.slice(span.end), hit: false },
  ].filter((p) => p.text !== '');
};

/**
 * Текст для пустой выдачи: запрос виден человеку целиком (S-02).
 *
 * Подсказки «возможно, имелось в виду» здесь нет намеренно: поиск уже проверил
 * вторую раскладку сам. Предлагать то, что только что не нашлось, — это ложь
 * интерфейса (docs/RULES.md §4). Вместо этого сообщаем, что обе раскладки учтены.
 */
export const emptyMessage = (query) => {
  const q = String(query ?? '').trim();
  const both = queryVariants(q).length > 1 ? ' Проверены обе раскладки.' : '';
  return `Ничего не найдено по запросу «${q}».${both}`;
};
