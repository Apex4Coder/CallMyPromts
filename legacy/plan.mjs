// legacy/plan.mjs — план миграции: что произойдёт, до того как произойдёт.
//
// Требование: REQ-MIG-REPORT (docs/SPEC.md §11). Сценарий S-11.
// Тест: tests/unit/migrate.test.mjs.
//
// Этот файл ничего не пишет на диск. Совсем. Он собирает решения в структуру,
// которую можно напечатать и прочитать глазами — и только потом legacy/apply.mjs
// её исполняет. Разделение не косметическое: миграция сливает три копии в одну и
// переименовывает поля, а такое действие нельзя предлагать кнопкой «поехали».
//
// Что план обязан назвать по каждому промпту:
//   — какая копия выиграла и ПОЧЕМУ (одной фразой, не «по алгоритму»);
//   — что потеряется, если тела копий разошлись;
//   — какое поле будет переименовано (`label` → `title`);
//   — конфликт `id`, когда одно имя занято в двух группах.

import { basename } from 'node:path';

import { ID_RE, TITLE_MAX } from '../contracts/index.mjs';
import { SOURCE_KINDS, readSource, pickWinner, sameBody } from './sources.mjs';

/**
 * Поле `label` прежнего формата — это `title` нынешнего.
 *
 * Переименование, а не поддержка обоих имён: два названия одного поля означают,
 * что читающий код обязан помнить про оба, и рано или поздно кто-то проверит
 * только одно. 26 файлов из 29 держат `label` (см. legacy/README.md).
 */
export const RENAMES = { label: 'title' };

/** Заголовок из `label`/`title`, обрезанный до контрактного предела. */
const titleOf = (item) => {
  const raw = item.meta.title ?? item.meta.label ?? '';
  const clean = String(raw).trim();
  if (clean !== '') return clean.slice(0, TITLE_MAX);
  // Имя файла — последний резерв: пустая строка в списке хуже технического имени.
  return basename(item.file, '.md');
};

/**
 * Разбор конфликта одинаковых `id` в разных группах.
 *
 * Живой случай: `s-hagent`, `s-ndoc`, `s-ses` лежат и в `chatbox/`, и в `inbox/`.
 * `inbox` по смыслу — «ещё не разложено», поэтому проигрывает всегда: промпт,
 * доехавший до именованной группы, уже обработан человеком.
 *
 * Переименование, а не удаление: файл в `inbox` может отличаться по телу, и
 * молча потерять его значило бы решить за человека (docs/RULES.md §5).
 */
export const INBOX = 'inbox';

/**
 * Разрешение конфликта имён — операция ИДЕМПОТЕНТНАЯ.
 *
 * Дефект найден повторным запуском миграции на настоящих данных: файлы превратились
 * в `s-hagent-inbox-inbox.md`, потом стали бы `-inbox-inbox-inbox`. Причина простая
 * и в первой версии незаметная: миграция читает `prompts/` и пишет в `prompts/`,
 * то есть второй прогон видит СВОЙ ЖЕ результат как источник — и добавляет суффикс
 * к уже переименованному имени.
 *
 * Проверка «суффикс уже есть» решает это целиком: имя, доведённое до конечного вида,
 * дальше не меняется. Повторный запуск обязан быть безопасным — человек запустит
 * миграцию дважды, например поправив один файл руками, и второй прогон не должен
 * плодить копии.
 *
 * Тест «повторный запуск не портит уже слитую библиотеку» существовал и проходил —
 * но он проверял ОДИН файл без конфликта имён. Дыра была ровно в непроверенной
 * комбинации: повтор + конфликт.
 */
const resolveId = (id, group, taken) => {
  const suffix = group === INBOX ? '-inbox' : `-${group}`;

  // Имя уже приведено к конечному виду: второй прогон ничего не меняет.
  if (id.endsWith(suffix)) {
    return { id, renamed: false, why: null };
  }

  if (!taken.has(id)) return { id, renamed: false, why: null };

  const next = `${id}${suffix}`;
  return {
    id: next,
    renamed: true,
    why: `«${id}» уже занят в другой группе — здесь станет «${next}»`,
  };
};

/**
 * Прочерк вместо значения — след прежней системы.
 *
 * `score: -` стоит в 22 файлах, и `Number('-')` даёт `NaN`. Именно это и попадало
 * на экран прежней сводки. Отчёт называет такие поля до записи: молча заменить
 * значение на `null` правильно по сути, но человек должен узнать, что в его файлах
 * было не то, что он думал.
 */
const DASHES = new Set(['-', '—', 'none', 'нет', '?', 'n/a']);

const dashFields = (meta) => Object.entries(meta)
  .filter(([, v]) => typeof v === 'string' && DASHES.has(v.trim().toLowerCase()))
  .map(([k]) => k);

/** Одна запись плана: что будет с этим промптом и почему. */
const entry = (id, copies, taken) => {
  const { best, rest, why } = pickWinner(copies);
  const notes = [];

  if (best.broken) notes.push(`главная копия испорчена: ${best.why}`);
  for (const other of rest) {
    if (!sameBody(best, other)) {
      const where = SOURCE_KINDS.find(([k]) => k === other.kind)?.[1] ?? other.kind;
      notes.push(`тело в «${where}» другое — эта версия останется только в резервной копии`);
    }
  }
  if ('label' in best.meta) notes.push('поле label станет title');

  const dashes = dashFields(best.meta);
  if (dashes.length > 0) {
    notes.push(`прочерк вместо значения в ${dashes.join(', ')} — станет пустым (это и давало «NaN»)`);
  }

  if (best.meta.group && best.meta.group !== best.group) {
    notes.push(`group «${best.meta.group}» не совпадает с папкой — папка главнее`);
  }

  const decided = resolveId(id, best.group, taken);
  if (decided.why) notes.push(decided.why);
  if (!ID_RE.test(decided.id)) notes.push(`id «${decided.id}» не по форме — файл нужно переименовать руками`);

  return {
    id: decided.id,
    sourceId: id,
    group: best.group,
    title: titleOf(best),
    from: best.kind,
    why,
    copies: copies.length,
    broken: best.broken,
    notes,
  };
};

/**
 * Полный план миграции по трём корням.
 *
 * @param {Record<string, string>} roots — вид источника → путь
 * @returns план: источники, записи, сводка. Ни одного действия.
 */
export const plan = (roots) => {
  const sources = SOURCE_KINDS
    .map(([kind]) => readSource(roots[kind] ?? '', kind))
    .filter((s) => s.exists);

  // Ключ — id + группа: одинаковые id в разных группах это разные промпты, и
  // склеивать их по имени значило бы потерять один из них.
  const byKey = new Map();
  for (const src of sources) {
    for (const item of src.items) {
      const key = `${item.group}/${item.id}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(item);
    }
  }

  // Порядок обхода фиксирован: иначе разбор конфликта id зависел бы от порядка
  // чтения файловой системы, и два прогона дали бы разные имена.
  const keys = [...byKey.keys()].sort();
  const taken = new Set();
  const entries = [];

  for (const key of keys) {
    const made = entry(key.split('/')[1], byKey.get(key), taken);
    taken.add(made.sourceId);
    taken.add(made.id);
    entries.push(made);
  }

  return {
    sources: sources.map((s) => ({ kind: s.kind, root: s.root, count: s.items.length })),
    entries,
    summary: {
      total: entries.length,
      broken: entries.filter((e) => e.broken).length,
      renamed: entries.filter((e) => e.id !== e.sourceId).length,
      conflicts: entries.filter((e) => e.copies > 1).length,
      relabeled: entries.filter((e) => e.notes.some((n) => n.includes('label'))).length,
      dashed: entries.filter((e) => e.notes.some((n) => n.includes('прочерк'))).length,
    },
  };
};

/** План в текст для человека. Числа сначала, подробности потом. */
export const printable = (p) => {
  const out = [];
  out.push('ИСТОЧНИКИ');
  for (const s of p.sources) {
    const label = SOURCE_KINDS.find(([k]) => k === s.kind)?.[1] ?? s.kind;
    out.push(`  ${label}: ${s.count} промптов — ${s.root}`);
  }
  if (p.sources.length === 0) out.push('  ни одной папки не найдено');

  out.push('');
  out.push('ИТОГО');
  out.push(`  промптов после слияния: ${p.summary.total}`);
  out.push(`  из них в нескольких копиях: ${p.summary.conflicts}`);
  out.push(`  переименовано из-за конфликта id: ${p.summary.renamed}`);
  out.push(`  label → title: ${p.summary.relabeled}`);
  out.push(`  прочерк вместо значения: ${p.summary.dashed}`);
  out.push(`  испорченных файлов: ${p.summary.broken}`);

  out.push('');
  out.push('ПОДРОБНО');
  for (const e of p.entries) {
    out.push(`  ${e.group}/${e.id} — ${e.title}`);
    out.push(`    берётся из: ${SOURCE_KINDS.find(([k]) => k === e.from)?.[1]} (${e.why})`);
    for (const n of e.notes) out.push(`    ! ${n}`);
  }

  return out.join('\n');
};
