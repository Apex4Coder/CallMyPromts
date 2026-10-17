// clipboard/privacy.mjs — приватность журнала буфера.
//
// Требование: REQ-CLIP-PRIVACY (docs/SPEC.md §4). Тест: tests/unit/clip-privacy.test.mjs.
// Правило: docs/RULES.md §6 — журнал буфера не покидает машину ни при какой настройке.
//
// Причина существования файла: в буфер обмена попадают пароли, токены и ключи.
// Журнал, который их запоминает и потом отдаёт наружу, опаснее отсутствия журнала.
// Здесь собраны три защиты: не записывать (чёрный список), не показывать открыто
// (пометка «секрет» + скрытие), не выпускать (запрет синхронизации).

import { isBlacklisted, BLACKLIST_DEFAULT } from '../contracts/index.mjs';

/**
 * Пара «ключевое слово — значение».
 *
 * Две правки после проверки на живых примерах:
 *
 * 1. `\b` вместо границы даёт ложное «нет»: в JavaScript граница слова считается
 *    по латинице, поэтому `\bпароль` не срабатывает никогда — ни в начале строки,
 *    ни после пробела. Русская запись «пароль = qwerty12345» проходила мимо всех
 *    защит. Заменено на просмотр назад по любому алфавиту с флагом `u`.
 *
 * 2. `\S{4,}` вместо значения даёт ложное «да»: строка `const password =
 *    getPassword();` помечалась как секрет. Это ссылка НА секрет, а не сам
 *    секрет, и в буфере программиста таких строк много. Ложная пометка хуже
 *    отсутствия пометки: если скрыта половина журнала, человек перестаёт читать
 *    предупреждения вообще. Поэтому значение отвергается, когда в нём есть
 *    признаки выражения: `(` и `)` — вызов, `$` — подстановка, `[` — обращение
 *    к окружению вида `os.environ["PW"]`.
 */
const KEY_VALUE = /(?<![\p{L}\p{N}_])(?:password|passwd|пароль)["']?\s*[:=]\s*(?![^\s]*[()[\]$])\S{4,}/iu;

/** Признаки того, что в тексте лежит секрет. Отдельно — имя, чтобы объяснить человеку. */
const SECRET_MARKS = [
  ['ключ OpenAI', /\bsk-[A-Za-z0-9]{20,}\b/],
  ['токен GitHub', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['токен Slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['ключ AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['приватный ключ', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['токен JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/],
  ['пара логин-пароль', KEY_VALUE],
  ['строка подключения', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/i],
];

/**
 * Ищет признаки секрета. Возвращает список названий, а не сами значения:
 * объяснение «похоже на токен GitHub» помогает, повтор токена в интерфейсе — нет.
 */
export const findSecretMarks = (text) => {
  const s = String(text ?? '');
  const out = [];
  for (const [name, re] of SECRET_MARKS) if (re.test(s)) out.push(name);
  return out;
};

export const looksSecret = (text) => findSecretMarks(text).length > 0;

/**
 * Решение перед записью в журнал.
 * @returns {{ skip: boolean, reason: string|null, why: string|null, sensitive: boolean, marks: string[] }}
 */
export const screen = (text, { sourceApp = null, blacklist = BLACKLIST_DEFAULT, watchSecrets = 'mark' } = {}) => {
  const marks = findSecretMarks(text);

  if (isBlacklisted(sourceApp, blacklist)) {
    return {
      skip: true,
      reason: 'blacklisted',
      why: `источник «${sourceApp}» в списке исключений`,
      sensitive: true,
      marks: [],
    };
  }

  if (marks.length > 0 && watchSecrets === 'skip') {
    return {
      skip: true,
      reason: 'secret',
      why: `похоже на секрет: ${marks.join(', ')}`,
      sensitive: true,
      marks,
    };
  }

  return { skip: false, reason: null, why: null, sensitive: marks.length > 0, marks };
};

/**
 * Маска для показа и для журнала событий: видны только края.
 * Середина заменяется многоточием фиксированной длины, чтобы по длине маски
 * нельзя было восстановить длину секрета.
 */
export const mask = (text, keep = 4) => {
  const s = String(text ?? '');
  if (s.length <= keep * 2) return '•'.repeat(Math.max(s.length, 3));
  return `${s.slice(0, keep)}…${'•'.repeat(6)}…${s.slice(-keep)}`;
};

/**
 * Строка для файла событий. Содержимого нет никогда — только тип, размер и хэш-хвост.
 * Это позволяет разбирать проблемы («запись не появилась») без утечки данных.
 */
export const eventLine = ({ kind = 'text', bytes = 0, hash = '', sourceApp = null, skipped = null }) => {
  const parts = [
    `kind=${kind}`,
    `bytes=${bytes}`,
    `hash=${String(hash).slice(0, 8)}`,
    `src=${sourceApp ? String(sourceApp).slice(0, 32) : '-'}`,
  ];
  if (skipped) parts.push(`skipped=${skipped}`);
  return parts.join(' ');
};

/** Пометки для интерфейса: содержимое скрыто до явного нажатия «показать». */
export const viewFlags = (clip) => {
  const marks = findSecretMarks(clip?.text ?? clip?.preview ?? '');
  return {
    sensitive: marks.length > 0,
    hidden: marks.length > 0,
    marks,
    hint: marks.length > 0 ? `Скрыто: ${marks.join(', ')}. Нажмите «Показать».` : null,
  };
};

/**
 * Проверка, что журнал не попадает под синхронизацию.
 * Вызывается любым будущим кодом обмена данными; жёсткое «нет» здесь дешевле,
 * чем разбор утечки потом (docs/RULES.md §6, REQ-SYNC-LATER).
 */
export const assertNotSynced = (what) => {
  if (String(what).includes('state/') || String(what).includes('clips.db')) {
    throw new Error(`журнал буфера не синхронизируется: ${what}`);
  }
  return true;
};

export const SYNC_DENY = ['state/', 'clips.db', 'runtime.json', 'token'];
