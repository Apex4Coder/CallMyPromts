// release/index.mjs — публичный барьер модуля release.
//
// Импорт внутренних файлов модуля мимо этого файла — нарушение границы,
// его ловит gates/arch-check.mjs (docs/ENTITY-MAP.md §6).
//
// Слой L1 по концепции gld/gold.md §2. Не знает ни про сервер, ни про интерфейс,
// ни про домен: он переставляет указатель и связывает каталоги. Обратное тоже
// верно — сервер о нём не знает, и это проверяет карта границ.

export {
  NAMES,
  LINKED_DIRS,
  KEEP_RELEASES,
  makeReleaseId,
  paths,
  ensureLayout,
  isJunction,
  linkTarget,
  makeJunction,
  removeJunction,
  linkShared,
  logRelease,
} from './layout.mjs';

export {
  RETRY,
  withRetry,
  current,
  previous,
  listReleases,
  swapTo,
  rollback,
  prune,
} from './swap.mjs';

// Standalone packaging policy belongs to release; consumers use this barrier.
export { RUNTIME_DIRS, sourceFiles, runtimeMetadata } from './bundle.mjs';
