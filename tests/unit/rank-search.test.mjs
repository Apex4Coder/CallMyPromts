// tests/unit/rank-search.test.mjs — поиск по библиотеке.
//
// Требование: REQ-RANK-SEARCH (docs/SPEC.md §5). Сценарий: S-02.
//
// Задача поиска: человек помнит слово, но не помнит ни триггер, ни номер позиции.
// Три особенности, без которых поиск бесполезен именно на этой машине:
// исправление раскладки, отказ искать по телу на коротком запросе, возврат позиций
// совпадения для подсветки без вставки разметки.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  swapLayout,
  norm,
  queryVariants,
  matchSpan,
  search,
} from '../../rank/index.mjs';

/** Библиотека для поиска: поля подобраны так, чтобы проверять приоритеты полей. */
const LIB = () => [
  {
    id: 'c-review',
    title: 'Ревью кода',
    group: 'code',
    trigger: ':rev',
    tags: ['review', 'качество'],
    body: 'Проверь изменения и найди ошибки.',
    used: 30,
  },
  {
    id: 'c-bug',
    title: 'Поиск дефекта',
    group: 'code',
    trigger: ':bug',
    tags: ['debug'],
    body: 'Найди причину сбоя и предложи исправление. Ревью не требуется.',
    used: 6,
  },
  {
    id: 'r-deep',
    title: 'Глубокое исследование',
    group: 'research',
    trigger: null,
    tags: ['research'],
    body: 'Собери источники по теме.',
    used: 5,
  },
];

const ids = (list) => list.map((i) => i.id);

// ── раскладка ────────────────────────────────────────────────────────────────

test('латиница переводится в кириллицу по физическим клавишам', () => {
  assert.equal(swapLayout('htdm'), 'ревь');
  assert.equal(swapLayout('rjl'), 'код');
});

test('кириллица переводится в латиницу', () => {
  assert.equal(swapLayout('ревь'), 'htdm');
});

test('символы вне раскладки остаются как есть', () => {
  // Проверено по таблице физических клавиш: c→с, r→к, e→у, v→м, i→ш, w→ц.
  // Дефис в раскладке не участвует и остаётся на месте.
  assert.equal(swapLayout('123'), '123');
  assert.equal(swapLayout('c-review'), 'с-кумшуц');
});

test('перевод в обе стороны возвращает исходное', () => {
  for (const s of ['привет', 'hello', 'ревью']) {
    assert.equal(swapLayout(swapLayout(s)), s, `${s}: двойной перевод должен вернуть исходник`);
  }
});

test('пустая строка не роняет перевод', () => {
  assert.equal(swapLayout(''), '');
  assert.equal(swapLayout(null), '');
});

// ── нормализация ─────────────────────────────────────────────────────────────

test('нормализация снимает регистр, края и различие ё/е', () => {
  // «ревью» и «Ревью» — одно слово. «ёлка» и «елка» тоже: на клавиатуре «ё»
  // в стороне, и её часто не набирают.
  assert.equal(norm('  РЕВЬЮ  '), 'ревью');
  assert.equal(norm('Ёлка'), 'елка');
  assert.equal(norm(null), '');
});

test('варианты запроса: как набрано и как в другой раскладке', () => {
  assert.deepEqual(queryVariants('htdm'), ['htdm', 'ревь']);
  assert.deepEqual(queryVariants('ревь'), ['ревь', 'htdm']);
});

test('вариант не дублируется, когда раскладка ничего не меняет', () => {
  // Иначе поиск делал бы двойную работу на каждом нажатии клавиши.
  assert.deepEqual(queryVariants('123'), ['123']);
});

test('пустой запрос вариантов не даёт', () => {
  assert.deepEqual(queryVariants(''), []);
  assert.deepEqual(queryVariants('   '), []);
});

// ── позиции совпадения ───────────────────────────────────────────────────────

test('позиции совпадения указывают точный отрезок', () => {
  assert.deepEqual(matchSpan('Ревью кода', 'кода'), { start: 6, end: 10 });
  assert.deepEqual(matchSpan('Ревью кода', 'ревью'), { start: 0, end: 5 });
});

test('нет совпадения — null, а не нулевой отрезок', () => {
  // Отрезок 0..0 подсветил бы начало строки без причины.
  assert.equal(matchSpan('Ревью кода', 'питон'), null);
  assert.equal(matchSpan('', 'что-то'), null);
  assert.equal(matchSpan('текст', ''), null);
});

// ── поиск ────────────────────────────────────────────────────────────────────

test('находит по названию', () => {
  const out = search(LIB(), 'ревью');

  assert.equal(out.length >= 1, true);
  assert.equal(out[0].id, 'c-review');
  assert.equal(out[0]._match.field, 'title');
});

test('находит по неверной раскладке и помечает исправление', () => {
  // Именно этот случай: окно всплыло поверх чата, раскладка осталась английской.
  const out = search(LIB(), 'htdm');

  assert.equal(out[0].id, 'c-review');
  assert.equal(out[0]._match.corrected, true, 'интерфейс должен показать, что запрос исправлен');
  assert.equal(out[0]._match.query, 'ревь');
});

test('точное совпадение id важнее всего', () => {
  const out = search(LIB(), 'c-bug');

  assert.equal(out[0].id, 'c-bug');
  assert.equal(out[0]._match.field, 'id');
});

test('точное совпадение триггера идёт следом за id', () => {
  const out = search(LIB(), 'bug');

  assert.equal(out[0].id, 'c-bug');
  assert.equal(out[0]._match.field, 'trigger');
});

test('триггер находится и с двоеточием, и без него', () => {
  assert.equal(search(LIB(), ':rev')[0].id, 'c-review');
  assert.equal(search(LIB(), 'rev')[0].id, 'c-review');
});

test('начало названия важнее начала слова, а слово важнее части слова', () => {
  // Три уровня совпадения в названии, по убыванию полезности для человека:
  // название начинается с запроса → запрос начинает слово → запрос внутри слова.
  const items = [
    { id: 'c-mid', title: 'Проверка кода', used: 1 },
    { id: 'c-part', title: 'Перекодировка текста', used: 1 },
    { id: 'c-start', title: 'Кодовое имя', used: 1 },
  ];

  assert.deepEqual(ids(search(items, 'код')), ['c-start', 'c-mid', 'c-part']);
});

test('название важнее тела: человек ищет промпт, а не фразу внутри', () => {
  // «Ревью» есть в названии c-review и в теле c-bug. Первым обязан быть c-review.
  const out = search(LIB(), 'ревью');

  assert.equal(out[0].id, 'c-review');
  assert.equal(out[0]._score > out[1]._score, true);
  assert.equal(out[1].id, 'c-bug');
  assert.equal(out[1]._match.field, 'body');
});

test('находит по метке', () => {
  // Триггер `:bug` здесь не подходит: точное совпадение требует равенства
  // целиком, а «debug» это не «bug». Совпадает метка.
  const out = search(LIB(), 'debug');

  assert.equal(out[0].id, 'c-bug');
  assert.equal(out[0]._match.field, 'tags');
});

test('находит по русской метке', () => {
  const out = search(LIB(), 'качество');

  assert.equal(out[0].id, 'c-review');
  assert.equal(out[0]._match.field, 'tags');
});

test('метка важнее группы: она точнее описывает промпт', () => {
  const out = search(LIB(), 'research');

  assert.equal(out[0].id, 'r-deep');
  assert.equal(out[0]._match.field, 'tags');
});

test('находит по группе, когда ни название, ни метки не подходят', () => {
  const items = [{ id: 'p-x', title: 'Разбор ответа', group: 'parsing', tags: [], used: 1 }];

  const out = search(items, 'parsing');

  assert.equal(out.length, 1);
  assert.equal(out[0]._match.field, 'group');
});

test('запрос из одного символа не идёт по телу', () => {
  // Иначе одна буква совпала бы почти со всем, и выдача потеряла бы смысл
  // (S-02, плохой путь 3).
  const out = search(LIB(), 'о');

  assert.equal(out.every((i) => i._match.field !== 'body'), true, 'ни одного совпадения по телу');
});

test('запрос из двух символов уже ищет по телу', () => {
  const items = [{ id: 'c-x', title: 'Без совпадения', body: 'Уникальное слово: щавель.', used: 1 }];

  const out = search(items, 'ща');

  assert.equal(out.length, 1);
  assert.equal(out[0]._match.field, 'body');
});

test('пустой запрос возвращает всё без фильтрации', () => {
  const out = search(LIB(), '');

  assert.equal(out.length, 3);
  assert.equal(out.every((i) => i._match === null), true, 'пометки совпадения нет — искать было нечего');
});

test('пустой запрос не меняет порядок: за порядок отвечает order', () => {
  const out = search(LIB(), '   ');

  assert.deepEqual(ids(out), ids(LIB()));
});

test('ничего не найдено — пустой массив, а не весь список', () => {
  assert.deepEqual(search(LIB(), 'абракадабра'), []);
});

test('при равном весе первым идёт более частый', () => {
  const items = [
    { id: 'a', title: 'Кода проверка', used: 3 },
    { id: 'b', title: 'Кода разбор', used: 40 },
  ];

  assert.deepEqual(ids(search(items, 'кода')), ['b', 'a']);
});

test('поиск не изменяет исходные записи', () => {
  const items = LIB();

  search(items, 'ревью');

  assert.equal('_score' in items[0], false, 'служебные поля только в результате');
});

test('поиск выдерживает записи без полей', () => {
  // Битый промпт может не иметь ни названия, ни тела. Падение здесь означало бы,
  // что один битый файл ломает поиск по всей библиотеке (REQ-LIB-ISOLATE).
  const items = [{ id: 'c-broken' }, { id: 'c-ok', title: 'Ревью кода', used: 1 }];

  const out = search(items, 'ревью');

  assert.deepEqual(ids(out), ['c-ok']);
});

test('регулярные символы в запросе не ломают поиск', () => {
  // Запрос идёт через indexOf, а не через RegExp: иначе «(» роняло бы поиск.
  const items = [{ id: 'c-x', title: 'Функция f(x) в коде', used: 1 }];

  assert.deepEqual(ids(search(items, 'f(x)')), ['c-x']);
  assert.deepEqual(search(items, '['), []);
});

// Подсветка совпадения и текст пустой выдачи — в tests/unit/rank-highlight.test.mjs:
// это показ результата, а здесь отбор и вес полей (docs/RULES.md §3).
