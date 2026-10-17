// tests/unit/migrate-clips.test.mjs — перенос клипов ClipClip в журнал буфера.
//
// Требование: REQ-MIG-CLIPS (docs/SPEC.md §11). Сценарий S-11.
// Проверяемый файл: legacy/migrate-clips.mjs.
// Слияние библиотеки — в tests/unit/migrate.test.mjs.
//
// Главное, что здесь проверяется, — КАЖДЫЙ отказ имеет причину. «Перенесено 12 из
// 39» без объяснения остальных 27 бесполезно: человек не знает, потерял он что-то
// или нет. Половина проверок поэтому про пропуски, а не про переносы.
//
// Второе: имя записи не «первые 50 символов». Прежняя система резала текст, и в
// списке стояли строки, по которым ничего нельзя найти.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  planClips, readClipFile, applyClips, printableClips, processOf,
} from '../../legacy/index.mjs';
import { tempRoot, cleanup } from '../helpers/harness.mjs';
import { clipFile, fakeStore } from '../helpers/legacyfix.mjs';

// ── что переносится ──────────────────────────────────────────────────────────

test('текстовый клип переносится с человекочитаемым именем', () => {
  const root = tempRoot();
  try {
    clipFile(root, 'clip1.txt', 'Проведи ревью кода ниже и разбери по уровням.');

    const p = planClips(root);

    assert.equal(p.summary.taken, 1);
    // Имя — не первые 50 символов: titleFromText берёт осмысленное начало.
    assert.equal(p.taken[0].clip.title.length <= 60, true);
    assert.equal(p.taken[0].clip.title.endsWith('…'), false, 'имя обрезано многоточием');
  } finally { cleanup(root); }
});

test('HTML от Google Docs очищается до текста', () => {
  // 19 из 39 клипов оказались HTML с инлайн-CSS. Разметка в чате бесполезна.
  const root = tempRoot();
  try {
    clipFile(root, 'clip2.html',
      '<html><body><p style="color:#111;font-family:Arial">Сожми текст без потерь.</p></body></html>');

    const p = planClips(root);
    const one = p.taken[0];

    assert.equal(p.summary.taken, 1);
    assert.match(one.clip.text, /Сожми текст без потерь/);
    assert.equal(one.clip.text.includes('<p'), false, 'разметка осталась');
    assert.equal(one.cleaned.includes('html'), true, 'очистка не отмечена');
    assert.equal(p.summary.cleaned, 1);
  } finally { cleanup(root); }
});

test('тип записи определяет журнал, а не перенос', () => {
  // Своё мнение о типе было бы вторым мнением о той же величине.
  const root = tempRoot();
  try {
    clipFile(root, 'code.txt', 'function hello() {\n  return 1;\n}\n');

    const kind = planClips(root).taken[0].clip.kind;
    assert.equal(typeof kind, 'string');
    assert.notEqual(kind, '', 'тип не определён');
  } finally { cleanup(root); }
});

test('порядок — от старых к новым: журнал это лог', () => {
  const root = tempRoot();
  try {
    clipFile(root, 'a.txt', 'Первая запись, она старше всех остальных.');
    clipFile(root, 'b.txt', 'Вторая запись, она новее первой записи.');

    const times = planClips(root).taken.map((t) => t.clip.createdAt);
    assert.deepEqual(times, [...times].sort(), 'порядок не хронологический');
  } finally { cleanup(root); }
});

// ── что НЕ переносится, и почему ─────────────────────────────────────────────

test('картинка пропускается с объяснением, а не молча', () => {
  const root = tempRoot();
  try {
    clipFile(root, 'shot.png', 'двоичные данные');

    const p = planClips(root);

    assert.equal(p.summary.taken, 0);
    assert.equal(p.summary.skipped, 1);
    assert.match(p.skipped[0].why, /картинка/);
    assert.match(p.skipped[0].why, /текст/, 'не сказано, почему нельзя');
  } finally { cleanup(root); }
});

test('клип из менеджера паролей не переносится', () => {
  // Запись, сделанная из KeePass, не должна ожить в новом журнале.
  const root = tempRoot();
  try {
    clipFile(root, 'clip-keepass.exe-001.txt', 'пароль от почты');

    const p = planClips(root);

    assert.equal(p.summary.taken, 0);
    assert.match(p.skipped[0].why, /keepass\.exe/);
    assert.match(p.skipped[0].why, /чёрном списке/);
  } finally { cleanup(root); }
});

test('содержимое отклонённой записи не попадает в отчёт', () => {
  // Иначе пароль оказался бы в логе миграции — там он живёт дольше, чем в буфере.
  const root = tempRoot();
  try {
    clipFile(root, 'clip-keepass.exe-002.txt', 'СекретноеЗначение123');

    const text = printableClips(planClips(root));
    assert.equal(text.includes('СекретноеЗначение123'), false, 'секрет напечатан');
  } finally { cleanup(root); }
});

test('HTML из одних тегов пропускается: текста не осталось', () => {
  const root = tempRoot();
  try {
    clipFile(root, 'empty.html', '<html><body><div style="height:2px"></div></body></html>');

    const p = planClips(root);

    assert.equal(p.summary.taken, 0);
    assert.match(p.skipped[0].why, /не осталось текста/);
  } finally { cleanup(root); }
});

test('нетекстовое расширение пропускается с указанием расширения', () => {
  const root = tempRoot();
  try {
    clipFile(root, 'data.bin', 'что-то');

    assert.match(planClips(root).skipped[0].why, /\.bin/);
  } finally { cleanup(root); }
});

test('отсутствующая папка — не ошибка, а «переносить нечего»', () => {
  const p = planClips(join(tempRoot(), 'нет-такой'));

  assert.equal(p.exists, false);
  assert.equal(p.summary.total, 0);
  assert.match(printableClips(p), /не найдена/);
});

// ── источник записи ─────────────────────────────────────────────────────────

/**
 * Префикс ClipClip не должен приклеиваться к имени процесса.
 *
 * Первая версия шаблона писала `[\w-]+` и вытаскивала из
 * `clip-keepass.exe-001.txt` имя «clip-keepass.exe». Чёрный список по такому имени
 * не сработал бы никогда, и запись из менеджера паролей ожила бы в новом журнале.
 * Поймано этим тестом.
 */
test('имя процесса вынимается без префикса ClipClip', () => {
  assert.equal(processOf('clip-notepad.exe-0012.txt'), 'notepad.exe');
  assert.equal(processOf('clip-keepass.exe-001.txt'), 'keepass.exe');
  assert.equal(processOf('чистое-имя.txt'), null);
});

/**
 * Обратная сторона того же решения, названная прямо.
 * Процесс с дефисом определится не полностью. Из двух ошибок выбрана менее
 * опасная: проверка по чёрному списку идёт по вхождению подстроки, поэтому
 * суженное имя всё равно совпадёт с записью списка, а имя с чужим префиксом — нет.
 */
test('дефис в названии процесса сужает имя — известное ограничение', () => {
  assert.equal(processOf('clip-some-app.exe-1.txt'), 'app.exe');
});

test('клип без известного источника переносится, но помечен', () => {
  // Проверить его по чёрному списку нельзя, и это ограничение переноса. Молча
  // выбросить такие записи значило бы потерять большинство клипов.
  const root = tempRoot();
  try {
    clipFile(root, 'без-источника.txt', 'Текст записи без имени процесса.');

    const p = planClips(root);

    assert.equal(p.summary.taken, 1);
    assert.equal(p.summary.unknownSource, 1);
    assert.equal(p.taken[0].clip.source, null);
  } finally { cleanup(root); }
});

test('битый файл называет причину, а не роняет перенос', () => {
  const out = readClipFile(tempRoot(), 'нет-такого.txt');

  assert.equal(out.ok, false);
  assert.match(out.why, /не прочитан/);
});

// ── запись в журнал ─────────────────────────────────────────────────────────

test('записи уходят в журнал с источником', () => {
  const root = tempRoot();
  try {
    clipFile(root, 'clip-notepad.exe-1.txt', 'Первая запись для переноса в журнал.');
    const store = fakeStore();

    const out = applyClips(planClips(root), store);

    assert.equal(out.ok, true);
    assert.equal(out.added.length, 1);
    // Имя параметра взято из clipboard/store.mjs: своё название означало бы, что
    // источник не доедет и чёрный список внутри add его не отсеет.
    assert.equal(store.seen[0].opts.sourceApp, 'notepad.exe');
  } finally { cleanup(root); }
});

test('отказ журнала объяснён словами, а не кодом', () => {
  const root = tempRoot();
  try {
    clipFile(root, 'dup.txt', 'Такой текст уже есть последней записью журнала.');
    const store = fakeStore(() => ({ ok: false, skipped: 'duplicate' }));

    const out = applyClips(planClips(root), store);

    assert.equal(out.ok, false);
    assert.match(out.failed[0].why, /уже последняя запись/);
    assert.equal(out.failed[0].why.includes('duplicate'), false, 'код вместо объяснения');
  } finally { cleanup(root); }
});

test('причина от журнала важнее собственной формулировки', () => {
  // Журнал знает больше: если он объяснил, повторять своими словами нельзя.
  const root = tempRoot();
  try {
    clipFile(root, 'x.txt', 'Запись, которую журнал отклонит по своей причине.');
    const store = fakeStore(() => ({ ok: false, skipped: 'blacklist', why: 'источник 1password.exe' }));

    const out = applyClips(planClips(root), store);
    assert.match(out.failed[0].why, /1password\.exe/);
  } finally { cleanup(root); }
});

test('сбой на одной записи не останавливает остальные', () => {
  const root = tempRoot();
  try {
    clipFile(root, 'a.txt', 'Первая запись, которая пройдёт нормально.');
    clipFile(root, 'b.txt', 'Вторая запись, на ней журнал бросит исключение.');

    let n = 0;
    const store = fakeStore(() => {
      n += 1;
      if (n === 2) throw new Error('база занята другим процессом');
      return { ok: true };
    });

    const out = applyClips(planClips(root), store);

    assert.equal(out.added.length, 1);
    assert.equal(out.failed.length, 1);
    assert.match(out.failed[0].why, /база занята/);
  } finally { cleanup(root); }
});

test('пропущенные при чтении доезжают до итогового отчёта', () => {
  // Иначе отказы теряются между планом и записью, и «перенесено 1» выглядит как
  // полный успех при трёх потерянных файлах.
  const root = tempRoot();
  try {
    clipFile(root, 'ok.txt', 'Нормальная запись для переноса в журнал.');
    clipFile(root, 'pic.png', 'двоичное');

    const out = applyClips(planClips(root), fakeStore());

    assert.equal(out.added.length, 1);
    assert.equal(out.skipped.length, 1);
  } finally { cleanup(root); }
});

test('отчёт перечисляет и переносимое, и пропущенное с причинами', () => {
  const root = tempRoot();
  try {
    clipFile(root, 'ok.txt', 'Запись, которая будет перенесена в журнал.');
    clipFile(root, 'pic.png', 'двоичное');

    const text = printableClips(planClips(root));

    assert.match(text, /ПЕРЕНОСИТСЯ/);
    assert.match(text, /ПРОПУСКАЕТСЯ, И ВОТ ПОЧЕМУ/);
    assert.match(text, /pic\.png/);
  } finally { cleanup(root); }
});
