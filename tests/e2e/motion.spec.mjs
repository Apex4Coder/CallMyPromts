// tests/e2e/motion.spec.mjs — движение: только transform и opacity, три уровня.
//
// Требование: REQ-UI-MOTION (docs/SPEC.md §7). Токены: docs/UI-SPEC.md §1.5.
// Сценарий S-09. Утверждение U-16.
//
// Свойства читаются у ЖИВЫХ анимаций через `document.getAnimations()`, а не из
// файла стилей. Так проверяется то, что браузер действительно анимирует: правило
// может быть переопределено, свойство — не поддержано, а `@keyframes` — не
// применён к элементу вовсе. Текст файла об этом ничего не говорит.

import { test, expect, open, LIBRARY, waitStill } from './deck.mjs';

/**
 * Запрещено анимировать (§1.5): каждое из этих свойств вызывает reflow или
 * тяжёлую перерисовку, и на слабой машине даёт рывки.
 */
const FORBIDDEN = [
  'width', 'height', 'top', 'left', 'right', 'bottom',
  'box-shadow', 'filter', 'backdrop-filter', 'margin', 'padding',
];

/** Разрешено: композитор справляется без перекомпоновки. */
const ALLOWED = ['transform', 'opacity'];

/** Единственное осознанное исключение — подсветка строки списка. */
const EXCEPTION = 'background-color';

/**
 * Все свойства, которые страница анимирует прямо сейчас.
 * Собирается из ключевых кадров: имена в `getKeyframes()` записаны в camelCase,
 * поэтому приводятся к дефисной форме — сравнивать надо с текстом спецификации.
 */
const animatedProps = (page) => page.evaluate(() => {
  const dash = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const skip = new Set(['offset', 'computedOffset', 'easing', 'composite']);
  const out = new Set();

  for (const a of document.getAnimations()) {
    for (const frame of a.effect?.getKeyframes?.() ?? []) {
      for (const key of Object.keys(frame)) {
        if (!skip.has(key)) out.add(dash(key));
      }
    }
  }
  return [...out];
});

/** Свойства, перечисленные в `transition-property` у элемента. */
const transitionProps = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  return getComputedStyle(el).transitionProperty.split(',').map((s) => s.trim()).filter(Boolean);
}, selector);

const durationOf = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const st = getComputedStyle(el);
  const num = (v) => Number.parseFloat(v) * (v.trim().endsWith('ms') ? 1 : 1000);
  return { animation: num(st.animationDuration), transition: num(st.transitionDuration) };
}, selector);

test.beforeAll(async ({ deck }) => {
  await deck.reset();
  deck.seed(LIBRARY);
});

/**
 * Уровень движения возвращается к «полному» перед каждым тестом.
 *
 * Настройки живут на сервере, а сервер один на весь файл — значит `motion: off`
 * из одного теста доставался следующему. Пульс индикатора при `off` имеет
 * длительность 0s, и проверка «2 секунды» падала не потому, что пульс сломан, а
 * потому что предыдущий тест выключил движение. Порядок тестов не должен влиять
 * на их смысл, поэтому предпосылка объявляется явно.
 */
test.beforeEach(async ({ deck, page }) => {
  await deck.settings({ ui: { motion: 'full' } });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test('§1.5 · появление окна анимируется только transform и opacity', async ({ page, deck }) => {
  await open(page, deck);

  // Снимок делается ДО конца анимации: после её завершения список пуст.
  const props = await animatedProps(page);
  expect(props.length, 'окно появилось без анимации').toBeGreaterThan(0);

  for (const p of props) {
    expect(ALLOWED, `анимируется «${p}» — это вызывает reflow`).toContain(p);
  }
});

test('§1.5 · длительность появления — 150 мс из токена --dur-fast', async ({ page, deck }) => {
  await open(page, deck);
  const d = await durationOf(page, '#picker');
  expect(d.animation).toBe(150);
});

test('§1.5 · ни один элемент не анимирует запрещённые свойства', async ({ page, deck }) => {
  await open(page, deck);
  await expect(page.locator('#pickerList .row').first()).toBeVisible();

  // Раскрытие превью, вспышка строки и уведомление — все анимации разом.
  await page.keyboard.press('Space');
  await page.locator('#prompt-c-review').click();

  const props = await animatedProps(page);
  for (const p of props) {
    expect(FORBIDDEN, `анимируется запрещённое «${p}» (§1.5)`).not.toContain(p);
  }
});

/**
 * §1.5 · исключение названо и ограничено.
 * Подсветка строки меняет `background-color` — одно свойство на одном элементе.
 * Проверяется, что исключение именно такое, а не «немного всего».
 */
test('§1.5 · строка списка переходит только по background-color', async ({ page, deck }) => {
  await open(page, deck);
  await expect(page.locator('#pickerList .row').first()).toBeVisible();

  const props = await transitionProps(page, '#pickerList .row');
  expect(props).toEqual([EXCEPTION]);

  const d = await durationOf(page, '#pickerList .row');
  expect(d.transition).toBe(100);
});

test('§1.5 · раскрытие превью едет по opacity и transform, не по ширине', async ({ page, deck }) => {
  await open(page, deck);
  await expect(page.locator('#pickerList .row').first()).toBeVisible();

  await page.keyboard.press('Space');
  await expect(page.locator('#pickerPreview')).toBeVisible();

  const props = await page.evaluate(() => {
    const dash = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    const skip = new Set(['offset', 'computedOffset', 'easing', 'composite']);
    const out = new Set();
    const el = document.getElementById('pickerPreview');
    for (const a of el.getAnimations()) {
      for (const frame of a.effect.getKeyframes()) {
        for (const key of Object.keys(frame)) if (!skip.has(key)) out.add(dash(key));
      }
    }
    return [...out];
  });

  expect(props.sort()).toEqual(['opacity', 'transform']);
});

test('§1.5 · уровень reduced укорачивает движение, но не убирает его', async ({ page, deck }) => {
  await deck.settings({ ui: { motion: 'reduced' } });
  await open(page, deck);

  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');

  const d = await durationOf(page, '#picker');
  expect(d.animation).toBeGreaterThan(0);
  expect(d.animation).toBeLessThanOrEqual(80);

  // Обратная связь остаётся: её исчезновение хуже краткости (§1.5).
  const props = await animatedProps(page);
  expect(props.length).toBeGreaterThan(0);
});

test('§1.5 · уровень off выключает и анимации, и переходы', async ({ page, deck }) => {
  await deck.settings({ ui: { motion: 'off' } });
  await open(page, deck);
  await expect(page.locator('#pickerList .row').first()).toBeVisible();

  await expect(page.locator('html')).toHaveAttribute('data-motion', 'off');

  const window = await durationOf(page, '#picker');
  const row = await durationOf(page, '#pickerList .row');
  expect(window.animation).toBe(0);
  expect(row.transition).toBe(0);

  await page.keyboard.press('Space');
  await expect(page.locator('#pickerPreview')).toBeVisible();
  expect(await animatedProps(page)).toEqual([]);
});

test('§1.5 · пульс индикатора сервиса — 2 секунды и бесконечно', async ({ page, deck }) => {
  await open(page, deck, '#deck');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');

  const live = await page.evaluate(() => {
    const dot = document.createElement('span');
    dot.className = 'dot is-live';
    document.body.append(dot);
    const st = getComputedStyle(dot);
    const out = { duration: st.animationDuration, iterations: st.animationIterationCount };
    dot.remove();
    return out;
  });

  expect(live.duration).toBe('2s');
  expect(live.iterations).toBe('infinite');
});

/**
 * U-16 · системная настройка сильнее пользовательской.
 *
 * Человек попросил ОС уменьшить движение — приложение не имеет права это
 * переопределять, даже если в настройках стоит «полное». Проверка идёт с
 * `motion: 'full'` в настройках: иначе она доказывала бы только то, что
 * `reduced` работает.
 */
test('U-16 · prefers-reduced-motion понижает уровень даже при «полном»', async ({ page, deck }) => {
  await open(page, deck);
  const normal = await durationOf(page, '#picker');
  expect(normal.animation).toBe(150);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();

  // Настройка осталась «полной»: понижение делает медиазапрос, а не приложение.
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');

  const reduced = await durationOf(page, '#picker');
  expect(reduced.animation, `при reduce длительность ${reduced.animation} мс`).toBeLessThanOrEqual(80);
});

test('U-16 · при reduce пульс индикатора останавливается', async ({ page, deck }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, deck, '#deck');

  const name = await page.evaluate(() => {
    const dot = document.createElement('span');
    dot.className = 'dot is-live';
    document.body.append(dot);
    const got = getComputedStyle(dot).animationName;
    dot.remove();
    return got;
  });

  expect(name, 'мигание продолжается при системном запросе покоя').toBe('none');
});

test('§1.5 · анимации завершаются и не остаются висеть', async ({ page, deck }) => {
  await open(page, deck);
  await expect(page.locator('#pickerList .row').first()).toBeVisible();

  await waitStill(page);

  // Бесконечные исключены: пульс индикатора живёт всё время работы сервиса.
  const stuck = await page.evaluate(() => document.getAnimations()
    .filter((a) => a.effect?.getTiming?.().iterations !== Infinity)
    .filter((a) => a.playState === 'running')
    .length);

  expect(stuck, 'анимация не закончилась — окно осталось полупрозрачным').toBe(0);
});
