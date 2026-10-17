// tests/unit/settings.test.mjs — схема настроек и их слияние.
//
// Требование: REQ-CT-SETTINGS (docs/SPEC.md §2). Правила V-S-*: DATA-CONTRACTS §3.
// Сценарий S-09.
//
// Ключевое требование V-S-4: приложение с испорченной настройкой обязано
// запуститься на значениях по умолчанию и СКАЗАТЬ об этом. Приложение, которое не
// стартует из-за одной опечатки, хуже приложения с настройками по умолчанию.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULTS, validateSettings, mergeSettings,
  LAYOUTS, THEMES, MOTIONS, ACCENTS, ORDER_MODES,
} from '../../contracts/index.mjs';

test('умолчания валидны сами по себе', () => {
  assert.deepEqual(validateSettings(DEFAULTS), []);
});

test('все варианты оформления перечислены: владелец выбирает в рантайме', () => {
  assert.deepEqual(LAYOUTS, ['palette', 'panels', 'hybrid']);
  assert.deepEqual(THEMES, ['light', 'dark', 'system']);
  assert.deepEqual(MOTIONS, ['full', 'reduced', 'off']);
  assert.equal(ACCENTS.length, 5, 'пять акцентов; красный и зелёный заняты статусами');
  assert.deepEqual(ORDER_MODES, ['pinned-frequency', 'manual']);
});

test('V-S-1 неизвестный ключ — bad с путём к нему', () => {
  const issues = validateSettings({ ui: { выдумка: 1 } });
  const issue = issues.find((i) => i.code === 'V-S-1');

  assert.equal(issue.level, 'bad');
  assert.equal(issue.field, 'ui.выдумка');
});

test('V-S-2 значение вне списка — bad с перечислением допустимых', () => {
  const issue = validateSettings({ ui: { layout: 'выдумка' } })[0];

  assert.equal(issue.code, 'V-S-2');
  assert.equal(issue.field, 'ui.layout');
  assert.match(issue.expected, /palette/);
});

test('V-S-2 число вне диапазона — bad с диапазоном', () => {
  const issue = validateSettings({ clipboard: { limit: 5 } })[0];
  assert.equal(issue.code, 'V-S-2');
  assert.match(issue.expected, /20/);
});

test('V-S-2 не тот тип — bad', () => {
  assert.equal(validateSettings({ ui: { show_badges: 'да' } })[0].code, 'V-S-2');
  assert.equal(validateSettings({ library: { path: '' } })[0].code, 'V-S-2');
});

test('V-S-5 пустой хоткей допустим: означает «не назначено»', () => {
  assert.deepEqual(validateSettings({ hotkeys: { toggle_watch: '' } }), []);
});

test('хоткей без модификатора отвергается', () => {
  assert.ok(validateSettings({ hotkeys: { open_picker: 'q' } }).length > 0);
});

test('mergeSettings дополняет частичные настройки умолчаниями', () => {
  const { settings, issues } = mergeSettings({ ui: { theme: 'dark' } });

  assert.equal(settings.ui.theme, 'dark');
  assert.equal(settings.ui.layout, DEFAULTS.ui.layout, 'остальное берётся из умолчаний');
  assert.equal(settings.clipboard.limit, DEFAULTS.clipboard.limit);
  assert.deepEqual(issues.filter((i) => i.level === 'bad'), []);
});

test('V-S-4 испорченное значение заменяется умолчанием, и подмена названа', () => {
  const { settings, issues } = mergeSettings({ ui: { layout: 'выдумка', theme: 'dark' } });

  assert.equal(settings.ui.layout, DEFAULTS.ui.layout, 'битое значение заменено');
  assert.equal(settings.ui.theme, 'dark', 'валидные значения сохранены');
  assert.ok(issues.some((i) => i.field === 'ui.layout'), 'подмена должна быть объяснена');
});

test('пустой объект даёт полные умолчания без замечаний', () => {
  const { settings, issues } = mergeSettings({});
  assert.deepEqual(settings.ui, DEFAULTS.ui);
  assert.deepEqual(issues, []);
});

test('мусор вместо объекта не роняет разбор', () => {
  for (const junk of [null, undefined, 'строка', 42, []]) {
    const { settings } = mergeSettings(junk);
    assert.equal(settings.ui.layout, DEFAULTS.ui.layout, `вход ${JSON.stringify(junk)}`);
  }
});

test('чёрный список приходит из настроек списком строк', () => {
  const { settings, issues } = mergeSettings({ clipboard: { blacklist: ['keepass', 'мой'] } });
  assert.deepEqual(settings.clipboard.blacklist, ['keepass', 'мой']);
  assert.deepEqual(issues, []);
});

test('не список в blacklist отвергается', () => {
  assert.ok(validateSettings({ clipboard: { blacklist: 'keepass' } }).length > 0);
});

test('умолчания не изменяются при слиянии: структура клонируется', () => {
  const before = JSON.stringify(DEFAULTS);
  const { settings } = mergeSettings({ ui: { theme: 'dark' } });
  settings.ui.theme = 'light';
  settings.clipboard.blacklist.push('подмена');

  assert.equal(JSON.stringify(DEFAULTS), before, 'DEFAULTS должен остаться неизменным');
});
