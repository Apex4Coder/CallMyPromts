// contracts/settings.mjs — схема настроек и их слияние с умолчаниями.
//
// Схема и допустимые значения: docs/DATA-CONTRACTS.md §3.
// Неизвестный ключ — ошибка с путём к нему (V-S-1), а не тихое игнорирование:
// опечатка в настройке иначе выглядит как «функция не работает».

import { bad, warn } from './errors.mjs';
import { LIMIT_DEFAULT, LIMIT_MIN, LIMIT_MAX, BLACKLIST_DEFAULT } from './clip.mjs';

export const LAYOUTS = ['palette', 'panels', 'hybrid'];
export const THEMES = ['light', 'dark', 'system'];
export const MOTIONS = ['full', 'reduced', 'off'];
export const ACCENTS = ['teal', 'indigo', 'amber', 'rose', 'slate'];
export const DENSITIES = ['compact', 'normal', 'comfortable'];
export const POSITIONS = ['center', 'cursor', 'top'];
export const ORDER_MODES = ['pinned-frequency', 'manual'];

export const SCHEMA_VERSION = 1;

export const DEFAULTS = {
  schema_version: SCHEMA_VERSION,
  ui: {
    layout: 'hybrid',
    theme: 'light',
    motion: 'full',
    accent: 'teal',
    density: 'compact',
    font_scale: 100,
    show_badges: true,
    show_temperature: true,
    show_groups: true,
    show_preview: true,
    position: 'cursor',
  },
  order: {
    mode: 'manual',
    suggest_pin_after: 5,
  },
  clipboard: {
    enabled: true,
    limit: LIMIT_DEFAULT,
    save_text: true,
    save_images: false,
    clear_on_exit: false,
    blacklist: [...BLACKLIST_DEFAULT],
  },
  hotkeys: {
    open_picker: '^+q',
    save_clip: '^+s',
    open_clips: '^!v',
    toggle_watch: '',
  },
  server: {
    port: 8791,
  },
  library: {
    path: 'prompts',
  },
};

/** Описание каждого листа схемы: тип и допустимые значения. */
const RULES = {
  'schema_version': { type: 'int', min: 1, max: 99 },
  'ui.layout': { type: 'enum', values: LAYOUTS },
  'ui.theme': { type: 'enum', values: THEMES },
  'ui.motion': { type: 'enum', values: MOTIONS },
  'ui.accent': { type: 'enum', values: ACCENTS },
  'ui.density': { type: 'enum', values: DENSITIES },
  'ui.font_scale': { type: 'int', min: 100, max: 200 },
  'ui.show_badges': { type: 'bool' },
  'ui.show_temperature': { type: 'bool' },
  'ui.show_groups': { type: 'bool' },
  'ui.show_preview': { type: 'bool' },
  'ui.position': { type: 'enum', values: POSITIONS },
  'order.mode': { type: 'enum', values: ORDER_MODES },
  'order.suggest_pin_after': { type: 'int', min: 1, max: 999 },
  'clipboard.enabled': { type: 'bool' },
  'clipboard.limit': { type: 'int', min: LIMIT_MIN, max: LIMIT_MAX },
  'clipboard.save_text': { type: 'bool' },
  'clipboard.save_images': { type: 'bool' },
  'clipboard.clear_on_exit': { type: 'bool' },
  'clipboard.blacklist': { type: 'strings' },
  'hotkeys.open_picker': { type: 'hotkey' },
  'hotkeys.save_clip': { type: 'hotkey' },
  'hotkeys.open_clips': { type: 'hotkey' },
  'hotkeys.toggle_watch': { type: 'hotkey' },
  'server.port': { type: 'int', min: 1024, max: 65535 },
  'library.path': { type: 'string' },
};

// Пустая строка означает «не назначено» (V-S-5), поэтому она допустима.
const HOTKEY_RE = /^([\^!+#]{1,4}[a-z0-9]|)$/i;

const checkLeaf = (path, value) => {
  const rule = RULES[path];
  if (!rule) return bad('V-S-1', `неизвестный ключ настроек «${path}»`, { field: path, expected: 'ключ из схемы' });

  if (rule.type === 'enum' && !rule.values.includes(value)) {
    return bad('V-S-2', `недопустимое значение «${value}»`, { field: path, expected: rule.values.join(' | ') });
  }
  if (rule.type === 'bool' && typeof value !== 'boolean') {
    return bad('V-S-2', `ожидалось true или false, получено «${value}»`, { field: path, expected: 'boolean' });
  }
  if (rule.type === 'int') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < rule.min || n > rule.max) {
      return bad('V-S-2', `значение вне диапазона: ${value}`, { field: path, expected: `целое ${rule.min}..${rule.max}` });
    }
  }
  if (rule.type === 'string' && (typeof value !== 'string' || value.trim() === '')) {
    return bad('V-S-2', 'ожидалась непустая строка', { field: path, expected: 'строка' });
  }
  if (rule.type === 'strings' && (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))) {
    return bad('V-S-2', 'ожидался список строк', { field: path, expected: '["a", "b"]' });
  }
  if (rule.type === 'hotkey' && !HOTKEY_RE.test(String(value))) {
    return bad('V-S-2', `недопустимое сочетание «${value}»`, { field: path, expected: '^!q, +#s или пусто' });
  }

  return null;
};

/** Плоский обход объекта: даёт пути вида "ui.theme". */
const walk = (obj, prefix = '') => {
  const out = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...walk(v, path));
    else out.push([path, v]);
  }
  return out;
};

export const validateSettings = (raw) => walk(raw).map(([p, v]) => checkLeaf(p, v)).filter(Boolean);

/**
 * Слияние настроек с основой.
 *
 * Основа по умолчанию — DEFAULTS, и для чтения файла это верно: файл описывает
 * состояние целиком. Для правки по HTTP — нет, и это стоило дефекта: запрос
 * `PUT /api/settings` с одним полем `{ui: {theme: 'dark'}}` возвращал объект,
 * собранный из умолчаний, и настроенные горячие клавиши обнулялись. Со стороны
 * это выглядело так: сменил тему — перестали работать хоткеи, причём в файле
 * они стояли верные ещё минуту назад.
 *
 * Поэтому вызывающий передаёт основу сам: `loadSettings` — умолчания,
 * `saveSettings` — действующие настройки.
 *
 * Битые и неизвестные значения заменяются значением из основы, но факт замены
 * попадает в issues: молча подменённая настройка выглядит как «приложение меня
 * не слушает».
 */
export const mergeSettings = (raw, { base = DEFAULTS } = {}) => {
  const out = structuredClone(base);
  const issues = [];

  for (const [path, value] of walk(raw)) {
    const problem = checkLeaf(path, value);
    if (problem) {
      issues.push(problem);
      continue;
    }
    const parts = path.split('.');
    let node = out;
    for (const p of parts.slice(0, -1)) node = node[p];
    node[parts.at(-1)] = value;
  }

  if (raw && raw.schema_version !== undefined && Number(raw.schema_version) !== SCHEMA_VERSION) {
    issues.push(warn('V-S-6', `версия схемы ${raw.schema_version} отличается от ${SCHEMA_VERSION}`,
      { field: 'schema_version', expected: String(SCHEMA_VERSION) }));
  }

  return { settings: out, issues };
};

export const knownPaths = () => Object.keys(RULES);
