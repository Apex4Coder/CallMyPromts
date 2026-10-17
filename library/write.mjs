// library/write.mjs — запись промптов без потери пользовательских данных.
//
// Требования: REQ-LIB-WRITE, REQ-LIB-SAFE (docs/SPEC.md §3).
//
// Два механизма защиты, а не обещания:
//   1. Атомарная запись: пишем во временный файл и переименовываем. Сбой на середине
//      оставляет исходный файл целым, а не половину нового.
//   2. Слияние метаданных: служебные поля (used, last_used, score, version) читаются
//      из существующего файла и переносятся. Прежняя система перезаписывала файл
//      целиком, потому что нашла в тексте слово TODO, — так терялась вся статистика.

import { mkdir, readFile, rename, writeFile, unlink, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  splitFrontmatter,
  buildPromptFile,
  withDefaults,
  validatePrompt,
  FIELD_ORDER,
  ContractError,
  bad,
} from '../contracts/index.mjs';

import { cleanBody, slugify, safeFileName } from './clean.mjs';

const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export const promptPath = (root, group, id) => join(root, group, `${safeFileName(id)}.md`);

const exists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/** Атомарная запись: временный файл рядом, затем переименование. */
export const writeAtomic = async (file, text) => {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, text, { encoding: 'utf8' });
  try {
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
};

/** Свободный id: если занят, добавляем -2, -3 и так далее. Перезаписи молча нет. */
export const freeId = async (root, group, wanted) => {
  const base = slugify(wanted);
  if (!(await exists(promptPath(root, group, base)))) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`;
    if (!(await exists(promptPath(root, group, candidate)))) return candidate;
  }
  return `${base}-${Date.now()}`;
};

/**
 * Чтение и разбор существующего файла без исключений.
 * Порча frontmatter — это состояние файла, а не сбой программы, поэтому наружу
 * уходит замечание с номером строки, как из валидатора. Прежняя версия давала
 * здесь ContractError, и правка одного битого файла роняла операцию целиком
 * вместо того, чтобы объяснить причину (docs/RULES.md §4).
 */
const readCurrent = async (file) => {
  const raw = await readFile(file, 'utf8');
  try {
    const { meta, body } = splitFrontmatter(raw, file);
    return { ok: true, raw, meta, body };
  } catch (err) {
    if (!(err instanceof ContractError)) throw err;
    return {
      ok: false,
      raw,
      meta: {},
      body: raw,
      issue: { level: 'bad', ...err.toJSON(), code: err.code, message: err.message, file },
    };
  }
};

/** Расхождение времени изменения: файл правили вне приложения (S-10). */
const mtimeConflict = async (file, expectedMtime) => {
  if (expectedMtime === null) return null;
  const info = await stat(file);
  // Допуск 1 мс: часть файловых систем округляет время записи.
  if (Math.abs(info.mtimeMs - expectedMtime) <= 1) return null;
  return bad('changed_outside', 'файл изменён вне приложения — перезапись отменена', {
    file,
    expected: 'подтверждение перезаписи',
  });
};

/**
 * Создание нового промпта.
 * @returns {{ ok: boolean, id?: string, path?: string, issues: object[] }}
 */
export const createPrompt = async (root, { title, group, body, tags, source, trigger, hotkey }) => {
  const g = slugify(group || 'inbox', 23);
  const cleaned = cleanBody(body);
  const id = await freeId(root, g, title || cleaned.text);

  const meta = withDefaults({
    id,
    title: String(title ?? '').trim(),
    group: g,
    tags: tags ?? [],
    source: source ?? null,
    trigger: trigger ?? null,
    hotkey: hotkey ?? null,
    created: today(),
    updated: today(),
  });

  const issues = validatePrompt(meta, cleaned.text, { folder: g, hasFrontmatter: true });
  if (issues.some((i) => i.level === 'bad')) return { ok: false, issues };

  const file = promptPath(root, g, id);
  await writeAtomic(file, buildPromptFile(meta, cleaned.text, FIELD_ORDER));

  return { ok: true, id, path: file, group: g, issues, cleaned: cleaned.changed };
};

/**
 * Отказ при нечитаемых метаданных.
 * Перезапись битого файла стирает счётчик использований и дату создания — это
 * потеря данных, поэтому она требует подтверждения, как обмен закреплений
 * (docs/RULES.md §6). Без подтверждения человек узнаёт причину и правит файл сам.
 */
const brokenRefusal = (file, issue, hasBody) => {
  const extra = hasBody
    ? bad('needs_force', 'метаданные не читаются: перезапись потеряет счётчик использований и дату создания', {
      file, expected: 'повторить с подтверждением',
    })
    : bad('body_required', 'метаданные не читаются: тело нужно передать явно, иначе испорченный frontmatter уйдёт в текст промпта', {
      file, field: 'body',
    });
  return { ok: false, broken: true, issues: [issue, extra] };
};

/**
 * Обновление промпта. Служебные поля переносятся из существующего файла.
 * expectedMtime защищает от перезаписи правки, сделанной извне (S-10): при
 * расхождении возвращаем конфликт, а не молча затираем.
 */
export const updatePrompt = async (root, id, group, patch, { expectedMtime = null, force = false } = {}) => {
  const g = slugify(group || 'inbox', 23);
  const file = promptPath(root, g, id);

  if (!(await exists(file))) {
    return { ok: false, issues: [bad('not_found', 'файл промпта не найден', { file })] };
  }

  const conflict = await mtimeConflict(file, expectedMtime);
  if (conflict) return { ok: false, conflict: true, issues: [conflict] };

  const current = await readCurrent(file);
  if (!current.ok && !(force && patch.body !== undefined)) {
    return brokenRefusal(file, current.issue, patch.body !== undefined);
  }

  const body = patch.body !== undefined ? cleanBody(patch.body).text : cleanBody(current.body).text;

  const meta = withDefaults({
    ...current.meta,
    ...patch,
    id,
    group: g,
    updated: today(),
    // Служебные поля не берём из patch: их пишут markUsed и setPin. Иначе клиент
    // мог бы подделать статистику, а правка текста — обнулить её.
    used: current.meta.used ?? 0,
    last_used: current.meta.last_used ?? null,
    version: current.meta.version ?? 1,
    created: current.meta.created ?? today(),
  });

  const issues = validatePrompt(meta, body, { folder: g, hasFrontmatter: true, file });
  if (issues.some((i) => i.level === 'bad')) return { ok: false, issues };

  await writeAtomic(file, buildPromptFile(meta, body, FIELD_ORDER));
  return { ok: true, id, path: file, group: g, issues, recovered: !current.ok };
};

/** Отметка использования. Единственный способ изменить used и last_used. */
export const markUsed = async (root, id, group) => {
  const g = slugify(group || 'inbox', 23);
  const file = promptPath(root, g, id);
  if (!(await exists(file))) return { ok: false, issues: [bad('not_found', 'файл не найден', { file })] };

  const current = await readCurrent(file);
  if (!current.ok) {
    // Битый промпт не вставляется, значит и отмечать нечего. Перезапись здесь
    // потеряла бы метаданные ради счётчика — цена несоразмерна.
    return { ok: false, issues: [current.issue] };
  }

  const next = withDefaults({
    ...current.meta,
    id,
    group: g,
    used: Number(current.meta.used ?? 0) + 1,
    last_used: nowIso(),
  });

  await writeAtomic(file, buildPromptFile(next, cleanBody(current.body).text, FIELD_ORDER));
  return { ok: true, used: next.used, last_used: next.last_used };
};

/**
 * Закрепление на позицию. Занятая позиция обменивается, а не перезаписывается.
 * Обе записи проверяются: две одинаковые позиции (V-P-4) хуже невыполненной
 * команды, поэтому при сбое первой записи вторая не делается, а при сбое второй
 * позиция возвращается прежнему владельцу.
 */
export const setPin = async (root, items, id, pin) => {
  const target = items.find((i) => i.id === id);
  if (!target) return { ok: false, issues: [bad('not_found', 'промпт не найден', { field: 'id' })] };
  if (target.status === 'archived') {
    return { ok: false, issues: [bad('archived', 'архивный промпт нельзя закрепить', { field: 'status' })] };
  }

  const occupant = pin === null ? null : items.find((i) => i.pin === pin && i.id !== id && i.status === 'active');
  const swapped = [];

  if (occupant) {
    const freed = await updatePrompt(root, occupant.id, occupant.group, { pin: target.pin ?? null });
    if (!freed.ok) {
      return {
        ok: false,
        issues: [...freed.issues,
          bad('swap_failed', `позиция ${pin} не освобождена: «${occupant.id}» не записан`, { field: 'pin' })],
      };
    }
    swapped.push({ id: occupant.id, pin: target.pin ?? null });
  }

  const done = await updatePrompt(root, id, target.group, { pin });
  if (!done.ok) {
    if (occupant) await updatePrompt(root, occupant.id, occupant.group, { pin });
    return { ok: false, issues: done.issues };
  }

  return { ok: true, id, pin, swapped };
};
