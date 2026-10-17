// legacy/sources.mjs — чтение трёх копий библиотеки и решение, какая версия новее.
//
// Требования: REQ-MIG-REPORT, REQ-MIG-APPLY (docs/SPEC.md §11). Сценарий S-11.
// Тест: tests/unit/migrate.test.mjs.
//
// Откуда взялись три копии. Прежний пайплайн из пяти Python-скриптов писал в
// разные места: `start1_tree.py` создавал `prompts/` в проекте, `start4_link.py`
// делал копию в `%USERPROFILE%\prompts`, а espanso читал третью в своей папке.
// Ни один шаг не сверялся с остальными, поэтому правка в одном месте не доходила
// до других, и «промпт не обновился» стало обычным делом.
//
// Здесь эти копии только ЧИТАЮТСЯ. Решение о слиянии — данные, а не действие:
// `plan()` возвращает описание, и его можно напечатать, не тронув ни файла. Это
// прямое следствие правила docs/RULES.md §5 — необратимое действие показывает
// последствие до, а не после.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { splitFrontmatter } from '../contracts/index.mjs';

/** Папки-источники в порядке убывания доверия: проект новее домашней копии. */
export const SOURCE_KINDS = [
  ['project', 'папка проекта'],
  ['home', 'копия в профиле пользователя'],
  ['espanso', 'копия espanso'],
];

const isPrompt = (name) => name.endsWith('.md') && !name.startsWith('.');

/**
 * Все `.md` источника с разобранными метаданными.
 *
 * Битый файл не выбрасывает исключение: он попадает в список с `broken: true` и
 * причиной. Иначе один испорченный `.md` останавливал бы миграцию целиком — та же
 * ошибка, из-за которой прежняя система теряла все 26 триггеров из-за одного файла
 * (REQ-LIB-ISOLATE).
 */
export const readSource = (root, kind) => {
  if (!existsSync(root)) return { kind, root, exists: false, items: [] };

  const items = [];
  for (const group of readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory() || group.name.startsWith('.')) continue;

    const dir = join(root, group.name);
    for (const name of readdirSync(dir)) {
      if (!isPrompt(name)) continue;
      items.push(readOne(dir, group.name, name, kind));
    }
  }
  return { kind, root, exists: true, items };
};

/** Причина отсутствия frontmatter словами, а не кодом парсера. */
const NO_FM = {
  no_fence: 'нет frontmatter — метаданных в файле не было вовсе',
  unclosed: 'frontmatter не закрыт вторым «---»',
};

const readOne = (dir, group, name, kind) => {
  const file = join(dir, name);
  const id = name.replace(/\.md$/, '');
  const base = { id, group, kind, file, rel: `${group}/${name}` };

  try {
    const raw = readFileSync(file, 'utf8');
    const st = statSync(file);
    // `splitFrontmatter` отдаёт `meta` уже РАЗОБРАННЫМ объектом, а не текстом
    // блока. Первая версия вызывала парсер повторно и получала «text.split is
    // not a function» на каждом файле: отчёт объявил испорченными все 30 промптов
    // и показал «label → title: 0» при 26 файлах с `label`. Поймано первым же
    // запуском на настоящих данных — ради этого отчёт и делается до записи.
    const parsed = splitFrontmatter(raw, file);

    if (!parsed.hasFrontmatter) {
      const why = NO_FM[parsed.reason] ?? parsed.reason ?? 'нет frontmatter';
      return { ...base, broken: true, why, meta: {}, body: parsed.body, mtime: st.mtimeMs, bytes: st.size };
    }

    return { ...base, broken: false, why: null, meta: parsed.meta, body: parsed.body, mtime: st.mtimeMs, bytes: st.size };
  } catch (err) {
    // Порча ВНУТРИ frontmatter — единственный случай, когда парсер бросает; у
    // такой ошибки есть строка, и она попадает в сообщение.
    return { ...base, broken: true, why: err.message, meta: {}, body: '', mtime: 0, bytes: 0 };
  }
};

/**
 * Какая из копий одного промпта считается главной.
 *
 * Порядок сравнения выбран так, чтобы решение можно было объяснить человеку одной
 * фразой, и он проверялся именно в этом порядке:
 *   1. `version` — единственное поле, которое прямо заявляет старшинство;
 *   2. `updated` — дата правки в метаданных, её ставит автор;
 *   3. `mtime` — время файла; ненадёжно, копирование его переписывает;
 *   4. порядок источников — проект важнее домашней копии.
 *
 * `mtime` НЕ идёт первым сознательно: `start4_link.py` копировал файлы, и у копии
 * время оказывалось новее оригинала. Доверие к нему потеряло бы правку.
 */
export const pickWinner = (copies) => {
  const rank = (c) => SOURCE_KINDS.findIndex(([k]) => k === c.kind);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  const sorted = [...copies].sort((a, b) => (
    num(b.meta.version) - num(a.meta.version)
      || String(b.meta.updated ?? '').localeCompare(String(a.meta.updated ?? ''))
      || b.mtime - a.mtime
      || rank(a) - rank(b)
  ));

  const [best, ...rest] = sorted;
  return { best, rest, why: whyWon(best, rest[0]) };
};

const whyWon = (best, second) => {
  if (!second) return 'единственная копия';
  if (Number(best.meta.version ?? 0) !== Number(second.meta.version ?? 0)) {
    return `version ${best.meta.version ?? 0} против ${second.meta.version ?? 0}`;
  }
  if (String(best.meta.updated ?? '') !== String(second.meta.updated ?? '')) {
    return `updated ${best.meta.updated ?? '—'} против ${second.meta.updated ?? '—'}`;
  }
  if (best.mtime !== second.mtime) return 'файл изменён позже';
  return `источник «${SOURCE_KINDS.find(([k]) => k === best.kind)?.[1]}» важнее`;
};

/** Совпадает ли тело у двух копий с точностью до пробелов по краям. */
export const sameBody = (a, b) => a.body.trim() === b.body.trim();
