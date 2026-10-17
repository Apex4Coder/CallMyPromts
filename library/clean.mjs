// library/clean.mjs — очистка текста перед выдачей в чат.
//
// Порядок операций фиксирован в docs/DATA-CONTRACTS.md §1.4 и не меняется:
// снять frontmatter → снять HTML → снять префикс TODO → обрезать края →
// нормализовать переводы строк.
//
// Зачем HTML: 19 из 39 клипов ClipClip — это HTML с инлайн-CSS от Google Docs.
// Вставить такое в чат означает отправить модели разметку вместо промпта.

// Признаки разметки. `<p>` без атрибутов — самая частая форма, поэтому проверка
// допускает и пробел, и закрывающую скобку: шаблон `<p\s` её пропускал, и текст
// уходил в библиотеку вместе с тегами.
const HTML_HINT = /<html|<body|<\/?(?:p|div|span|br|li|ul|ol|h[1-6]|table|tr|td|pre|blockquote)[\s>/]|style=/i;

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&#39;': "'", '&apos;': "'", '&mdash;': '—',
  '&ndash;': '–', '&hellip;': '…', '&laquo;': '«', '&raquo;': '»',
};

/** Раскрытие HTML-сущностей, включая числовые. */
export const unescapeHtml = (s) => String(s)
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
  .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);

export const looksLikeHtml = (s) => HTML_HINT.test(String(s ?? '').slice(0, 400));

/**
 * Снятие разметки с сохранением границ абзацев.
 * Блочные теги превращаются в перевод строки, остальные удаляются: иначе весь
 * документ склеился бы в одну строку и промпт стал бы нечитаемым.
 */
export const stripHtml = (input) => {
  let s = String(input ?? '');

  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)\s*>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '- ');
  s = s.replace(/<[^>]+>/g, '');
  s = unescapeHtml(s);

  // Пробелы внутри строк сворачиваем, но переводы строк сохраняем.
  s = s.split('\n').map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
};

/** Снятие префикса-заглушки. Признак прежней системы, где TODO означало «пусто». */
export const stripTodo = (s) => String(s ?? '').replace(/^\s*TODO:\s*/i, '');

export const normalizeNewlines = (s) => String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

/**
 * Полная очистка тела промпта.
 * @returns {{ text: string, changed: string[] }} changed — что именно применили,
 * чтобы интерфейс мог показать причину, а не молча подменить текст.
 */
export const cleanBody = (input) => {
  const changed = [];
  let s = normalizeNewlines(input);

  if (looksLikeHtml(s)) {
    s = stripHtml(s);
    changed.push('html');
  }

  const noTodo = stripTodo(s);
  if (noTodo !== s) {
    s = noTodo;
    changed.push('todo');
  }

  const trimmed = s.trim();
  if (trimmed !== s) changed.push('trim');

  return { text: trimmed, changed };
};

/**
 * Имя-заголовок из текста, когда пользователь его не задал.
 * Берём первые значимые слова первой строки, а не первые 50 символов: в ClipClip
 * заголовком служил обрезанный текст, и список получался нечитаемым.
 */
export const titleFromText = (text, max = 48) => {
  const first = String(text ?? '').split('\n').find((l) => l.trim() !== '') ?? '';
  const words = first.replace(/[#*`<>_[\]]/g, ' ').split(/\s+/).filter(Boolean);
  let out = '';
  for (const w of words) {
    if (out !== '' && (`${out} ${w}`).length > max) break;
    out = out === '' ? w : `${out} ${w}`;
  }
  if (out === '') return 'Без названия';
  return out.charAt(0).toUpperCase() + out.slice(1);
};

/** Транслитерация для id: заголовок русский, имя файла обязано быть латиницей. */
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export const slugify = (input, max = 40) => {
  const lower = String(input ?? '').toLowerCase();
  let s = '';
  for (const ch of lower) s += TRANSLIT[ch] ?? ch;
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/g, '');
  return s === '' ? 'prompt' : s;
};

/** Запрещённые в Windows символы имени файла заменяются, а не отбрасываются молча. */
export const safeFileName = (name) => String(name ?? '').replace(/[\\/:*?"<>|]/g, '-').trim();
