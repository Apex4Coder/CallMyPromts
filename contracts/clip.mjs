// contracts/clip.mjs — схема записи журнала буфера и определение типа.
//
// Схема: docs/DATA-CONTRACTS.md §2.1. Правила V-C-1..V-C-8: §2.2. Типы: §2.3.

import { bad, warn } from './errors.mjs';

export const KINDS = ['text', 'url', 'code', 'path', 'email', 'image'];

export const PREVIEW_LEN = 160;
export const MIN_LEN = 2;
export const MAX_LEN = 1024 * 1024;

export const LIMIT_DEFAULT = 100;
export const LIMIT_MIN = 20;
export const LIMIT_MAX = 1000;

/** Чёрный список по умолчанию: буфер менеджера паролей содержит сам пароль. */
export const BLACKLIST_DEFAULT = [
  'keepass', 'keepassxc', 'bitwarden', '1password', 'lastpass',
  'dashlane', 'enpass', 'protonpass', 'nordpass',
];

const URL_RE = /^https?:\/\/\S+$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const WIN_PATH_RE = /^[a-zA-Z]:\\/;
const UNC_PATH_RE = /^\\\\/;
const NIX_PATH_RE = /^\/[^\s]/;

const CODE_MARKS = ['{', '}', ';', '=>', 'def ', 'function ', 'import ', 'const ', 'class ', '</'];

/**
 * Определение типа записи. Порядок проверок важен: первое совпадение выигрывает.
 * Тип — подсказка для значка и фильтра, а не гарантия: ошибка классификации
 * не влияет на сохранность данных.
 */
export const detectKind = (text, { isImage = false } = {}) => {
  if (isImage) return 'image';

  const s = String(text ?? '').trim();
  const lines = s.split('\n');
  const single = lines.length === 1;

  if (single && URL_RE.test(s)) return 'url';
  if (single && EMAIL_RE.test(s)) return 'email';
  if (single && (WIN_PATH_RE.test(s) || UNC_PATH_RE.test(s) || NIX_PATH_RE.test(s))) return 'path';

  if (lines.length >= 2) {
    let marks = 0;
    for (const m of CODE_MARKS) if (s.includes(m)) marks += 1;
    if (/\n[ \t]{2,}\S/.test(s)) marks += 1;
    if (marks >= 2) return 'code';
  }

  return 'text';
};

/** Одна строка для списка: переводы строк заменены точкой-разделителем (V-C-8). */
export const makePreview = (text) => {
  const flat = String(text ?? '').replace(/\s*\n+\s*/g, ' · ').replace(/[ \t]+/g, ' ').trim();
  return flat.length <= PREVIEW_LEN ? flat : `${flat.slice(0, PREVIEW_LEN - 1)}…`;
};

export const countLines = (text) => String(text ?? '').split('\n').length;

/** Проверка входа перед записью в журнал. */
export const validateClipInput = (text, { isImage = false } = {}) => {
  const out = [];
  const s = String(text ?? '');

  if (!isImage && s.trim().length < MIN_LEN) {
    out.push(bad('V-C-5', `содержимое короче ${MIN_LEN} знаков`, { field: 'text', expected: `≥ ${MIN_LEN}` }));
  }
  if (Buffer.byteLength(s, 'utf8') > MAX_LEN) {
    out.push(warn('V-C-6', 'содержимое длиннее 1 МБ — будет обрезано', { field: 'text', expected: '≤ 1 МБ' }));
  }

  return out;
};

/**
 * Попадает ли процесс-источник в чёрный список.
 * Сравнение по подстроке без учёта регистра: имя процесса бывает
 * «KeePassXC.exe», «keepass2», «1Password.exe».
 */
export const isBlacklisted = (sourceApp, blacklist = BLACKLIST_DEFAULT) => {
  if (!sourceApp) return false;
  const name = String(sourceApp).toLowerCase();
  return blacklist.some((b) => name.includes(String(b).toLowerCase()));
};

export const clampLimit = (n) => {
  const v = Number.parseInt(n, 10);
  if (!Number.isInteger(v)) return LIMIT_DEFAULT;
  return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, v));
};
