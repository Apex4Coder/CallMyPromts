// tests/e2e/keys.spec.mjs — модель клавиатуры окна выбора.
//
// Требование: REQ-UI-KEYS (docs/SPEC.md §7). Контракт: docs/UI-SPEC.md §4.
// Сценарии: S-01, S-02. Утверждения: U-5, U-6, U-7.
//
// Каждое нажатие проверяется по последствию, а не по внутреннему состоянию:
// «1» доказана тем, что мост получил текст первого закреплённого, а не тем, что
// в объекте выставился индекс. Разбор самих нажатий отдельно проверяет
// ui/views/keys.js через unit-тесты — здесь важна связка с DOM и сетью.

import {
  test, expect, open, LIBRARY,
  fakeBridge, readClipboard, seedClipboard,
} from './deck.mjs';

/** Приметная строка в буфере: если она осталась, буфер никто не тронул. */
const MARK = 'МЕТКА-БУФЕРА-1234';

const rows = (page) => page.locator('#pickerList .row');
const row = (page, id) => page.locator(`#prompt-${id}`);

test.beforeAll(async ({ deck }) => {
  await deck.reset();
  deck.seed(LIBRARY);
});

/**
 * U-5 · цифра выбирает закреплённого и сразу вставляет.
 * Два действия одним нажатием — это решение из ClipClip: закрепление существует
 * ради скорости, и подтверждение выбора вторым нажатием её бы съело.
 */
test('U-5 · «1» вставляет первый закреплённый без Enter', async ({ page, deck }) => {
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();

  const taken = fakeBridge(deck);
  await page.keyboard.press('1');

  expect(await taken).toContain('Тело промпта c-review');
  await expect(page.locator('#toast')).toContainText('Команда вставки выполнена');
});

test('U-5 · «2» вставляет второй закреплённый, а не второй в списке', async ({ page, deck }) => {
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();

  const taken = fakeBridge(deck);
  await page.keyboard.press('2');

  expect(await taken).toContain('Тело промпта c-bug');
});

/**
 * Свободная позиция — это факт, а не ошибка (S-06). Поэтому уровень `none`,
 * а не `bad`, и никакой вставки.
 */
test('§4 · цифра свободной позиции говорит «свободна» и не вставляет', async ({ page, deck }) => {
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();
  await seedClipboard(page, MARK);

  const taken = fakeBridge(deck, { forMs: 900 });
  await page.keyboard.press('7');

  await expect(page.locator('#toast')).toContainText('Позиция 7 свободна');
  await expect(page.locator('#toast .state')).toHaveClass(/is-none/);
  expect(await taken, 'заявка на вставку не должна была уйти').toBeNull();
  expect(await readClipboard(page)).toBe(MARK);
});

/**
 * S-02, плохой путь 6 · цифра при непустом поиске — это символ.
 * Неоднозначность решена в пользу ввода: человек, набирающий запрос, печатает.
 */
test('S-02 · «1» при непустом поиске попадает в поиск, а не выбирает', async ({ page, deck }) => {
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();

  await page.click('#pickerSearch');
  await page.keyboard.type('код');
  await expect(rows(page).first()).toBeVisible();

  const taken = fakeBridge(deck, { forMs: 900 });
  await page.keyboard.press('1');

  await expect(page.locator('#pickerSearch')).toHaveValue('код1');
  expect(await taken, 'цифра при непустом поиске не должна вставлять').toBeNull();
});

test('§4 · ↑↓ двигают выбор и не выходят за границы списка', async ({ page, deck }) => {
  await open(page, deck);
  await expect(rows(page)).toHaveCount(5);

  await expect(rows(page).nth(0)).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('ArrowDown');
  await expect(rows(page).nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(rows(page).nth(0)).toHaveAttribute('aria-selected', 'false');

  // Вверх с первой позиции — остаёмся на первой, а не прыгаем в конец:
  // список короткий, и «перескок» читается как сбой.
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(rows(page).nth(0)).toHaveAttribute('aria-selected', 'true');

  for (let i = 0; i < 8; i += 1) await page.keyboard.press('ArrowDown');
  await expect(rows(page).nth(4)).toHaveAttribute('aria-selected', 'true');
});

test('§6 · активная строка объявлена через aria-activedescendant', async ({ page, deck }) => {
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();

  await expect(page.locator('#pickerList')).toHaveAttribute('aria-activedescendant', 'prompt-c-review');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#pickerList')).toHaveAttribute('aria-activedescendant', 'prompt-c-bug');
});

test('§4 · Enter вставляет именно выбранную строку', async ({ page, deck }) => {
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(rows(page).nth(2)).toHaveAttribute('aria-selected', 'true');

  const taken = fakeBridge(deck);
  await page.keyboard.press('Enter');
  expect(await taken).toContain('Тело промпта c-tests');
});

/**
 * §4 · Ctrl+Enter — вставка без хвостовых пустых строк.
 *
 * Наблюдение, которое стоит записать: тело приходит уже обрезанным, потому что
 * library/clean.mjs снимает края при чтении файла. То есть Ctrl+Enter здесь не
 * преобразование, а ГАРАНТИЯ в точке вставки: даже если однажды тело придёт с
 * хвостом, в чат он не уедет. Проверяется именно это свойство результата.
 *
 * Ожидание — по ЧИСЛУ строк, а не по видимости нужной. Видимость здесь ничего не
 * доказывает: искомый промпт есть и в полном списке, поэтому проверка проходила
 * ещё до того, как отработал фильтр, и Ctrl+Enter вставлял первую строку полного
 * списка. `toHaveCount(1)` доказывает, что ответ на запрос уже применён.
 */
test('§4 · Ctrl+Enter вставляет текст без хвостовых пустых строк', async ({ page, deck }) => {
  deck.seed([{ id: 'c-tail', group: 'code', title: 'С хвостом', body: 'Первая строка.\n\n\n' }]);

  await open(page, deck);
  await page.fill('#pickerSearch', 'хвостом');
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, 'c-tail')).toHaveAttribute('aria-selected', 'true');

  const taken = fakeBridge(deck);
  await page.keyboard.press('Control+Enter');

  const text = await taken;
  expect(text).toContain('Первая строка.');
  expect(text, 'в чат уехали хвостовые переводы строк').toBe(text.trimEnd());
});

/**
 * U-7 · Tab копирует, но не вставляет.
 * Это единственный путь, где страница пишет в буфер сама: человек попросил
 * копию, и терять прежнее содержимое здесь допустимо — он сам его заменяет.
 */
test('U-7 · Tab кладёт в буфер и не отправляет заявку мосту', async ({ page, deck }) => {
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();
  await seedClipboard(page, MARK);

  const taken = fakeBridge(deck, { forMs: 900 });
  await page.keyboard.press('Tab');

  await expect(page.locator('#toast')).toContainText('Скопировано в буфер');
  expect(await taken, 'Tab не должен просить мост о вставке').toBeNull();
  expect(await readClipboard(page)).toContain('Тело промпта c-review');
});

/**
 * REQ-UI-A11Y · Shift+Tab оставлен браузеру.
 * Перехват обратной табуляции ломает единственный способ уйти с поля без мыши,
 * поэтому клавиша сознательно не обрабатывается.
 *
 * Буфер проверяется со второй страницы: Shift+Tab с первого поля уводит фокус
 * ЗА пределы документа, в интерфейс браузера, и `readText` в неактивном
 * документе запрещён. Сам этот отказ — доказательство, что клавиша сработала
 * как переход фокуса, а не как действие интерфейса.
 */
test('§4 · Shift+Tab не копирует и не вставляет — это переход фокуса', async ({ page, deck, context }) => {
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();
  await seedClipboard(page, MARK);
  await expect(page.locator('#pickerSearch')).toBeFocused();

  const taken = fakeBridge(deck, { forMs: 900 });
  await page.keyboard.press('Shift+Tab');

  expect(await taken).toBeNull();
  await expect(page.locator('#toast')).toBeHidden();
  await expect(page.locator('#pickerSearch')).not.toBeFocused();

  const other = await context.newPage();
  await open(other, deck);
  expect(await readClipboard(other)).toBe(MARK);
  await other.close();
});

test('§4 · Space раскрывает и скрывает превью в hybrid', async ({ page, deck }) => {
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();

  await expect(page.locator('#picker')).toHaveAttribute('data-expanded', 'false');
  await expect(page.locator('#pickerPreview')).toBeHidden();

  await page.keyboard.press('Space');
  await expect(page.locator('#picker')).toHaveAttribute('data-expanded', 'true');
  await expect(page.locator('#pickerPreview')).toBeVisible();
  await expect(page.locator('#previewTitle')).toHaveText('Ревью кода');
  await expect(page.locator('#previewBody')).toContainText('Тело промпта c-review');

  await page.keyboard.press('Space');
  await expect(page.locator('#picker')).toHaveAttribute('data-expanded', 'false');
  await expect(page.locator('#pickerPreview')).toBeHidden();
});

test('§4 · Space при непустом поиске — пробел в запросе', async ({ page, deck }) => {
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();

  await page.click('#pickerSearch');
  await page.keyboard.type('ревью');
  await page.keyboard.press('Space');

  await expect(page.locator('#pickerSearch')).toHaveValue('ревью ');
  await expect(page.locator('#picker')).toHaveAttribute('data-expanded', 'false');
});

test('§4 · F2 уводит на правку выбранного промпта', async ({ page, deck }) => {
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();

  await page.keyboard.press('F2');
  await expect(page).toHaveURL(/#edit-c-review$/);
});

/**
 * U-6 · Esc закрывает без действия.
 *
 * Буфер читается со ВТОРОЙ страницы того же браузера: `close()` в интерфейсе
 * вызывает `window.close()`, и первая страница к моменту проверки может быть уже
 * закрыта. Буфер обмена в браузере общий, поэтому вторая страница видит то же
 * содержимое — а проверяемое утверждение как раз про буфер, не про окно.
 */
test('U-6 · Esc не вставляет и не меняет буфер', async ({ page, deck, context }) => {
  await open(page, deck);
  await expect(rows(page).first()).toBeVisible();
  await seedClipboard(page, MARK);

  const taken = fakeBridge(deck, { forMs: 900 });
  await page.keyboard.press('Escape');

  // Класс ставится в том же обработчике, что и нажатие: анимация уходящего окна
  // (docs/UI-SPEC.md §1.5) — единственный видимый след Esc.
  await expect(page.locator('#picker')).toHaveClass(/is-leaving/);
  expect(await taken, 'Esc отправил заявку на вставку').toBeNull();

  const other = await context.newPage();
  await open(other, deck);
  expect(await readClipboard(other)).toBe(MARK);
  await other.close();
});
