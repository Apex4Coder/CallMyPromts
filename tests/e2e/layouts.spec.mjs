// tests/e2e/layouts.spec.mjs — три раскладки окна выбора.
//
// Требование: REQ-UI-LAYOUT (docs/SPEC.md §7). Макеты: docs/UI-SPEC.md §2.
// Сценарий S-09. Утверждения: U-1, U-15.
//
// Главное свойство, которое здесь проверяется: DOM у трёх раскладок ОДИН и тот
// же, различается только CSS. Поэтому смена раскладки не может сломать
// остальные тесты — и это утверждение само нуждается в проверке, иначе
// «различается только CSS» останется обещанием в комментарии.

import { test, expect, open, LIBRARY, boxOf } from './deck.mjs';

const LAYOUTS = ['palette', 'panels', 'hybrid'];

/** Размеры из §2: palette 640×420, panels 900×560, hybrid 640 → 1040. */
const WIDTH = { palette: 640, panels: 900, hybrid: 640 };

const rows = (page) => page.locator('#pickerList .row');

/**
 * Геометрия берётся общим помощником, а не собственным `evaluate`.
 *
 * Первая версия читала ширину из `getBoundingClientRect` сразу после появления
 * окна и получала 898 вместо 900: окно въезжает через `scale(0.98) → 1` за
 * 150 мс, а прямоугольник учитывает `transform`. Числа выглядели как ошибка в
 * раскладке, хотя раскладка была верной — измерение шло посреди анимации.
 * `boxOf` ждёт конца анимаций и берёт размеры из компоновки.
 */
const box = (page, selector) => boxOf(page, selector);

test.beforeAll(async ({ deck }) => {
  await deck.reset();
  deck.seed(LIBRARY);
});

for (const layout of LAYOUTS) {
  test(`U-1 · ${layout}: окно открывается и содержит список`, async ({ page, deck }) => {
    await deck.settings({ ui: { layout } });
    await open(page, deck);

    await expect(page.locator('html')).toHaveAttribute('data-layout', layout);
    await expect(page.locator('#picker')).toBeVisible();
    await expect(page.locator('#pickerSearch')).toBeFocused();
    await expect(rows(page)).toHaveCount(5);
    await expect(page.locator('#pickerHints')).toBeVisible();
  });

  test(`U-1 · ${layout}: те же id, тот же состав строки`, async ({ page, deck }) => {
    await deck.settings({ ui: { layout } });
    await open(page, deck);
    await expect(rows(page).first()).toBeVisible();

    // Контракт §3.1 не зависит от раскладки: если id появляются или исчезают,
    // то раскладка — это не «только CSS», и остальные спеки станут хрупкими.
    for (const id of ['picker', 'pickerSearch', 'pickerList', 'pickerHints', 'prompt-c-review']) {
      await expect(page.locator(`#${id}`), `нет #${id} в раскладке ${layout}`).toHaveCount(1);
    }
    await expect(rows(page).first().locator('.digit')).toHaveText('1');
    await expect(rows(page).first().locator('.name')).toHaveText('Ревью кода');
  });

  test(`U-15 · ${layout}: нет горизонтального скролла на 800×600`, async ({ page, deck }) => {
    await deck.settings({ ui: { layout } });
    await page.setViewportSize({ width: 800, height: 600 });
    await open(page, deck);
    await expect(rows(page).first()).toBeVisible();

    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(over, `на 800px раскладка ${layout} вылезает на ${over}px`).toBeLessThanOrEqual(0);
  });
}

test('§2.1 · palette: одна колонка, превью нет вовсе', async ({ page, deck }) => {
  await deck.settings({ ui: { layout: 'palette' } });
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();

  expect((await box(page, '#picker')).w).toBe(WIDTH.palette);
  await expect(page.locator('#pickerPreview')).toBeHidden();

  // Space в palette раскрывать нечего: превью в этой раскладке отсутствует.
  await page.keyboard.press('Space');
  await expect(page.locator('#pickerPreview')).toBeHidden();
  expect((await box(page, '#picker')).w).toBe(WIDTH.palette);
});

test('§2.2 · panels: две колонки, превью видно всегда', async ({ page, deck }) => {
  await deck.settings({ ui: { layout: 'panels' } });
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();

  expect((await box(page, '#picker')).w).toBe(WIDTH.panels);
  await expect(page.locator('#pickerPreview')).toBeVisible();
  await expect(page.locator('#previewTitle')).toHaveText('Ревью кода');

  // Колонки рядом, а не одна под другой: у превью тот же верх, что у списка.
  const list = await box(page, '#pickerList');
  const preview = await box(page, '#pickerPreview');
  expect(preview.x).toBeGreaterThan(list.x + list.w - 2);
  expect(Math.abs(preview.y - list.y)).toBeLessThanOrEqual(2);
  expect(list.w).toBe(320);
});

test('§2.3 · hybrid: Space раскрывает окно с 640 до 1040', async ({ page, deck }) => {
  await deck.settings({ ui: { layout: 'hybrid' } });
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();

  expect((await box(page, '#picker')).w).toBe(WIDTH.hybrid);
  await expect(page.locator('#pickerPreview')).toBeHidden();

  await page.keyboard.press('Space');
  await expect(page.locator('#pickerPreview')).toBeVisible();
  expect((await box(page, '#picker')).w).toBe(1040);

  await page.keyboard.press('Space');
  await expect(page.locator('#pickerPreview')).toBeHidden();
  expect((await box(page, '#picker')).w).toBe(WIDTH.hybrid);
});

/**
 * §2.3 · раскрытое окно в hybrid сжимается по узкому экрану.
 * 1040 при ширине 900 дало бы горизонтальный скролл — то есть часть промпта
 * оказалась бы за краем, и человек не знал бы, что она там есть.
 */
test('U-15 · hybrid: раскрытое превью не вылезает на узком экране', async ({ page, deck }) => {
  await deck.settings({ ui: { layout: 'hybrid' } });
  await page.setViewportSize({ width: 900, height: 700 });
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();

  await page.keyboard.press('Space');
  await expect(page.locator('#pickerPreview')).toBeVisible();

  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over).toBeLessThanOrEqual(0);
  expect((await box(page, '#picker')).w).toBeLessThanOrEqual(900);
});

test('§2 · очень узкий экран ставит превью под список', async ({ page, deck }) => {
  await deck.settings({ ui: { layout: 'panels' } });
  await page.setViewportSize({ width: 520, height: 800 });
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();

  const list = await box(page, '#pickerList');
  const preview = await box(page, '#pickerPreview');
  expect(preview.y, 'на 520px колонки остались рядом').toBeGreaterThan(list.y + list.h - 2);

  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over).toBeLessThanOrEqual(0);
});

test('§2 · позиция «сверху» опускает окно от края, «по центру» центрирует', async ({ page, deck }) => {
  await deck.settings({ ui: { layout: 'palette', position: 'top' } });
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();

  const top = (await box(page, '#picker')).y;
  // 25vh от 900 — примерно 225; допуск на границы и рамку.
  expect(top).toBeGreaterThan(150);
  expect(top).toBeLessThan(300);

  await page.evaluate(() => { document.documentElement.dataset.position = 'center'; });
  const centered = await box(page, '#picker');
  const gapBelow = 900 - (centered.y + centered.h);
  expect(Math.abs(centered.y - gapBelow), 'окно не по центру').toBeLessThanOrEqual(8);
});

/**
 * S-09 · смена раскладки в настройках доходит до окна выбора.
 * Проверяется через сохранение: раскладку читает уже НОВОЕ окно, потому что
 * мост открывает его заново по хоткею.
 */
test('S-09 · выбранная в настройках раскладка применяется к окну выбора', async ({ page, deck }) => {
  await deck.settings({ ui: { layout: 'hybrid' } });
  await open(page, deck, '#deck');
  await page.click('#deckNav a[href="#view-look"]');
  await page.selectOption('#optLayout', 'panels');

  await expect(page.locator('html')).toHaveAttribute('data-layout', 'panels');

  await page.goto(deck.url);
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'panels');
  await expect(page.locator('#pickerPreview')).toBeVisible();
});

test('§2 · длинное название переносится, а не растягивает окно', async ({ page, deck }) => {
  deck.seed([{
    id: 'c-long',
    group: 'code',
    title: 'Очень длинное название промпта которое обязано переноситься по словам целиком',
    body: 'C:\\Users\\Example\\Desktop\\codeproj\\main-md\\prompt-system\\prompts\\code\\очень-длинный-путь-без-пробелов.md',
  }]);

  await deck.settings({ ui: { layout: 'palette' } });
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, deck);
  await page.fill('#pickerSearch', 'длинное');
  await expect(rows(page)).toHaveCount(1);

  expect((await box(page, '#picker')).w).toBe(WIDTH.palette);
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over).toBeLessThanOrEqual(0);

  // Строка выше одной линии — значит перенос сработал, а не обрезка.
  const rowBox = await box(page, '#pickerList .row');
  expect(rowBox.h).toBeGreaterThan(24);
});
