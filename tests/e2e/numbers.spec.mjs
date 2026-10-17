// tests/e2e/numbers.spec.mjs — честные числа: ноль, «никогда», прочерк.
//
// Требование: REQ-UI-EMPTY (docs/SPEC.md §7). Состояния: docs/UI-SPEC.md §5.
// Сценарий S-12. Утверждение U-14.
// Пустые списки и их объяснения — в tests/e2e/empty.spec.mjs.
//
// Выделено из empty.spec.mjs, когда тот вышел за 300 строк. Разделение по смыслу:
// там — «что написано, когда показывать нечего», здесь — «чем ноль отличается от
// неизвестного».
//
// Три значения выглядят похоже и означают разное:
//   0        — измерено, результат ноль («использован 0 раз»);
//   никогда  — известно точно, что события не было («ни разу не использован»);
//   —        — значение неизвестно («время работы остановленного сервиса»).
// Свести их к одному виду значит потерять факт. Поэтому каждая пара проверяется
// рядом: два похожих случая обязаны выглядеть по-разному.

import { test, expect, open } from './deck.mjs';
import { expectNoLies } from './nolies.mjs';

test.beforeAll(async ({ deck }) => {
  await deck.reset();
});

test('U-14 · раздел «Библиотека» на нуле промптов: ноль и «все в норме»', async ({ page, deck }) => {
  await deck.reset();

  await open(page, deck, '#deck');
  await page.click('#deckNav a[href="#view-library"]');

  // Ноль промптов — это измеренный ноль, поэтому число, а не прочерк. Но рядом
  // объяснено, что проблем нет: пустая строка «Проблемы» читалась бы как сбой.
  await expect(page.locator('#libCount')).toContainText('0');
  await expect(page.locator('#libIssues')).toContainText('все промпты в норме');
  await expect(page.locator('#libIssues .state')).toHaveClass(/is-good/);

  // Путь к папке заполнен: пустое поле выглядело бы как «библиотека не настроена».
  await expect(page.locator('#libPath')).not.toHaveValue('');
});

test('U-14 · диагностика на пустоте: причина и предложение миграции', async ({ page, deck }) => {
  await deck.reset();

  await open(page, deck, '#deck');
  await page.click('#deckNav a[href="#view-diag"]');
  await page.click('#diagRunBtn');

  const list = page.locator('#diagList');
  await expect(list).toContainText('промптов нет');
  await expect(list).toContainText('запустите миграцию');

  // Каждая строка диагностики несёт плашку: строка без состояния не отвечает на
  // вопрос «в порядке или нет».
  const rows = list.locator('.field');
  const count = await rows.count();
  expect(count, 'диагностика пуста').toBeGreaterThan(3);
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await expect(rows.nth(i).locator('.state')).toHaveCount(1);
  }

  await expectNoLies(page, 'диагностика на пустой библиотеке');
});

/**
 * U-14 · «ни разу» — это слово, а не прочерк.
 *
 * Разница тонкая и она в пользу кода. Прочерк означает «значение неизвестно»:
 * так показывается время работы остановленного сервиса. Здесь же известно точно —
 * промпт не использовали ни разу, и [`humanDays()`](rank/temperature.mjs:121)
 * отвечает «никогда». Первая версия теста ждала прочерк и была неправа: замена
 * слова на прочерк потеряла бы факт.
 *
 * Счётчик при этом остаётся числом: «использовано 0 раз» — измеренный ноль.
 */
test('U-14 · неиспользованный промпт: ноль в счётчике, «никогда» во времени', async ({ page, deck }) => {
  await deck.reset();
  deck.seed([{ id: 'c-new', group: 'code', title: 'Ни разу не использован', used: 0 }]);

  await open(page, deck);
  await expect(page.locator('#prompt-c-new')).toBeVisible();

  const meta = page.locator('#previewMeta');
  await expect(meta).toContainText('⌗0');
  await expect(meta).toContainText('никогда');
  await expect(meta).toContainText('холодный');

  // Значка счётчика в строке нет: «⌗0» на каждой строке — шум, а его отсутствие
  // само означает «ещё не использован» (rank/usage.mjs, порог 3).
  await expect(page.locator('#prompt-c-new .badge')).toHaveCount(0);

  // Температура показана словом и полосками, а не пустотой: «нет данных» о
  // температуре не бывает, холодный — это ответ.
  await expect(page.locator('#prompt-c-new .temp .bars')).toHaveText('▱▱▱');

  await expectNoLies(page, 'неиспользованный промпт');
});

/**
 * Прочерк остаётся там, где значение действительно неизвестно.
 * Пара к предыдущему тесту: два похожих случая обязаны выглядеть по-разному,
 * иначе «не знаю» и «ничего не было» сливаются в одно.
 */
test('U-14 · время работы остановленного сервиса — прочерк, а не ноль', async ({ page, deck }) => {
  await deck.reset();

  await page.route('**/api/system', (route) => route.abort('failed'));
  await open(page, deck, '#deck');

  await expect(page.locator('#svcUptime')).toHaveText('—');
  await expect(page.locator('#svcState')).toContainText('сервис остановлен');

  await page.unroute('**/api/system');
});

/**
 * Пустое тело плюс пустая библиотека — худший случай.
 * Единственный промпт сломан, значит вставлять нечего, но список НЕ пуст: строка
 * видна и объяснена. Молча спрятать её значило бы показать пустую библиотеку при
 * существующем файле — самая опасная форма лжи, потому что человек начнёт искать
 * пропавший файл.
 */
test('U-14 · единственный битый промпт виден и объяснён, а не спрятан', async ({ page, deck }) => {
  await deck.reset();
  deck.seed([{ id: 'c-broken', group: 'code', title: 'Пустое тело', body: '' }]);

  await open(page, deck);

  await expect(page.locator('#pickerEmpty')).toBeHidden();
  await expect(page.locator('#prompt-c-broken')).toBeVisible();
  await expect(page.locator('#prompt-c-broken .state.is-bad')).toHaveCount(1);
  await expect(page.locator('#prompt-c-broken .state.is-bad')).toHaveAttribute('title', /тело промпта пусто/);

  await expectNoLies(page, 'единственный битый промпт');
});

/**
 * S-12 · сервис остановлен — это не «пусто».
 * Самый частый случай и самый опасный для формулировки: пустой список без причины
 * заставил бы думать, что пропали промпты.
 */
test('S-12 · остановленный сервис отличается от пустой библиотеки', async ({ page, deck }) => {
  await deck.reset();
  deck.seed([{ id: 'c-one', group: 'code', title: 'Промпт на диске' }]);

  await page.route('**/api/**', (route) => route.abort('failed'));
  await open(page, deck);

  await expect(page.locator('#pickerEmpty')).toBeVisible();
  const why = page.locator('#pickerEmptyText');

  await expect(why).toContainText('нет связи с сервисом');
  // Формулировка про отсутствие промптов здесь была бы ложью: они на диске.
  await expect(why).not.toContainText('Промптов нет');

  await expect(page.locator('#headState')).toContainText('сервис остановлен');
  await expectNoLies(page, 'остановленный сервис');

  await page.unroute('**/api/**');
});
