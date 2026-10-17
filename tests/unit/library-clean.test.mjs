// tests/unit/library-clean.test.mjs — очистка текста перед выдачей в чат.
//
// Требование: REQ-LIB-CLEAN (docs/SPEC.md §3). Порядок операций: DATA-CONTRACTS §1.4.
// Сценарий S-03.
//
// Зачем это проверять. Разведка ClipClip показала: 19 из 39 клипов — HTML с
// инлайн-стилями от Google Docs. Вставить такое в чат означает отправить модели
// разметку вместо промпта. Заодно проверяется имя: в ClipClip заголовком служил
// обрезанный текст, и список был нечитаемым.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  unescapeHtml, looksLikeHtml, stripHtml, stripTodo,
  normalizeNewlines, cleanBody, titleFromText, slugify, safeFileName,
} from '../../library/index.mjs';

test('распознаёт HTML по признакам, а не по угловым скобкам вообще', () => {
  assert.equal(looksLikeHtml('<p>текст</p>'), true);
  assert.equal(looksLikeHtml('<div class="x">'), true);
  assert.equal(looksLikeHtml('<span style="color:red">'), true);
  assert.equal(looksLikeHtml('если a < b и b > c'), false);
  assert.equal(looksLikeHtml('обычный текст'), false);
});

test('раскрывает сущности, включая числовые', () => {
  assert.equal(unescapeHtml('a&nbsp;b'), 'a b');
  assert.equal(unescapeHtml('&lt;тег&gt;'), '<тег>');
  assert.equal(unescapeHtml('&#1055;&#1088;&#1080;&#1074;&#1077;&#1090;'), 'Привет');
  assert.equal(unescapeHtml('&laquo;цитата&raquo;'), '«цитата»');
});

test('снимает разметку, сохраняя границы абзацев', () => {
  const html = '<p>Первый абзац.</p><p>Второй абзац.</p>';
  assert.equal(stripHtml(html), 'Первый абзац.\nВторой абзац.');
});

test('пункты списка становятся строками с дефисом', () => {
  const out = stripHtml('<ul><li>раз</li><li>два</li></ul>');
  assert.match(out, /- раз/);
  assert.match(out, /- два/);
});

test('script и style удаляются вместе с содержимым', () => {
  const out = stripHtml('<style>.a{color:red}</style>Текст<script>alert(1)</script>');
  assert.equal(out, 'Текст');
});

test('HTML из Google Docs превращается в читаемый текст', () => {
  const clip = '<html><body><p style="line-height:1.2;margin-top:0pt"><span style="font-family:Arial">'
    + 'Проведи ревью кода.</span></p><p style="margin:0"><span>Смотри корректность.</span></p></body></html>';
  const out = stripHtml(clip);

  assert.equal(out.includes('<'), false, 'теги должны исчезнуть');
  assert.equal(out.includes('style'), false, 'стили должны исчезнуть');
  assert.equal(out, 'Проведи ревью кода.\nСмотри корректность.');
});

test('снимает префикс-заглушку TODO', () => {
  assert.equal(stripTodo('TODO: настоящий текст'), 'настоящий текст');
  assert.equal(stripTodo('todo:  текст'), 'текст');
});

test('слово TODO внутри текста не трогается: это законная часть промпта', () => {
  const text = 'Сгенерируй скелет кода с TODO вместо селекторов';
  assert.equal(stripTodo(text), text);
  assert.equal(cleanBody(text).text, text, 'именно на этом прежняя система стирала p-parse.md');
});

test('нормализует переводы строк Windows', () => {
  assert.equal(normalizeNewlines('a\r\nb\rc'), 'a\nb\nc');
});

test('cleanBody сообщает, что именно изменил', () => {
  const plain = cleanBody('  обычный текст  ');
  assert.equal(plain.text, 'обычный текст');
  assert.deepEqual(plain.changed, ['trim']);

  const html = cleanBody('<p>текст</p>');
  assert.ok(html.changed.includes('html'));

  const todo = cleanBody('TODO: текст');
  assert.ok(todo.changed.includes('todo'));

  const clean = cleanBody('уже чистый');
  assert.deepEqual(clean.changed, [], 'без изменений список пуст');
});

test('заголовок берётся из первых слов, а не из первых 50 символов', () => {
  const text = 'Проведи ревью кода ниже по четырём критериям и опиши каждый подробно';
  const title = titleFromText(text);

  assert.ok(title.length <= 48);
  assert.equal(title.endsWith('…'), false, 'слова не рубятся посередине');
  assert.ok(title.split(' ').every((w) => text.includes(w)), 'все слова из текста');
});

test('заголовок берёт первую значимую строку, пропуская пустые', () => {
  assert.match(titleFromText('\n\n  \nПервая значимая строка'), /^Первая значимая строка/);
});

test('заголовок из пустого текста называется прямо', () => {
  assert.equal(titleFromText(''), 'Без названия');
  assert.equal(titleFromText('   \n  '), 'Без названия');
});

test('разметка из заголовка убирается', () => {
  assert.match(titleFromText('## **Ревью** кода'), /^Ревью кода/);
});

test('slugify транслитерирует кириллицу в имя файла', () => {
  assert.equal(slugify('Ревью кода'), 'revyu-koda');
  assert.equal(slugify('План перед действием'), 'plan-pered-deystviem');
  assert.equal(slugify('Ёлка и Щука'), 'elka-i-schuka');
});

test('slugify не оставляет пустое имя и висячие дефисы', () => {
  assert.equal(slugify(''), 'prompt');
  assert.equal(slugify('!!!'), 'prompt');
  assert.equal(slugify('  Текст  '), 'tekst');
  assert.equal(slugify('а-'.repeat(40)).endsWith('-'), false);
});

test('запрещённые символы Windows заменяются, а не отбрасываются молча', () => {
  assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
});
