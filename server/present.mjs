// server/present.mjs — приведение внутренних записей к виду для интерфейса.
//
// Зачем отдельный файл: интерфейс не должен видеть внутреннюю форму записи.
// Здесь решается, что уходит в браузер, и, главное, что НЕ уходит:
//   • `raw` промпта — интерфейсу нужен разобранный текст, не исходник файла;
//   • тело промпта в списке — на 26 файлах это сотни килобайт на каждый кадр поиска;
//   • полный текст записи журнала в списке — только preview до 160 знаков.
//
// Разметка не собирается здесь никогда: подсветка уходит массивом частей
// (`highlightParts`), и содержимое промпта не может стать HTML.

import { describeKind, viewFlags } from '../clipboard/index.mjs';
import { describeUsage, highlightParts } from '../rank/index.mjs';

const shortIssues = (issues = []) => issues.map((x) => ({
  level: x.level,
  code: x.code,
  message: x.message,
  field: x.field ?? null,
  expected: x.expected ?? null,
}));

/** Промпт для списка: без тела и без raw. */
export const forList = (i) => ({
  id: i.id,
  group: i.group,
  title: i.title,
  pin: i.pin ?? null,
  pos: i._pos ?? null,
  trigger: i.trigger ?? null,
  hotkey: i.hotkey ?? null,
  status: i.status,
  state: i.state,
  tags: i.tags ?? [],
  bytes: i.bytes,
  usage: describeUsage(i),
  match: i._match
    ? {
      field: i._match.field,
      corrected: i._match.corrected,
      parts: highlightParts(i.title, i._match.field === 'title' ? i._match.span : null),
    }
    : null,
  issues: shortIssues(i.issues),
});

/** Промпт целиком: для превью и редактирования. */
export const forOne = (i) => ({
  ...forList(i),
  body: i.body,
  mtimeMs: i.mtimeMs ?? null,
  path: i.path,
  cleaned: i.cleaned ?? [],
  source: i.source ?? null,
  created: i.created ?? null,
  updated: i.updated ?? null,
  version: i.version ?? 1,
});

/** Запись журнала для списка: preview, тип, признак секрета. */
export const clipForList = (c) => ({
  id: c.id,
  kind: c.kind,
  preview: c.preview,
  bytes: c.bytes,
  lines: c.lines,
  sourceApp: c.source_app ?? null,
  createdAt: c.created_at,
  promotedTo: c.promoted_to ?? null,
  view: describeKind(c.preview, { kind: c.kind }),
  privacy: viewFlags({ preview: c.preview, text: c.text ?? c.preview }),
});

/** Запись журнала с текстом: только по прямому запросу одной записи. */
export const clipForOne = (c) => ({ ...clipForList(c), text: c.text });

/** Первая блокирующая проблема — для кода ответа и текста ошибки. */
export const firstBad = (issues = []) => issues.find((i) => i.level === 'bad') ?? issues[0] ?? null;
