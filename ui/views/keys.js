// ui/views/keys.js — модель клавиатуры окна выбора.
//
// Требование: REQ-UI-KEYS (docs/SPEC.md §7). Контракт: docs/UI-SPEC.md §4.
// Тест: tests/e2e/keys.spec.mjs.
//
// Вынесено из ui/views/picker.js: разбор нажатий — отдельное решение от
// отрисовки списка, и лимит чанка (docs/RULES.md §3) не обходится, а соблюдается.
//
// Функция чистая: она получает нажатие и отвечает, что нужно сделать. Ни DOM, ни
// запросов здесь нет, поэтому правило «цифра при непустом поиске — это символ, а
// не выбор позиции» видно целиком в одном месте и не размазано по обработчику.
//
// Модель взята из ClipClip: одно нажатие — один смысл. Неоднозначность «1» между
// «позиция 1» и «символ 1» решена в пользу ввода: человек, набирающий запрос,
// печатает, а не выбирает (docs/UI-SPEC.md §4).

/** Ничего не делаем и событие не перехватываем. */
const PASS = { act: null, prevent: false };

/**
 * Что делать по нажатию.
 *
 * @param {{key: string, ctrlKey?: boolean, shiftKey?: boolean}} e нажатие
 * @param {{emptyQuery: boolean}} state пусто ли поле поиска
 * @returns {{act: string|null, prevent: boolean, step?: number, pin?: number,
 *   copyOnly?: boolean, trim?: boolean}}
 */
export const keyAction = (e, { emptyQuery }) => {
  switch (e.key) {
    case 'Escape':
      return { act: 'close', prevent: true };
    case 'ArrowDown':
      return { act: 'move', step: 1, prevent: true };
    case 'ArrowUp':
      return { act: 'move', step: -1, prevent: true };
    case 'Enter':
      // Ctrl+Enter вставляет без хвостовых пустых строк: в чате они уезжают
      // отправкой сообщения раньше, чем человек допишет своё.
      return { act: 'insert', trim: e.ctrlKey === true, prevent: true };
    case 'Tab':
      // Shift+Tab оставлен браузеру: это переход по фокусу, и ломать его нельзя
      // (REQ-UI-A11Y).
      return e.shiftKey ? PASS : { act: 'insert', copyOnly: true, prevent: true };
    case 'F2':
      return { act: 'edit', prevent: true };
    case ' ':
      return emptyQuery ? { act: 'expand', prevent: true } : PASS;
    default:
      break;
  }

  if (emptyQuery && /^[1-9]$/.test(e.key)) {
    return { act: 'pin', pin: Number(e.key), prevent: true };
  }
  return PASS;
};
