// tests/e2e/clipmenu.spec.mjs — контекстное меню журнала: ровно три пункта.
//
// Требование: REQ-UI-CLIPS (docs/SPEC.md §7). DOM-id: docs/UI-SPEC.md §3.2.
// Сценарии S-04 (шаг 4), S-05. Утверждения: U-11, U-12.
//
// Выделено из tests/e2e/clips.spec.mjs по лимиту чанка (docs/RULES.md §3).
// Фикстуры общие — tests/e2e/clipfix.mjs.
//
// Владелец сформулировал границу прямо: «правой клавишей мыши сохранить,
// копировать, а больше тут копировать и сохранить ничего не надо». Поэтому число
// пунктов проверяется буквально: четвёртый — изменение контракта, а не улучшение.

import { test, expect, open, readClipboard, seedClipboard } from './deck.mjs';
import { CLIPS, clipRows, addClips, openClipMenu } from './clipfix.mjs';

/**
 * Журнал наполняется заново перед КАЖДЫМ тестом, а не один раз на файл.
 *
 * Сервер один на весь файл, поэтому состояние переживает границу теста. Тесты,
 * которым нужен свой набор записей, вызывают `reset()` сами — и следующий тест
 * получал их данные вместо своих: проверка «Копировать кладёт последнюю запись»
 * падала с «Запись номер 14» из соседнего теста. Порядок тестов не должен влиять
 * на их смысл, поэтому предпосылка объявляется явно.
 */
test.beforeEach(async ({ deck }) => {
  await deck.reset();
  await addClips(deck);
});

test('U-11 · меню — ровно три пункта в заданном порядке', async ({ page, deck }) => {
  await open(page, deck, '#clips');
  await expect(clipRows(page).first()).toBeVisible();
  await openClipMenu(page);

  const items = page.locator('#clipMenu > button[role="menuitem"]');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveAttribute('id', 'clipCopyBtn');
  await expect(items.nth(1)).toHaveAttribute('id', 'clipPromoteBtn');
  await expect(items.nth(2)).toHaveAttribute('id', 'clipDeleteBtn');

  await expect(items.nth(0)).toHaveText('Копировать');
  await expect(items.nth(1)).toContainText('Сохранить как промпт');
  await expect(items.nth(2)).toHaveText('Удалить');
});

test('§6 · меню объявлено как меню и получает фокус', async ({ page, deck }) => {
  await open(page, deck, '#clips');
  await expect(clipRows(page).first()).toBeVisible();
  await openClipMenu(page);

  await expect(page.locator('#clipMenu')).toHaveAttribute('role', 'menu');
  await expect(page.locator('#clipMenu')).toHaveAttribute('aria-label', 'Действия с записью');
  // Фокус на первом пункте: иначе меню, открытое с клавиатуры, недостижимо.
  await expect(page.locator('#clipCopyBtn')).toBeFocused();
});

test('§3.2 · меню закрывается по Esc и по клику вне', async ({ page, deck }) => {
  await open(page, deck, '#clips');
  await expect(clipRows(page).first()).toBeVisible();

  await openClipMenu(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#clipMenu')).toBeHidden();

  await openClipMenu(page);
  await page.locator('#clipsHead').click();
  await expect(page.locator('#clipMenu')).toBeHidden();
});

/**
 * §3.2 · меню не уезжает за край окна.
 *
 * Щёлкать надо ИМЕННО по записи: обработчик ищет `.clip` от точки нажатия и по
 * пустому месту списка меню не открывает — это верно, вызывать действия не над
 * чем. Первая версия теста била в пустую часть списка на y=300 и падала на
 * «меню скрыто», хотя интерфейс вёл себя правильно.
 *
 * Окно берётся маленьким, а список — длинным и прокрученным вниз: только тогда
 * запись оказывается у правого нижнего угла, и ограничение действительно
 * срабатывает. На большом экране проверка проходила бы, ничего не проверяя.
 */
test('§3.2 · меню не уезжает за край окна', async ({ page, deck }) => {
  await deck.reset();
  await addClips(deck, Array.from({ length: 14 }, (_, i) => ({ text: `Строка списка ${i + 1}` })));

  await page.setViewportSize({ width: 420, height: 320 });
  await open(page, deck, '#clips');
  await expect(clipRows(page)).toHaveCount(14);

  await page.locator('#clipsList').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const row = await clipRows(page).last().boundingBox();

  const size = page.viewportSize();
  await page.mouse.click(size.width - 4, row.y + 4, { button: 'right' });
  await expect(page.locator('#clipMenu')).toBeVisible();

  const box = await page.locator('#clipMenu').boundingBox();
  expect(box.x, 'меню начинается за левым краем').toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `меню шириной ${box.width} вылезло справа`).toBeLessThanOrEqual(size.width);
  expect(box.y + box.height, `меню высотой ${box.height} вылезло снизу`).toBeLessThanOrEqual(size.height);
});

test('S-04 шаг 4 · «Копировать» кладёт полный текст в буфер', async ({ page, deck }) => {
  await open(page, deck, '#clips');
  await expect(clipRows(page).first()).toBeVisible();
  await seedClipboard(page, 'старое-содержимое');

  await openClipMenu(page);
  await page.click('#clipCopyBtn');

  await expect(page.locator('#toast')).toContainText('Скопировано');
  await expect(page.locator('#clipMenu')).toBeHidden();
  expect(await readClipboard(page)).toBe('Последняя запись, она обязана быть сверху.');
});

/**
 * U-12 · подменю групп.
 * Группы приходят из API, а не перечислены в интерфейсе: список папок — это
 * состояние диска, и второе его описание рассинхронизировалось бы (RULES §1).
 */
test('U-12 · «Сохранить как промпт» показывает группы из API и «+ Новая группа»', async ({ page, deck }) => {
  deck.seed([
    { id: 'c-one', group: 'code', title: 'Один' },
    { id: 'r-two', group: 'research', title: 'Два' },
  ]);

  await open(page, deck, '#clips');
  await expect(clipRows(page).first()).toBeVisible();
  await openClipMenu(page);

  await expect(page.locator('#clipGroupList')).toBeHidden();
  await page.click('#clipPromoteBtn');

  await expect(page.locator('#clipPromoteBtn')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#clipGroupList')).toBeVisible();

  const groups = page.locator('#clipGroupList button');
  await expect(groups).toHaveCount(3);
  await expect(groups.nth(0)).toHaveAttribute('data-group', 'code');
  await expect(groups.nth(0)).toContainText('Код (1)');
  await expect(groups.nth(1)).toHaveAttribute('data-group', 'research');
  await expect(groups.nth(2)).toHaveText('+ Новая группа');

  // Повторное нажатие свёртывает: подменю — переключатель, а не одноразовое.
  await page.click('#clipPromoteBtn');
  await expect(page.locator('#clipGroupList')).toBeHidden();
});

/**
 * S-05, плохой путь 1 · групп нет вовсе.
 * Подменю не может быть пустым: без «+ Новая группа» сохранять было бы некуда,
 * и человек оказался бы в тупике на первом же запуске.
 */
test('S-05 · без групп подменю показывает только «+ Новая группа»', async ({ page, deck }) => {
  await open(page, deck, '#clips');
  await expect(clipRows(page).first()).toBeVisible();
  await openClipMenu(page);
  await page.click('#clipPromoteBtn');

  const groups = page.locator('#clipGroupList button');
  await expect(groups).toHaveCount(1);
  await expect(groups.nth(0)).toHaveText('+ Новая группа');
});

/**
 * S-05 · превращение записи в промпт.
 * Окно ввода имени — это второй шаг подтверждения (docs/RULES.md §5), поэтому
 * диалог принимается как есть, а не подменяется: без него проверялся бы другой
 * сценарий.
 */
test('S-05 · запись сохраняется как промпт и помечается в журнале', async ({ page, deck }) => {
  deck.seed([{ id: 'c-one', group: 'code', title: 'Один' }]);

  await open(page, deck, '#clips');
  await expect(clipRows(page).first()).toBeVisible();

  page.on('dialog', (d) => d.accept('Заметка об архитектуре'));

  await openClipMenu(page);
  await page.click('#clipPromoteBtn');
  await page.locator('#clipGroupList button[data-group="code"]').click();

  await expect(page.locator('#toast')).toContainText('Сохранён как');
  await expect(page.locator('#toast')).toContainText('в «code»');

  // Промпт появился в библиотеке без перезапуска.
  const lib = await deck.api('/api/prompts?q=архитектуре');
  expect(lib.data.items.length).toBe(1);
  expect(lib.data.items[0].title).toBe('Заметка об архитектуре');

  // Запись в журнале осталась и помечена: журнал — это лог, из него не удаляют.
  await expect(clipRows(page).first().locator('.state.is-good')).toContainText('сохранён');
});

/**
 * S-05, плохой путь 2 · та же запись сохраняется второй раз.
 * Предупреждение показывается ДО создания файла и не запрещает копию: человек
 * может осознанно хотеть второй вариант того же текста.
 */
test('S-05 · повторное сохранение предупреждает, но не запрещает', async ({ page, deck }) => {
  await deck.reset();
  await addClips(deck, [{ text: 'Текст, который сохранят дважды.' }]);

  await open(page, deck, '#clips');
  await expect(clipRows(page).first()).toBeVisible();

  const asked = [];
  page.on('dialog', (d) => {
    asked.push(d.message());
    d.accept('Первое имя');
  });

  await openClipMenu(page);
  await page.click('#clipPromoteBtn');
  await page.locator('#clipGroupList button[data-group="__new__"]').click();

  await expect(page.locator('#toast')).toContainText('Сохранён как');
  const created = await deck.api('/api/prompts?q=Первое');
  expect(created.data.items.length).toBe(1);

  // Второй раз: в вопросе об имени видно предупреждение о повторе.
  await openClipMenu(page);
  await page.click('#clipPromoteBtn');
  await page.locator('#clipGroupList button').first().click();

  await expect(page.locator('#toast')).toBeVisible();
  expect(asked.at(-1), `диалоги: ${JSON.stringify(asked)}`).toMatch(/уже сохранена|Название/);
});

test('§3.2 · «Удалить» убирает запись и уменьшает счётчик', async ({ page, deck }) => {
  await open(page, deck, '#clips');
  await expect(clipRows(page)).toHaveCount(5);
  await expect(page.locator('#clipsCount')).toHaveText('5/100');

  await openClipMenu(page);
  await page.click('#clipDeleteBtn');

  await expect(page.locator('#toast')).toContainText('Удалено');
  await expect(clipRows(page)).toHaveCount(4);
  await expect(page.locator('#clipsCount')).toHaveText('4/100');
});

test('§3.2 · меню работает над той записью, по которой щёлкнули', async ({ page, deck }) => {
  await open(page, deck, '#clips');
  await expect(clipRows(page)).toHaveCount(5);
  await seedClipboard(page, 'до-копирования');

  // Щёлкаем по последней, а не по первой: подмена записи была бы незаметна,
  // если бы меню всегда работало с верхней строкой.
  await openClipMenu(page, 4);
  await page.click('#clipCopyBtn');

  await expect(page.locator('#toast')).toContainText('Скопировано');
  expect(await readClipboard(page)).toBe('Первая скопированная строка про архитектуру.');
});
