// contracts/yaml.mjs — единственный парсер frontmatter на проект.
//
// Понимает плоское подмножество YAML из docs/DATA-CONTRACTS.md §7: скаляр, строка
// в кавычках, число, boolean, null, inline-список. Ничего больше.
//
// Почему подмножество, а не полный YAML: frontmatter промпта плоский по схеме §1.2,
// а второй полноценный парсер стал бы вторым мнением о формате (docs/RULES.md §1).
// Настройки лежат в JSON именно потому, что они вложенные.

import { ContractError } from './errors.mjs';

const FENCE = '---';

/** Снимает парные кавычки, если они есть. Кавычки — оформление, не семантика. */
const unquote = (s) => {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1);
  }
  return s;
};

/** Разбор скаляра в типизированное значение. */
const scalar = (raw) => {
  const s = raw.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  // Число только если строка целиком число: "2026-08-07" числом не станет.
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return Number.parseFloat(s);
  return unquote(s);
};

/** Разбор inline-списка [a, b, c]. Пустой список — пустой массив, не null. */
const inlineList = (raw) => {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((part) => scalar(part));
};

/**
 * Разбор плоского YAML-блока.
 * @param {string} text блок без ограждающих ---
 * @param {string|null} file путь для сообщений об ошибках
 * @param {number} lineOffset номер строки, с которой начинается блок в файле
 */
export const parseFlatYaml = (text, file = null, lineOffset = 0) => {
  const out = {};
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const at = lineOffset + i + 1;

    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    if (line !== line.trimStart()) {
      throw new ContractError('yaml_indent', 'вложенность во frontmatter не поддерживается', {
        file,
        line: at,
        expected: 'ключ без отступа',
      });
    }

    const sep = line.indexOf(':');
    if (sep < 1) {
      throw new ContractError('yaml_no_colon', 'строка не является парой ключ-значение', {
        file,
        line: at,
        expected: 'ключ: значение',
      });
    }

    const key = line.slice(0, sep).trim();
    const raw = line.slice(sep + 1).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      throw new ContractError('yaml_bad_key', `недопустимое имя ключа «${key}»`, {
        file,
        line: at,
        expected: 'латиница, цифры, дефис, подчёркивание',
      });
    }

    if (Object.hasOwn(out, key)) {
      throw new ContractError('yaml_duplicate_key', `ключ «${key}» повторяется`, {
        file,
        line: at,
        expected: 'уникальные ключи',
      });
    }

    if (raw === '|' || raw === '>' || raw.startsWith('&') || raw.startsWith('*')) {
      throw new ContractError('yaml_unsupported', `конструкция «${raw}» не поддерживается`, {
        file,
        line: at,
        expected: 'скаляр или inline-список',
      });
    }

    if (raw.startsWith('[')) {
      if (!raw.endsWith(']')) {
        throw new ContractError('yaml_bad_list', 'незакрытый inline-список', {
          file,
          line: at,
          expected: '[a, b, c] на одной строке',
        });
      }
      out[key] = inlineList(raw);
      continue;
    }

    out[key] = scalar(raw);
  }

  return out;
};

/**
 * Делит файл промпта на frontmatter и тело.
 *
 * Не выбрасывает, когда frontmatter отсутствует или не закрыт: это замечание
 * валидатора (V-P-1), а не сбой парсера. Исключение бросается только на порче
 * ВНУТРИ frontmatter — там ошибка имеет строку и её можно показать.
 *
 * Поле `reason` различает два случая, потому что чинятся они по-разному:
 * `no_fence` — метаданных нет вовсе, `unclosed` — забыт второй `---`.
 * Одно сообщение на оба случая заставляло бы искать, что именно не так.
 *
 * @returns {{meta, body, hasFrontmatter, fmLines, reason: string|null}}
 */
export const splitFrontmatter = (text, file = null) => {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = src.split('\n');

  if (lines[0]?.trim() !== FENCE) {
    return { meta: {}, body: src.trim(), hasFrontmatter: false, fmLines: 0, reason: 'no_fence' };
  }

  const close = lines.findIndex((l, i) => i > 0 && l.trim() === FENCE);
  if (close === -1) {
    return { meta: {}, body: src.trim(), hasFrontmatter: false, fmLines: 0, reason: 'unclosed' };
  }

  const block = lines.slice(1, close).join('\n');
  const meta = parseFlatYaml(block, file, 1);
  const body = lines.slice(close + 1).join('\n').replace(/^\n+/, '').trimEnd();

  return { meta, body, hasFrontmatter: true, fmLines: close + 1, reason: null };
};

/** Сериализация значения обратно в YAML-скаляр. */
const dumpValue = (v) => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => String(x)).join(', ')}]`;
  const s = String(v);
  // Кавычим то, что иначе прочитается как другой тип или сломает разбор.
  const risky = s === '' || /^[\d-]/.test(s) || s.includes(':') || s.includes('#')
    || ['true', 'false', 'null', '~'].includes(s);
  return risky ? `"${s.replace(/"/g, '\\"')}"` : s;
};

/**
 * Сборка файла промпта. Порядок ключей фиксирован: стабильный порядок делает
 * diff в git читаемым, а перемешанные ключи превращают правку одного поля
 * в изменение всего блока.
 */
export const buildFrontmatter = (meta, order) => {
  const keys = order ?? Object.keys(meta);
  const rows = keys
    .filter((k) => Object.hasOwn(meta, k))
    .map((k) => `${k}: ${dumpValue(meta[k])}`);
  return `${FENCE}\n${rows.join('\n')}\n${FENCE}\n`;
};

export const buildPromptFile = (meta, body, order) =>
  `${buildFrontmatter(meta, order)}\n${String(body).trimEnd()}\n`;
