// tests/e2e/geometry-contract.spec.mjs — проверка layout-контракта экрана.
//
// Требование: REQ-UI-GEOMETRY (docs/SPEC.md §14). Методичка: gld/ui-contract.txt §2.2.
// Контракт: docs/contracts/ui/picker.yaml.
// Харнесс инвариантов: tests/e2e/geometry.mjs.
//
// Это первый автоматизированный валидатор layout-contract. Он не пытается стать
// YAML-парсером проекта: контракт намеренно остаётся плоским, а проверяемая часть
// выбирает regions по стабильным CSS-селекторам и прогоняет базовые DOM-инварианты.
//
// Экран без контракта — красный тест. Регион, который объявлен в контракте, но
// исчез из DOM, — красный тест. Это закрывает старый разрыв «кодер понял слово
// горизонтально иначе»: слово теперь имя компонента + измеримое assertion.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { open, test as e2e, LIBRARY } from './deck.mjs';
import {
  checkAll, noOverflow, noPageScroll, notClippedOrOccluded, singleRow,
} from './geometry.mjs';

const CONTRACT = join(process.cwd(), 'docs', 'contracts', 'ui', 'picker.yaml');

/**
 * Плоская часть YAML: извлекает `selector` у региона по его id.
 *
 * Не использует внешний YAML-пакет: ноль новых зависимостей — требование config.
 * Кавычки снимаются, пробелы вокруг значения — тоже.
 */
const selectors = () => {
  const text = readFileSync(CONTRACT, 'utf8');
  const rows = [...text.matchAll(/^  - id: ([\w-]+)\r?\n    selector: "([^"]+)"/gm)];
  return new Map(rows.map(([, id, selector]) => [id, selector]));
};

const REGION_SELECTORS = selectors();

const expectRegions = async (page) => {
  const missing = [];
  for (const [id, selector] of REGION_SELECTORS) {
    if (selector === '#clips' || selector === '#deck' || selector === '#stagePicker') continue;
    const count = await page.locator(selector).count();
    if (count !== 1) missing.push(`${id}: ${selector} найдено ${count}`);
  }
  assert.deepEqual(missing, [], 'контрактный регион отсутствует или не уникален');
};

e2e('layout-contract · YAML существует и описывает все регионы', async () => {
  assert.equal(REGION_SELECTORS.size, 10);
  assert.equal(REGION_SELECTORS.get('picker-head'), '#pickerHead');
  assert.equal(REGION_SELECTORS.get('clips-list'), '#clipsList');
  assert.equal(REGION_SELECTORS.get('deck-main'), '#deckMain');
});

e2e('layout-contract · окно выбора удовлетворяет контракту', async ({ page, deck }) => {
  await deck.reset();
  deck.seed(LIBRARY);
  await open(page, deck);
  await page.locator('#pickerList .row').first().waitFor();

  await expectRegions(page);
  await checkAll(page, 'layout-contract picker');
  await noOverflow(page, 'picker regions');
  await noPageScroll(page, 'picker page');

  // Контракт объявляет picker-list DataList в одну вертикальную колонку, а picker-head
  // Toolbar в ряд. Это две разные геометрические истины, обе измеряем.
  await singleRow(page, '#pickerHead > *', 'picker toolbar');
});

e2e('layout-contract · окно управления удовлетворяет контракту', async ({ page, deck }) => {
  await deck.reset();
  deck.seed(LIBRARY);
  await open(page, deck, '#deck');

  await expectRegions(page);
  await checkAll(page, 'layout-contract deck');
  await noPageScroll(page, 'deck page');
  await notClippedOrOccluded(page, 'deck controls');
});

e2e('layout-contract · журнал удовлетворяет контракту', async ({ page, deck }) => {
  await deck.reset();
  await open(page, deck, '#clips');
  await page.locator('#clipsEmpty').waitFor();

  await expectRegions(page);
  await checkAll(page, 'layout-contract clips');
  await noPageScroll(page, 'clips page');

  // Контракт объявляет clips-head Toolbar, но его дочерние элементы принадлежат
  // двум регионам: верхняя строка `clipsSearch`/pause и отдельная полоса фильтров.
  // I5 проверяет только первую строку — проверять прямых детей означало бы
  // объявить вложенную структуру одним рядом и снова получить ложный контракт.
  await singleRow(page, '#clipsSearch, #clipsPauseBtn', 'clips toolbar first row');
});
