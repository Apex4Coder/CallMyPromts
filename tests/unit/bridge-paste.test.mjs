// tests/unit/bridge-paste.test.mjs — контракт вставки в скрипте AutoHotkey.
//
// Требование: REQ-KEY-PASTE (docs/SPEC.md §8). Сценарии: S-01 (вставка),
// S-03 (сохранение выделенного), S-04 (слежка).
//
// Скрипт AHK нельзя выполнить из Node: он живёт в процессе AutoHotkey и работает
// с настоящими окнами Windows. Проверяются решения, которые дороже всего потерять
// при правке, — по тексту файла, через tests/helpers/ahk.mjs.
//
// Каждое из решений принято по конкретной причине, и каждое легко потерять
// «упрощением»:
//   1. Вставка через буфер, а не SendText — SendText теряет кириллицу.
//   2. Буфер восстанавливается — человек не просил его затирать.
//   3. Опрос вместо OnClipboardChange — иначе восстановление буфера даёт цикл.
//   4. Каждый хоткей в своём try — одна занятая клавиша не должна уносить все.
//   5. Целевое окно запоминается ДО открытия нашего — иначе вставка уйдёт в него.
//
// Проверка текстом честная в своих границах: она подтверждает, что решение на
// месте, и не подтверждает, что оно работает. Работу проверяет живой прогон
// (S-01 проверяется руками, наличие AHK — tests/unit/bridge-capture.test.mjs).
//
// Связь с сервером и экранирование — в tests/unit/bridge-post.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readScript, ahkFn, orderIn, maskAhk } from '../helpers/ahk.mjs';
import { PASTE_WAIT_MS } from '../../server/index.mjs';

const SCRIPT = readScript();
const CODE = ahkFn(SCRIPT, 'PasteTo');

// ── версия и одиночный экземпляр ─────────────────────────────────────────────

test('скрипт требует AutoHotkey v2', () => {
  // Синтаксис v2 несовместим с v1: запуск в v1 дал бы ошибки разбора вместо
  // работающих хоткеев.
  assert.match(SCRIPT, /#Requires AutoHotkey v2/);
});

test('второй экземпляр моста не поднимается', () => {
  // Два моста означали бы двойную регистрацию хоткеев и двойные записи журнала.
  assert.match(SCRIPT, /#SingleInstance Force/);
});

// ── вставка ──────────────────────────────────────────────────────────────────

test('вставка идёт через буфер обмена, а не SendText', () => {
  // SendText теряет кириллицу при активной русской раскладке — проверено.
  assert.match(CODE.text, /A_Clipboard := text/);
  assert.match(CODE.text, /Send "\^v"/);
  assert.equal(/SendText/.test(CODE.code), false, 'SendText недопустим для русского текста');
});

test('прежнее содержимое буфера восстанавливается', () => {
  // Вставка промпта не должна стирать то, что человек держал в буфере.
  assert.match(CODE.text, /saved := ClipboardAll\(\)/);
  assert.match(CODE.text, /A_Clipboard := saved/);
});

test('буфер возвращается после нажатия, а не до', () => {
  // Порядок здесь и есть решение: восстановление до Ctrl+V вставило бы прежнее
  // содержимое буфера вместо промпта.
  const send = CODE.text.indexOf('Send "^v"');
  const restore = CODE.text.indexOf('A_Clipboard := saved');

  assert.notEqual(send, -1);
  assert.equal(send < restore, true, 'сначала вставить, потом вернуть буфер');
});

test('захват буфера повторяется: он бывает занят на доли секунды', () => {
  // S-01, плохой путь 4. Одна попытка давала бы случайные потери вставки.
  assert.match(CODE.text, /loop 3/);
  assert.match(CODE.text, /Sleep 50/);
});

test('неудача захвата буфера названа человеку, а не проглочена', () => {
  assert.match(CODE.text, /TrayTip/);
  assert.match(CODE.text, /буфер/i);
  assert.match(CODE.text, /return false/, 'вызывающий узнаёт о неудаче');
});

test('вставка активирует целевое окно и ждёт его', () => {
  // Send без активации ушёл бы в наше окно или в то, что окажется активным.
  assert.match(CODE.text, /WinActivate/);
  assert.match(CODE.text, /WinWaitActive/);
});

test('ожидание активации ограничено по времени', () => {
  // Окно могло закрыться. Без таймаута мост встал бы навсегда на одной вставке.
  assert.match(CODE.text, /WinWaitActive\([^\n]*, *, *0\.4\)/);
});

test('исчезнувшее окно не роняет вставку', () => {
  // Человек мог закрыть чат, пока выбирал промпт. Тогда активация пропускается,
  // а текст остаётся в буфере — это лучше, чем ошибка скрипта.
  assert.match(CODE.text, /if !hwnd \|\| !WinExist\("ahk_id " hwnd\)/);
});

// ── целевое окно ─────────────────────────────────────────────────────────────

test('целевое окно запоминается до открытия окна выбора', () => {
  // Порядок строк здесь и есть решение: WinExist("A") после Open вернул бы
  // наше собственное окно.
  const picker = ahkFn(SCRIPT, 'OpenPicker').text;
  const { a, ordered } = orderIn(picker, 'WinExist("A")', 'Open(');

  assert.notEqual(a, -1, 'активное окно должно запоминаться');
  assert.equal(ordered, true, 'запомнить нужно ДО открытия нашего окна');
});

test('журнал буфера запоминает окно так же', () => {
  // S-04: из журнала тоже вставляют, и вставлять надо туда же.
  const clips = ahkFn(SCRIPT, 'OpenClips').text;

  assert.equal(orderIn(clips, 'WinExist("A")', 'Open(').ordered, true);
});

test('интерфейс открывается отдельным окном приложения, а не вкладкой браузера', () => {
  const entry = ahkFn(SCRIPT, 'Open').text;
  assert.match(entry, /OpenOwnedPanel\(hash/, 'публичный вход обязан вызвать проверенный запуск');
  const open = ahkFn(SCRIPT, 'OpenOwnedPanel').text;

  assert.match(open, /--app=/, 'Edge должен запускаться в режиме приложения');
  assert.match(open, /FindEdge\(\)/, 'путь к Edge должен определяться явно');
  assert.match(SCRIPT, /Microsoft\\Edge\\Application\\msedge\.exe/,
    'должны проверяться штатные каталоги Edge');
});

test('TARGET объявлена глобально один раз', () => {
  // `global TARGET := WinExist("A")` внутри функции — объявление с
  // присваиванием; в AHK v2 это допустимо только один раз на функцию и ломается
  // при повторном вызове. Объявление вынесено наверх, в функциях остаётся
  // `global TARGET` отдельной строкой.
  assert.match(SCRIPT, /^global TARGET := 0$/m);
  assert.equal(/global TARGET :=[^\n]*WinExist/.test(SCRIPT), false,
    'присваивание в объявлении внутри функции сработает только раз');
});

// ── чтение выделения ─────────────────────────────────────────────────────────

test('чтение выделения не портит буфер', () => {
  // Ctrl+C ради чтения выделения — побочный эффект, который надо откатить.
  const save = ahkFn(SCRIPT, 'SaveSelection').text;

  assert.match(save, /saved := ClipboardAll\(\)/);
  assert.match(save, /A_Clipboard := saved/);
});

test('ожидание буфера ограничено по времени', () => {
  // Без таймаута хоткей висел бы навсегда, когда выделения нет.
  assert.match(ahkFn(SCRIPT, 'SaveSelection').text, /ClipWait\(0?\.\d+\)/);
});

test('без выделения берётся содержимое буфера', () => {
  // S-03, плохой путь 1: человек нажал сохранение, ничего не выделив.
  const save = ahkFn(SCRIPT, 'SaveSelection').text;

  assert.match(save, /!ClipWait/);
  assert.match(save, /Нечего сохранять/, 'и если буфер пуст — сказано прямо');
});

test('имя процесса-источника уходит вместе с текстом', () => {
  // Без него не работает чёрный список менеджеров паролей (REQ-CLIP-PRIVACY).
  const save = ahkFn(SCRIPT, 'SaveSelection').text;

  assert.match(save, /sourceApp/);
  assert.match(save, /ActiveExe\(\)/);
});

// ── слежка ───────────────────────────────────────────────────────────────────

test('слежка опрашивает буфер, а не подписывается на смену', () => {
  // OnClipboardChange ловит и наши собственные записи: восстановление буфера
  // после вставки вызвало бы новую запись и бесконечный цикл.
  //
  // Запрет проверяется по коду без комментариев: объяснение решения содержит
  // само слово OnClipboardChange, и по исходнику проверка падала бы на тексте,
  // который её же и обосновывает.
  assert.match(SCRIPT, /SetTimer WatchClipboard/);
  assert.equal(/OnClipboardChange/.test(maskAhk(SCRIPT)), false, 'подписка дала бы цикл');
});

test('интервал опроса задан числом в коде', () => {
  assert.match(SCRIPT, /SetTimer WatchClipboard, \d+/);
});

test('пауза слежки проверяется первой', () => {
  // На паузе содержимое буфера не читается вовсе: меньше работы с
  // чувствительными данными — меньше поводов для утечки.
  const watch = ahkFn(SCRIPT, 'WatchClipboard').text;
  const { a, ordered } = orderIn(watch, 'if !WATCH', 'A_Clipboard');

  assert.notEqual(a, -1);
  assert.equal(ordered, true, 'проверка паузы должна быть до чтения');
});

test('повтор того же содержимого не отправляется', () => {
  const watch = ahkFn(SCRIPT, 'WatchClipboard').text;

  assert.match(watch, /LAST_CLIP/);
  assert.match(watch, /text = LAST_CLIP/);
});

test('чтение буфера обёрнуто в try: занятый буфер не роняет мост', () => {
  const watch = ahkFn(SCRIPT, 'WatchClipboard').text;

  assert.match(watch, /try text := A_Clipboard/);
  assert.match(watch, /catch/);
});

// ── приём заявки на вставку ──────────────────────────────────────────────────

test('мост опрашивает сервер о заявке на вставку', () => {
  // Без этого опроса вставка не происходит вообще: страница не может нажать
  // Ctrl+V в чужом окне, а событие внутри страницы мост не слышит.
  assert.match(SCRIPT, /SetTimer PollPaste, \d+/);
  assert.match(ahkFn(SCRIPT, 'PollPaste').text, /\/api\/paste/);
});

test('опрос вставки чаще, чем сервер ждёт ответа', () => {
  // Сервер держит ответ интерфейсу 700 мс (PASTE_WAIT_MS). Интервал опроса
  // больше половины этого времени давал бы «мост не ответил» на живом мосту.
  const found = /SetTimer PollPaste, (\d+)/.exec(SCRIPT);

  assert.notEqual(found, null, 'опрос вставки должен быть заведён');
  assert.equal(Number(found[1]) * 2 <= PASTE_WAIT_MS, true,
    `опрос ${found[1]} мс против ожидания ${PASTE_WAIT_MS} мс — мост не успеет`);
});

test('вставка идёт в запомненное окно, а не в активное', () => {
  // WinExist("A") в момент вставки вернул бы окно браузера с нашей страницей.
  const poll = ahkFn(SCRIPT, 'PollPaste').text;

  assert.match(poll, /PasteTo\(TARGET,/);
  assert.equal(/WinExist\("A"\)/.test(poll), false, 'активное окно здесь уже наше');
});

test('пустой ответ сервера не приводит к вставке', () => {
  // Сервис остановлен или заявки нет — вставлять нечего, и «нечего» не должно
  // превращаться в пустую строку в чужом окне.
  const poll = ahkFn(SCRIPT, 'PollPaste').text;

  assert.match(poll, /"has":true/);
  assert.match(poll, /return/);
});
