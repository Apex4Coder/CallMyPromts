// tests/e2e/picker.spec.mjs — окно выбора: скорость, поиск, битые промпты, вставка.
//
// Требования: REQ-UI-SPEED, REQ-UI-EMPTY, REQ-API-PASTE (docs/SPEC.md §6, §7).
// Сценарии: S-01, S-02. Утверждения: U-4, U-8, U-9, U-10, U-19.
//
// Проверяется РЕЗУЛЬТАТ, а не намерение. Разница здесь принципиальна: прежняя
// версия интерфейса рисовала «Вставлено» всегда, потому что судила по факту
// отправки события, а не по подтверждению моста. Поэтому «вставлено» считается
// доказанным только когда текст забрал мост, и это проверяется отдельно от того,
// что показано на экране.

import {
  test, expect, open, LIBRARY,
  measureReady, readyMs, fakeBridge, readClipboard, watchConsole,
} from './deck.mjs';

/** Битый промпт и промпт с приметой в теле — для U-9, U-10 и поиска по телу. */
const EXTRA = [
  { id: 'c-empty', group: 'code', title: 'Пустой промпт', body: '' },
  { id: 'c-mark', group: 'code', title: 'Заметка о сборке', body: 'Особое слово: кувырок.' },
];

const rows = (page) => page.locator('#pickerList .row');
const row = (page, id) => page.locator(`#prompt-${id}`);

test.beforeAll(async ({ deck }) => {
  await deck.reset();
  deck.seed([...LIBRARY, ...EXTRA]);
});

/**
 * U-4 · окно готово ≤ 200 мс.
 *
 * Замер делается на ВТОРОЙ навигации. Требование говорит о нажатии хоткея при
 * работающем сервисе, а первая навигация в свежем браузере включает создание
 * контекста и компиляцию модулей — это цена запуска браузера, а не цена окна.
 */
test('U-4 · список виден за 200 мс на работающем сервисе', async ({ page, deck }) => {
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();

  await measureReady(page);
  await page.reload();
  await expect(rows(page).first()).toBeVisible();

  const ms = await readyMs(page);
  expect(ms, 'первая строка списка так и не появилась').not.toBeNull();
  expect(Math.round(ms)).toBeLessThanOrEqual(200);
});

test('S-01 шаг 2 · фокус в поиске, список и подсказки клавиш сразу', async ({ page, deck }) => {
  const errors = watchConsole(page);
  await open(page, deck);

  await expect(rows(page)).toHaveCount(7);
  await expect(page.locator('#pickerSearch')).toBeFocused();
  await expect(page.locator('#pickerEmpty')).toBeHidden();

  // Подсказка клавиш — часть контракта §3.1: без неё модель ввода не видна.
  await expect(page.locator('#pickerHints')).toContainText('1–9 закреплённые');
  await expect(page.locator('#headState')).toContainText('работает');

  expect(errors, 'интерфейс ругается в консоль').toEqual([]);
});

test('§3.1 · закреплённые сверху, отделены разделителем', async ({ page, deck }) => {
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();

  const first = rows(page).nth(0);
  const second = rows(page).nth(1);
  await expect(first).toHaveAttribute('data-id', 'c-review');
  await expect(first.locator('.digit')).toHaveText('1');
  await expect(second).toHaveAttribute('data-id', 'c-bug');
  await expect(second.locator('.digit')).toHaveText('2');

  await expect(page.locator('#pickerSplit')).toHaveCount(1);
  await expect(first).toHaveAttribute('aria-selected', 'true');
});

test('U-8 · поиск находит по названию', async ({ page, deck }) => {
  await open(page, deck);
  await page.fill('#pickerSearch', 'ревью');

  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, 'c-review')).toBeVisible();
  // Совпадение подсвечено частями, а не перекраской всей строки (S-02, шаг 2).
  await expect(row(page, 'c-review').locator('.hit')).toHaveText('Ревью');
});

test('U-8 · поиск находит по группе', async ({ page, deck }) => {
  await open(page, deck);
  await page.fill('#pickerSearch', 'research');

  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, 'r-deep')).toBeVisible();
});

test('U-8 · поиск находит по телу промпта', async ({ page, deck }) => {
  await open(page, deck);
  await page.fill('#pickerSearch', 'кувырок');

  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, 'c-mark')).toBeVisible();
});

/**
 * S-02, плохой путь 1 · забыта раскладка.
 * «htdm» на русской раскладке даёт «ревь» — по физическим клавишам, а не по
 * похожести букв. Это самый частый случай на машине владельца.
 */
test('S-02 · «htdm» находит «Ревью кода»', async ({ page, deck }) => {
  await open(page, deck);
  await page.fill('#pickerSearch', 'htdm');

  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, 'c-review')).toBeVisible();
});

test('S-02 · нет совпадений — причина с запросом, окно живо', async ({ page, deck }) => {
  await open(page, deck);
  await page.fill('#pickerSearch', 'zzzq');

  await expect(page.locator('#pickerEmpty')).toBeVisible();
  await expect(page.locator('#pickerEmptyText')).toContainText('«zzzq»');
  await expect(page.locator('#pickerEmptyText')).toContainText('Проверены обе раскладки');
  await expect(page.locator('#pickerList')).toBeHidden();
  // Окно осталось: пустая выдача — это состояние, а не закрытие (REQ-UI-EMPTY).
  await expect(page.locator('#picker')).toBeVisible();
  await expect(page.locator('#pickerSearch')).toHaveValue('zzzq');
});

/**
 * U-9 · битый промпт помечен и не вставляется.
 * Первый клик выбирает строку, второй вставляет — так же, как для рабочей.
 * Проверяется именно второй клик: пометка без запрета вставки бесполезна.
 */
test('U-9 · битый промпт помечен ✕ и не вставляется', async ({ page, deck }) => {
  await open(page, deck);
  const broken = row(page, 'c-empty');

  await expect(broken).toHaveClass(/is-broken/);
  await expect(broken.locator('.state.is-bad .glyph')).toHaveText('✕');
  await expect(broken.locator('.state.is-bad .word')).toHaveText('сломано');

  await broken.click();
  await expect(broken).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#previewMeta')).toContainText('тело промпта пусто');

  await page.keyboard.press('Enter');
  await expect(page.locator('#toast')).toContainText('Не вставлено');
  await expect(page.locator('#toast')).toContainText('тело промпта пусто');
  await expect(page.locator('#toast .state')).toHaveClass(/is-bad/);
});

test('U-10 · один битый не мешает остальным шести', async ({ page, deck }) => {
  await open(page, deck);

  await expect(rows(page)).toHaveCount(7);
  await expect(page.locator('#pickerList .row.is-broken')).toHaveCount(1);

  // Битый уходит в конец списка: он виден и объяснён, но не мешает выбирать.
  await expect(rows(page).last()).toHaveAttribute('data-id', 'c-empty');
  await expect(rows(page).first()).not.toHaveClass(/is-broken/);
});

/**
 * S-01 шаг 3 · текст доходит до моста.
 *
 * Мост подменён: настоящий bridge/deck.ahk опрашивает `GET /api/paste` каждые
 * 250 мс и нажимает Ctrl+V. Нажатие в чужое окно из теста не проверить, но
 * ГЛАВНОЕ звено — что текст вообще попадает мосту в руки — проверяется точно.
 * Именно это звено и отсутствовало в первой версии.
 */
test('S-01 шаг 3 · мост забирает текст, интерфейс говорит «Вставлено»', async ({ page, deck }) => {
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();

  const taken = fakeBridge(deck);
  await page.keyboard.press('Enter');

  expect(await taken, 'мост не получил заявку на вставку').toContain('Тело промпта c-review');
  await expect(page.locator('#toast')).toContainText('Команда вставки выполнена');
  await expect(page.locator('#toast .state')).toHaveClass(/is-good/);
});

/**
 * S-01, плохой путь 5 · моста нет.
 * Обязательное поведение: текст остаётся в буфере, человеку сказано вставить
 * вручную. Тихое «Вставлено» здесь было бы ложью о результате (RULES §4).
 */
test('S-01 плохой путь 5 · без моста текст в буфере и об этом сказано', async ({ page, deck }) => {
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();

  await page.keyboard.press('Enter');

  // Сервер ждёт мост 700 мс, поэтому предупреждение приходит с задержкой.
  await expect(page.locator('#toast')).toContainText('вставьте вручную', { timeout: 4000 });
  await expect(page.locator('#toast .state')).toHaveClass(/is-warn/);
  expect(await readClipboard(page)).toContain('Тело промпта c-review');
});

/**
 * U-19 · счётчик растёт только на состоявшейся вставке.
 * Второй половиной проверки идёт обратное утверждение: вставка без моста
 * счётчик НЕ увеличивает, иначе температура и порядок строились бы на лжи.
 */
test('U-19 · счётчик растёт на вставке и не растёт без моста', async ({ page, deck }) => {
  const usedOf = async (id) => {
    const out = await deck.api('/api/prompts?q=');
    return out.data.items.find((i) => i.id === id).usage.used;
  };

  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();
  await row(page, 'c-tests').click();
  await expect(row(page, 'c-tests')).toHaveAttribute('aria-selected', 'true');

  const before = await usedOf('c-tests');

  const taken = fakeBridge(deck);
  await page.keyboard.press('Enter');
  expect(await taken).toContain('Тело промпта c-tests');
  await expect(page.locator('#toast')).toContainText('Команда вставки выполнена');

  expect(await usedOf('c-tests')).toBe(before + 1);

  // Защитное окно счётчика — 2000 мс (rank/usage.mjs), поэтому ждём его,
  // иначе повтор не был бы посчитан и по причине дребезга, а не из-за моста.
  await page.waitForTimeout(2100);
  await page.keyboard.press('Enter');
  await expect(page.locator('#toast')).toContainText('вставьте вручную', { timeout: 4000 });
  expect(await usedOf('c-tests')).toBe(before + 1);
});
