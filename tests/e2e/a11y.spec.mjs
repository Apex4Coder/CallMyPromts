// tests/e2e/a11y.spec.mjs — доступность: подписи, роли, фокус, клавиатура.
//
// Требование: REQ-UI-A11Y (docs/SPEC.md §7). Правила: docs/UI-SPEC.md §6.
// Утверждение: U-17.
// Узкий экран (U-15) и токен в странице (U-18) — в tests/e2e/viewport.spec.mjs.
//
// Здесь проверяется то, что нельзя увидеть глазами на своей машине: работает ли
// экран без мыши, есть ли у полей подписи, виден ли фокус. Каждый из этих пунктов
// ломает работу целиком для того, кто пользуется клавиатурой или чтением с экрана,
// и не ломает ничего для остальных — поэтому его невозможно заметить без проверки.

import { test, expect, open, LIBRARY, watchConsole } from './deck.mjs';
import { addClips } from './clipfix.mjs';

/** Сколько пикселей вылезает за правый край. Ноль — норма (U-15). */
const overflow = (page) => page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);

/** Куда сейчас смотрит фокус: тег, id и видимая обводка. */
const focused = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const st = getComputedStyle(el);
  return {
    tag: el.tagName,
    id: el.id,
    role: el.getAttribute('role'),
    outlineWidth: Number.parseFloat(st.outlineWidth) || 0,
    outlineStyle: st.outlineStyle,
  };
});

test.beforeAll(async ({ deck }) => {
  await deck.reset();
  deck.seed(LIBRARY);
});

/**
 * §6 · у каждого поля есть подпись.
 *
 * Проверяются все поля всех разделов сразу, а не выборочно: подпись забывают
 * ровно у того поля, которое добавили последним. Годится и `<label for>`, и
 * `aria-label`, и `aria-labelledby` — важно, что имя есть.
 */
test('§6 · каждое поле ввода имеет подпись', async ({ page, deck }) => {
  await open(page, deck, '#deck');
  await expect(page.locator('#view-service')).toBeVisible();

  const naked = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('#deck input, #deck select, #deck textarea')) {
      const byFor = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
      const wrapped = el.closest('label');
      const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
      if (!byFor && !wrapped && !aria) out.push(el.id || el.name || el.tagName);
    }
    return out;
  });

  expect(naked, 'поля без подписи').toEqual([]);
});

test('§6 · поля поиска на обоих экранах подписаны', async ({ page, deck }) => {
  await open(page, deck);
  await expect(page.locator('label[for="pickerSearch"]')).toHaveText('Поиск промпта');

  // Подпись скрыта от глаз, но не от чтения с экрана: она остаётся в дереве.
  const box = await page.locator('label[for="pickerSearch"]').boundingBox();
  expect(box.width, 'подпись занимает место на экране').toBeLessThan(3);

  await open(page, deck, '#clips');
  await expect(page.locator('label[for="clipsSearch"]')).toHaveText('Поиск в журнале');
});

/**
 * §6 · роли списков.
 * `listbox` + `option` + `aria-selected` — это то, что позволяет чтению с экрана
 * сказать «третий из семи, выбран». Без ролей это просто набор строк.
 */
test('§6 · список промптов — listbox с option и aria-selected', async ({ page, deck }) => {
  await open(page, deck);
  const list = page.locator('#pickerList');

  await expect(list).toHaveAttribute('role', 'listbox');
  await expect(list).toHaveAttribute('aria-label', 'Промпты');

  const rows = page.locator('#pickerList .row');
  await expect(rows.first()).toHaveAttribute('role', 'option');

  // Выбранная строка названа в aria-activedescendant: фокус остаётся в поиске,
  // поэтому иначе чтение с экрана не узнало бы, что именно выбрано.
  await expect(list).toHaveAttribute('aria-activedescendant', 'prompt-c-review');
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('ArrowDown');
  await expect(list).toHaveAttribute('aria-activedescendant', 'prompt-c-bug');
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(rows.first()).toHaveAttribute('aria-selected', 'false');
});

test('§6 · журнал буфера тоже listbox с option', async ({ page, deck }) => {
  await addClips(deck, [{ text: 'Запись для проверки роли' }]);
  await open(page, deck, '#clips');

  const list = page.locator('#clipsList');
  await expect(list).toHaveAttribute('role', 'listbox');
  await expect(page.locator('#clipsList .clip').first()).toHaveAttribute('role', 'option');
});

test('§3.2 · контекстное меню объявлено меню, пункты — menuitem', async ({ page, deck }) => {
  await addClips(deck, [{ text: 'Запись для меню' }]);
  await open(page, deck, '#clips');

  await page.locator('#clipsList .clip').first().click({ button: 'right' });
  await expect(page.locator('#clipMenu')).toBeVisible();
  await expect(page.locator('#clipMenu')).toHaveAttribute('role', 'menu');

  for (const id of ['clipCopyBtn', 'clipPromoteBtn', 'clipDeleteBtn']) {
    await expect(page.locator(`#${id}`)).toHaveAttribute('role', 'menuitem');
  }
});

/**
 * §6 · фокус видим.
 * `outline: none` в проекте запрещён. Проверяется не наличие правила в CSS, а
 * результат: у элемента с фокусом есть обводка ненулевой толщины.
 */
test('§6 · фокус виден обводкой, а не только курсором', async ({ page, deck }) => {
  await open(page, deck, '#deck');
  await expect(page.locator('#view-service')).toBeVisible();

  await page.keyboard.press('Tab');
  const first = await focused(page);

  expect(first, 'Tab ни на что не встал').not.toBeNull();
  expect(first.outlineStyle, `обводки нет: ${JSON.stringify(first)}`).not.toBe('none');
  expect(first.outlineWidth).toBeGreaterThanOrEqual(2);
});

test('§6 · кнопки сервиса достижимы с клавиатуры и нажимаются Enter', async ({ page, deck }) => {
  const errors = watchConsole(page);
  await open(page, deck, '#deck');

  await page.focus('#svcRestartBtn');
  const now = await focused(page);
  expect(now.id).toBe('svcRestartBtn');
  expect(now.outlineWidth).toBeGreaterThanOrEqual(2);

  // Нажатие клавиатурой обязано делать то же, что клик: отдельного пути нет.
  await page.keyboard.press('Enter');
  await expect(page.locator('#toast')).toBeVisible();

  expect(errors).toEqual([]);
});

/**
 * U-17 · экран выбора работает без мыши целиком.
 *
 * Путь: набрать запрос, перейти по списку стрелками, увидеть выбранное. Ни одно
 * действие не требует указателя, и фокус ни на шаге не уходит из поля поиска —
 * человек продолжает печатать без лишних Tab.
 */
test('U-17 · выбор промпта проходится одной клавиатурой', async ({ page, deck }) => {
  await deck.reset();
  deck.seed(LIBRARY);

  await open(page, deck);
  await expect(page.locator('#pickerSearch')).toBeFocused();

  // «ко» находит «Ревью кода» и «Глубокое исследование» — два промпта нужны,
  // чтобы проверить именно движение стрелками, а не просто наличие выбора.
  await page.keyboard.type('ко');
  await expect(page.locator('#pickerList .row')).toHaveCount(2);

  // Превью следует за выбором: отдельного действия «посмотреть» не требуется.
  await expect(page.locator('#previewTitle')).toHaveText('Ревью кода');

  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#previewTitle')).toHaveText('Глубокое исследование');
  await expect(page.locator('#pickerSearch')).toBeFocused();
});

/**
 * §4 · пробел при непустом поиске — это символ, а не команда.
 *
 * Проверка родилась из провала предыдущего теста: он ждал, что `Space` раскроет
 * превью после набора запроса. Код вёл себя верно, недоговаривала таблица клавиш
 * — и это единственно возможное поведение: запрос «ревью кода» состоит из двух
 * слов, и перехват пробела оставил бы поиск односложным.
 */
test('§4 · пробел набирается в поиске, а раскрывает превью только при пустом поле', async ({ page, deck }) => {
  await deck.reset();
  deck.seed(LIBRARY);

  await open(page, deck);
  await expect(page.locator('#pickerList .row').first()).toBeVisible();

  // Пустой поиск: пробел — команда, в поле ничего не появилось.
  await page.keyboard.press('Space');
  await expect(page.locator('#pickerPreview')).toBeVisible();
  await expect(page.locator('#pickerSearch')).toHaveValue('');

  // Непустой поиск: пробел — символ, и запрос из двух слов набирается целиком.
  await page.keyboard.type('ревью кода');
  await expect(page.locator('#pickerSearch')).toHaveValue('ревью кода');
  await expect(page.locator('#pickerList .row')).toHaveCount(1);
  await expect(page.locator('#prompt-c-review')).toBeVisible();
});

/**
 * §6 · заголовок страницы и язык.
 * Мелочь, которая видна только чтению с экрана: без `lang` синтезатор читает
 * русский текст английскими правилами.
 */
test('§6 · язык страницы объявлен русским', async ({ page, deck }) => {
  await open(page, deck);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page).toHaveTitle(`CallMyPromts · Закреплённые [${deck.port}]`);
});

test('§6 · разделы окна управления связаны с заголовками', async ({ page, deck }) => {
  await open(page, deck, '#deck');

  const unlinked = await page.evaluate(() => {
    const out = [];
    for (const s of document.querySelectorAll('#deckMain section')) {
      const by = s.getAttribute('aria-labelledby');
      if (!by || !document.getElementById(by)) out.push(s.id);
    }
    return out;
  });

  expect(unlinked, 'разделы без заголовка').toEqual([]);
});

/** Уведомление обязано быть областью живого сообщения: иначе его не прочитают. */
test('§6 · уведомление объявлено как status с aria-live', async ({ page, deck }) => {
  await open(page, deck);
  const toast = page.locator('#toast');

  await expect(toast).toHaveAttribute('role', 'status');
  await expect(toast).toHaveAttribute('aria-live', 'polite');
});
