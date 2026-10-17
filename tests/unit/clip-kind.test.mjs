// tests/unit/clip-kind.test.mjs — прикладной вид над типом записи.
//
// Требование: REQ-CLIP-KIND (docs/SPEC.md §4). Модуль: clipboard/kind.mjs.
// Сценарий: S-04 (фильтры в журнале буфера).
//
// Схема типов проверяется в tests/unit/clip-schema.test.mjs. Здесь — то, что
// видит человек: подпись, глиф, фильтры, догадка о языке кода.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KIND_VIEW,
  KIND_FILTERS,
  guessLanguage,
  describeKind,
  matchesFilter,
  countByFilter,
} from '../../clipboard/index.mjs';

import { KINDS } from '../../contracts/index.mjs';

// ── подписи и глифы ──────────────────────────────────────────────────────────

test('у каждого типа схемы есть подпись и глиф', () => {
  // Тип без подписи показался бы в интерфейсе как «undefined».
  for (const k of KINDS) {
    assert.ok(KIND_VIEW[k], `${k}: нет вида`);
    assert.equal(typeof KIND_VIEW[k].label, 'string');
    assert.equal(KIND_VIEW[k].label.trim() !== '', true);
    assert.equal(KIND_VIEW[k].glyph.trim() !== '', true);
  }
});

test('подписи не повторяются: два типа с одним словом не различить', () => {
  const labels = KINDS.map((k) => KIND_VIEW[k].label);

  assert.equal(new Set(labels).size, labels.length);
});

test('вид не задаёт цвет: цвет только усиление, а не носитель смысла', () => {
  // docs/RULES.md §5: около 8% мужчин не различают красный и зелёный.
  for (const k of KINDS) {
    assert.equal('color' in KIND_VIEW[k], false, `${k}: цвет в KIND_VIEW недопустим`);
  }
});

// ── фильтры ──────────────────────────────────────────────────────────────────

test('первый фильтр — «все»: чаще всего нужен весь список', () => {
  assert.equal(KIND_FILTERS[0].id, 'all');
  assert.equal(KIND_FILTERS[0].kinds, null);
});

test('каждый тип попадает хотя бы под один фильтр кроме «все»', () => {
  // Тип, недостижимый фильтрами, выглядел бы как пропавшие записи.
  const covered = new Set(KIND_FILTERS.filter((f) => f.kinds).flatMap((f) => f.kinds));

  for (const k of KINDS) assert.equal(covered.has(k), true, `${k}: не покрыт фильтрами`);
});

test('ссылки и почта в одном фильтре: для человека это одно действие', () => {
  const link = KIND_FILTERS.find((f) => f.id === 'link');

  assert.deepEqual(link.kinds, ['url', 'email']);
});

test('фильтр «все» пропускает любой тип', () => {
  for (const k of KINDS) assert.equal(matchesFilter(k, 'all'), true);
});

test('фильтр отбирает свои типы и отсекает чужие', () => {
  assert.equal(matchesFilter('url', 'link'), true);
  assert.equal(matchesFilter('email', 'link'), true);
  assert.equal(matchesFilter('text', 'link'), false);
  assert.equal(matchesFilter('code', 'code'), true);
  assert.equal(matchesFilter('text', 'code'), false);
});

test('неизвестный фильтр не скрывает ничего', () => {
  // Опечатка в идентификаторе фильтра не должна выглядеть как пустой журнал.
  assert.equal(matchesFilter('text', 'такого-фильтра-нет'), true);
  assert.equal(matchesFilter('text', null), true);
  assert.equal(matchesFilter('text', ''), true);
});

test('счётчики по фильтрам складывают свои типы', () => {
  const out = countByFilter({ text: 40, code: 12, url: 5, email: 2, path: 1 });

  assert.equal(out.all, 60, '«все» — сумма всего');
  assert.equal(out.text, 40);
  assert.equal(out.link, 7, 'ссылки и почта вместе');
  assert.equal(out.path, 1);
  assert.equal(out.image, 0, 'отсутствующий тип даёт ноль, а не undefined');
});

test('счётчики от пустого журнала — нули по всем фильтрам', () => {
  const out = countByFilter({});

  for (const f of KIND_FILTERS) assert.equal(out[f.id], 0, `${f.id}: ожидался ноль`);
});

test('мусор в счётчиках не превращается в NaN', () => {
  // NaN в подписи вкладки выглядит как поломка всей панели.
  const out = countByFilter({ text: 'много', code: null, url: undefined });

  for (const f of KIND_FILTERS) assert.equal(Number.isFinite(out[f.id]), true, `${f.id}: NaN`);
});

// ── describeKind ─────────────────────────────────────────────────────────────

test('описание типа даёт подпись и глиф по содержимому', () => {
  const out = describeKind('https://example.com/page');

  assert.equal(out.kind, 'url');
  assert.equal(out.label, 'ссылка');
  assert.equal(out.glyph, '↗');
  assert.equal(out.language, null, 'язык только у кода');
});

test('готовый тип из базы используется вместо повторного определения', () => {
  // Записи в журнале уже классифицированы. Повторное определение при отрисовке
  // означало бы, что список может разойтись с базой.
  const out = describeKind('обычный текст', { kind: 'code' });

  assert.equal(out.kind, 'code');
});

test('недопустимый готовый тип игнорируется и определяется заново', () => {
  const out = describeKind('https://example.com/page', { kind: 'придуманный' });

  assert.equal(out.kind, 'url');
});

test('картинка описывается без обращения к содержимому', () => {
  const out = describeKind('', { isImage: true });

  assert.equal(out.kind, 'image');
  assert.equal(out.label, 'картинка');
});

test('неизвестный тип не роняет описание, а показывается как текст', () => {
  const out = describeKind('строка', { kind: 'text' });

  assert.equal(out.label, 'текст');
  assert.equal(out.glyph, '¶');
});

// ── догадка о языке ──────────────────────────────────────────────────────────

test('язык определяется по нескольким признакам', () => {
  assert.equal(guessLanguage('def f(self):\n    import os\n    return os'), 'python');
  assert.equal(guessLanguage('const f = () => 1;\nexport default f;'), 'javascript');
  assert.equal(guessLanguage('<div class="a"></div>\n<!doctype html>'), 'html');
  assert.equal(guessLanguage('.button {\n  color: red;\n}'), 'css');
  assert.equal(guessLanguage('SELECT id FROM users\nINSERT INTO logs VALUES (1)'), 'sql');
});

test('одного признака недостаточно: чужой язык хуже никакого', () => {
  // Подписать питон как javascript — сбить человека с толку. Отсутствие подписи
  // честнее (docs/RULES.md §4).
  assert.equal(guessLanguage('x => x'), null, 'одна стрелка не делает текст кодом');
  assert.equal(guessLanguage('обычный текст на русском языке'), null);
});

test('пустой и пробельный текст языка не имеют', () => {
  assert.equal(guessLanguage(''), null);
  assert.equal(guessLanguage('   \n\t '), null);
  assert.equal(guessLanguage(null), null);
  assert.equal(guessLanguage(undefined), null);
});

test('язык прикладывается только к коду', () => {
  const asCode = describeKind('def f(self):\n    import os\n    return os', { kind: 'code' });
  const asText = describeKind('def f(self):\n    import os\n    return os', { kind: 'text' });

  assert.equal(asCode.language, 'python');
  assert.equal(asText.language, null, 'подпись языка у текста сбивала бы с толку');
});
