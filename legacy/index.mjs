// legacy/index.mjs — публичный барьер модуля legacy.
//
// Импорт внутренних файлов модуля мимо этого файла — нарушение границы,
// его ловит gates/arch-check.mjs (docs/ENTITY-MAP.md §6).
//
// Модуль существует ради одного разового действия — переезда с прежней системы.
// После успешной миграции он не участвует в работе приложения: сервер, мост и
// интерфейс о нём не знают и знать не должны.

export {
  SOURCE_KINDS,
  readSource,
  pickWinner,
  sameBody,
} from './sources.mjs';

export {
  RENAMES,
  INBOX,
  plan,
  printable,
} from './plan.mjs';

export {
  backupSource,
  migrateMeta,
  apply,
  verifyApplied,
  leftoverSources,
} from './apply.mjs';

export {
  TEXT_EXT,
  IMAGE_EXT,
  processOf,
  readClipFile,
  planClips,
  applyClips,
  printableClips,
} from './migrate-clips.mjs';

export { parseArgs, defaultRoots, defaultTarget, main } from './migrate.mjs';
