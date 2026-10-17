// tests/helpers/legacyfix.mjs — фикстуры прежнего формата для тестов миграции.
//
// Требования: REQ-MIG-REPORT, REQ-MIG-APPLY, REQ-MIG-CLIPS (docs/SPEC.md §11).
// Используют: tests/unit/migrate.test.mjs, migrate-apply.test.mjs,
// migrate-clips.test.mjs.
//
// Три файла тестов собирают одни и те же входные данные: промпт с полем `label`,
// клип ClipClip, набор корней-источников. Копия в каждом означала бы три версии
// «прежнего формата», которые разойдутся при первой правке — та же болезнь, от
// которой лечится сама библиотека.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Файл промпта в ПРЕЖНЕМ формате.
 *
 * Ключевое отличие от `promptFile` из harness.mjs: здесь `label`, а не `title`, и
 * нет полей `id`/`group`/`status`. Именно так выглядят 26 файлов, которые оставил
 * `start2_files.py`, и подменять их на нынешний формат в тесте значило бы
 * проверять миграцию на данных, которых не бывает.
 */
export const oldPrompt = (root, group, id, over = {}) => {
  const { label = `Промпт ${id}`, body = 'Текст промпта.', ...rest } = over;
  const dir = join(root, group);
  mkdirSync(dir, { recursive: true });

  const meta = { trigger: `:${id}`, label: `"${label}"`, used: 0, ...rest };
  const lines = Object.entries(meta).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(join(dir, `${id}.md`), `---\n${lines.join('\n')}\n---\n\n${body}\n`, 'utf8');

  return join(dir, `${id}.md`);
};

/** Файл без frontmatter: так лежат три промпта в inbox/ и AGENTS.md. */
export const bareFile = (root, group, name, text) => {
  const dir = join(root, group);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text, 'utf8');
  return join(dir, name);
};

/**
 * Три корня-источника внутри одной временной папки.
 * `espanso` пустой: в этой установке промпты лежат в `match/`, а не отдельной
 * папкой с группами, и отсутствие источника — нормальный случай, не ошибка.
 */
export const migRoots = (root) => ({
  project: join(root, 'proj'),
  home: join(root, 'home'),
  espanso: '',
});

/** Файл клипа в папке ClipClip. */
export const clipFile = (dir, name, text) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text, 'utf8');
  return join(dir, name);
};

/**
 * Журнал-заглушка с той же формой ответа, что настоящий store.
 *
 * Настоящий требует SQLite и файла базы. Здесь проверяется поведение переноса, а
 * не журнала: его проверяют tests/unit/clip-*.test.mjs. Форма ответа скопирована с
 * `clipboard/store.mjs` — `{ ok, id }` при успехе, `{ ok: false, skipped, why }`
 * при отказе; расхождение здесь сделало бы тесты зелёными на неверном коде.
 *
 * @param {(text: string, opts: object) => {ok: boolean, skipped?: string, why?: string}} behave
 */
export const fakeStore = (behave = () => ({ ok: true })) => {
  const seen = [];
  let next = 1;

  return {
    seen,
    add(text, opts = {}) {
      seen.push({ text, opts });
      const out = behave(text, opts);
      return out.ok ? { ok: true, id: next++, issues: [] } : out;
    },
  };
};
