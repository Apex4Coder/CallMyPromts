// tests/e2e/geo-matrix.spec.mjs — геометрия по всей матрице прогонов.
//
// Требование: REQ-UI-GEOMETRY (docs/SPEC.md §7). Методичка: gld/ui-contract.txt §1.4–1.6.
// Харнесс: tests/e2e/geometry.mjs. Матрица: tests/e2e/matrix.mjs.
//
// Это инвентаризация в терминах методички: базовый набор инвариантов гоняется по
// 18 ячейкам (3 ширины × 3 объёма × 2 темы) на трёх экранах. Задача не «починить», а
// ИЗМЕРИТЬ — и получить список нарушений с точным местом.
//
// Почему полный перебор, а не выборка. Уже есть свидетельство: вложенный `.field`
// давал скролл ровно на 800×600 и не давал на 1280. Выборка «проверим на типичном
// размере» пропустила бы его — что и произошло, пока проверка не появилась.
//
// Стоимость прогона осознанная: 18 ячеек × 3 экрана. Данные на 200 промптов создаются
// файлами, и это самая долгая часть; поэтому объём 200 гоняется не во всех
// комбинациях, а на каждой ширине по одному разу — см. `heavyCells`.

import { test } from './deck.mjs';
import { checkAll, noOverflow, noPageScroll, emptyKeepsLayout } from './geometry.mjs';
import { WIDTHS, VOLUMES, THEMES, setupCell } from './matrix.mjs';

/**
 * Ячейки полного перебора: объёмы 0 и 20 во всех комбинациях.
 * 3 ширины × 2 объёма × 2 темы = 12 ячеек.
 */
const lightCells = [];
for (const size of WIDTHS) {
  for (const vol of VOLUMES.filter((v) => v.count <= 20)) {
    for (const theme of THEMES) {
      lightCells.push({ size, vol, theme, name: `${size.name} · ${vol.name} · ${theme}` });
    }
  }
}

/**
 * Тяжёлые ячейки: 200 промптов на каждой ширине, тема одна.
 * Тема на объём не влияет — она меняет цвета, а не размеры. Гонять 200 промптов
 * дважды ради этого значило бы удвоить самую долгую часть прогона без новой правды.
 */
const heavyCells = WIDTHS.map((size) => ({
  size,
  vol: VOLUMES.find((v) => v.count === 200),
  theme: 'light',
  name: `${size.name} · 200 промптов · light`,
}));

// ── окно выбора: базовый набор по всем ячейкам ───────────────────────────────

for (const cell of lightCells) {
  test(`геометрия · окно выбора · ${cell.name}`, async ({ page, deck }) => {
    await setupCell(page, deck, cell);
    await page.goto(deck.url);

    // Ждём отрисовки: измерять боксы до появления списка бессмысленно.
    if (cell.vol.count > 0) {
      await page.locator('#pickerList .row').first().waitFor();
    } else {
      await page.locator('#pickerEmpty').waitFor();
    }

    await checkAll(page, `окно выбора ${cell.name}`);
  });
}

for (const cell of heavyCells) {
  test(`геометрия · окно выбора · ${cell.name}`, async ({ page, deck }) => {
    await setupCell(page, deck, cell);
    await page.goto(deck.url);
    await page.locator('#pickerList .row').first().waitFor();

    await checkAll(page, `окно выбора ${cell.name}`);
  });
}

// ── окно управления: все семь разделов ───────────────────────────────────────

const VIEWS = ['view-service', 'view-hotkeys', 'view-look', 'view-order',
  'view-clipboard', 'view-library', 'view-diag'];

for (const cell of lightCells) {
  test(`геометрия · окно управления · ${cell.name}`, async ({ page, deck }) => {
    await setupCell(page, deck, cell);
    await page.goto(`${deck.url}#deck`);
    await page.locator('#view-service').waitFor();

    for (const view of VIEWS) {
      // eslint-disable-next-line no-await-in-loop
      await page.click(`#deckNav a[href="#${view}"]`);
      // eslint-disable-next-line no-await-in-loop
      await page.locator(`#${view}`).waitFor();
      // eslint-disable-next-line no-await-in-loop
      await noOverflow(page, `${view} ${cell.name}`);
      // eslint-disable-next-line no-await-in-loop
      await noPageScroll(page, `${view} ${cell.name}`);
    }
  });
}

// ── журнал буфера ────────────────────────────────────────────────────────────

for (const cell of lightCells) {
  test(`геометрия · журнал буфера · ${cell.name}`, async ({ page, deck }) => {
    await setupCell(page, deck, cell, { withClips: true });
    await page.goto(`${deck.url}#clips`);

    if (cell.vol.count > 0) {
      await page.locator('#clipsList .clip').first().waitFor();
    } else {
      await page.locator('#clipsEmpty').waitFor();
    }

    await checkAll(page, `журнал ${cell.name}`);
  });
}

// ── пустое состояние не схлопывает вёрстку ───────────────────────────────────

for (const size of WIDTHS) {
  test(`геометрия · пустота держит высоту · ${size.name}`, async ({ page, deck }) => {
    // Ноль строк — законное состояние (первый запуск), а не отсутствие экрана.
    // Нулевая высота означает, что человек видит пустоту без объяснения.
    await setupCell(page, deck, { size, vol: { count: 0, name: 'пусто' }, theme: 'light' });

    await page.goto(deck.url);
    await page.locator('#pickerEmpty').waitFor();
    await emptyKeepsLayout(page, '#pickerEmpty', `окно выбора ${size.name}`);

    await page.goto(`${deck.url}#clips`);
    await page.locator('#clipsEmpty').waitFor();
    await emptyKeepsLayout(page, '#clipsEmpty', `журнал ${size.name}`);
  });
}
