// clipboard/index.mjs — публичный барьер модуля clipboard.
//
// Владелец сущности «Запись буфера» (docs/ENTITY-MAP.md §1). Файл state/clips.db
// принадлежит только этому модулю; никто больше не открывает базу журнала.
//
// Записи в prompts/ здесь нет и быть не может: promote готовит план, исполняет
// его library через server (docs/ENTITY-MAP.md §6).

export { ClipStore } from './store.mjs';

export {
  KIND_VIEW,
  KIND_FILTERS,
  guessLanguage,
  describeKind,
  matchesFilter,
  countByFilter,
} from './kind.mjs';

export {
  findSecretMarks,
  looksSecret,
  screen,
  mask,
  eventLine,
  viewFlags,
  assertNotSynced,
  SYNC_DENY,
} from './privacy.mjs';

export {
  groupChoices,
  planPromotion,
  applyPromotion,
  describeResult,
} from './promote.mjs';
