// clipboard/kind.mjs — прикладной слой над определением типа записи.
//
// Требование: REQ-CLIP-KIND (docs/SPEC.md §4). Тест: tests/unit/clip-kind.test.mjs.
//
// Разделение обязанностей: contracts/clip.mjs отвечает за сам факт «какой это тип»
// (примитив схемы, от него зависит запись в базу). Здесь — прикладной вид над типом:
// подпись, значок, фильтры для списка, догадка о языке кода. Это разные скорости
// изменения: схема живёт годами, подписи и значки правятся часто.

import { detectKind, KINDS, num } from '../contracts/index.mjs';

/**
 * Подписи и значки типов.
 * Значок — текстовый, не картинка: список буфера рисуется сотнями строк,
 * и текстовый глиф не тянет за собой ни файлов, ни задержки на загрузку.
 * Цвет здесь не задаётся: тип обозначается словом и глифом, а цвет — только
 * усиление (docs/RULES.md §5, docs/UI-SPEC.md §1.3).
 */
export const KIND_VIEW = {
  text: { label: 'текст', glyph: '¶', order: 1 },
  code: { label: 'код', glyph: '{ }', order: 2 },
  url: { label: 'ссылка', glyph: '↗', order: 3 },
  path: { label: 'путь', glyph: '/', order: 4 },
  email: { label: 'почта', glyph: '@', order: 5 },
  image: { label: 'картинка', glyph: '▣', order: 6 },
};

/** Фильтры для панели журнала. `all` первым: чаще всего нужен весь список. */
export const KIND_FILTERS = [
  { id: 'all', label: 'все', kinds: null },
  { id: 'text', label: 'текст', kinds: ['text'] },
  { id: 'code', label: 'код', kinds: ['code'] },
  { id: 'link', label: 'ссылки', kinds: ['url', 'email'] },
  { id: 'path', label: 'пути', kinds: ['path'] },
  { id: 'image', label: 'картинки', kinds: ['image'] },
];

const LANG_MARKS = [
  ['python', [/^\s*def\s+\w+\s*\(/m, /^\s*import\s+\w+$/m, /\bself\b/, /:\s*$/m]],
  ['javascript', [/=>/, /\bconst\s+\w+\s*=/, /\bfunction\s*\(/, /\bexport\s+/]],
  ['html', [/<\/[a-z]+>/i, /<!doctype/i, /<div/i]],
  ['css', [/[.#][\w-]+\s*\{/, /:\s*[\w#(]+;/]],
  ['sql', [/\bselect\b[\s\S]+\bfrom\b/i, /\binsert\s+into\b/i]],
  ['json', [/^\s*\{[\s\S]*"[^"]+"\s*:/]],
  ['yaml', [/^[a-z_][\w-]*:\s+\S+$/im]],
  ['shell', [/^\s*(cd|ls|git|npm|python|node)\s+/m, /^\s*#!/]],
];

/**
 * Догадка о языке для подсветки. Возвращает `null`, когда уверенности нет:
 * подписать чужой язык хуже, чем не подписать никакой (docs/RULES.md §4).
 */
export const guessLanguage = (text) => {
  const s = String(text ?? '');
  if (!s.trim()) return null;

  let best = null;
  let bestScore = 0;
  for (const [lang, marks] of LANG_MARKS) {
    let score = 0;
    for (const re of marks) if (re.test(s)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = lang;
    }
  }
  return bestScore >= 2 ? best : null;
};

/** Полное описание типа для одной записи: и для списка, и для просмотра. */
export const describeKind = (text, { isImage = false, kind = null } = {}) => {
  const k = kind && KINDS.includes(kind) ? kind : detectKind(text, { isImage });
  const view = KIND_VIEW[k] ?? KIND_VIEW.text;
  return {
    kind: k,
    label: view.label,
    glyph: view.glyph,
    language: k === 'code' ? guessLanguage(text) : null,
  };
};

/** Подходит ли запись под фильтр. Неизвестный фильтр не скрывает ничего. */
export const matchesFilter = (kind, filterId) => {
  if (!filterId || filterId === 'all') return true;
  const f = KIND_FILTERS.find((x) => x.id === filterId);
  if (!f || !f.kinds) return true;
  return f.kinds.includes(kind);
};

/**
 * Счётчики по фильтрам для подписей вкладок.
 * Все значения проходят через `num` из contracts: подпись «код (NaN)» выглядит
 * как поломка всей панели, а не как одно битое число (docs/RULES.md §4).
 */
export const countByFilter = (byKind = {}) => {
  const out = {};
  for (const f of KIND_FILTERS) {
    const keys = f.kinds ?? Object.keys(byKind ?? {});
    out[f.id] = keys.reduce((a, k) => a + num(byKind?.[k]), 0);
  }
  return out;
};
