// legacy/apply.mjs — исполнение плана миграции с резервной копией всех источников.
//
// Требование: REQ-MIG-APPLY (docs/SPEC.md §11). Сценарий S-11.
// Тест: tests/unit/migrate.test.mjs.
//
// Порядок операций здесь не подлежит перестановке:
//   1. резервная копия ВСЕХ источников целиком, включая те, что проиграли;
//   2. запись слитой библиотеки;
//   3. отчёт о том, что записано.
//
// Копия делается первой и полной, потому что миграция — единственная операция во
// всём приложении, которая сводит три версии текста в одну. Если решение о
// старшинстве окажется неверным, человек должен иметь возможность достать
// проигравшую версию, а не услышать «она была старее» (инвариант SPEC §13.1).
//
// Ни одного удаления. Исходные папки остаются на месте: миграция создаёт новую
// библиотеку, а не переносит старую. Удалять источники — отдельное решение
// человека, и принимать его за него нельзя (docs/RULES.md §5).

import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { buildPromptFile, withDefaults, FIELD_ORDER } from '../contracts/index.mjs';
import { cleanBody } from '../library/index.mjs';
import { readSource, SOURCE_KINDS } from './sources.mjs';
import { plan, RENAMES } from './plan.mjs';

/** Метка времени для имени папки резервной копии: сортируется как текст. */
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/**
 * Резервная копия источника «как есть», без разбора и очистки.
 *
 * Копируются даже испорченные файлы. Битый `.md` — это тоже текст, который человек
 * когда-то написал, и решение «это мусор» принимает он, а не миграция.
 */
export const backupSource = (src, into) => {
  const dir = join(into, src.kind);
  let copied = 0;

  for (const item of src.items) {
    const target = join(dir, item.rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(item.file, target);
    copied += 1;
  }
  return { kind: src.kind, root: src.root, dir, copied };
};

/**
 * Значения, которыми прежняя система обозначала «ничего».
 *
 * `score: -` стоит в 22 файлах домашней копии, и это ПРЯМОЙ источник дефекта, с
 * которого началась вся работа: прочерк — не число, `Number('-')` даёт `NaN`, и
 * сводка показывала «NaN» на весь экран. Прочерк в YAML означал «не оценивал», а
 * настоящее «не оценивал» — это `null`.
 *
 * Нормализуется только заведомо пустое. Значение вроде `score: 7` НЕ трогается:
 * оно осмысленно, но вне диапазона, и решать за человека, что он имел в виду,
 * нельзя — валидатор пометит его `warn V-P-15`, и это правильный исход.
 */
const EMPTYISH = new Set(['-', '—', '', 'null', 'none', 'нет', '?', 'n/a']);

const normalizeEmpty = (value) => (
  typeof value === 'string' && EMPTYISH.has(value.trim().toLowerCase()) ? null : value
);

/**
 * Метаданные промпта в нынешнем формате.
 *
 * `label` → `title` и никаких остатков прежнего имени: `withDefaults` собирает
 * ровно поля схемы §1.2, поэтому неизвестные ключи отбрасываются здесь, а не
 * доживают до валидатора.
 *
 * `used` и `last_used` переносятся как есть: их пишет программа
 * (docs/DATA-CONTRACTS.md §1.5), и обнулить статистику при миграции значило бы
 * потерять историю, по которой строится порядок списка.
 */
export const migrateMeta = (item, entry) => {
  const src = {};
  for (const [key, value] of Object.entries(item.meta)) {
    src[key] = normalizeEmpty(value);
  }

  for (const [from, to] of Object.entries(RENAMES)) {
    if (from in src && (src[to] ?? null) === null) src[to] = src[from];
    delete src[from];
  }

  /**
   * Хронология: дата создания не может быть позже даты правки.
   *
   * Два дефекта, оба найдены ЖИВЫМ ЗАПУСКОМ, а не тестами.
   *
   * Первый: прежний формат писал только `updated`, а `withDefaults` подставлял в
   * `created` сегодняшнюю дату — файл выходил изменённым за месяц до создания.
   * Первая правка брала `created` из `updated`, и этого оказалось мало.
   *
   * Второй: миграция читает СВОЙ ЖЕ результат. После первого прогона в файле уже
   * стоят обе даты — `created` сегодня, `updated` из прошлого, — и условие «создания
   * нет» больше не выполняется. Пара остаётся битой навсегда.
   *
   * Поэтому проверяется не отсутствие поля, а САМО НАРУШЕНИЕ: если `created` позже
   * `updated`, дата создания заменяется датой правки. Раньше `updated` файл
   * существовать не мог, а более точной информации нет; сегодняшняя дата утверждала
   * бы то, чего не было (V-P-9).
   *
   * Обратный случай не трогаем: `created` есть, `updated` нет — `withDefaults`
   * поставит сегодня, и это верно, потому что миграция файл действительно меняет.
   */
  const created = src.created ?? null;
  const updated = src.updated ?? null;

  if (created === null && updated !== null) {
    src.created = updated;
  } else if (created !== null && updated !== null && String(updated) < String(created)) {
    src.created = updated;
  }

  return withDefaults({
    ...src,
    id: entry.id,
    title: entry.title,
    group: entry.group,
  }, { id: entry.id, group: entry.group });
};

/** Победившая копия по записи плана. */
const winnerOf = (sources, entry) => {
  const src = sources.find((s) => s.kind === entry.from);
  return src?.items.find((i) => i.group === entry.group && i.id === entry.sourceId) ?? null;
};

/**
 * Исполнение плана.
 *
 * @param {Record<string,string>} roots вид источника → путь
 * @param {string} target корень новой библиотеки
 * @param {string} backupRoot куда положить резервные копии
 */
export const apply = (roots, target, backupRoot) => {
  const p = plan(roots);
  if (p.entries.length === 0) {
    return { ok: false, why: 'ни одного промпта не найдено — миграция не нужна', plan: p };
  }

  const sources = SOURCE_KINDS
    .map(([kind]) => readSource(roots[kind] ?? '', kind))
    .filter((s) => s.exists);

  // Шаг 1. Копия раньше записи: порядок и есть гарантия.
  const into = join(backupRoot, `migrate-${stamp()}`);
  const backups = sources.map((s) => backupSource(s, into));

  // Шаг 2. Запись слитой библиотеки.
  const written = [];
  const failed = [];

  for (const entry of p.entries) {
    const item = winnerOf(sources, entry);
    if (!item) {
      failed.push({ id: entry.id, why: 'победившая копия не найдена при записи' });
      continue;
    }

    try {
      written.push(writeOne(target, entry, item));
    } catch (err) {
      // Один сбойный файл не останавливает остальные (REQ-LIB-ISOLATE).
      failed.push({ id: entry.id, why: err.message });
    }
  }

  return {
    ok: failed.length === 0,
    plan: p,
    backup: { dir: into, sources: backups },
    written,
    failed,
  };
};

const writeOne = (target, entry, item) => {
  const cleaned = cleanBody(item.body);
  const meta = migrateMeta(item, entry);
  const file = join(target, entry.group, `${entry.id}.md`);

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buildPromptFile(meta, cleaned.text, FIELD_ORDER), 'utf8');

  return {
    id: entry.id,
    group: entry.group,
    file,
    cleaned: cleaned.changed,
    bytes: Buffer.byteLength(buildPromptFile(meta, cleaned.text, FIELD_ORDER), 'utf8'),
  };
};

/**
 * Сверка результата с планом: столько же файлов, и каждый читается.
 *
 * Отдельный шаг, а не доверие к `apply`: «записано 29» из отчёта той же функции,
 * которая писала, — это её собственное мнение о себе. Проверка читает диск.
 */
export const verifyApplied = (target, p) => {
  const missing = [];
  const unreadable = [];

  for (const entry of p.entries) {
    const file = join(target, entry.group, `${entry.id}.md`);
    if (!existsSync(file)) {
      missing.push(`${entry.group}/${entry.id}.md`);
      continue;
    }
    try {
      const text = readFileSync(file, 'utf8');
      if (text.trim() === '') unreadable.push(`${entry.group}/${entry.id}.md: файл пуст`);
    } catch (err) {
      unreadable.push(`${entry.group}/${entry.id}.md: ${err.message}`);
    }
  }

  return {
    ok: missing.length === 0 && unreadable.length === 0,
    expected: p.entries.length,
    missing,
    unreadable,
    leftovers: leftoverSources(target, p),
  };
};

/**
 * Исходники, оставшиеся в целевой папке после переименования.
 *
 * Дефект найден ЖИВЫМ ЗАПУСКОМ: `inbox/s-hagent.md` переименован в
 * `s-hagent-inbox.md`, но исходный файл остался рядом — и сервер увидел ДВА промпта
 * с одинаковым `id` (V-P-2, оба помечены сломанными).
 *
 * Причина в столкновении двух верных правил. Миграция не удаляет источники — это
 * правильно, когда источник лежит в другой папке. Но здесь цель и источник совпали:
 * `prompts/` читается и записывается одновременно, и переименованный файл не заменяет
 * старый, а добавляется к нему.
 *
 * Удалять сам НЕ буду: это решение человека (docs/RULES.md §5). Функция называет
 * файлы, а `migrate.mjs` печатает их с готовой командой удаления — человек видит, что
 * именно предлагается убрать, и почему.
 */
export const leftoverSources = (target, p) => {
  const out = [];

  for (const entry of p.entries) {
    if (entry.id === entry.sourceId) continue;

    const old = join(target, entry.group, `${entry.sourceId}.md`);
    if (!existsSync(old)) continue;

    out.push({
      file: old,
      rel: `${entry.group}/${entry.sourceId}.md`,
      why: `переименован в «${entry.id}» — этот файл даёт дубликат id и помечается сломанным`,
    });
  }

  return out;
};
