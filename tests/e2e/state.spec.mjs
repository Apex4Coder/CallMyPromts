// tests/e2e/state.spec.mjs — четыре состояния и честные числа.
//
// Требование: REQ-UI-STATE (docs/SPEC.md §7). Правила: docs/RULES.md §4, §5.
// Сценарий S-12. Утверждения: U-3, U-14.
//
// Проверяется главное правило проекта: интерфейс не имеет права врать о
// состоянии. Отсюда два жёстких требования. Первое — плашка несёт значок И слово,
// потому что цвет не читается при дальтонизме, на плохом мониторе и через
// удалённое подключение. Второе — на экране не бывает `undefined`, `NaN` и
// «0 промптов» без объяснения: вместо них прочерк и причина.

import { test, expect, open, LIBRARY } from './deck.mjs';

/** Слова, которых на экране быть не может ни при каком состоянии данных. */
const FORBIDDEN_WORDS = ['undefined', 'NaN', 'null', 'Infinity', '[object Object]'];

/** Текст всей страницы: ищем ложь целиком, а не по одному элементу. */
const pageText = (page) => page.evaluate(() => document.body.innerText);

/** Плашки состояния: у каждой обязаны быть и значок, и слово (U-3). */
const chipsOf = (page) => page.evaluate(() => [...document.querySelectorAll('.state')].map((el) => ({
  cls: el.className,
  glyph: el.querySelector('.glyph')?.textContent ?? '',
  word: el.querySelector('.word')?.textContent ?? '',
  text: el.innerText.trim(),
})));

test.beforeAll(async ({ deck }) => {
  await deck.reset();
});

test('U-3 · каждая плашка окна выбора несёт значок и слово', async ({ page, deck }) => {
  deck.seed([
    ...LIBRARY,
    { id: 'c-empty', group: 'code', title: 'Пустое тело', body: '' },
    { id: 'c-html', group: 'code', title: 'Разметка внутри', body: '<p>Текст в теге</p>' },
  ]);

  await open(page, deck);
  await expect(page.locator('#pickerList .row').first()).toBeVisible();

  const chips = await chipsOf(page);
  expect(chips.length, 'на экране нет ни одной плашки состояния').toBeGreaterThan(0);

  for (const c of chips) {
    expect(c.glyph, `плашка «${c.text}» без значка (${c.cls})`).not.toBe('');
    expect(c.word, `плашка «${c.text}» без слова (${c.cls})`).not.toBe('');
    expect(['✓', '!', '✕', '–'], `неизвестный значок «${c.glyph}»`).toContain(c.glyph);
  }
});

test('U-3 · все четыре уровня различимы значком, а не только классом', async ({ page, deck }) => {
  await open(page, deck);

  const seen = await page.evaluate(() => {
    const out = {};
    for (const level of ['good', 'warn', 'bad', 'none']) {
      const chip = document.createElement('span');
      chip.className = `state is-${level}`;
      const glyph = document.createElement('span');
      glyph.className = 'glyph';
      glyph.textContent = { good: '✓', warn: '!', bad: '✕', none: '–' }[level];
      chip.append(glyph);
      document.body.append(chip);
      out[level] = { glyph: glyph.textContent, color: getComputedStyle(chip).color };
      chip.remove();
    }
    return out;
  });

  const glyphs = Object.values(seen).map((s) => s.glyph);
  expect(new Set(glyphs).size, 'значки повторяются — уровни неразличимы без цвета').toBe(4);

  const colors = Object.values(seen).map((s) => s.color);
  expect(new Set(colors).size, 'цвета уровней совпадают').toBe(4);
});

/**
 * REQ-UI-STATE · битый промпт помечен `✕` и объяснён.
 * Пометка без причины бесполезна: человек видит, что нельзя, и не знает почему.
 */
test('REQ-UI-STATE · битый промпт: значок ✕, слово «сломано», причина в превью', async ({ page, deck }) => {
  await deck.reset();
  deck.seed([
    { id: 'c-good', group: 'code', title: 'Рабочий' },
    { id: 'c-empty', group: 'code', title: 'Пустое тело', body: '' },
  ]);

  await open(page, deck);
  const broken = page.locator('#prompt-c-empty');
  await expect(broken).toBeVisible();

  const chip = broken.locator('.state.is-bad');
  await expect(chip.locator('.glyph')).toHaveText('✕');
  await expect(chip.locator('.word')).toHaveText('сломано');
  await expect(chip).toHaveAttribute('title', /тело промпта пусто/);

  await broken.click();
  await expect(page.locator('#previewMeta')).toContainText('тело промпта пусто');
});

/**
 * REQ-UI-STATE · предупреждение не запрещает вставку.
 *
 * Этот тест нашёл дефект в контрактах. Очистка тела идёт ДО валидации
 * (DATA-CONTRACTS §1.4), поэтому валидатор видел текст уже без тегов, и правило
 * V-P-10 на пути чтения не срабатывало никогда: промпт с HTML в файле выглядел
 * как `good`. Человек не узнавал, что его файл чинится при каждом открытии.
 * Исправлено передачей `cleanBody().changed` в валидатор.
 */
test('REQ-UI-STATE · промпт с предупреждением помечен «!», но вставляется', async ({ page, deck }) => {
  await deck.reset();
  deck.seed([{ id: 'c-html', group: 'code', title: 'Разметка', body: '<p>Текст в теге</p>' }]);

  await open(page, deck);
  const row = page.locator('#prompt-c-html');
  await expect(row).toBeVisible();

  // Предупреждение — это не запрет: строка не зачёркнута и не отключена.
  await expect(row).not.toHaveClass(/is-broken/);
  const chip = row.locator('.state.is-warn');
  await expect(chip.locator('.glyph')).toHaveText('!');
  await expect(chip.locator('.word')).toHaveText('внимание');
  await expect(chip).toHaveAttribute('title', /в файле остался HTML/);

  // Главное: промпт остаётся пригодным к вставке, и превью показывает ЧИСТЫЙ текст —
  // в чат уходит то, что человек видит, а не разметка из файла.
  await row.click();
  await expect(page.locator('#previewBody')).toHaveText('Текст в теге');
});

/**
 * U-14 · пустая библиотека.
 * «0 промптов» без объяснения — то же, что молчание (docs/UI-SPEC.md §5).
 * Поэтому проверяется наличие причины И следующего действия.
 */
test('U-14 · пустая библиотека: причина, следующее действие, ноль лжи', async ({ page, deck }) => {
  await deck.reset();

  await open(page, deck);

  await expect(page.locator('#pickerEmpty')).toBeVisible();
  await expect(page.locator('#pickerEmptyText')).toContainText('Промптов нет');
  await expect(page.locator('#pickerEmptyText')).toContainText('Ctrl+Shift+S');
  await expect(page.locator('#pickerList')).toBeHidden();

  const text = await pageText(page);
  for (const word of FORBIDDEN_WORDS) {
    expect(text.includes(word), `на экране «${word}»`).toBe(false);
  }
});

test('U-14 · пустая библиотека в окне управления: прочерки, а не нули', async ({ page, deck }) => {
  await deck.reset();

  await open(page, deck, '#deck');
  await expect(page.locator('#svcState')).toContainText('работает');

  await page.click('#deckNav a[href="#view-library"]');
  await expect(page.locator('#libCount')).toContainText('0');
  await expect(page.locator('#libIssues')).toContainText('все промпты в норме');

  await page.click('#deckNav a[href="#view-diag"]');
  await page.click('#diagRunBtn');
  await expect(page.locator('#diagList')).toContainText('промптов нет');
  await expect(page.locator('#diagList')).toContainText('запустите миграцию');

  const text = await pageText(page);
  for (const word of FORBIDDEN_WORDS) {
    expect(text.includes(word), `на экране «${word}»`).toBe(false);
  }
});

/**
 * U-14 · битые числа в файле не превращаются в NaN на экране.
 * Один испорченный `used` не имеет права сломать сводку: «NaN из 26» выглядит как
 * поломка всей библиотеки (REQ-LIB-ISOLATE).
 */
test('U-14 · испорченный счётчик не даёт NaN в сводке', async ({ page, deck }) => {
  await deck.reset();
  deck.seed([
    { id: 'c-one', group: 'code', title: 'Первый', used: 5 },
    { id: 'c-bad-num', group: 'code', title: 'Со странным счётчиком', used: 'много' },
  ]);

  await open(page, deck, '#deck');
  await page.click('#deckNav a[href="#view-diag"]');
  await page.click('#diagRunBtn');

  await expect(page.locator('#diagList')).toContainText('Использование');
  const text = await pageText(page);
  expect(text.includes('NaN'), 'сводка показала NaN').toBe(false);
  expect(text.includes('undefined')).toBe(false);

  // Файл при этом назван в проблемах: подмена значения объяснена, а не скрыта.
  await page.click('#deckNav a[href="#view-library"]');
  await expect(page.locator('#libIssues')).toContainText('c-bad-num');
});

/**
 * S-12 · сервис остановлен.
 * Самый частый случай, и он не должен выглядеть как «пусто». Состояние `none` с
 * причиной вместо пустого списка.
 */
test('S-12 · при недоступном API окно говорит «сервис остановлен» с причиной', async ({ page, deck }) => {
  deck.seed(LIBRARY);

  // Запросы к API обрываются: так выглядит остановленный сервис для страницы,
  // которая уже открыта. Статику не трогаем — иначе не загрузился бы сам экран.
  await page.route('**/api/**', (route) => route.abort('failed'));
  await open(page, deck);

  await expect(page.locator('#headState')).toContainText('сервис остановлен');
  await expect(page.locator('#headState')).toHaveClass(/is-none/);
  await expect(page.locator('#headState .glyph')).toHaveText('–');

  await expect(page.locator('#pickerEmpty')).toBeVisible();
  await expect(page.locator('#pickerEmptyText')).toContainText('нет связи с сервисом');
  await expect(page.locator('#pickerList')).toBeHidden();

  await page.unroute('**/api/**');
});

test('S-12 · остановленный сервис в окне управления объяснён и предлагает запуск', async ({ page, deck }) => {
  await page.route('**/api/**', (route) => route.abort('failed'));
  await open(page, deck, '#deck');

  await expect(page.locator('#svcState')).toContainText('сервис остановлен');
  await expect(page.locator('#svcState')).toHaveClass(/is-none/);
  await expect(page.locator('#svcUptime')).toHaveText('—');
  await expect(page.locator('#svcStartBtn')).toBeVisible();

  await page.click('#deckNav a[href="#view-hotkeys"]');
  await expect(page.locator('#keyConflicts')).toContainText('мост не отчитался');

  const text = await pageText(page);
  for (const word of FORBIDDEN_WORDS) {
    expect(text.includes(word), `на экране «${word}»`).toBe(false);
  }

  await page.unroute('**/api/**');
});

test('REQ-UI-STATE · температура показана полосками и словом, не только цветом', async ({ page, deck }) => {
  await deck.reset();
  deck.seed(LIBRARY);

  await open(page, deck);
  await expect(page.locator('#pickerList .row').first()).toBeVisible();

  const temps = await page.evaluate(() => [...document.querySelectorAll('#pickerList .temp')].map((el) => ({
    level: el.dataset.level,
    bars: el.querySelector('.bars')?.textContent ?? '',
    word: el.lastElementChild?.textContent ?? '',
  })));

  expect(temps.length).toBe(5);
  for (const t of temps) {
    expect(t.bars, `уровень ${t.level} без полосок`).toMatch(/[▰▱]{3}/);
    expect(t.word, `уровень ${t.level} без слова`).not.toBe('');
  }

  // Свежий и давний промпты различаются числом полосок, а не только оттенком.
  const filled = temps.map((t) => (t.bars.match(/▰/g) ?? []).length);
  expect(new Set(filled).size, `все промпты получили одну температуру: ${filled}`).toBeGreaterThan(1);
});

test('REQ-UI-STATE · уведомление тоже несёт плашку с уровнем', async ({ page, deck }) => {
  await deck.reset();
  deck.seed([{ id: 'c-empty', group: 'code', title: 'Пустое тело', body: '' }]);

  await open(page, deck);
  const broken = page.locator('#prompt-c-empty');
  await expect(broken).toBeVisible();

  await broken.click();
  // Approved W2 contract: second click edits; Enter attempts insertion.
  await page.keyboard.press('Enter');

  const toast = page.locator('#toast');
  await expect(toast).toBeVisible();
  await expect(toast.locator('.state.is-bad')).toHaveCount(1);
  await expect(toast.locator('.state .glyph')).toHaveText('✕');
  await expect(toast).toHaveAttribute('role', 'status');
  await expect(toast).toHaveAttribute('aria-live', 'polite');
});
