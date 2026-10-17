// tests/unit/yaml.test.mjs — единственный парсер YAML в проекте.
//
// Требование: REQ-CT-YAML (docs/SPEC.md §2). Подмножество: DATA-CONTRACTS §7.
//
// Главное свойство парсера — предсказуемый отказ. Прежняя система собирала один
// base.yml из всех промптов без проверки, и один сломанный файл убивал все 26
// триггеров. Здесь ошибка обязана называть строку, иначе поиск причины
// превращается в перебор файлов вслепую.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFlatYaml, splitFrontmatter, buildFrontmatter, buildPromptFile, ContractError, FIELD_ORDER,
} from '../../contracts/index.mjs';

test('читает строки, числа, null и логические значения', () => {
  const got = parseFlatYaml([
    'id: "c-review"',
    'title: Ревью кода',
    'used: 12',
    'pin: null',
    'ready: true',
  ].join('\n'));

  assert.equal(got.id, 'c-review');
  assert.equal(got.title, 'Ревью кода');
  assert.equal(got.used, 12);
  assert.equal(got.pin, null);
  assert.equal(got.ready, true);
});

test('читает плоский список в квадратных скобках', () => {
  const got = parseFlatYaml('tags: ["code", "review"]');
  assert.deepEqual(got.tags, ['code', 'review']);
});

test('пустое значение — это null, а не пустая строка', () => {
  const got = parseFlatYaml('trigger:');
  assert.equal(got.trigger, null);
});

test('двоеточие внутри значения не ломает разбор', () => {
  const got = parseFlatYaml('title: "Ревью: что смотреть"');
  assert.equal(got.title, 'Ревью: что смотреть');
});

test('отвергает то, чего не понимает, и называет строку', () => {
  const cases = [
    ['block: |', 'блочный литерал'],
    ['fold: >', 'сложенный литерал'],
    ['  indented: 1', 'отступ'],
    ['anchor: &a 1', 'якорь'],
    ['ref: *a', 'ссылка'],
  ];

  for (const [text, what] of cases) {
    assert.throws(
      () => parseFlatYaml(`ok: 1\n${text}`),
      (err) => {
        assert.ok(err instanceof ContractError, `${what}: должна быть ContractError`);
        assert.equal(err.line, 2, `${what}: должна называться строка 2`);
        return true;
      },
      `${what} должен быть отвергнут`,
    );
  }
});

test('дубликат ключа — ошибка: молчаливое перекрытие меняет смысл файла', () => {
  assert.throws(
    () => parseFlatYaml('id: a\nid: b'),
    (err) => err instanceof ContractError && err.line === 2,
  );
});

test('незакрытый список отвергается', () => {
  assert.throws(() => parseFlatYaml('tags: ["a", "b"'), ContractError);
});

test('splitFrontmatter делит метаданные и тело', () => {
  const raw = '---\nid: "c-x"\ntitle: "Имя"\n---\n\nТело промпта.\n';
  const got = splitFrontmatter(raw, 'code/c-x.md');

  assert.equal(got.hasFrontmatter, true);
  assert.equal(got.meta.id, 'c-x');
  assert.equal(got.body.trim(), 'Тело промпта.');
});

test('отсутствие frontmatter не выбрасывает: это замечание валидатора, не сбой парсера', () => {
  const got = splitFrontmatter('просто текст без метаданных', 'code/x.md');
  assert.equal(got.hasFrontmatter, false);
  assert.equal(got.body, 'просто текст без метаданных');
});

test('незакрытый frontmatter не выбрасывает, но называет причину', () => {
  // Исключение здесь означало бы падение чтения библиотеки из-за одного файла.
  // Поэтому это состояние, а не сбой: hasFrontmatter=false и reason='unclosed',
  // из которого валидатор строит V-P-1 с точной формулировкой.
  const got = splitFrontmatter('---\nid: "a"\nтело без закрытия', 'code/x.md');

  assert.equal(got.hasFrontmatter, false);
  assert.equal(got.reason, 'unclosed');
  assert.deepEqual(got.meta, {});
});

test('порча внутри frontmatter выбрасывается с местом: строку можно показать', () => {
  assert.throws(
    () => splitFrontmatter('---\nid: "a"\n  bad: 1\n---\nтело', 'code/x.md'),
    (err) => err instanceof ContractError && err.file === 'code/x.md' && err.line === 3,
  );
});

test('отсутствие и незакрытость различаются: чинятся по-разному', () => {
  assert.equal(splitFrontmatter('просто текст').reason, 'no_fence');
  assert.equal(splitFrontmatter('---\nid: "a"').reason, 'unclosed');
  assert.equal(splitFrontmatter('---\nid: "a"\n---\nтело').reason, null);
});

test('три дефиса внутри тела не считаются закрытием второй раз', () => {
  const raw = '---\nid: "c-x"\ntitle: "Имя"\n---\n\nТекст\n\n---\n\nПродолжение\n';
  const got = splitFrontmatter(raw, 'code/c-x.md');

  assert.equal(got.meta.id, 'c-x');
  assert.match(got.body, /Продолжение/, 'разделитель в теле должен остаться в теле');
});

test('запись и чтение дают исходные данные', () => {
  const meta = {
    id: 'c-x', title: 'Имя с "кавычками"', group: 'code', pin: 3,
    used: 7, tags: ['a', 'b'], last_used: null,
  };

  const text = buildFrontmatter(meta, FIELD_ORDER);
  const back = splitFrontmatter(`${text}\nтело\n`, 'x.md');

  assert.equal(back.meta.id, 'c-x');
  assert.equal(back.meta.pin, 3);
  assert.equal(back.meta.used, 7);
  assert.deepEqual(back.meta.tags, ['a', 'b']);
  assert.equal(back.meta.last_used, null);
});

test('порядок ключей стабилен — от этого зависит читаемость diff', () => {
  const a = buildFrontmatter({ title: 'Б', id: 'a', group: 'code' }, FIELD_ORDER);
  const b = buildFrontmatter({ group: 'code', id: 'a', title: 'Б' }, FIELD_ORDER);
  assert.equal(a, b, 'один набор полей должен давать один текст независимо от порядка объекта');
});

test('buildPromptFile завершает файл переводом строки', () => {
  const out = buildPromptFile({ id: 'a', title: 'Имя', group: 'code' }, 'тело', FIELD_ORDER);
  assert.ok(out.startsWith('---\n'));
  assert.ok(out.endsWith('\n'));
});
