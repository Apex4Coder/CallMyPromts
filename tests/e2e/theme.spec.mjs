// tests/e2e/theme.spec.mjs — две темы, пять акцентов, контраст, смена без перезагрузки.
//
// Требование: REQ-UI-THEME (docs/SPEC.md §7). Значения: docs/UI-SPEC.md §1.
// Сценарий S-09. Утверждения: U-2, U-3, U-20.
//
// Контраст измеряется в браузере (tests/e2e/contrast.mjs), а не сверяется с
// файлом стилей: реальный цвет складывается из темы, акцента и `color-mix`,
// и проверка по исходнику доказывала бы лишь то, что файл написан как написан.

import { test, expect, open, LIBRARY } from './deck.mjs';
import { measureContrast, textContrast, borderContrast } from './contrast.mjs';

/** Все четыре плашки состояния сразу: сервис, журнал, конфликты, библиотека. */
const CHIPS = ['good', 'warn', 'bad', 'none'];

/** Порог для текста и для границ — docs/UI-SPEC.md §6. */
const TEXT_MIN = 4.5;
const EDGE_MIN = 3;

const ACCENTS = ['teal', 'indigo', 'amber', 'rose', 'slate'];

/**
 * Страница с четырьмя плашками сразу. Собирается в живом DOM, потому что
 * измерять надо вычисленный цвет: класс `.is-warn` в одиночку ничего не значит,
 * значение приходит из темы.
 */
const putChips = (page) => page.evaluate((levels) => {
  const box = document.createElement('div');
  box.id = 'probeChips';
  for (const level of levels) {
    const chip = document.createElement('span');
    chip.id = `chip-${level}`;
    chip.className = `state is-${level}`;
    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = { good: '✓', warn: '!', bad: '✕', none: '–' }[level];
    const word = document.createElement('span');
    word.className = 'word';
    word.textContent = { good: 'в норме', warn: 'внимание', bad: 'сломано', none: 'нет данных' }[level];
    chip.append(glyph, word);
    box.append(chip);
  }
  document.getElementById('picker').append(box);
}, CHIPS);

test.beforeAll(async ({ deck }) => {
  await deck.reset();
  deck.seed(LIBRARY);
});

for (const theme of ['light', 'dark']) {
  test(`U-2 · ${theme}: текст на поверхности читается`, async ({ page, deck }) => {
    await deck.settings({ ui: { theme } });
    await open(page, deck);
    await expect(page.locator('#pickerList .row').first()).toBeVisible();

    const name = await textContrast(page, '#pickerList .row .name');
    expect(name, `основной текст ${name}:1 при пороге ${TEXT_MIN}:1`).toBeGreaterThanOrEqual(TEXT_MIN);

    // Приглушённый текст — группа, время, подсказки. Он тоже текст, и порог тот же:
    // «второстепенный» не значит «можно не читать».
    const muted = await textContrast(page, '#pickerList .row .group');
    expect(muted, `приглушённый текст ${muted}:1`).toBeGreaterThanOrEqual(TEXT_MIN);

    const hints = await textContrast(page, '#pickerHints');
    expect(hints, `подсказки клавиш ${hints}:1`).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  test(`U-2 · ${theme}: границы окна и поля различимы`, async ({ page, deck }) => {
    await deck.settings({ ui: { theme, layout: 'panels' } });
    await open(page, deck, '#deck');
    await page.click('#deckNav a[href="#view-hotkeys"]');
    await expect(page.locator('#keyPicker')).toBeVisible();

    // Рамка поля ввода — единственный признак, по которому поле видно вообще.
    const input = await borderContrast(page, '#keyPicker');
    expect(input, `рамка поля ввода ${input}:1 при пороге ${EDGE_MIN}:1`).toBeGreaterThanOrEqual(EDGE_MIN);

    const button = await borderContrast(page, '#keyResetBtn');
    expect(button, `рамка кнопки ${button}:1`).toBeGreaterThanOrEqual(EDGE_MIN);
  });

  test(`U-2, U-3 · ${theme}: все четыре плашки — контраст, значок и слово`, async ({ page, deck }) => {
    await deck.settings({ ui: { theme } });
    await open(page, deck);
    await expect(page.locator('#pickerList .row').first()).toBeVisible();
    await putChips(page);

    const got = await measureContrast(page, CHIPS.map((l) => `#chip-${l}`));

    for (const chip of got) {
      expect(chip.missing, `плашка ${chip.sel} не найдена`).toBeUndefined();

      // U-3: смысл несут значок И слово. Цвет — только усиление, и без этой
      // проверки тема могла бы «читаться» одним цветом.
      expect(chip.glyph, `${chip.sel}: нет значка`).not.toBe('');
      expect(chip.word, `${chip.sel}: нет слова`).not.toBe('');

      expect(chip.text, `${chip.sel}: текст ${chip.text}:1`).toBeGreaterThanOrEqual(TEXT_MIN);
      expect(chip.border, `${chip.sel}: граница ${chip.border}:1`).toBeGreaterThanOrEqual(EDGE_MIN);
    }
  });
}

test('§1.1 · тёмная тема действительно темнее светлой', async ({ page, deck }) => {
  const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await deck.settings({ ui: { theme: 'light' } });
  await open(page, deck);
  const light = await bodyBg();

  await deck.settings({ ui: { theme: 'dark' } });
  await page.reload();
  const dark = await bodyBg();

  expect(light).not.toBe(dark);

  const sum = (css) => (css.match(/\d+/g) ?? []).slice(0, 3).reduce((a, n) => a + Number(n), 0);
  expect(sum(dark), `светлая ${light}, тёмная ${dark}`).toBeLessThan(sum(light));
});

/**
 * U-20 · смена темы не требует перезагрузки.
 *
 * Проверяется по вычисленному цвету, а не по атрибуту: атрибут можно поставить и
 * без единого правила в стилях, и человек увидел бы прежний экран.
 */
test('U-20 · тема применяется сразу, без перезагрузки', async ({ page, deck }) => {
  await deck.settings({ ui: { theme: 'light' } });
  await open(page, deck, '#deck');
  await page.click('#deckNav a[href="#view-look"]');
  await expect(page.locator('#optTheme')).toBeVisible();

  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await page.selectOption('#optTheme', 'dark');

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const after = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(after, 'атрибут сменился, а цвет нет').not.toBe(before);

  // Настройка не только применилась, но и сохранилась: иначе следующее открытие
  // окна вернуло бы прежнюю тему, и человек решил бы, что выбор не работает.
  const saved = await deck.api('/api/settings');
  expect(saved.data.settings.ui.theme).toBe('dark');
});

test('§1.2 · пять акцентов дают пять разных цветов', async ({ page, deck }) => {
  await deck.settings({ ui: { theme: 'light' } });
  await open(page, deck);

  const seen = new Map();
  for (const accent of ACCENTS) {
    await page.evaluate((a) => { document.documentElement.dataset.accent = a; }, accent);
    const color = await page.evaluate(
      () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    );
    expect(color, `акцент ${accent} не задан`).not.toBe('');
    seen.set(accent, color);
  }

  expect(new Set(seen.values()).size, `повторяющиеся цвета: ${[...seen].join(', ')}`).toBe(ACCENTS.length);
});

/**
 * §1.2 · акцент не занимает тон статуса.
 * Красный акцент делал бы кнопку неотличимой от ошибки, зелёный — от «в норме».
 * Поэтому в списке нет ни красного, ни зелёного, и это проверяется по тону.
 */
test('§1.2 · ни один акцент не попадает в тон «сломано» или «в норме»', async ({ page, deck }) => {
  await open(page, deck);

  const hue = (css) => {
    const [r, g, b] = (css.match(/\d+/g) ?? []).map(Number).map((v) => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return null; // серый: тона нет, конфликта тоже
    const d = max - min;
    let h = 0;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return ((h * 60) + 360) % 360;
  };

  for (const accent of ACCENTS) {
    await page.evaluate((a) => { document.documentElement.dataset.accent = a; }, accent);
    const got = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--accent)';
      document.body.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });

    const h = hue(got);
    if (h === null) continue;
    // Зелёный 100..170, красный 0..15 и 345..360 — тона --good и --bad.
    const clash = (h >= 100 && h <= 170) || h <= 15 || h >= 345;
    expect(clash, `акцент ${accent} (${got}, тон ${Math.round(h)}°) спорит со статусом`).toBe(false);
  }
});

test('§6 · фокус виден обводкой акцентного цвета', async ({ page, deck }) => {
  await open(page, deck, '#deck');
  await page.click('#deckNav a[href="#view-hotkeys"]');
  await page.focus('#keyPicker');

  const outline = await page.evaluate(() => {
    const st = getComputedStyle(document.getElementById('keyPicker'));
    return { width: st.outlineWidth, style: st.outlineStyle, color: st.outlineColor };
  });

  expect(outline.style, 'обводка снята — уйти по Tab станет некуда').not.toBe('none');
  expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(2);

  const accent = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  expect(outline.color).toBe(accent);
});

test('§1.4 · плотность меняет высоту строки, а не её состав', async ({ page, deck }) => {
  await deck.settings({ ui: { density: 'compact' } });
  await open(page, deck);
  await expect(page.locator('#pickerList .row').first()).toBeVisible();

  const height = () => page.evaluate(
    () => Math.round(document.querySelector('#pickerList .row').getBoundingClientRect().height),
  );
  const columns = () => page.evaluate(
    () => document.querySelectorAll('#pickerList .row:first-child > *').length,
  );

  const compact = await height();
  const parts = await columns();

  await page.evaluate(() => { document.documentElement.dataset.density = 'comfortable'; });
  const comfortable = await height();

  expect(comfortable, `плотно ${compact}px, свободно ${comfortable}px`).toBeGreaterThan(compact);
  expect(await columns(), 'плотность изменила состав строки').toBe(parts);
});

test('§1.4 · масштаб текста увеличивает буквы, сетка не рвётся', async ({ page, deck }) => {
  await deck.settings({ ui: { font_scale: 100 } });
  await open(page, deck);
  await expect(page.locator('#pickerList .row').first()).toBeVisible();

  const size = () => page.evaluate(
    () => Number.parseFloat(getComputedStyle(document.querySelector('#pickerList .row .name')).fontSize),
  );
  const overflow = () => page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );

  const at100 = await size();

  await page.evaluate(() => { document.documentElement.style.setProperty('--font-scale', '1.6'); });
  const at160 = await size();

  expect(at160).toBeGreaterThan(at100);
  expect(await overflow(), 'увеличенный текст вызвал горизонтальный скролл').toBeLessThanOrEqual(0);
});
