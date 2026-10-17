// library/read.mjs — чтение библиотеки промптов из папки .md.
//
// Требования: REQ-LIB-READ, REQ-LIB-ISOLATE (docs/SPEC.md §3).
//
// Ключевое свойство: битый файл выводит из строя ТОЛЬКО себя. В прежней системе
// сборка одного base.yml из всех промптов означала, что один пустой .md убивает
// все 26 триггеров. Здесь каждый файл читается независимо, ошибка становится
// свойством записи, а не всей библиотеки.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import {
  splitFrontmatter,
  withDefaults,
  validatePrompt,
  validateUnique,
  stateOf,
  ContractError,
} from '../contracts/index.mjs';

import { cleanBody } from './clean.mjs';

/** Папки, которые не являются группами промптов. */
const SKIP_DIRS = new Set(['_bench', 'archive', 'node_modules', '.git', 'templates']);

const isMd = (name) => name.toLowerCase().endsWith('.md') && name.toLowerCase() !== 'readme.md';

/** Рекурсивный сбор путей .md. Ошибка чтения одной папки не роняет обход. */
export const listPromptFiles = async (root) => {
  const found = [];

  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // папка исчезла или недоступна — сообщит вызывающий по пустому результату
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full);
      } else if (e.isFile() && isMd(e.name)) {
        found.push(full);
      }
    }
  };

  await walk(root);
  return found.sort();
};

/** Куда файл относится: группа из папки, id из имени. */
const placeOf = (root, file) => {
  const rel = relative(root, file).split(sep).join('/');
  const parts = rel.split('/');
  return {
    rel,
    folder: parts.length > 1 ? parts[0] : null,
    base: parts.at(-1).replace(/\.md$/i, ''),
  };
};

/** Запись о нечитаемом файле. Он виден в списке и объяснён, а не пропущен молча. */
const unreadable = ({ rel, folder, base }, err) => ({
  ...withDefaults({ id: base, group: folder }),
  path: rel,
  body: '',
  raw: '',
  bytes: 0,
  issues: [{
    level: 'bad',
    code: 'read_failed',
    message: `не удалось прочитать файл: ${err.code ?? err.message}`,
    file: rel,
    field: null,
    line: null,
    expected: 'читаемый файл в UTF-8',
  }],
  state: 'bad',
});

/**
 * Разбор frontmatter с превращением ошибки контракта в issue.
 * Исключение здесь означало бы падение всей библиотеки из-за одного файла,
 * поэтому наружу пробрасывается только неожидаемая ошибка (не ContractError).
 */
const parseOrIssue = (raw, rel) => {
  try {
    return { parsed: splitFrontmatter(raw, rel), issues: [] };
  } catch (err) {
    if (!(err instanceof ContractError)) throw err;
    return {
      parsed: { meta: {}, body: raw, hasFrontmatter: false, reason: 'broken' },
      issues: [{ level: 'bad', ...err.toJSON(), code: err.code, message: err.message, file: rel }],
    };
  }
};

/**
 * Чтение одного файла в запись промпта.
 * Никогда не выбрасывает: проблема возвращается как issue уровня bad.
 */
export const readPromptFile = async (root, file) => {
  const place = placeOf(root, file);

  let raw = '';
  let bytes = 0;
  let mtimeMs = null;
  try {
    const info = await stat(file);
    bytes = info.size; mtimeMs = info.mtimeMs;
    raw = await readFile(file, 'utf8');
  } catch (err) {
    return unreadable(place, err);
  }

  const { parsed, issues: parseIssues } = parseOrIssue(raw, place.rel);
  const cleaned = cleanBody(parsed.body);
  const meta = withDefaults(parsed.meta, { id: place.base, group: place.folder ?? 'inbox' });

  // `cleaned.changed` уходит в валидатор намеренно: очистка идёт ДО проверки, и
  // без этого списка правила V-P-10 и V-P-11 не срабатывали бы на чтении вовсе —
  // они смотрят текст, из которого разметка и префикс TODO уже убраны. Человек
  // при этом не узнавал бы, что его файл чинится при каждом открытии.
  const issues = [
    ...parseIssues,
    ...validatePrompt(meta, cleaned.text, {
      file: place.rel,
      folder: place.folder,
      bytes,
      hasFrontmatter: parsed.hasFrontmatter,
      reason: parsed.reason ?? null,
      cleaned: cleaned.changed,
    }),
  ];

  return {
    ...meta,
    path: place.rel,
    body: cleaned.text,
    raw,
    bytes,
    mtimeMs,
    cleaned: cleaned.changed,
    issues,
    state: stateOf(issues),
  };
};

/**
 * Чтение всей библиотеки.
 * Возвращает { items, groups, stats } — без исключений даже при пустой или
 * отсутствующей папке: пустая библиотека это состояние «нет данных», а не сбой
 * (docs/RULES.md §4).
 */
export const readLibrary = async (root) => {
  const files = await listPromptFiles(root);
  const items = [];

  for (const f of files) items.push(await readPromptFile(root, f));

  // Уникальность считается по всей библиотеке, поэтому вторым проходом.
  // Ключ — путь файла: при дубликате id ключ по id склеил бы две записи в одну.
  const extra = validateUnique(items);
  for (const it of items) {
    const more = extra.get(it.path) ?? [];
    if (more.length > 0) {
      it.issues = [...it.issues, ...more.map((m) => ({ ...m, file: it.path }))];
      it.state = stateOf(it.issues);
    }
  }

  const groups = new Map();
  for (const it of items) {
    const g = it.group ?? 'inbox';
    groups.set(g, (groups.get(g) ?? 0) + 1);
  }

  const stats = {
    total: items.length,
    good: items.filter((i) => i.state === 'good').length,
    warn: items.filter((i) => i.state === 'warn').length,
    bad: items.filter((i) => i.state === 'bad').length,
    pinned: items.filter((i) => i.pin !== null && i.status === 'active').length,
  };

  return {
    items,
    groups: [...groups.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)),
    stats,
  };
};

/** Только пригодные к вставке. Битые исключаются из выдачи, но видны в диагностике. */
export const usableItems = (items) => items.filter((i) => i.state !== 'bad' && i.status !== 'archived');
