// contracts/index.mjs — публичный барьер модуля contracts.
//
// Импорт внутренних файлов модуля мимо этого файла — нарушение границы,
// его ловит gates/arch-check.mjs (docs/ENTITY-MAP.md §6).

export { ContractError, issue, bad, warn, stateOf, num, counter } from './errors.mjs';

export {
  parseFlatYaml,
  splitFrontmatter,
  buildFrontmatter,
  buildPromptFile,
} from './yaml.mjs';

export {
  ID_RE,
  GROUP_RE,
  TRIGGER_RE,
  TAG_RE,
  TAG_HINT,
  DATE_RE,
  HOTKEY_RE,
  STATUSES,
  FIELD_ORDER,
  MAX_BYTES,
  TITLE_MAX,
  MACHINE_FIELDS,
  withDefaults,
  validatePrompt,
  validateUnique,
} from './prompt.mjs';

export {
  KINDS,
  PREVIEW_LEN,
  MIN_LEN,
  MAX_LEN,
  LIMIT_DEFAULT,
  LIMIT_MIN,
  LIMIT_MAX,
  BLACKLIST_DEFAULT,
  detectKind,
  makePreview,
  countLines,
  validateClipInput,
  isBlacklisted,
  clampLimit,
} from './clip.mjs';

export {
  LAYOUTS,
  THEMES,
  MOTIONS,
  ACCENTS,
  DENSITIES,
  POSITIONS,
  ORDER_MODES,
  SCHEMA_VERSION,
  DEFAULTS,
  validateSettings,
  mergeSettings,
  knownPaths,
} from './settings.mjs';
