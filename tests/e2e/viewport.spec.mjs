// tests/e2e/viewport.spec.mjs — узкий экран и токен в странице.
//
// Требование: REQ-UI-A11Y (docs/SPEC.md §7). Правила: docs/UI-SPEC.md §6.
// Утверждения: U-15, U-18.
// Подписи, роли и фокус — в tests/e2e/a11y.spec.mjs.
//
// Выделено из a11y.spec.mjs, когда тот вышел за 300 строк. Разделение по смыслу:
// там — «поймёт ли экран человек, не видящий его», здесь — «влезает ли он в
// маленькое окно» и «дошёл ли до страницы токен».
//
// U-18 живёт в E2E, а не в интеграционных тестах, по конкретной причине: там
// заголовок передаётся вручную, и первый прогон показал, что в браузере токен до
// страницы не доходил вовсе (CSP запрещала встроенный скрипт). Проверка «страница
// получила токен и умеет им пользоваться» возможна только в браузере.

import { test, expect, open, LIBRARY } from './deck.mjs';

/** Сколько пикселей вылезает за правый край. Ноль — норма (U-15). */
const overflow = (page) => page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);

test.beforeAll(async ({ deck }) => {
  await deck.reset();
  deck.seed(LIBRARY);
});

/**
 * U-15 · нет горизонтального скролла.
 * Горизонтальный скролл на окне выбора означает, что часть строки не видна, а
 * добраться до неё мышью в всплывающем окне почти невозможно. Самый частый
 * источник — длинный путь без пробелов, поэтому он в фикстуре.
 */
test('U-15 · окно выбора на 800×600 не даёт горизонтального скролла', async ({ page, deck }) => {
  await deck.reset();
  deck.seed([
    ...LIBRARY,
    {
      id: 'c-long',
      group: 'code',
      title: 'Путь без пробелов в теле',
      body: 'C:\\Users\\Example\\Desktop\\codeproj\\main-md\\prompt-system\\prompts\\code\\очень-длинное-имя-файла.md',
    },
  ]);

  await page.setViewportSize({ width: 800, height: 600 });
  await open(page, deck);
  await expect(page.locator('#pickerList .row').first()).toBeVisible();

  expect(await overflow(page)).toBe(0);

  // И в раскрытом превью, где длинный путь показан целиком.
  await page.locator('#prompt-c-long').click();
  await page.keyboard.press('Space');
  await expect(page.locator('#pickerPreview')).toBeVisible();
  expect(await overflow(page), 'превью с длинным путём растянуло страницу').toBe(0);
});

/**
 * U-15 · окно управления целиком.
 *
 * Проверка нашла настоящий дефект: раздел «Горячие клавиши» был на 6 пикселей
 * шире экрана, потому что ui/views/diag.js рисует свои `.field` ВНУТРИ внешнего
 * `.field`, и две колонки подписей по 220px требовали 586px там, где раздел
 * получал 580. Исправлено в ui/styles/panels.css. Отсюда перебор всех семи
 * разделов, а не одного: дефект был ровно в том, куда бы никто не посмотрел.
 */
test('U-15 · окно управления на 800×600: разделы без горизонтального скролла', async ({ page, deck }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await open(page, deck, '#deck');

  const views = ['view-service', 'view-hotkeys', 'view-look', 'view-order',
    'view-clipboard', 'view-library', 'view-diag'];

  for (const view of views) {
    // eslint-disable-next-line no-await-in-loop
    await page.click(`#deckNav a[href="#${view}"]`);
    // eslint-disable-next-line no-await-in-loop
    await expect(page.locator(`#${view}`)).toBeVisible();
    // eslint-disable-next-line no-await-in-loop
    expect(await overflow(page), `раздел ${view} шире экрана`).toBe(0);
  }
});

test('U-15 · журнал буфера на 800×600 не растягивается длинной записью', async ({ page, deck }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await deck.api('/api/clips', {
    method: 'POST',
    body: { text: `Ключ=${'x'.repeat(400)}`, kind: 'text' },
  });

  await open(page, deck, '#clips');
  await expect(page.locator('#clipsList .clip').first()).toBeVisible();

  expect(await overflow(page), 'запись без пробелов растянула журнал').toBe(0);
});

/**
 * U-18 · API закрыт токеном, и страница им пользуется.
 *
 * Две половины одного факта. Первая: запрос без заголовка получает 401 — иначе
 * любая открытая вкладка читала бы журнал буфера с паролями. Вторая: сама
 * страница токен получила и работает — 401 «для всех» бесполезен, если он
 * достаётся и своему интерфейсу. Именно вторая половина и была сломана.
 */
test('U-18 · запрос из страницы без токена получает 401', async ({ page, deck }) => {
  await open(page, deck);

  const bare = await page.evaluate(async () => {
    const res = await fetch('/api/prompts');
    const data = await res.json();
    return { status: res.status, error: data.error, message: data.message };
  });

  expect(bare.status).toBe(401);
  expect(bare.error).toBe('no_token');
  expect(bare.message).toContain('x-deck-token');
});

test('U-18 · токен дошёл до страницы через meta, и список загрузился', async ({ page, deck }) => {
  await open(page, deck);
  await expect(page.locator('#pickerList .row').first()).toBeVisible();

  const meta = await page.locator('meta[name="deck-token"]').getAttribute('content');
  expect(meta, 'метка не заменена настоящим токеном').not.toBe('__DECK_TOKEN__');
  expect(meta).toMatch(/^[0-9a-f]{32}$/);

  // Тот же токен работает: список на экране — это доказательство, но проверим и прямо.
  const withToken = await page.evaluate(async (t) => {
    const res = await fetch('/api/prompts', { headers: { 'X-Deck-Token': t } });
    return res.status;
  }, meta);
  expect(withToken).toBe(200);
});

/**
 * §6 · политика безопасности осталась строгой.
 * Токен переехал в `<meta>` именно чтобы не ослаблять CSP. Проверка закрепляет
 * это: `unsafe-inline` не должен вернуться «чтобы заработало».
 */
test('§6 · CSP запрещает встроенные скрипты и стили', async ({ page, deck }) => {
  const res = await page.goto(deck.url);
  const csp = res.headers()['content-security-policy'] ?? '';

  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("style-src 'self'");
  expect(csp, 'CSP ослаблена').not.toContain('unsafe-inline');

  // И в разметке нет ни встроенного скрипта, ни встроенного стиля.
  const inline = await page.evaluate(() => ({
    scripts: [...document.querySelectorAll('script')].filter((s) => !s.src).length,
    styles: document.querySelectorAll('style').length,
  }));
  expect(inline.scripts, 'встроенный <script> не выполнится и молча сломает страницу').toBe(0);
  expect(inline.styles, 'встроенный <style> не применится').toBe(0);
});
