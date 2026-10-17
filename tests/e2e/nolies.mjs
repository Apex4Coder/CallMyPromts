// tests/e2e/nolies.mjs — проверка «на экране нет технических значений».
//
// Требование: REQ-UI-EMPTY (docs/SPEC.md §7). Утверждение U-14.
// Используется в tests/e2e/empty.spec.mjs и tests/e2e/numbers.spec.mjs.
//
// Вынесено в отдельный файл, когда empty.spec.mjs разделился на два: копия
// функции в каждом означала бы два списка запрещённых слов, которые разойдутся
// при первом же добавлении.
//
// Почему это не косметика. Прежняя система показывала «NaN» в сводке из-за поля
// `score: -` в девяти файлах, и такая подпись выглядит как поломка всей программы,
// а не как один битый файл (REQ-LIB-ISOLATE).

import { expect } from '@playwright/test';

/** Слова, которых на экране быть не может ни при каком состоянии данных. */
export const FORBIDDEN = ['undefined', 'NaN', 'null', 'Infinity', '[object Object]'];

export const pageText = (page) => page.evaluate(() => document.body.innerText);

/** Проверка всего видимого текста разом: ложь ищется целиком, а не по элементу. */
export const expectNoLies = async (page, where) => {
  const text = await pageText(page);
  for (const word of FORBIDDEN) {
    expect(text.includes(word), `${where}: на экране «${word}»`).toBe(false);
  }
};
