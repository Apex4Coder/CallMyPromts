// library/groups.mjs — группы промптов. Папка на диске = группа в интерфейсе.
//
// Требование: REQ-LIB-GROUP (docs/SPEC.md §3).
//
// Почему папка, а не поле в базе: папку видно в проводнике и в VS Code, её можно
// переименовать вручную, и это не рассинхронизируется с приложением. Отдельный
// реестр групп стал бы вторым мнением о структуре (docs/RULES.md §1).

import { mkdir, readdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

import { GROUP_RE } from '../contracts/index.mjs';
import { slugify } from './clean.mjs';

/** Служебные папки: группами не считаются. */
const HIDDEN = new Set(['_bench', 'archive', 'node_modules', 'templates']);

/** Понятные подписи для известных групп. Неизвестные показываются как есть. */
const LABELS = {
  code: 'Код',
  core: 'Ядро',
  research: 'Исследование',
  parsing: 'Парсинг',
  chatbox: 'Chatbox',
  inbox: 'Входящие',
};

export const groupLabel = (name) => LABELS[name] ?? name;

export const listGroups = async (root) => {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !HIDDEN.has(e.name))
    .map((e) => e.name)
    .sort();
};

/**
 * Создание группы. Имя приводится к допустимому виду, и итог возвращается —
 * пользователь должен видеть, что «Мои Промпты!» стали `moi-prompty`.
 */
export const createGroup = async (root, name) => {
  const slug = slugify(name, 23);
  if (!GROUP_RE.test(slug)) {
    return {
      ok: false,
      issues: [{
        level: 'bad',
        code: 'bad_group',
        message: `имя группы «${name}» непригодно`,
        field: 'group',
        expected: GROUP_RE.source,
      }],
    };
  }
  await mkdir(join(root, slug), { recursive: true });
  return { ok: true, name: slug, label: groupLabel(slug), renamed: slug !== String(name).trim() };
};

/** Удаление только пустой группы: непустую удалять — это удалять промпты. */
export const removeGroupIfEmpty = async (root, name) => {
  const dir = join(root, name);
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return { ok: false, issues: [{ level: 'bad', code: 'not_found', message: 'группа не найдена', file: dir }] };
  }
  if (entries.length > 0) {
    return {
      ok: false,
      issues: [{
        level: 'bad',
        code: 'not_empty',
        message: `в группе ${entries.length} файл(ов) — удаление запрещено`,
        file: dir,
        expected: 'пустая папка',
      }],
    };
  }
  await rmdir(dir);
  return { ok: true, name };
};

/** Слияние списка папок и счётчиков из прочитанной библиотеки. */
export const describeGroups = (dirs, counts) => {
  const map = new Map(counts.map((c) => [c.name, c.count]));
  const names = new Set([...dirs, ...map.keys()]);
  return [...names].sort().map((name) => ({
    name,
    label: groupLabel(name),
    count: map.get(name) ?? 0,
  }));
};
