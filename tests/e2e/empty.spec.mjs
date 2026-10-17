// tests/e2e/empty.spec.mjs — честная пустота списков.
//
// Требование: REQ-UI-EMPTY (docs/SPEC.md §7). Состояния: docs/UI-SPEC.md §5.
// Сценарии S-01, S-02, S-04, S-13. Утверждение U-14.
// Ноль, «никогда» и прочерк — в tests/e2e/numbers.spec.mjs.
//
// Единственное правило файла: пустое состояние обязано содержать ПРИЧИНУ и
// СЛЕДУЮЩЕЕ ДЕЙСТВИЕ. «0 промптов» без объяснения — то же, что молчание: человек
// не знает, программа сломалась, папка не та, или он просто ещё ничего не создал.
//
// Каждый экран проверяется в САМОМ пустом состоянии, какое возможно: библиотека без
// файлов, журнал без записей, первый запуск без настроек. Именно так программа
// выглядит в первую минуту знакомства (S-13), и именно это состояние обычно никто
// не проверяет — у автора библиотека всегда полна.

import { test, expect, open, watchConsole } from './deck.mjs';
import { expectNoLies } from './nolies.mjs';

test.beforeAll(async ({ deck }) => {
  await deck.reset();
});

/**
 * S-13 · первый запуск.
 * Библиотеки нет, журнала нет, настроек нет. Человек видит окно впервые, и оно
 * обязано сказать, что делать, а не показать пустой прямоугольник.
 */
test('S-13 · пустая библиотека называет причину и следующее действие', async ({ page, deck }) => {
  const errors = watchConsole(page);
  await deck.reset();

  await open(page, deck);

  await expect(page.locator('#pickerEmpty')).toBeVisible();
  await expect(page.locator('#pickerList')).toBeHidden();

  const why = page.locator('#pickerEmptyText');
  await expect(why).toContainText('Промптов нет');
  // Следующее действие названо клавишами, а не «добавьте промпт»: человеку нужен
  // способ, а не пожелание.
  await expect(why).toContainText('Ctrl+Shift+S');

  // Плашка состояния на месте: пустота — это `none`, а не отсутствие состояния.
  await expect(page.locator('#pickerEmpty .state')).toHaveClass(/is-none/);
  await expect(page.locator('#pickerEmpty .glyph')).toHaveText('–');

  await expectNoLies(page, 'пустая библиотека');
  expect(errors, 'интерфейс ругается в консоль на пустой библиотеке').toEqual([]);
});

/**
 * S-02 · поиск без результатов.
 * Отличается от пустой библиотеки: причина другая, и запрос обязан быть виден.
 * «Ничего не найдено» без запроса не даёт понять, что искалось — особенно когда
 * запрос набран не в той раскладке.
 */
test('S-02 · пустая выдача поиска повторяет запрос и не закрывает окно', async ({ page, deck }) => {
  await deck.reset();
  deck.seed([{ id: 'c-one', group: 'code', title: 'Единственный промпт' }]);

  await open(page, deck);
  await expect(page.locator('#pickerList .row')).toHaveCount(1);

  await page.fill('#pickerSearch', 'щукшн');

  await expect(page.locator('#pickerEmpty')).toBeVisible();
  await expect(page.locator('#pickerEmptyText')).toContainText('«щукшн»');
  await expect(page.locator('#pickerEmptyText')).toContainText('Проверены обе раскладки');

  // Окно живо и запрос на месте: пустая выдача — состояние, а не выход.
  await expect(page.locator('#picker')).toBeVisible();
  await expect(page.locator('#pickerSearch')).toHaveValue('щукшн');
  await expect(page.locator('#pickerSearch')).toBeFocused();

  // Возврат к непустой выдаче: пустое состояние скрывается, список возвращается.
  await page.fill('#pickerSearch', '');
  await expect(page.locator('#pickerList .row')).toHaveCount(1);
  await expect(page.locator('#pickerEmpty')).toBeHidden();
});

test('S-04 · пустой журнал объясняет, что слежка идёт и чего ждать', async ({ page, deck }) => {
  await deck.reset();

  await open(page, deck, '#clips');

  await expect(page.locator('#clipsEmpty')).toBeVisible();
  await expect(page.locator('#clipsList')).toBeHidden();
  await expect(page.locator('#clipsEmptyText')).toContainText('скопируйте что-нибудь');

  // Слежка включена, и это сказано: пустой журнал при выключенной слежке —
  // совсем другая ситуация, и путать их нельзя.
  await expect(page.locator('#clipsWatch')).toContainText('слежка идёт');
  await expect(page.locator('#clipsWatch')).toHaveClass(/is-good/);

  // Счётчик показывает «0/100», а не прочерк: ноль здесь измерен, а не неизвестен.
  await expect(page.locator('#clipsCount')).toHaveText('0/100');

  await expectNoLies(page, 'пустой журнал');
});

/**
 * Пустой журнал при ВЫКЛЮЧЕННОЙ слежке.
 * Тот же пустой список, но причина обратная: ждать нечего, пока не включат.
 * Одинаковый текст для двух разных причин был бы ложью об одной из них.
 */
test('S-04 · пустой журнал при выключенной слежке говорит про настройку', async ({ page, deck }) => {
  await deck.reset();
  await deck.settings({ clipboard: { enabled: false } });

  await open(page, deck, '#clips');

  await expect(page.locator('#clipsWatch')).toContainText('слежка отключена');
  await expect(page.locator('#clipsWatch')).toHaveClass(/is-none/);
  await expect(page.locator('#clipsWatch')).toHaveAttribute('title', /настройках/);

  await expectNoLies(page, 'журнал с выключенной слежкой');
  await deck.settings({ clipboard: { enabled: true } });
});

test('S-04 · поиск по журналу без совпадений повторяет запрос', async ({ page, deck }) => {
  await deck.reset();
  await deck.api('/api/clips', { method: 'POST', body: { text: 'Одна запись в журнале' } });

  await open(page, deck, '#clips');
  await expect(page.locator('#clipsList .clip')).toHaveCount(1);

  await page.fill('#clipsSearch', 'ъъъ');

  await expect(page.locator('#clipsEmpty')).toBeVisible();
  await expect(page.locator('#clipsEmptyText')).toContainText('«ъъъ»');
  await expectNoLies(page, 'поиск по журналу без совпадений');
});

/**
 * U-14 · окно управления на пустых данных.
 * Здесь больше всего чисел, и каждое — возможный `undefined`. Проверяются все
 * семь разделов подряд: пропущенный прочерк находится именно так.
 */
test('U-14 · все разделы управления на пустой библиотеке без лжи', async ({ page, deck }) => {
  const errors = watchConsole(page);
  await deck.reset();

  await open(page, deck, '#deck');
  await expect(page.locator('#svcState')).toContainText('работает');

  const views = ['view-service', 'view-hotkeys', 'view-look', 'view-order',
    'view-clipboard', 'view-library', 'view-diag'];

  for (const view of views) {
    // eslint-disable-next-line no-await-in-loop
    await page.click(`#deckNav a[href="#${view}"]`);
    // eslint-disable-next-line no-await-in-loop
    await expect(page.locator(`#${view}`)).toBeVisible();
    // eslint-disable-next-line no-await-in-loop
    await expectNoLies(page, `раздел ${view}`);
  }

  expect(errors).toEqual([]);
});

/**
 * Пустое состояние не остаётся на экране после появления данных.
 * Проверка от обратного: блок «нет данных» обязан исчезнуть, иначе человек видит
 * список и надпись «промптов нет» одновременно.
 */
test('REQ-UI-EMPTY · появление данных убирает блок пустоты', async ({ page, deck }) => {
  await deck.reset();

  await open(page, deck);
  await expect(page.locator('#pickerEmpty')).toBeVisible();

  // Промпт появляется на диске, пока окно открыто — так работает сохранение из
  // журнала в другом окне.
  deck.seed([{ id: 'c-late', group: 'code', title: 'Появился позже' }]);
  await page.reload();

  await expect(page.locator('#prompt-c-late')).toBeVisible();
  await expect(page.locator('#pickerEmpty')).toBeHidden();
  await expect(page.locator('#pickerList')).toBeVisible();
});
