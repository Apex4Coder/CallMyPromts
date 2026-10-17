// tests/e2e/clips.spec.mjs — журнал буфера: список, типы, фильтры, поиск, приватность.
//
// Требование: REQ-UI-CLIPS (docs/SPEC.md §7). DOM-id: docs/UI-SPEC.md §3.2.
// Сценарий S-04.
//
// Контекстное меню — в tests/e2e/clipmenu.spec.mjs: вместе файл выходил за 300
// строк, а лимит чанка (docs/RULES.md §3) не обходится, а соблюдается. Общие
// фикстуры — в tests/e2e/clipfix.mjs, чтобы оба файла проверяли один журнал.
//
// Владелец описал журнал прямо: «это буфер, работает как логирование, все записи
// идут друг за другом, моя задача только вытащить эту запись». Отсюда проверки:
// новое сверху, тип виден, фильтр сужает, поиск находит.

import { test, expect, open, readClipboard, seedClipboard } from './deck.mjs';
import {
  CLIPS, clipRows, addClips, openClipMenu, clipWith,
} from './clipfix.mjs';

test.beforeAll(async ({ deck }) => {
  await deck.reset();
  await addClips(deck);
});

test('S-04 шаг 1 · новое сверху, счётчик «5 из 100», слежка идёт', async ({ page, deck }) => {
  await open(page, deck, '#clips');

  await expect(clipRows(page)).toHaveCount(5);
  await expect(clipRows(page).first().locator('.text')).toContainText('она обязана быть сверху');
  await expect(clipRows(page).last().locator('.text')).toContainText('Первая скопированная');

  await expect(page.locator('#clipsCount')).toHaveText('5/100');
  await expect(page.locator('#clipsWatch')).toContainText('слежка идёт');
  await expect(page.locator('#clipsWatch')).toHaveClass(/is-good/);
  await expect(page.locator('#clipsEmpty')).toBeHidden();
});

test('§3.2 · тип записи показан глифом и подписью, а не цветом', async ({ page, deck }) => {
  await open(page, deck, '#clips');
  await expect(clipRows(page).first()).toBeVisible();

  await expect((await clipWith(page, 'example.com')).locator('.glyph')).toHaveText('↗');
  await expect((await clipWith(page, 'notes.md')).locator('.glyph')).toHaveText('/');
  await expect((await clipWith(page, 'answer = 42')).locator('.glyph')).toHaveText('{ }');
  await expect((await clipWith(page, 'про архитектуру')).locator('.glyph')).toHaveText('¶');

  // Подпись типа доступна как title: глиф без слова читался бы как ребус.
  await expect((await clipWith(page, 'example.com')).locator('.glyph')).toHaveAttribute('title', 'ссылка');
});

test('§3.2 · фильтры считают записи и сужают список', async ({ page, deck }) => {
  await open(page, deck, '#clips');
  await expect(clipRows(page)).toHaveCount(5);

  const filters = page.locator('#clipsFilters button');
  await expect(filters).toHaveCount(6);
  await expect(filters.nth(0)).toHaveText('все 5');
  await expect(filters.nth(0)).toHaveAttribute('aria-pressed', 'true');

  await filters.nth(2).click(); // код
  await expect(clipRows(page)).toHaveCount(1);
  await expect(clipRows(page).first().locator('.text')).toContainText('answer = 42');
  await expect(filters.nth(2)).toHaveAttribute('aria-pressed', 'true');
  await expect(filters.nth(0)).toHaveAttribute('aria-pressed', 'false');

  await filters.nth(3).click(); // ссылки
  await expect(clipRows(page)).toHaveCount(1);
  await expect(clipRows(page).first().locator('.text')).toContainText('example.com');

  await filters.nth(0).click();
  await expect(clipRows(page)).toHaveCount(5);
});

test('S-04 шаг 2 · поиск находит запись по содержимому', async ({ page, deck }) => {
  await open(page, deck, '#clips');
  await expect(clipRows(page)).toHaveCount(5);

  await page.fill('#clipsSearch', 'архитектур');
  await expect(clipRows(page)).toHaveCount(1);
  await expect(clipRows(page).first().locator('.text')).toContainText('про архитектуру');

  await page.fill('#clipsSearch', 'такого-текста-нет');
  await expect(page.locator('#clipsEmpty')).toBeVisible();
  await expect(page.locator('#clipsEmptyText')).toContainText('такого-текста-нет');
  await expect(page.locator('#clipsList')).toBeHidden();
});

/**
 * S-04, плохой путь 2 · слежка на паузе.
 * Пауза — это состояние `warn`, а не ошибка: человек сам её включил. Но молчать
 * о ней нельзя, иначе «журнал не пополняется» выглядит как поломка.
 */
test('S-04 · пауза видна как warn, кнопка меняет подпись', async ({ page, deck }) => {
  await deck.reset();
  await addClips(deck, CLIPS.slice(0, 2));

  await open(page, deck, '#clips');
  await expect(clipRows(page)).toHaveCount(2);
  await expect(page.locator('#clipsPauseBtn')).toHaveText('Пауза');

  await page.click('#clipsPauseBtn');

  await expect(page.locator('#clipsWatch')).toContainText('слежка на паузе');
  await expect(page.locator('#clipsWatch')).toHaveClass(/is-warn/);
  await expect(page.locator('#clipsPauseBtn')).toHaveText('Продолжить');
  await expect(page.locator('#clipsPauseBtn')).toHaveAttribute('aria-pressed', 'true');

  // На паузе новая запись не появляется — это и есть смысл паузы.
  await deck.api('/api/clips', { method: 'POST', body: { text: 'запись во время паузы' } });
  await page.click('#clipsPauseBtn');
  await expect(page.locator('#clipsWatch')).toContainText('слежка идёт');
  await expect(clipRows(page)).toHaveCount(2);
});

/**
 * S-04, плохой путь 8 · скопировано трижды подряд одно и то же.
 * Дедупликация (V-C-4) существует ради читаемого журнала: три одинаковые строки
 * не несут информации, а вытесняют полезные записи.
 */
test('S-04 · повтор подряд не создаёт вторую запись', async ({ page, deck }) => {
  await deck.reset();
  await addClips(deck, [{ text: 'один и тот же текст' }]);

  await open(page, deck, '#clips');
  await expect(clipRows(page)).toHaveCount(1);

  await deck.api('/api/clips', { method: 'POST', body: { text: 'один и тот же текст' } });
  await deck.api('/api/clips', { method: 'POST', body: { text: 'один и тот же текст' } });

  await page.reload();
  await expect(clipRows(page)).toHaveCount(1);
  await expect(page.locator('#clipsCount')).toHaveText('1/100');
});

/**
 * S-04, плохой путь 9 · копирование из менеджера паролей.
 * Секрет не показывается открыто: содержимое скрыто до прямого нажатия, и причина
 * названа. Значение при этом в журнал попало — скрытие относится к показу, а
 * запись пресекает чёрный список источников, это отдельная защита.
 */
test('REQ-CLIP-PRIVACY · запись с секретом скрыта до нажатия', async ({ page, deck }) => {
  await deck.reset();
  const token = ['gh', 'p_', 'A'.repeat(36)].join('');
  await addClips(deck, [{ text: `Токен для сборки: ${token}`, sourceApp: 'code.exe' }]);

  await open(page, deck, '#clips');
  await expect(clipRows(page)).toHaveCount(1);

  const row = clipRows(page).first();
  await expect(row).toHaveClass(/is-hidden/);
  await expect(row.locator('.text')).toContainText('токен GitHub');
  await expect(row.locator('.text')).not.toContainText(token);

  await row.click();
  await expect(row).not.toHaveClass(/is-hidden/);
  await expect(row.locator('.text')).toContainText(token);
});

test('S-04 · длинная запись показана превью, а не целиком', async ({ page, deck }) => {
  await deck.reset();
  const long = `НАЧАЛО ${'длинный текст записи. '.repeat(60)}КОНЕЦ`;
  await addClips(deck, [{ text: long }]);

  await open(page, deck, '#clips');
  await expect(clipRows(page)).toHaveCount(1);

  const shown = await clipRows(page).first().locator('.text').textContent();
  expect(shown).toContain('НАЧАЛО');
  expect(shown).not.toContain('КОНЕЦ');
  expect(shown.length).toBeLessThan(200);

  // Полный текст доступен, но только по прямому запросу одной записи. Ожидание
  // уведомления обязательно: «Копировать» сначала запрашивает текст у сервера.
  await seedClipboard(page, 'до-копирования');
  await openClipMenu(page);
  await page.click('#clipCopyBtn');
  await expect(page.locator('#toast')).toContainText('Скопировано');

  const copied = await readClipboard(page);
  expect(copied).toContain('НАЧАЛО');
  expect(copied).toContain('КОНЕЦ');
  expect(copied.length).toBeGreaterThan(shown.length);
});

/**
 * S-04, плохой путь 1 · журнал пуст.
 * Пустое состояние называет причину и следующее действие: «0 записей» без
 * объяснения — то же, что молчание (docs/UI-SPEC.md §5).
 */
test('REQ-UI-EMPTY · пустой журнал объясняет, что делать', async ({ page, deck }) => {
  await deck.reset();

  await open(page, deck, '#clips');

  await expect(page.locator('#clipsEmpty')).toBeVisible();
  await expect(page.locator('#clipsEmptyText')).toContainText('скопируйте что-нибудь');
  await expect(page.locator('#clipsList')).toBeHidden();
  await expect(page.locator('#clipsCount')).toHaveText('0/100');

  // Слежка идёт — значит запись появится сама, и это сказано.
  await expect(page.locator('#clipsWatch')).toContainText('слежка идёт');
});

test('§3.2 · новая запись приезжает в журнал без перезагрузки', async ({ page, deck }) => {
  await deck.reset();
  await addClips(deck, CLIPS.slice(0, 2));

  await open(page, deck, '#clips');
  await expect(clipRows(page)).toHaveCount(2);

  // Список обновляется по таймеру: журнал пополняется мостом, а не страницей.
  await deck.api('/api/clips', { method: 'POST', body: { text: 'приехала пока окно открыто' } });

  await expect(clipRows(page)).toHaveCount(3, { timeout: 4000 });
  await expect(clipRows(page).first().locator('.text')).toContainText('приехала пока окно открыто');
  await expect(page.locator('#clipsCount')).toHaveText('3/100');
});
