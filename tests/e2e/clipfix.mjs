// tests/e2e/clipfix.mjs — фикстуры журнала буфера для E2E.
//
// Требование: REQ-UI-CLIPS (docs/SPEC.md §7). DOM-id: docs/UI-SPEC.md §3.2.
//
// Вынесено из спек, потому что журнал проверяют два файла: tests/e2e/clips.spec.mjs
// (список, фильтры, поиск) и tests/e2e/clipmenu.spec.mjs (контекстное меню).
// Разделение — из-за лимита чанка в 300 строк (docs/RULES.md §3), и общий набор
// записей обязан быть один: два набора «почти одинаковых» клипов означали бы, что
// тесты проверяют разные журналы и расходятся молча.

import { expect } from '@playwright/test';

/**
 * Записи журнала. Порядок в массиве = порядок добавления, поэтому в интерфейсе
 * они окажутся в обратном: новое сверху (владелец: «все записи идут друг за
 * другом»). Типы подобраны так, чтобы каждый фильтр §3.2 нашёл своё.
 */
export const CLIPS = [
  { text: 'Первая скопированная строка про архитектуру.', sourceApp: 'code.exe' },
  { text: 'https://example.com/docs/api', sourceApp: 'chrome.exe' },
  { text: 'C:\\Users\\Example\\Desktop\\notes.md', sourceApp: 'explorer.exe' },
  { text: 'const answer = 42;\nexport default answer;\nfunction go() { return answer; }', sourceApp: 'code.exe' },
  { text: 'Последняя запись, она обязана быть сверху.', sourceApp: 'code.exe' },
];

/** Строки журнала на странице. */
export const clipRows = (page) => page.locator('#clipsList .clip');

/**
 * Наполнение журнала через API — тем же путём, каким это делает слежка моста
 * (`POST /api/clips`). Прямая запись в базу проверяла бы другой путь.
 */
export const addClips = async (deck, items = CLIPS) => {
  for (const c of items) {
    // eslint-disable-next-line no-await-in-loop
    await deck.api('/api/clips', { method: 'POST', body: c });
  }
};

/** Правый клик по записи: меню открывается только так (§3.2). */
export const openClipMenu = async (page, index = 0) => {
  await clipRows(page).nth(index).click({ button: 'right' });
  await expect(page.locator('#clipMenu')).toBeVisible();
};

/** Запись по фрагменту текста: искать по номеру строки хрупко. */
export const clipWith = async (page, needle) => {
  const all = clipRows(page);
  const count = await all.count();
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const text = await all.nth(i).locator('.text').textContent();
    if (text.includes(needle)) return all.nth(i);
  }
  throw new Error(`записи с «${needle}» нет в журнале`);
};
