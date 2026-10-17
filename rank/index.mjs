// rank/index.mjs — публичный барьер модуля rank.
//
// Слой app: собирает данные library и clipboard в то, что видит человек —
// порядок, поиск, температура, счётчик. Своих файлов на диске не имеет.

export {
  LEVELS,
  LEVEL_VIEW,
  FRESH_DAYS,
  OFTEN,
  DAY_MS,
  daysSince,
  temperature,
  describeTemperature,
  humanDays,
  temperatureStats,
} from './temperature.mjs';

export {
  swapLayout,
  norm,
  queryVariants,
  matchSpan,
  search,
  highlightParts,
  emptyMessage,
} from './search.mjs';

export {
  MODES,
  PIN_MIN,
  PIN_MAX,
  pinned,
  unpinned,
  weight,
  order,
  firstFreePin,
  occupantOf,
  planPin,
  suggestPin,
  pinSlots,
} from './order.mjs';

export {
  DEBOUNCE_MS,
  UsageTracker,
  usageBadge,
  describeUsage,
  usageStats,
  topUsed,
} from './usage.mjs';
