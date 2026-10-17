// tests/e2e/freeze.spec.mjs — 20 защищённых вариантов UI-поведения.
//
// Требование: REQ-UI-GEOMETRY (docs/SPEC.md §14). Методичка: gld/ui-contract.txt §2.4.
//
// Это «список заморозки»: новая функция не считается успешной, если ломает хотя бы
// один из этих вариантов. Здесь намеренно нет новых абстракций — каждый тест
// формулирует одно обещание владельцу человеческими словами и проверяет его живым
// DOM/API. Изменить обещание можно только вместе со спецификацией.

import { test, expect, open, LIBRARY } from './deck.mjs';
import { addClips } from './clipfix.mjs';
import {
  noPageScroll, notClippedOrOccluded, overlayFits, singleRow, emptyKeepsLayout,
} from './geometry.mjs';
import { promptsFor } from './matrix.mjs';

test.beforeEach(async ({ deck }) => {
  await deck.reset();
});

// 1
test('freeze 01 · окно выбора открывается с фокусом в поиске', async ({ page, deck }) => {
  deck.seed(LIBRARY);
  await open(page, deck);
  await expect(page.locator('#pickerSearch')).toBeFocused();
});

// 2
test('freeze 02 · длинный заголовок не создаёт горизонтальный скролл', async ({ page, deck }) => {
  deck.seed(promptsFor(20));
  await page.setViewportSize({ width: 800, height: 600 });
  await open(page, deck);
  await noPageScroll(page, 'длинные заголовки');
});

// 3
test('freeze 03 · пустая библиотека сохраняет видимый плейсхолдер', async ({ page, deck }) => {
  await open(page, deck);
  await emptyKeepsLayout(page, '#pickerEmpty', 'пустая библиотека');
  await expect(page.locator('#pickerEmptyText')).toContainText('Промптов нет');
});

// 4
test('freeze 04 · 200 промптов отображаются без потери строк', async ({ page, deck }) => {
  deck.seed(promptsFor(200));
  await open(page, deck);
  await expect(page.locator('#pickerList .row')).toHaveCount(200);
});

// 5
test('freeze 05 · поиск сужает список и оставляет окно открытым', async ({ page, deck }) => {
  deck.seed(LIBRARY);
  await open(page, deck);
  await page.fill('#pickerSearch', 'ревью');
  await expect(page.locator('#pickerList .row')).toHaveCount(1);
  await expect(page.locator('#picker')).toBeVisible();
});

// 6
test('freeze 06 · пробел в непустом поиске остаётся символом', async ({ page, deck }) => {
  deck.seed(LIBRARY);
  await open(page, deck);
  await page.keyboard.type('ревью кода');
  await expect(page.locator('#pickerSearch')).toHaveValue('ревью кода');
});

// 7
test('freeze 07 · пробел в пустом поиске открывает превью', async ({ page, deck }) => {
  deck.seed(LIBRARY);
  await open(page, deck);
  await page.keyboard.press('Space');
  await expect(page.locator('#pickerPreview')).toBeVisible();
});

// 8
test('freeze 08 · превью целиком помещается в 800×600', async ({ page, deck }) => {
  deck.seed(LIBRARY);
  await page.setViewportSize({ width: 800, height: 600 });
  await open(page, deck);
  await page.keyboard.press('Space');
  await overlayFits(page, '#pickerPreview', 'preview');
});

// 9
test('freeze 09 · состояние промпта имеет значок и слово', async ({ page, deck }) => {
  deck.seed([{ id: 'c-bad', group: 'code', title: 'Пустой', body: '' }]);
  await open(page, deck);
  const chip = page.locator('#prompt-c-bad .state');
  await expect(chip.locator('.glyph')).not.toHaveText('');
  await expect(chip.locator('.word')).not.toHaveText('');
});

// 10
test('freeze 10 · пустой журнал сохраняет видимый плейсхолдер', async ({ page, deck }) => {
  await open(page, deck, '#clips');
  await emptyKeepsLayout(page, '#clipsEmpty', 'пустой журнал');
});

// 11
test('freeze 11 · длинная запись журнала не растягивает страницу', async ({ page, deck }) => {
  await addClips(deck, [{ text: `ключ=${'x'.repeat(400)}` }]);
  await page.setViewportSize({ width: 800, height: 600 });
  await open(page, deck, '#clips');
  await noPageScroll(page, 'длинная запись журнала');
});

// 12
test('freeze 12 · контекстное меню целиком в окне', async ({ page, deck }) => {
  await addClips(deck, [{ text: 'Запись для меню' }]);
  await page.setViewportSize({ width: 800, height: 600 });
  await open(page, deck, '#clips');
  await page.locator('#clipsList .clip').first().click({ button: 'right' });
  await overlayFits(page, '#clipMenu', 'контекстное меню');
});

// 13
test('freeze 13 · меню содержит ровно три команды', async ({ page, deck }) => {
  await addClips(deck, [{ text: 'Запись для меню' }]);
  await open(page, deck, '#clips');
  await page.locator('#clipsList .clip').first().click({ button: 'right' });
  await expect(page.locator('#clipMenu [role=menuitem]')).toHaveCount(3);
});

// 14
test('freeze 14 · поиск и пауза журнала лежат в одном ряду', async ({ page, deck }) => {
  await open(page, deck, '#clips');
  await singleRow(page, '#clipsSearch, #clipsPauseBtn', 'верхняя строка журнала');
});

// 15
test('freeze 15 · обе темы сохраняют доступные интерактивные элементы', async ({ page, deck }) => {
  deck.seed(LIBRARY);
  for (const theme of ['light', 'dark']) {
    // eslint-disable-next-line no-await-in-loop
    await deck.settings({ ui: { theme } });
    // eslint-disable-next-line no-await-in-loop
    await open(page, deck);
    // eslint-disable-next-line no-await-in-loop
    await notClippedOrOccluded(page, `theme ${theme}`);
  }
});

// 16
test('freeze 16 · прежние разделы сохранены, облако и возврат в CRM доступны', async ({ page, deck }) => {
  await open(page, deck, '#deck');
  await expect(page.locator('#deckNav a')).toHaveCount(10);
  for (const view of ['service','hotkeys','look','order','clipboard','library','diag','cloud','about'])
    await expect(page.locator(`#deckNav a[href="#view-${view}"]`)).toHaveCount(1);
  await expect(page.locator('#deckNav a[href="#crm"]')).toBeVisible();
});

// 17
test('freeze 17 · одновременно виден ровно один раздел настроек', async ({ page, deck }) => {
  await open(page, deck, '#deck');
  await page.click('#deckNav a[href="#view-look"]');
  await expect(page.locator('#deckMain section:not([hidden])')).toHaveCount(1);
});

// 18
test('freeze 18 · кнопки сервиса имеют цель не меньше 32px', async ({ page, deck }) => {
  await open(page, deck, '#deck');
  for (const id of ['svcStartBtn', 'svcStopBtn', 'svcRestartBtn']) {
    // eslint-disable-next-line no-await-in-loop
    const box = await page.locator(`#${id}`).boundingBox();
    expect(Math.round(box.height), id).toBeGreaterThanOrEqual(32);
  }
});

// 19
test('freeze 19 · смена темы не сбрасывает горячую клавишу', async ({ page, deck }) => {
  await deck.settings({ hotkeys: { open_picker: '^!p' } });
  await open(page, deck, '#deck');
  await page.click('#deckNav a[href="#view-look"]');
  await page.selectOption('#optTheme', 'dark');
  const saved = await deck.api('/api/settings');
  expect(saved.data.settings.hotkeys.open_picker).toBe('^!p');
});

// 20
test('freeze 20 · интерфейс не показывает технические значения', async ({ page, deck }) => {
  deck.seed(LIBRARY);
  await open(page, deck, '#deck');
  const text = await page.locator('body').innerText();
  for (const word of ['undefined', 'NaN', '[object Object]']) expect(text).not.toContain(word);
});
