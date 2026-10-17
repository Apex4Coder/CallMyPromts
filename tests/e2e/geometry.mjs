// tests/e2e/geometry.mjs — харнесс инвариантов геометрии: 10 машинных проверок.
//
// Требование: REQ-UI-GEOMETRY (docs/SPEC.md §7). Методичка: gld/ui-contract.txt §1.5.
// Используют: tests/e2e/geo-*.spec.mjs.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ
//
// Прежние 162 E2E-теста проверяли СМЫСЛ: те ли данные, то ли состояние, те ли слова.
// Геометрию они не проверяли вовсе — и это тот класс дефектов, который человек видит
// глазами, а гейт пропускает. Ровно это уже случилось в проекте дважды:
//
//   — вложенный `.field` давал 6 пикселей горизонтального скролла на 800×600;
//   — 29 промптов с пустым заголовком выглядели как список прочерков.
//
// Первое нашлось замером `scrollWidth`, второе — живым запуском. Ни один тест на
// «выглядит правильно» их не поймал бы, потому что таких тестов не было.
//
// ПРАВИЛО ФОРМУЛИРОВОК (словарь геометрии из методички, отменяет любые трактовки)
//
//   Полоса (strip) — ОДИН контейнер, элементы внутри в ОДНУ строку.
//                    «Метрики горизонтально» = одна полоса с N элементами,
//                    а НЕ N карточек и НЕ столбец.
//   Ряд (row)      — элементы с одинаковым `y` (±1px).
//   Столбец        — элементы с одинаковым `x` (±1px).
//
// Любое требование к вёрстке, которое нельзя выразить утверждением о боксах,
// считается неполным: сначала дописывается инвариант, потом правится код.
//
// ФОРМА КАЖДОЙ ПРОВЕРКИ
//
// Собрать СПИСОК нарушений и сравнить с пустым. Не `expect(ok).toBe(true)`: провал
// такого теста говорит «что-то не так», а список говорит ЧТО именно и где.

import { expect } from '@playwright/test';

/** Короткое имя узла для сообщения о нарушении. */
const NAMER = `(el) => el.getAttribute('data-testid')
  || el.id
  || (el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''))`;

/**
 * I1 — ни один узел не переполняет свой контейнер.
 *
 * Первый и самый ценный инвариант: именно он поймал вложенный `.field`. Узлы с
 * собственной прокруткой исключаются — для них переполнение и есть назначение.
 */
export const noOverflow = async (page, where = '') => {
  const bad = await page.evaluate(`(() => {
    const sel = ${NAMER};
    const out = [];

    for (const el of document.querySelectorAll('*')) {
      if (el.offsetParent === null && el !== document.body) continue;
      const cs = getComputedStyle(el);

      // Своя прокрутка: переполнение для такого узла и есть назначение.
      if (['auto', 'scroll'].includes(cs.overflowX) || ['auto', 'scroll'].includes(cs.overflowY)) continue;

      // Приём «скрыто от глаз, доступно для чтения с экрана»: узел размером 1×1 с
      // clip-path. Первый прогон дал 27 ложных срабатываний ровно на нём — подпись
      // поиска 95×19 внутри рамки 1×1. Это НЕ дефект вёрстки, а способ сохранить
      // текст для доступности, не показывая его. Проверка, которая краснеет на
      // приёме доступности, вынуждает выбирать между гейтом и доступностью.
      if (el.classList.contains('visually-hidden')) continue;
      if (cs.clipPath && cs.clipPath !== 'none') continue;
      if (el.clientWidth <= 1 && el.clientHeight <= 1) continue;

      // Значение overflow visible означает: содержимое ВЫХОДИТ за рамку, и это
      // разрешено по умолчанию. Второй источник ложных срабатываний — плашка
      // состояния 70px в ячейке 18px: она не обрезана, она нарисована шире.
      // Обрезание проверяет I2, там где оно действительно мешает нажать.
      //
      // Обратные кавычки в этом комментарии стоять НЕ МОГУТ: тело функции живёт в
      // строковом шаблоне, и первая же такая кавычка закрыла его — прогон упал с
      // SyntaxError на этой строке.
      const hidesX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
      const hidesY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';

      if (hidesX && el.scrollWidth > el.clientWidth + 1) {
        out.push('по ширине: ' + sel(el) + ' ' + el.scrollWidth + '>' + el.clientWidth);
      }
      if (hidesY && el.scrollHeight > el.clientHeight + 1) {
        out.push('по высоте: ' + sel(el) + ' ' + el.scrollHeight + '>' + el.clientHeight);
      }
    }
    return out;
  })()`);

  expect(bad, `${where}: содержимое обрезано контейнером`).toEqual([]);
};

/**
 * I2 — интерактивный элемент не обрезан, не перекрыт, не мельче 32px.
 *
 * Четыре нарушения в одной проверке, потому что у них одна причина — элемент есть, но
 * нажать его нельзя. Перекрытие проверяется `elementFromPoint`: центр кнопки обязан
 * принадлежать самой кнопке, иначе клик уйдёт чужому узлу.
 */
export const notClippedOrOccluded = async (page, where = '') => {
  const bad = await page.evaluate(`(() => {
    const sel = ${NAMER};
    const out = [];
    const nodes = document.querySelectorAll('button, a, [role=button], [role=menuitem], input, select, textarea');
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const name = sel(el);

      if (r.top < -1 || r.left < -1 || r.bottom > innerHeight + 1 || r.right > innerWidth + 1) {
        out.push('вне вьюпорта: ' + name);
        continue;
      }
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (top && !el.contains(top) && !top.contains(el)) out.push('перекрыт: ' + name + ' элементом ' + sel(top));
      if (el.scrollWidth > el.clientWidth + 1) out.push('текст обрезан: ' + name);

      // min-height: 32px — контракт минимальной цели. Методика запрещает цель
      // МЕНЬШЕ 32, а не требует, чтобы каждый элемент был ровно 32.
      //
      // Кнопки и поля ввода — интерактивные цели. Ссылки навигации и menuitem
      // допускаются меньше: у них есть дополнительная область строки/меню, и
      // первый прогон показал, что требование к каждому элементу создаёт шум
      // вместо локализации реального дефекта.
      //
      // getBoundingClientRect может вернуть 31.5px из-за device scale factor,
      // хотя CSS-контракт min-height 32px выполнен. Поэтому измерение нормализуется
      // вверх: дробное представление физического пикселя не должно превращать
      // соблюдённый контракт в красный тест.
      const needsTapTarget = el.matches('button, input, select, textarea, [role=button]');
      if (needsTapTarget && Math.ceil(r.height) < 32) {
        out.push('высота ' + Math.round(r.height) + 'px < 32: ' + name);
      }
    }
    return out;
  })()`);

  expect(bad, `${where}: элемент недоступен для нажатия`).toEqual([]);
};

/** I3 — у страницы нет горизонтальной прокрутки. */
export const noPageScroll = async (page, where = '') => {
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over, `${where}: страница шире окна на ${over}px`).toBeLessThanOrEqual(0);
};

/**
 * I4 — открытая панель целиком в окне, её кнопки видны без прокрутки.
 *
 * «Модалка» в терминах методички; здесь это контекстное меню журнала и превью.
 */
export const overlayFits = async (page, selector, where = '') => {
  const bad = await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.hidden) return [];
    const r = el.getBoundingClientRect();
    const out = [];
    if (r.top < 0) out.push('верх за экраном: ' + Math.round(r.top));
    if (r.bottom > innerHeight) out.push('низ за экраном: ' + Math.round(r.bottom - innerHeight) + 'px');
    if (r.left < 0) out.push('левый край за экраном');
    if (r.right > innerWidth) out.push('правый край за экраном: ' + Math.round(r.right - innerWidth) + 'px');

    for (const b of el.querySelectorAll('button, [role=menuitem]')) {
      const br = b.getBoundingClientRect();
      if (br.bottom > innerHeight || br.top < 0) out.push('кнопка вне экрана: ' + (b.textContent || '').trim().slice(0, 20));
    }
    return out;
  })()`);

  expect(bad, `${where}: панель ${selector} не влезает`).toEqual([]);
};

/**
 * I5 — элементы лежат в ОДНОМ ряду.
 *
 * Машинная форма слова «горизонтально» из словаря. Округление до целого убирает
 * дробные пиксели масштабирования, которые к переносу строки отношения не имеют.
 */
export const singleRow = async (page, selector, where = '') => {
  const rows = await page.evaluate(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter((e) => e.offsetParent !== null && getComputedStyle(e).display !== 'none')
      .filter((e) => !e.matches('input, label, [aria-hidden="true"]'));
    if (els.length === 0) return { count: 0, rows: [] };
    const ys = els.map((e) => Math.round(e.getBoundingClientRect().y));
    return { count: els.length, rows: [...new Set(ys)] };
  })()`);

  expect(rows.count, `${where}: не найдено ни одного ${selector}`).toBeGreaterThan(0);
  expect(rows.rows.length, `${where}: ${selector} разъехались на ${rows.rows.length} ряда`).toBe(1);
};

/** I6 — контейнер ровно один: полоса, а не N блоков. */
export const exactlyOne = async (page, selector, where = '') => {
  const n = await page.locator(selector).count();
  expect(n, `${where}: ${selector} встречается ${n} раз вместо одного`).toBe(1);
};

/**
 * I7 — прокручиваемый список не теряет позицию после действия.
 *
 * Проверяется по факту: запомнить `scrollTop`, выполнить действие, сверить. Сброс
 * прокрутки после каждого клика — самое раздражающее поведение длинных списков, и
 * заметить его без такой проверки можно только вручную.
 */
export const scrollKept = async (page, selector, action, where = '') => {
  const before = await page.locator(selector).evaluate((el) => {
    el.scrollTop = Math.min(300, el.scrollHeight);
    return el.scrollTop;
  });

  await action();

  const after = await page.locator(selector).evaluate((el) => el.scrollTop);
  expect(Math.abs(after - before), `${where}: прокрутка уехала с ${before} на ${after}`).toBeLessThanOrEqual(4);
};

/**
 * I8 — пустое состояние не схлопывает вёрстку.
 *
 * Ноль строк — законное состояние, а не отсутствие экрана. Высота нулевой высоты
 * означает, что человек видит пустоту без объяснения.
 */
export const emptyKeepsLayout = async (page, selector, where = '') => {
  const box = await page.locator(selector).boundingBox();
  expect(box, `${where}: ${selector} отсутствует на экране`).not.toBeNull();
  expect(box.height, `${where}: ${selector} схлопнулся в ноль`).toBeGreaterThan(24);
};

/**
 * I9 — обрезанный текст обязан иметь подсказку.
 *
 * Многоточие вместо текста допустимо, потеря текста — нет. `title` возвращает
 * содержимое по наведению.
 */
export const truncatedHasTitle = async (page, where = '') => {
  const bad = await page.evaluate(`(() => {
    const sel = ${NAMER};
    const out = [];

    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0 || el.offsetParent === null) continue;

      // Те же два исключения, что в I1, и по тем же причинам: скрытая подпись для
      // чтения с экрана и содержимое, которому разрешено выходить за рамку.
      // Обрезание — это когда текст ПРОПАЛ, а не когда он нарисован шире.
      if (el.classList.contains('visually-hidden')) continue;
      if (el.clientWidth <= 1) continue;

      const cs = getComputedStyle(el);
      if (cs.overflowX !== 'hidden' && cs.overflowX !== 'clip') continue;

      if (el.scrollWidth <= el.clientWidth + 1) continue;

      const text = (el.textContent || '').trim();
      if (text === '') continue;
      if (!el.getAttribute('title') && !el.closest('[title]')) {
        out.push(sel(el) + ': «' + text.slice(0, 24) + '»');
      }
    }
    return out;
  })()`);

  expect(bad, `${where}: текст обрезан без подсказки`).toEqual([]);
};

/**
 * I10 — на экране нет технических значений.
 *
 * Формально это не геометрия, но обнаруживается тем же способом и тем же прогоном:
 * `undefined` в подписи — это визуальный дефект, который человек видит первым.
 * Прежняя система показывала «NaN» на весь экран.
 */
export const noTechnicalText = async (page, where = '') => {
  const found = await page.evaluate(`(() => {
    const text = document.body.innerText;
    return ['undefined', 'NaN', 'null', 'Infinity', '[object Object]'].filter((w) => text.includes(w));
  })()`);

  expect(found, `${where}: на экране технические значения`).toEqual([]);
};

/**
 * Базовый набор: гоняется на КАЖДОМ экране в КАЖДОЙ ячейке матрицы.
 *
 * Пять проверок, не требующих знания конкретного экрана. Специфичные (полоса, панель,
 * прокрутка) вызываются отдельно там, где есть соответствующий элемент.
 */
export const checkAll = async (page, where = '') => {
  await noOverflow(page, where);
  await noPageScroll(page, where);
  await notClippedOrOccluded(page, where);
  await truncatedHasTitle(page, where);
  await noTechnicalText(page, where);
};
