// library/index.mjs — публичный барьер модуля library.
//
// Владелец сущности «Промпт» и «Группа» (docs/ENTITY-MAP.md §1). Никакой другой
// модуль не пишет в папку prompts напрямую.

export {
  unescapeHtml,
  looksLikeHtml,
  stripHtml,
  stripTodo,
  normalizeNewlines,
  cleanBody,
  titleFromText,
  slugify,
  safeFileName,
} from './clean.mjs';

export {
  listPromptFiles,
  readPromptFile,
  readLibrary,
  usableItems,
} from './read.mjs';

export {
  promptPath,
  writeAtomic,
  freeId,
  createPrompt,
  updatePrompt,
  markUsed,
  setPin,
} from './write.mjs';

export {
  groupLabel,
  listGroups,
  createGroup,
  removeGroupIfEmpty,
  describeGroups,
} from './groups.mjs';
