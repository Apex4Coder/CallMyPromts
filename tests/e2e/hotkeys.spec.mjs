// tests/e2e/hotkeys.spec.mjs — раздел «Горячие клавиши»: правка, отказы, конфликты.
//
// Требование: REQ-UI-SETTINGS (docs/SPEC.md §7). DOM-id: docs/UI-SPEC.md §3.3.
// Сценарий S-07. Утверждение: U-13.
// Остальные разделы окна управления — в tests/e2e/settings.spec.mjs.
//
// Выделено из settings.spec.mjs, когда тот вышел за 300 строк. Раскладка по
// смыслу: здесь единственный раздел, где интерфейс показывает состояние, о
// котором знает не он, а мост в ОС.
//
// Отчёт моста подставляется через `POST /api/hotkeys` напрямую: сам AutoHotkey под
// Playwright не запустить, но реакция интерфейса на отчёт проверяется полностью.
// Это осознанная граница — что делает AHK, проверяют unit-тесты bridge/.

import { test, expect, open, LIBRARY } from './deck.mjs';

const go = async (page, view) => {
  await page.click(`#deckNav a[href="#${view}"]`);
  await expect(page.locator(`#${view}`)).toBeVisible();
};

test.beforeAll(async ({ deck }) => {
  await deck.reset();
  deck.seed(LIBRARY);
});

test('S-07 · хоткей сохраняется, но о задержке применения сказано', async ({ page, deck }) => {
  await open(page, deck, '#deck');
  await go(page, 'view-hotkeys');

  await page.fill('#keyPicker', '^!z');
  await page.locator('#keyPicker').blur();

  // Мост читает settings.json на старте: обещать мгновенное применение — ложь.
  await expect(page.locator('#toast')).toContainText('Перезапустить сервис');
  await expect(page.locator('#toast .state')).toHaveClass(/is-warn/);

  const saved = await deck.api('/api/settings');
  expect(saved.data.settings.hotkeys.open_picker).toBe('^!z');
});

test('S-07 · недопустимое сочетание отвергается с примером верного', async ({ page, deck }) => {
  await open(page, deck, '#deck');
  await go(page, 'view-hotkeys');

  await page.fill('#keyPicker', 'Ctrl+Alt+Q');
  await page.locator('#keyPicker').blur();

  await expect(page.locator('#toast')).toContainText('недопустимое сочетание');
  await expect(page.locator('#toast')).toContainText('^!q');
  await expect(page.locator('#keyPicker')).toHaveAttribute('aria-invalid', 'true');
});

test('S-07 · пустое поле — это «не назначена», а не ошибка', async ({ page, deck }) => {
  await open(page, deck, '#deck');
  await go(page, 'view-hotkeys');

  await page.fill('#keyWatch', '');
  await page.locator('#keyWatch').blur();

  await expect(page.locator('#keyWatch')).not.toHaveAttribute('aria-invalid', 'true');
  const saved = await deck.api('/api/settings');
  expect(saved.data.settings.hotkeys.toggle_watch).toBe('');
});

test('S-07 · сброс возвращает значения по умолчанию во все поля', async ({ page, deck }) => {
  await deck.settings({ hotkeys: { open_picker: '^!z', save_clip: '^+z', open_clips: '^!m', toggle_watch: '^!w' } });

  await open(page, deck, '#deck');
  await go(page, 'view-hotkeys');
  await expect(page.locator('#keyPicker')).toHaveValue('^!z');

  await page.click('#keyResetBtn');

  await expect(page.locator('#toast')).toContainText('сброшены');
  await expect(page.locator('#keyPicker')).toHaveValue('^+q');
  await expect(page.locator('#keySave')).toHaveValue('^+s');
  await expect(page.locator('#keyClips')).toHaveValue('^!v');
  await expect(page.locator('#keyWatch')).toHaveValue('');
});

/**
 * U-13 · занятый хоткей.
 * Состояние приходит от моста через `POST /api/hotkeys`: только он знает, что
 * отказала ОС.
 */
test('U-13 · занятая клавиша помечена красным с именем перехватчика', async ({ page, deck }) => {
  await deck.api('/api/hotkeys', {
    method: 'POST',
    body: {
      hotkeys: {
        open_picker: { combo: '^!q', state: 'bad', reason: 'занята ClipClip.exe' },
        save_clip: { combo: '^+s', state: 'good' },
        open_clips: { combo: '^!v', state: 'good' },
        toggle_watch: { combo: '', state: 'none' },
      },
    },
  });

  await open(page, deck, '#deck');
  await go(page, 'view-hotkeys');

  await expect(page.locator('#keyConflicts')).toContainText('ClipClip.exe');
  await expect(page.locator('#keyConflicts .state.is-bad')).toHaveCount(1);
  await expect(page.locator('#keyConflicts .state.is-bad .glyph')).toHaveText('✕');
  // Поле связано с проблемой: искать причину в другом месте экрана не нужно.
  await expect(page.locator('#keyPicker')).toHaveAttribute('aria-invalid', 'true');
});

/**
 * S-07 · «конфликтов нет» — только когда их правда нет.
 *
 * Комбинации подобраны вне списка известных занятых: со значением по умолчанию
 * `open_clips: ^!v` предупреждение появляется законно (см. следующий тест), и
 * проверка «нет конфликтов» на нём доказывала бы обратное тому, что нужно.
 */
test('S-07 · без конфликтов раздел говорит об этом прямо', async ({ page, deck }) => {
  await deck.settings({
    hotkeys: { open_picker: '^!q', save_clip: '^+s', open_clips: '^!m', toggle_watch: '' },
  });
  await deck.api('/api/hotkeys', {
    method: 'POST',
    body: {
      hotkeys: {
        open_picker: { combo: '^!q', state: 'good' },
        save_clip: { combo: '^+s', state: 'good' },
        open_clips: { combo: '^!m', state: 'good' },
        toggle_watch: { combo: '', state: 'none' },
      },
    },
  });

  await open(page, deck, '#deck');
  await go(page, 'view-hotkeys');

  await expect(page.locator('#keyConflicts')).toContainText('конфликтов нет');
  await expect(page.locator('#keyConflicts .state.is-good')).toHaveCount(1);
  await expect(page.locator('#keyPicker')).not.toHaveAttribute('aria-invalid', 'true');
});

/**
 * S-07 · известная занятая клавиша остаётся предупреждением даже при успешной
 * регистрации.
 *
 * Punto Switcher перехватывает нажатия низкоуровневым хуком, а не через
 * `RegisterHotKey`. Поэтому AHK регистрирует `^!v` без ошибки и докладывает
 * `good`, но до нашего окна нажатие может не дойти. Сервер знает об этом из
 * списка известных занятых и оставляет `warn`.
 *
 * Уровень именно `warn`, а не `bad`: клавиша, возможно, работает. Утверждать
 * обратное без доказательства — такая же ложь, как молчать (docs/RULES.md §4).
 */
test('S-07 · «вероятно занята» переживает успешный отчёт моста', async ({ page, deck }) => {
  await deck.settings({ hotkeys: { open_clips: '^!v' } });
  await deck.api('/api/hotkeys', {
    method: 'POST',
    body: { hotkeys: { open_clips: { combo: '^!v', state: 'good' } } },
  });

  await open(page, deck, '#deck');
  await go(page, 'view-hotkeys');

  await expect(page.locator('#keyConflicts')).toContainText('Punto Switcher');
  await expect(page.locator('#keyConflicts .state.is-warn')).toHaveCount(1);
  await expect(page.locator('#keyConflicts .state.is-warn .glyph')).toHaveText('!');

  // Поле не помечено ошибкой: предупреждение — не отказ, вводить заново нечего.
  await expect(page.locator('#keyClips')).not.toHaveAttribute('aria-invalid', 'true');
});
