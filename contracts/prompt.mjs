// contracts/prompt.mjs — схема промпта и её валидация.
//
// Схема: docs/DATA-CONTRACTS.md §1.2. Правила V-P-1..V-P-12: §1.3.
// Уровень bad изолирует ТОЛЬКО этот файл (REQ-LIB-ISOLATE): один битый .md не имеет
// права выводить из строя остальные — именно так прежняя система теряла все 26
// триггеров из-за одного пустого файла.

import { bad, warn, stateOf } from './errors.mjs';

// Латиница обязательна там, где значение уходит за пределы файла: `id` и `group`
// становятся именем файла и папки, `trigger` набирается с клавиатуры.
export const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
export const GROUP_RE = /^[a-z][a-z0-9-]{1,23}$/;
export const TRIGGER_RE = /^:[a-z][a-z0-9-]{1,23}$/;

// Метка не имя файла и не набираемый текст — она только читается человеком и
// участвует в поиске, который работает с кириллицей. Единственное техническое
// ограничение: запятая и скобки сломали бы разбор списка `[a, b]`, поэтому
// разрешены буквы любого алфавита, цифры, дефис и подчёркивание.
export const TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{1,23}$/u;

// Человеку показывается словами: исходник регулярного выражения с \p{L} ничего
// ему не объясняет.
export const TAG_HINT = 'буквы, цифры, дефис; 2..24 знака';

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const HOTKEY_RE = /^[\^!+#]{1,4}[a-z0-9]$/;

export const STATUSES = ['active', 'draft', 'archived'];

/** Порядок ключей в файле. Стабильный порядок делает diff читаемым. */
export const FIELD_ORDER = [
  'id', 'title', 'group', 'pin', 'hotkey', 'trigger', 'status', 'version',
  'created', 'updated', 'used', 'last_used', 'score', 'tags', 'source',
];

export const MAX_BYTES = 256 * 1024;
export const TITLE_MAX = 60;

/** Поля, которые правит только программа (docs/DATA-CONTRACTS.md §1.5). */
export const MACHINE_FIELDS = ['used', 'last_used', 'updated'];

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Заполняет отсутствующие поля значениями по умолчанию.
 * Не валидирует: пустоты и порча — забота validatePrompt.
 */
export const withDefaults = (meta, hints = {}) => ({
  id: meta.id ?? hints.id ?? null,
  title: meta.title ?? null,
  group: meta.group ?? hints.group ?? null,
  pin: meta.pin ?? null,
  hotkey: meta.hotkey ?? null,
  trigger: meta.trigger ?? null,
  status: meta.status ?? 'active',
  version: meta.version ?? 1,
  created: meta.created ?? hints.created ?? today(),
  updated: meta.updated ?? hints.updated ?? today(),
  used: meta.used ?? 0,
  last_used: meta.last_used ?? null,
  score: meta.score ?? null,
  tags: Array.isArray(meta.tags) ? meta.tags : [],
  source: meta.source ?? null,
});

const HTML_MARK = /<html|<body|<p\s|style=/i;

/**
 * Что означает факт очистки тела для человека.
 *
 * Зачем отдельно от HTML_MARK. V-P-10 и V-P-11 проверяют СЫРОЙ текст, а через
 * чтение библиотеки сюда приходит уже очищенный: `cleanBody` снимает разметку и
 * префикс TODO ДО валидации (docs/DATA-CONTRACTS.md §1.4). Значит проверка по
 * тексту на этом пути не срабатывала никогда — предупреждение существовало в
 * коде и было недостижимо. Поймано E2E-тестом состояний.
 *
 * Формулировка изменена по смыслу: «разметка попадёт в чат» после очистки
 * неправда — в чат уйдёт чистый текст. Правда в другом: разметка осталась В
 * ФАЙЛЕ, и её снимают при каждом чтении. Это `warn`, а не `bad`: промпт рабочий,
 * но файл стоит починить, иначе очистка молча работает вечно.
 */
const CLEANED_WHY = {
  html: { code: 'V-P-10', why: 'разметка снята при чтении — в файле остался HTML' },
  todo: { code: 'V-P-11', why: 'префикс TODO снят при чтении — в файле осталась заглушка' },
};

/**
 * Проверка одного промпта. Возвращает список замечаний; вызывающий решает,
 * что с ними делать. Уникальность id, pin, hotkey проверяется отдельно
 * (validateUnique), потому что требует всей библиотеки.
 *
 * @param {string[]} [ctx.cleaned] что именно сняла очистка тела (`cleanBody().changed`).
 *   Передаёт только чтение библиотеки: при создании и правке файл записывается уже
 *   чистым, и предупреждать не о чем — оставшейся разметки в нём нет.
 */
export const validatePrompt = (p, body, ctx = {}) => {
  const out = [];
  const place = { file: ctx.file ?? null };
  const at = (field, expected) => ({ ...place, field, expected });

  if (ctx.hasFrontmatter === false) {
    // Порча ВНУТРИ frontmatter — особый случай, и он обрабатывается первым.
    // У такой ошибки уже есть точное замечание с номером строки (его даёт
    // парсер), поэтому добавлять нечего. Остальные проверки на непрочитанных
    // метаданных дают производные жалобы: «нет frontmatter» — неправда, оба
    // `---` на месте; «title пусто» — неправда, title в файле есть, он просто
    // не был прочитан. Три замечания, два из них ложные, уводят от строки,
    // которую надо починить.
    //
    // Пустой список здесь безопасен: единственное место, выставляющее
    // reason: 'broken' — блок catch в library/read.mjs, и он в том же вызове
    // добавляет замечание уровня bad. Файл без замечаний из этой ветки выйти
    // не может.
    if (ctx.reason === 'broken') return out;

    // Причина названа точно: «нет метаданных» и «забыт второй ---» чинятся
    // по-разному, и общая формулировка заставляла бы искать, что именно не так.
    const why = ctx.reason === 'unclosed'
      ? 'frontmatter открыт, но не закрыт вторым ---'
      : 'нет frontmatter: файл не начинается с ---';
    out.push(bad('V-P-1', why, at('frontmatter', '--- ... ---')));
  }

  if (!p.id || !ID_RE.test(String(p.id))) {
    out.push(bad('V-P-2', `недопустимый id «${p.id ?? ''}»`, at('id', ID_RE.source)));
  }

  const title = String(p.title ?? '').trim();
  if (title === '') {
    out.push(bad('V-P-3', 'поле title пусто', at('title', `строка 1..${TITLE_MAX} знаков`)));
  } else if (title.length > TITLE_MAX) {
    out.push(warn('V-P-3', `title длиннее ${TITLE_MAX} знаков`, at('title', `не более ${TITLE_MAX}`)));
  }

  if (p.pin !== null && p.pin !== undefined) {
    const pin = Number(p.pin);
    if (!Number.isInteger(pin) || pin < 1 || pin > 9) {
      out.push(bad('V-P-4', `pin вне диапазона: ${p.pin}`, at('pin', 'целое 1..9 или null')));
    }
  }

  if (p.hotkey && !HOTKEY_RE.test(String(p.hotkey))) {
    out.push(warn('V-P-5', `hotkey «${p.hotkey}» не похож на сочетание AHK`, at('hotkey', '^!r, +#q')));
  }

  if (p.trigger && !TRIGGER_RE.test(String(p.trigger))) {
    out.push(warn('V-P-6', `trigger «${p.trigger}» не по формату`, at('trigger', TRIGGER_RE.source)));
  }

  if (!p.group || !GROUP_RE.test(String(p.group))) {
    out.push(warn('V-P-7', `группа «${p.group ?? ''}» не по формату`, at('group', GROUP_RE.source)));
  } else if (ctx.folder && ctx.folder !== p.group) {
    out.push(warn('V-P-7', `group «${p.group}» не совпадает с папкой «${ctx.folder}»`, at('group', ctx.folder)));
  }

  if (!STATUSES.includes(String(p.status))) {
    out.push(warn('V-P-13', `неизвестный status «${p.status}»`, at('status', STATUSES.join(' | '))));
  }

  const text = String(body ?? '').trim();
  if (text === '') {
    out.push(bad('V-P-8', 'тело промпта пусто', at('body', 'непустой текст')));
  }

  if (p.created && p.updated && DATE_RE.test(String(p.created)) && DATE_RE.test(String(p.updated))
      && String(p.updated) < String(p.created)) {
    out.push(warn('V-P-9', 'updated раньше created', at('updated', '>= created')));
  }

  if (HTML_MARK.test(text.slice(0, 200))) {
    out.push(warn('V-P-10', 'тело выглядит как HTML — разметка попадёт в чат', at('body', 'обычный текст')));
  }

  if (/^TODO:/i.test(text)) {
    out.push(warn('V-P-11', 'тело начинается с TODO — это заглушка', at('body', 'готовый текст')));
  }

  // Порча, которую очистка уже исправила в выдаче, но не в файле. `trim` здесь
  // сознательно не участвует: лишние пробелы по краям не меняют смысл текста, и
  // предупреждение о них было бы шумом на половине библиотеки.
  const already = new Set(out.map((i) => i.code));
  for (const what of ctx.cleaned ?? []) {
    const rule = CLEANED_WHY[what];
    if (!rule || already.has(rule.code)) continue;
    out.push(warn(rule.code, rule.why, at('body', 'обычный текст в файле')));
  }

  const bytes = ctx.bytes ?? Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_BYTES) {
    out.push(bad('V-P-12', `размер ${bytes} байт превышает лимит`, at('body', `не более ${MAX_BYTES}`)));
  }

  for (const key of ['version', 'used']) {
    const v = Number(p[key]);
    if (!Number.isInteger(v) || v < 0) {
      out.push(warn('V-P-14', `поле ${key} должно быть целым ≥ 0`, at(key, 'целое ≥ 0')));
    }
  }

  if (p.score !== null && p.score !== undefined) {
    const s = Number(p.score);
    if (!Number.isInteger(s) || s < 1 || s > 5) {
      out.push(warn('V-P-15', `score вне диапазона: ${p.score}`, at('score', 'целое 1..5 или null')));
    }
  }

  for (const t of p.tags ?? []) {
    if (!TAG_RE.test(String(t))) {
      out.push(warn('V-P-16', `недопустимая метка «${t}»`, at('tags', TAG_HINT)));
      break;
    }
  }

  return out;
};

/**
 * Проверка уникальности по всей библиотеке.
 * Дубликат id — bad: поведение начинает зависеть от порядка чтения файлов.
 * Дубликат pin — bad: две «позиции 3» ломают моторную память, ради которой
 * закрепление и существует. Дубликаты hotkey и trigger — warn: это опциональные
 * каналы, конфликт решается в настройках.
 *
 * Ключ результата — ПУТЬ файла, а не id. Первая версия ключевалась по id, и на
 * дубликате id ломалась дважды: запись второго файла затирала первую в карте,
 * а список «также у …» получался пустым, потому что из него отфильтровывался
 * сам искомый id — то есть оба совпадающих значения. Путь уникален всегда,
 * и в сообщении видно, какой именно файл конфликтует.
 */
export const validateUnique = (items) => {
  const byPath = new Map();
  const seen = { id: new Map(), pin: new Map(), hotkey: new Map(), trigger: new Map() };

  for (const it of items) {
    const where = it.path ?? it.id;
    byPath.set(where, []);
    for (const key of Object.keys(seen)) {
      const v = it[key];
      if (v === null || v === undefined || v === '') continue;
      if (key === 'pin' && it.status !== 'active') continue;
      const list = seen[key].get(v) ?? [];
      list.push(where);
      seen[key].set(v, list);
    }
  }

  const levels = { id: bad, pin: bad, hotkey: warn, trigger: warn };
  const codes = { id: 'V-P-2', pin: 'V-P-4', hotkey: 'V-P-5', trigger: 'V-P-6' };
  const names = { id: 'id', pin: 'позиция', hotkey: 'горячая клавиша', trigger: 'триггер' };

  for (const [key, map] of Object.entries(seen)) {
    for (const [value, places] of map) {
      if (places.length < 2) continue;
      for (const where of places) {
        const others = places.filter((x) => x !== where);
        byPath.get(where).push(levels[key](codes[key],
          `${names[key]} «${value}» повторяется: также в ${others.join(', ')}`,
          { field: key, expected: 'уникальное значение' }));
      }
    }
  }

  return byPath;
};

export { stateOf };
