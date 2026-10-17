// tests/e2e/service.spec.mjs — управление сервисом: остановка, перезапуск, отказ.
//
// Требования: REQ-API-SERVICE, REQ-UI-SETTINGS (docs/SPEC.md §6, §7). Сценарий S-08.
//
// Этот файл появился после провала теста доступности: кнопки «Запустить»,
// «Остановить», «Перезапустить» существовали в разметке и не делали НИЧЕГО. Ни
// обработчика, ни маршрута. Нажатие клавиатурой ничего не меняло, и это было не
// нарушение доступности, а отсутствующая функция, которую тест доступности нашёл
// первым — потому что он единственный нажимал эти кнопки.
//
// Проверяется не только «работает», но и граница: остановка спрашивает
// подтверждение, а «Запустить» отказывает с причиной. Кнопка, которая молча ничего
// не делает — тот же дефект, который здесь исправлен, поэтому недоступность
// обязана быть объяснённой (docs/RULES.md §4).
//
// Фактическое завершение процесса этот файл не воспроизводит: сервер поднят
// внутри процесса-исполнителя Playwright, и настоящий выход убил бы все
// остальные тесты. Фикстура подставляет `control.shutdown`, который записывает
// вызов (tests/e2e/deck.mjs). Проверяется вся цепочка до последнего звена —
// кнопка, подтверждение, запрос, команда процессу, — а само `process.exit`
// принадлежит запуску из командной строки и здесь не исполняется.

import { test, expect, open } from './deck.mjs';

/** Три кнопки раздела «Сервис» (docs/UI-SPEC.md §3.3). */
const BUTTONS = ['svcStartBtn', 'svcStopBtn', 'svcRestartBtn'];

test.beforeAll(async ({ deck }) => {
  await deck.reset();
});

test('S-08 · сервер перечисляет доступные действия, а не страница угадывает', async ({ deck }) => {
  const out = await deck.api('/api/service');

  expect(out.status).toBe(200);
  expect(out.data.actions.start.allowed).toBe(false);
  expect(out.data.actions.start.why).toContain('это окно отдал он');

  expect(out.data.actions.stop.allowed).toBe(true);
  expect(out.data.actions.restart.allowed).toBe(true);

  // Планы приходят оттуда же: текст последствия не дублируется в интерфейсе.
  expect(out.data.plans.stop.effect).toContain('Слежка за буфером остановится');
  expect(out.data.plans.stop.effect).toContain('Значок в трее останется');
  expect(out.data.plans.restart.effect).toContain('перечитает горячие клавиши');
});

test('S-08 · «Запустить» недоступна, и причина написана, а не подразумевается', async ({ page, deck }) => {
  await open(page, deck, '#deck');
  await expect(page.locator('#svcState')).toContainText('работает');

  const start = page.locator('#svcStartBtn');
  await expect(start).toBeDisabled();
  await expect(start).toHaveAttribute('title', /значком в трее|уже работает/);
});

/**
 * Прямой запрос «запустить» отвергается с 409.
 * Причина не формальная: запрос доходит только если сервис жив, а значит запускать
 * нечего. Молчаливый `200 ok` здесь означал бы «сделано» без действия.
 */
test('S-08 · POST start отвергается с объяснением', async ({ deck }) => {
  const out = await deck.api('/api/service', { method: 'POST', body: { action: 'start' } });

  expect(out.status).toBe(409);
  expect(out.data.error).toBe('already_running');
  expect(out.data.expected).toBe('stop | restart');
});

test('S-08 · неизвестное действие названо, допустимые перечислены', async ({ deck }) => {
  const out = await deck.api('/api/service', { method: 'POST', body: { action: 'выключить' } });

  expect(out.status).toBe(400);
  expect(out.data.error).toBe('bad_action');
  expect(out.data.message).toContain('выключить');
  expect(out.data.expected).toContain('stop');
});

/**
 * Первый запрос НЕ выполняет остановку.
 * Это главная проверка файла: если бы выполнял, один клик выключал бы горячие
 * клавиши без предупреждения, и человек искал бы причину «почему перестало
 * работать» (docs/RULES.md §6).
 */
test('S-08 · запрос без подтверждения только объясняет последствие', async ({ deck }) => {
  await deck.reset();
  const out = await deck.api('/api/service', { method: 'POST', body: { action: 'stop' } });

  expect(out.status).toBe(200);
  expect(out.data.done, 'остановка выполнена без подтверждения').toBeUndefined();
  expect(out.data.plan.word).toContain('Остановить');
  expect(out.data.plan.effect).toContain('Промпты и журнал останутся на диске');

  // Команда процессу не отдана: это и есть смысл первого шага.
  expect(deck.shutdowns, 'сервис остановлен без подтверждения').toEqual([]);

  // Сервис действительно работает: следующий запрос отвечает.
  const still = await deck.api('/api/system');
  expect(still.status).toBe(200);
  expect(still.data.service.state).toBe('good');
});

test('S-08 · подтверждённая остановка доходит до процесса', async ({ deck }) => {
  await deck.reset();
  const out = await deck.api('/api/service', { method: 'POST', body: { action: 'stop', confirm: true } });

  expect(out.status).toBe(200);
  expect(out.data.done).toBe('stop');
  // Остановка без перезапуска: `restart: false` отличает её от перезапуска, и
  // именно этот флаг решает, поднимется ли новый процесс (server/index.mjs).
  expect(deck.shutdowns).toEqual([{ restart: false }]);
});

test('S-08 · подтверждённый перезапуск просит поднять новый процесс', async ({ deck }) => {
  await deck.reset();
  const out = await deck.api('/api/service', { method: 'POST', body: { action: 'restart', confirm: true } });

  expect(out.status).toBe(200);
  expect(out.data.done).toBe('restart');
  expect(deck.shutdowns).toEqual([{ restart: true }]);
});

/**
 * Интерфейс спрашивает перед остановкой.
 * Диалог отклоняется — сервис обязан остаться работать, и об этом сказано.
 */
test('S-08 · отказ в подтверждении оставляет сервис работать', async ({ page, deck }) => {
  await deck.reset();
  await open(page, deck, '#deck');
  await expect(page.locator('#svcStopBtn')).toBeEnabled();

  const asked = [];
  page.on('dialog', (d) => {
    asked.push(d.message());
    d.dismiss();
  });

  await page.click('#svcStopBtn');

  await expect(page.locator('#toast')).toContainText('Отменено');
  expect(asked.length, 'остановка пошла без вопроса').toBe(1);
  expect(asked[0]).toContain('Остановить сервис?');
  expect(asked[0]).toContain('Слежка за буфером');
  expect(deck.shutdowns, 'отказ всё равно остановил сервис').toEqual([]);

  // Кнопки на месте: отказ ничего не сломал.
  await expect(page.locator('#svcStopBtn')).toBeEnabled();
  await expect(page.locator('#svcState')).toContainText('работает');
});

/**
 * Согласие доводит команду до процесса и говорит, что делать дальше.
 * «Остановлено» без «запустить — значком в трее» оставило бы человека с окном,
 * которое перестало работать, и без способа это исправить.
 */
test('S-08 · согласие останавливает и объясняет, как запустить обратно', async ({ page, deck }) => {
  await deck.reset();
  await open(page, deck, '#deck');
  await expect(page.locator('#svcStopBtn')).toBeEnabled();

  page.on('dialog', (d) => d.accept());
  await page.click('#svcStopBtn');

  await expect(page.locator('#toast')).toContainText('значком в трее');
  await expect(page.locator('#svcState')).toContainText('останавливается');

  // Повторное нажатие невозможно: кнопки выключены сразу после команды.
  await expect(page.locator('#svcStopBtn')).toBeDisabled();
  await expect(page.locator('#svcRestartBtn')).toBeDisabled();

  await expect.poll(() => deck.shutdowns.length, { timeout: 3000 }).toBe(1);
  expect(deck.shutdowns[0]).toEqual({ restart: false });
});

test('S-08 · перезапуск объясняет, зачем он нужен после смены хоткея', async ({ page, deck }) => {
  await deck.reset();
  await open(page, deck, '#deck');

  const asked = [];
  page.on('dialog', (d) => {
    asked.push(d.message());
    d.dismiss();
  });

  await page.click('#svcRestartBtn');

  // Ожидание обязательно: между кликом и вопросом есть запрос к серверу, и без
  // него проверка читала бы пустой список. Первая версия теста падала здесь.
  await expect(page.locator('#toast')).toContainText('Отменено');

  expect(asked[0]).toContain('Перезапустить сервис?');
  // Связь с предупреждением из раздела хоткеев: там сказано «после
  // «Перезапустить сервис»», здесь — что именно это даст.
  expect(asked[0]).toContain('перечитает горячие клавиши');
});

test('S-08 · нажатие Enter на кнопке делает то же, что клик', async ({ page, deck }) => {
  await deck.reset();
  await open(page, deck, '#deck');

  const asked = [];
  page.on('dialog', (d) => {
    asked.push(d.message());
    d.dismiss();
  });

  await page.focus('#svcRestartBtn');
  await page.keyboard.press('Enter');

  await expect(page.locator('#toast')).toContainText('Отменено');
  expect(asked.length, 'клавиатура не запустила действие').toBe(1);
});

test('§3.3 · все три кнопки на месте, состояние каждой объяснено', async ({ page, deck }) => {
  await deck.reset();
  await open(page, deck, '#deck');

  for (const id of BUTTONS) {
    const el = page.locator(`#${id}`);
    await expect(el, `нет кнопки #${id}`).toHaveCount(1);
    await expect(el).toBeVisible();

    // Недоступная кнопка обязана объяснять, почему: серая кнопка без причины
    // выглядит как поломка.
    if (await el.isDisabled()) {
      const why = await el.getAttribute('title');
      expect(why, `#${id} недоступна без объяснения`).toBeTruthy();
    }
  }
});
