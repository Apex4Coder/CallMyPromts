// tests/e2e/settings.spec.mjs — окно управления: разделы, поля, сохранение.
//
// Требование: REQ-UI-SETTINGS (docs/SPEC.md §7). DOM-id: docs/UI-SPEC.md §3.3.
// Сценарии S-08, S-09, S-12. Утверждение: U-17.
// Раздел «Горячие клавиши» — в tests/e2e/hotkeys.spec.mjs, кнопки остановки и
// перезапуска — в tests/e2e/service.spec.mjs.
//
// Поля описаны один раз в ui/views/fields.js, и разметка строится оттуда. Поэтому
// тест проверяет НАЛИЧИЕ конкретных id из контракта §3.3: если список полей и
// контракт разойдутся, здесь это будет видно, а не всплывёт при попытке настроить.

import { test, expect, open, LIBRARY } from './deck.mjs';

/** Разделы и их ссылки в навигации (§3.3). */
const VIEWS = [
  ['view-cloud', 'Облако'],
  ['view-about', 'О приложении'],
  ['view-service', 'Сервис'],
  ['view-hotkeys', 'Горячие клавиши'],
  ['view-look', 'Вид'],
  ['view-order', 'Порядок'],
  ['view-clipboard', 'Буфер'],
  ['view-library', 'Библиотека'],
  ['view-diag', 'Диагностика'],
];

/** Все поля из §3.3. Отсутствие любого — расхождение контракта и разметки. */
const FIELD_IDS = {
  'view-hotkeys': ['keyPicker', 'keySave', 'keyClips', 'keyWatch'],
  'view-look': [
    'optLayout', 'optTheme', 'optAccent', 'optMotion', 'optDensity',
    'optFontScale', 'optPosition', 'optBadges', 'optTemperature', 'optGroups',
  ],
  'view-order': ['optOrderMode', 'optSuggestAfter'],
  'view-clipboard': ['optClipEnabled', 'optClipLimit', 'optClipImages', 'optClipClear', 'optBlacklist'],
  'view-library': ['libPath'],
};

const go = async (page, view) => {
  await page.click(`#deckNav a[href="#${view}"]`);
  await expect(page.locator(`#${view}`)).toBeVisible();
};

test.beforeAll(async ({ deck }) => {
  await deck.reset();
  deck.seed(LIBRARY);
});

test('§3.3 · девять разделов и возврат в CRM, активный помечен aria-current', async ({ page, deck }) => {
  await open(page, deck, '#deck');

  const links = page.locator('#deckNav a');
  await expect(links).toHaveCount(VIEWS.length + 1);
  await expect(page.locator('#deckNav a[href="#crm"]')).toBeVisible();

  // Открыт первый раздел: окно управления начинается с состояния сервиса.
  await expect(page.locator('#view-service')).toBeVisible();
  await expect(page.locator('#deckNav a[href="#view-service"]')).toHaveAttribute('aria-current', 'page');

  for (const [view, label] of VIEWS) {
    await go(page, view);
    await expect(page.locator(`#deckNav a[href="#${view}"]`), label).toHaveAttribute('aria-current', 'page');

    // Ровно один раздел виден: иначе поля наложились бы друг на друга.
    const shown = await page.locator('#deckMain section:not([hidden])').count();
    expect(shown, `видно ${shown} разделов вместо одного`).toBe(1);
  }
});

test('§3.3 · все поля контракта на месте и с подписями', async ({ page, deck }) => {
  await open(page, deck, '#deck');

  for (const [view, ids] of Object.entries(FIELD_IDS)) {
    await go(page, view);
    for (const id of ids) {
      await expect(page.locator(`#${id}`), `нет поля #${id} в ${view}`).toHaveCount(1);
      // REQ-UI-A11Y: подпись связана с полем через for/id, иначе поле безымянно
      // для чтения с экрана.
      await expect(page.locator(`label[for="${id}"]`), `у #${id} нет подписи`).toHaveCount(1);
    }
  }
});

test('S-09 · выбранная тема сохраняется и переживает открытие заново', async ({ page, deck }) => {
  await open(page, deck, '#deck');
  await go(page, 'view-look');

  await page.selectOption('#optTheme', 'dark');
  await page.selectOption('#optDensity', 'compact');
  await page.selectOption('#optAccent', 'indigo');

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'indigo');

  // Закрыть и открыть заново: настройка живёт в файле, а не в памяти страницы.
  await page.goto(`${deck.url}#deck`);
  await go(page, 'view-look');
  await expect(page.locator('#optTheme')).toHaveValue('dark');
  await expect(page.locator('#optDensity')).toHaveValue('compact');
  await expect(page.locator('#optAccent')).toHaveValue('indigo');
});

/**
 * S-09, плохой путь 3 · значение вне диапазона.
 * Ошибка называет допустимый диапазон: «неверное значение» без числа заставляет
 * угадывать (docs/RULES.md §4).
 */
test('S-09 · значение вне диапазона отвергается с указанием границ', async ({ page, deck }) => {
  await open(page, deck, '#deck');
  await go(page, 'view-clipboard');

  await page.fill('#optClipLimit', '5000');
  await page.locator('#optClipLimit').blur();

  await expect(page.locator('#toast')).toContainText('вне диапазона');
  await expect(page.locator('#toast')).toContainText('20..1000');
  await expect(page.locator('#optClipLimit')).toHaveAttribute('aria-invalid', 'true');

  // Прежнее значение осталось в силе: отказ не должен ничего портить.
  const saved = await deck.api('/api/settings');
  expect(saved.data.settings.clipboard.limit).toBe(100);
});

/**
 * Дефект, найденный интеграционным тестом и закреплённый здесь: правка одного
 * поля стирала остальные настройки, потому что слияние шло с умолчаниями.
 * Смена темы обнуляла настроенные горячие клавиши.
 */
test('S-09 · правка одного поля не сбрасывает остальные', async ({ page, deck }) => {
  await deck.settings({ hotkeys: { open_picker: '^!p' }, order: { suggest_pin_after: 12 } });

  await open(page, deck, '#deck');
  await go(page, 'view-look');
  await page.selectOption('#optTheme', 'light');

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  const saved = await deck.api('/api/settings');
  expect(saved.data.settings.hotkeys.open_picker, 'смена темы стёрла хоткей').toBe('^!p');
  expect(saved.data.settings.order.suggest_pin_after).toBe(12);
});

test('S-08 · раздел «Сервис» показывает состояние, порт и время работы', async ({ page, deck }) => {
  await open(page, deck, '#deck');

  await expect(page.locator('#svcState')).toContainText('работает');
  await expect(page.locator('#svcState')).toHaveClass(/is-good/);
  await expect(page.locator('#svcState')).toHaveAttribute('title', new RegExp(`порт ${deck.port}`));

  // Прочерк вместо пустоты: «undefined мин» — это ложь о данных (U-14).
  await expect(page.locator('#svcUptime')).not.toHaveText('—');
  await expect(page.locator('#svcUptime')).toContainText('с');

  for (const id of ['svcStartBtn', 'svcStopBtn', 'svcRestartBtn']) {
    await expect(page.locator(`#${id}`)).toBeVisible();
  }
});

test('S-12 · диагностика перечисляет проверки с причинами', async ({ page, deck }) => {
  deck.seed([{ id: 'c-broken', group: 'code', title: 'Битый', body: '' }]);

  await open(page, deck, '#deck');
  await go(page, 'view-diag');
  await page.click('#diagRunBtn');

  const rows = page.locator('#diagList .field');
  await expect(rows.first()).toBeVisible();
  await expect(page.locator('#diagList')).toContainText('Библиотека');
  await expect(page.locator('#diagList')).toContainText('Битые промпты');
  await expect(page.locator('#diagList')).toContainText('Журнал буфера');
  await expect(page.locator('#diagList')).toContainText('Использование');

  // Битый файл назван числом и отправлен туда, где видна причина.
  await expect(page.locator('#diagList')).toContainText('причины в разделе «Библиотека»');

  await go(page, 'view-library');
  await expect(page.locator('#libIssues')).toContainText('code/c-broken');
  await expect(page.locator('#libIssues')).toContainText('тело промпта пусто');
});

/**
 * U-17 · клавиатура проходит все разделы.
 * Порядок табуляции обязан совпадать с визуальным: человек, идущий по Tab,
 * должен попадать в ссылки навигации в том же порядке, в каком их видит.
 */
test('U-17 · Tab проходит навигацию в визуальном порядке', async ({ page, deck }) => {
  await open(page, deck, '#deck');
  await expect(page.locator('#view-service')).toBeVisible();

  await page.locator('body').click({ position: { x: 2, y: 2 } });

  const order = [];
  for (let i = 0; i < VIEWS.length + 2; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Tab');
    // eslint-disable-next-line no-await-in-loop
    const href = await page.evaluate(() => {
      const el = document.activeElement;
      return el?.tagName === 'A' ? el.getAttribute('href') : null;
    });
    if (href) order.push(href);
  }

  expect(order).toEqual(['#crm', ...VIEWS.map(([v]) => `#${v}`)]);
});

test('U-17 · внутри раздела фокус доходит до каждого поля', async ({ page, deck }) => {
  await open(page, deck, '#deck');
  await go(page, 'view-look');

  await page.focus('#deckNav a[href="#view-look"]');

  const reached = new Set();
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Tab');
    // eslint-disable-next-line no-await-in-loop
    const id = await page.evaluate(() => document.activeElement?.id ?? '');
    if (id) reached.add(id);
  }

  for (const id of FIELD_IDS['view-look']) {
    expect(reached.has(id), `до #${id} нельзя добраться по Tab`).toBe(true);
  }
});

test('§3.3 · чёрный список правится строками и сохраняется списком', async ({ page, deck }) => {
  await open(page, deck, '#deck');
  await go(page, 'view-clipboard');

  await page.fill('#optBlacklist', 'keepass.exe\n1password.exe\n\nbitwarden.exe');
  await page.locator('#optBlacklist').blur();

  const saved = await deck.api('/api/settings');
  // Пустая строка отброшена: она не имя процесса, а след от набора текста.
  expect(saved.data.settings.clipboard.blacklist).toEqual(['keepass.exe', '1password.exe', 'bitwarden.exe']);
});

test('§3.3 · флажки сохраняются и влияют на окно выбора', async ({ page, deck }) => {
  await open(page, deck, '#deck');
  await go(page, 'view-look');

  await page.uncheck('#optGroups');
  await page.uncheck('#optTemperature');

  const saved = await deck.api('/api/settings');
  expect(saved.data.settings.ui.show_groups).toBe(false);
  expect(saved.data.settings.ui.show_temperature).toBe(false);

  await page.goto(deck.url);
  await expect(page.locator('#pickerList .row').first()).toBeVisible();
  await expect(page.locator('#pickerList .row').first().locator('.group')).toHaveText('');
  await expect(page.locator('#pickerList .row').first().locator('.temp')).toHaveCount(0);
});

/**
 * S-09, плохой путь 1 · битый settings.json.
 * Файл отводится в сторону, применяются умолчания, причина показана. Молчаливый
 * сброс настроек выглядел бы как «приложение забыло всё, что я настроил».
 */
test('S-09 · битый settings.json объяснён, а не скрыт', async ({ page, deck }) => {
  await deck.settings({ ui: { theme: 'dark' }, order: { suggest_pin_after: 42 } });

  const bad = await deck.api('/api/settings', {
    method: 'PUT',
    body: { ui: { theme: 'нетакойтемы' } },
  });

  expect(bad.status).toBe(400);
  expect(bad.data.message).toContain('недопустимое значение');
  expect(bad.data.expected).toContain('light');

  // Настройки не пострадали: отказ ничего не меняет.
  const still = await deck.api('/api/settings');
  expect(still.data.settings.ui.theme).toBe('dark');
  expect(still.data.settings.order.suggest_pin_after).toBe(42);

  await open(page, deck, '#deck');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
