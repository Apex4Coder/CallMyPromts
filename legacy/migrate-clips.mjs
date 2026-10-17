// legacy/migrate-clips.mjs — перенос сохранённых клипов ClipClip в журнал буфера.
//
// Требование: REQ-MIG-CLIPS (docs/SPEC.md §11). Сценарий S-11.
// Тест: tests/unit/migrate-clips.test.mjs.
//
// Что переносится. ClipClip держит сохранённые клипы файлами в своей папке: текст
// в `.txt`, форматированный — в `.html` с инлайн-CSS от Google Docs. Из 39 клипов
// 19 оказались HTML, и это главная причина, по которой перенос не сводится к
// копированию: разметка в чате бесполезна, а иногда и вредна.
//
// Что НЕ переносится и почему:
//   — картинки: журнал хранит текст, картинку в чат вставлять нечем;
//   — клипы из чёрного списка процессов: если запись сделана из менеджера паролей,
//     она не должна ожить в новом журнале;
//   — пустые после очистки: HTML из одних тегов даёт пустую строку.
//
// Имя записи НЕ «первые 50 символов». Прежняя система именно так и делала, и в
// списке стояли строки вида «Проведи ревью кода ниже. Разбери по уровн…», по
// которым ничего нельзя найти. Заголовок берётся `titleFromText` — той же функцией,
// что и при сохранении промпта из журнала: одно правило на оба пути.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

import { detectKind, isBlacklisted, BLACKLIST_DEFAULT } from '../contracts/index.mjs';
import { cleanBody, titleFromText } from '../library/index.mjs';

/** Расширения, которые ClipClip пишет для текстовых клипов. */
export const TEXT_EXT = new Set(['.txt', '.html', '.htm', '.rtf', '.md']);

/** Расширения картинок: они узнаются, чтобы отказ имел причину, а не молчал. */
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);

/**
 * Имя процесса из имени файла ClipClip, если оно там есть.
 *
 * ClipClip кладёт источник в имя не всегда, и это ограничение переноса, а не
 * оплошность: клип без источника нельзя проверить по чёрному списку. Такие записи
 * переносятся, но помечаются — решение о них остаётся за человеком.
 *
 * Дефис в класс НЕ входит, и это осознанный компромисс. Первая версия шаблона
 * писала `[\w-]+` и вытаскивала из `clip-keepass.exe-001.txt` имя
 * «clip-keepass.exe»: префикс самого ClipClip приклеивался к имени процесса, и
 * чёрный список по нему не сработал бы никогда. Обратная сторона — процесс с
 * дефисом в названии (`some-app.exe`) определится как «app.exe». Из двух ошибок
 * выбрана менее опасная: сузить имя хуже, чем испортить его префиксом, потому что
 * проверка по чёрному списку идёт по вхождению подстроки.
 */
export const processOf = (name) => {
  const m = /([A-Za-z0-9_.]+\.exe)/i.exec(basename(name));
  return m ? m[1].toLowerCase() : null;
};

/**
 * Разбор одного файла клипа.
 * Возвращает либо запись для журнала, либо отказ с причиной. Молчаливый пропуск
 * запрещён: «перенесено 12 из 39» без объяснения остальных 27 бесполезно.
 */
export const readClipFile = (dir, name, { blacklist = BLACKLIST_DEFAULT } = {}) => {
  const ext = extname(name).toLowerCase();
  const file = join(dir, name);

  if (IMAGE_EXT.has(ext)) {
    return { ok: false, file, why: 'картинка — журнал хранит текст, вставлять её в чат нечем' };
  }
  if (!TEXT_EXT.has(ext)) {
    return { ok: false, file, why: `расширение ${ext || '«нет»'} не текстовое` };
  }

  const proc = processOf(name);
  if (proc && isBlacklisted(proc, blacklist)) {
    return { ok: false, file, why: `источник ${proc} в чёрном списке — запись не переносится` };
  }

  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, file, why: `не прочитан: ${err.message}` };
  }

  const cleaned = cleanBody(raw);
  if (cleaned.text.trim() === '') {
    return { ok: false, file, why: 'после очистки не осталось текста — были только теги' };
  }

  const st = statSync(file);
  return {
    ok: true,
    file,
    clip: {
      text: cleaned.text,
      kind: detectKind(cleaned.text),
      title: titleFromText(cleaned.text),
      source: proc,
      createdAt: new Date(st.mtimeMs).toISOString(),
    },
    cleaned: cleaned.changed,
    unknownSource: proc === null,
  };
};

/**
 * План переноса клипов. Ничего не пишет.
 *
 * Порядок по времени файла, от старых к новым: журнал — это лог, и записи в нём
 * идут друг за другом. Перенос в случайном порядке дал бы историю, в которой
 * «вчера» стоит после «сегодня».
 */
export const planClips = (dir, opts = {}) => {
  if (!existsSync(dir)) {
    return { exists: false, dir, taken: [], skipped: [], summary: { total: 0, taken: 0, skipped: 0, cleaned: 0 } };
  }

  const results = readdirSync(dir)
    .filter((n) => !n.startsWith('.'))
    .map((n) => readClipFile(dir, n, opts))
    .sort((a, b) => String(a.clip?.createdAt ?? '').localeCompare(String(b.clip?.createdAt ?? '')));

  const taken = results.filter((r) => r.ok);
  const skipped = results.filter((r) => !r.ok);

  return {
    exists: true,
    dir,
    taken,
    skipped,
    summary: {
      total: results.length,
      taken: taken.length,
      skipped: skipped.length,
      cleaned: taken.filter((r) => r.cleaned.length > 0).length,
      unknownSource: taken.filter((r) => r.unknownSource).length,
    },
  };
};

/**
 * Запись плана в журнал.
 *
 * `store` приходит извне, а не создаётся здесь: журналом владеет модуль clipboard
 * (docs/ENTITY-MAP.md §2), и второе место, открывающее ту же базу, означало бы два
 * мнения о её схеме. Дедупликация и кольцевой лимит при этом достаются бесплатно —
 * их делает `store.add`.
 */
/** Отказ журнала словами. Код `skipped` человеку ничего не говорит. */
const SKIP_WHY = {
  paused: 'слежка на паузе — снимите пузу и повторите',
  duplicate: 'такой же текст уже последняя запись журнала',
  too_short: 'слишком короткий текст, чтобы быть записью',
  blacklist: 'источник в чёрном списке',
};

export const applyClips = (plan, store) => {
  const added = [];
  const failed = [];

  for (const item of plan.taken) {
    try {
      // `sourceApp`, а не `source`: имя параметра взято из clipboard/store.mjs, и
      // первая версия передавала свои названия — запись прошла бы без источника,
      // и чёрный список внутри `add` не смог бы её отсеять.
      //
      // `kind` не передаётся вовсе: журнал определяет тип сам через `detectKind`.
      // Своё мнение о типе здесь было бы вторым мнением о той же величине.
      const out = store.add(item.clip.text, { sourceApp: item.clip.source });

      if (out.ok) {
        added.push({ file: item.file, id: out.id, title: item.clip.title });
      } else {
        const why = out.why ?? SKIP_WHY[out.skipped] ?? `журнал отклонил: ${out.skipped}`;
        failed.push({ file: item.file, why });
      }
    } catch (err) {
      failed.push({ file: item.file, why: err.message });
    }
  }

  return { ok: failed.length === 0, added, failed, skipped: plan.skipped };
};

/** План клипов в текст для человека. */
export const printableClips = (p) => {
  const out = [];
  if (!p.exists) return `Папка ClipClip не найдена: ${p.dir}\nПеренос клипов не нужен.`;

  out.push(`ПАПКА: ${p.dir}`);
  out.push(`  файлов: ${p.summary.total}`);
  out.push(`  переносится: ${p.summary.taken}`);
  out.push(`  очищено от разметки: ${p.summary.cleaned}`);
  out.push(`  без известного источника: ${p.summary.unknownSource}`);
  out.push(`  пропускается: ${p.summary.skipped}`);

  if (p.taken.length > 0) {
    out.push('');
    out.push('ПЕРЕНОСИТСЯ');
    for (const t of p.taken) out.push(`  ${t.clip.title} [${t.clip.kind}]`);
  }

  if (p.skipped.length > 0) {
    out.push('');
    out.push('ПРОПУСКАЕТСЯ, И ВОТ ПОЧЕМУ');
    for (const s of p.skipped) out.push(`  ${basename(s.file)}: ${s.why}`);
  }

  return out.join('\n');
};
