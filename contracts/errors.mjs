// contracts/errors.mjs — единый формат ошибок проекта.
//
// Ошибка обязана называть место: файл, строку и что ожидалось. Ошибка вида
// «что-то пошло не так» превращает отладку в поиск наугад (docs/RULES.md §4).

/** Ошибка контракта данных: несёт место и ожидание, а не только текст. */
export class ContractError extends Error {
  constructor(code, message, place = {}) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
    this.file = place.file ?? null;
    this.line = place.line ?? null;
    this.expected = place.expected ?? null;
    this.field = place.field ?? null;
  }

  /** Форма для HTTP-ответа и логов (docs/DATA-CONTRACTS.md §6). */
  toJSON() {
    const out = { error: this.code, message: this.message };
    if (this.field !== null) out.field = this.field;
    if (this.file !== null) out.file = this.file;
    if (this.line !== null) out.line = this.line;
    if (this.expected !== null) out.expected = this.expected;
    return out;
  }
}

/**
 * Число из чего угодно, но без NaN.
 *
 * `Number(v || 0)` для этого недостаточно: непустая нечисловая строка проходит
 * как истинное значение и даёт NaN. Живой случай — поле `score: -` в девяти
 * файлах библиотеки; одного такого значения хватало, чтобы подпись в панели
 * стала «NaN», а это выглядит как поломка всей программы, а не как один битый
 * файл (REQ-LIB-ISOLATE).
 *
 * Место в contracts, потому что это свойство данных, а не отображения: одно и то
 * же правило нужно и счётчикам журнала, и сводке использований. Две копии стали
 * бы двумя мнениями о том, что такое «число» (docs/RULES.md §1).
 */
export const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Целое ≥ 0 — форма, в которой хранятся все счётчики проекта. */
export const counter = (v) => Math.max(0, Math.trunc(num(v)));

/** Замечание валидации. Уровень решает, изолируется файл или только помечается. */
export const issue = (level, code, message, place = {}) => ({
  level, // 'bad' | 'warn'
  code,
  message,
  field: place.field ?? null,
  file: place.file ?? null,
  line: place.line ?? null,
  expected: place.expected ?? null,
});

export const bad = (code, message, place) => issue('bad', code, message, place);
export const warn = (code, message, place) => issue('warn', code, message, place);

/**
 * Состояние сущности по списку замечаний.
 * Ровно четыре состояния на весь проект (docs/RULES.md §5): пятое состояние
 * пришлось бы отличать глазами, а предел различимости уже достигнут.
 */
export const stateOf = (issues) => {
  if (issues.some((i) => i.level === 'bad')) return 'bad';
  if (issues.some((i) => i.level === 'warn')) return 'warn';
  return 'good';
};
