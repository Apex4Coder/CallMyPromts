// tests/unit/bridge-post.test.mjs — контракт связи моста с сервером.
//
// Требования: REQ-KEY-PASTE, REQ-API-AUTH (docs/SPEC.md §8, §6).
// Проверяемый файл: bridge/deck.ahk. Способ проверки: tests/helpers/ahk.mjs.
//
// Отделено от tests/unit/bridge-paste.test.mjs по теме и по размеру: там —
// решения о вставке и слежке, здесь — как мост разговаривает с сервером и как
// экранирует текст. Экранирование вынесено сюда потому, что это единственное
// место, где текст промпта становится частью протокола, и ошибка в нём теряет
// запись целиком.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readScript, ahkFn, maskAhk } from '../helpers/ahk.mjs';

const SCRIPT = readScript();
const MASK = maskAhk(SCRIPT);

// ── адрес и токен ────────────────────────────────────────────────────────────

test('обращение только к 127.0.0.1', () => {
  // Мост не имеет права стучаться в сеть: журнал буфера не покидает машину
  // (docs/RULES.md §6).
  const hosts = SCRIPT.match(/http:\/\/[^"' ]+/g) ?? [];

  assert.equal(hosts.length > 0, true, 'обращения к серверу должны быть');
  for (const h of hosts) {
    assert.match(h, /^http:\/\/127\.0\.0\.1:/, `${h}: только локальный адрес`);
  }
});

test('localhost по имени не используется', () => {
  // Имя разрешается через DNS и на некоторых машинах уходит в ::1, где сервер не
  // слушает. Адрес цифрами такого исхода не имеет.
  assert.equal(/http:\/\/localhost/.test(MASK), false);
});

test('токен передаётся в каждом запросе к API', () => {
  // Без заголовка сервер ответит 401, и мост будет молча не работать.
  for (const name of ['Post', 'Get']) {
    assert.match(ahkFn(SCRIPT, name).text, /X-Deck-Token/, `${name}: нет токена`);
  }
});

test('порт берётся из runtime.json, а не только из константы', () => {
  // Порт мог быть занят, и сервер поднялся на другом. Мост обязан идти туда же.
  const read = ahkFn(SCRIPT, 'ReadPort').text;

  assert.match(read, /runtime\.json/);
  assert.match(read, /"port"/);
});

// ── молчание при остановленном сервисе ───────────────────────────────────────

test('остановленный сервис не вызывает всплывающих сообщений', () => {
  // Иначе при выключенном сервисе каждое копирование давало бы уведомление —
  // это хуже самой проблемы.
  const post = ahkFn(SCRIPT, 'Post');

  assert.match(post.text, /catch/);
  assert.equal(/TrayTip/.test(post.code), false, 'в обработчике сбоя связи уведомлений нет');
});

test('неудачный опрос вставки тоже молчит', () => {
  const get = ahkFn(SCRIPT, 'Get');

  assert.match(get.text, /catch/);
  assert.equal(/TrayTip/.test(get.code), false);
  assert.match(get.text, /return ""/, 'пустая строка вместо исключения');
});

test('код ответа проверяется, а не игнорируется', () => {
  // 401 при разъехавшемся токене вернул бы тело ошибки, и мост попытался бы
  // достать из него текст на вставку.
  assert.match(ahkFn(SCRIPT, 'Get').text, /http\.Status != 200/);
});

// ── экранирование при записи ─────────────────────────────────────────────────

test('текст экранируется перед вставкой в JSON', () => {
  // Кавычка или перевод строки в скопированном тексте иначе сломали бы тело
  // запроса, и запись не попала бы в журнал.
  //
  // Об экранировании в самой проверке: `\\` в литерале регулярного выражения —
  // это ОДИН обратный слэш в тексте файла. Первая версия писала `\\\\` и искала
  // два, поэтому не находила ничего.
  const quote = ahkFn(SCRIPT, 'JsonQuote').text;

  for (const [what, pattern] of [
    ['обратный слэш', /StrReplace\(s, "\\", "\\\\"\)/],
    ['кавычка', /StrReplace\(s, '"', '\\"'\)/],
    ['перевод строки', /\\n/],
    ['табуляция', /\\t/],
  ]) {
    assert.match(quote, pattern, `${what}: не экранируется`);
  }
});

test('обратный слэш экранируется раньше кавычки', () => {
  // Обратный порядок превратил бы уже вставленный слэш экранирования в данные
  // и сломал бы JSON на тексте с кавычками.
  const quote = ahkFn(SCRIPT, 'JsonQuote').text;
  const slash = quote.indexOf('StrReplace(s, "\\", "\\\\")');
  const dq = quote.indexOf('StrReplace(s, \'"\'');

  assert.notEqual(slash, -1, 'замена слэша должна быть');
  assert.notEqual(dq, -1, 'замена кавычки должна быть');
  assert.equal(slash < dq, true, 'порядок замен важен');
});

test('CRLF сворачивается раньше одиночного CR', () => {
  // Иначе перевод строки Windows дал бы в журнале две пустые строки вместо одной.
  const quote = ahkFn(SCRIPT, 'JsonQuote').text;

  assert.equal(quote.indexOf('`r`n') < quote.indexOf('StrReplace(s, "`r"'), true);
});

test('управляющие знаки уходят как \\u, а не сырыми', () => {
  // JSON запрещает знаки до 0x20 в строке буквально. Текст с Chr(1) — редкость,
  // но он приходит из чужих программ, и тело запроса ломается целиком.
  const quote = ahkFn(SCRIPT, 'JsonQuote').text;

  assert.match(quote, /loop 32/);
  assert.match(quote, /Format\("\\u\{:04x\}", code\)/);
});

test('табуляция и переводы строк не экранируются дважды', () => {
  // Они уже превращены в \t и \n выше; повторная замена дала бы \u0009 в
  // тексте, который человек увидит в журнале.
  const quote = ahkFn(SCRIPT, 'JsonQuote').text;

  assert.match(quote, /code = 9 \|\| code = 10 \|\| code = 13/);
});

// ── экранирование при чтении ─────────────────────────────────────────────────

test('обратное экранирование идёт одним проходом', () => {
  // Цепочка StrReplace здесь неверна в любом порядке: текст промпта с
  // последовательностью «слэш + n» приходит как `\\n`, и любая цепочка либо
  // превратит его в перевод строки, либо потеряет слэш.
  const un = ahkFn(SCRIPT, 'JsonUnquote');

  assert.match(un.text, /while \(i <= StrLen\(s\)\)/);
  assert.equal(/StrReplace/.test(un.code), false, 'цепочка замен даёт неверный результат');
});

test('распознаются все экраны, которые ставит сервер', () => {
  // JSON.stringify на стороне Node выдаёт \n \t \r \b \f \" \\ и \uXXXX.
  const un = ahkFn(SCRIPT, 'JsonUnquote').text;

  for (const e of ['"n"', '"t"', '"r"', '"b"', '"f"']) {
    assert.match(un, new RegExp(e.replace(/"/g, '"')), `экран ${e} не разбирается`);
  }
  assert.match(un, /"u"/, '\\uXXXX не разбирается');
  assert.match(un, /Chr\("0x"/, 'код символа не собирается');
});

test('неизвестный экран отдаёт сам знак, а не исчезает', () => {
  // `\/` допустим в JSON. Пропуск такого экрана съел бы символ из промпта.
  assert.match(ahkFn(SCRIPT, 'JsonUnquote').text, /PAIRS\.Has\(e\) \? PAIRS\[e\] : e/);
});

// ── доклад о хоткеях ─────────────────────────────────────────────────────────

test('состояние хоткеев докладывается серверу', () => {
  // Панель показывает светофор по этому докладу: иначе она обещала бы то,
  // чего в ОС не зарегистрировано.
  const report = ahkFn(SCRIPT, 'Report').text;

  assert.match(report, /\/api\/hotkeys/);
  for (const action of ['open_picker', 'save_clip', 'open_clips', 'toggle_watch']) {
    assert.match(report, new RegExp(action), `${action}: не докладывается`);
  }
});

test('неудачи собираются и показываются, а не теряются', () => {
  assert.match(ahkFn(SCRIPT, 'Bind').text, /FAILED/, 'неудача запоминается');
  assert.match(ahkFn(SCRIPT, 'Report').text, /TrayTip/, 'и называется человеку');
});

test('каждая комбинация регистрируется в своём try', () => {
  // S-07, плохой путь 6: одна занятая клавиша не должна уносить остальные.
  const bind = ahkFn(SCRIPT, 'Bind').text;

  assert.match(bind, /try \{/);
  assert.match(bind, /Hotkey combo/);
  assert.match(bind, /catch as err/);
});

test('пустая комбинация пропускается без ошибки', () => {
  // «Не назначено» — допустимое значение (V-S-5), а не сбой.
  assert.match(ahkFn(SCRIPT, 'Bind').text, /if \(Trim\(combo\) = ""\)/);
});

test('незарегистрированная клавиша докладывается как bad с причиной', () => {
  const keyJson = ahkFn(SCRIPT, 'KeyJson').text;

  assert.match(keyJson, /"state":"bad"/);
  assert.match(keyJson, /занята другим приложением/);
  assert.match(keyJson, /"state":"none"/, 'и «не назначена» отличается от «сломана»');
});

// ── открытие и управление из трея ─────────────────────────────────────────────

test('URL открывается напрямую без cmd.exe', () => {
  // Промежуточный `cmd /c start` добавляет второй парсер кавычек и способен
  // исказить URL. AutoHotkey умеет передать адрес оболочке Windows напрямую.
  const open = ahkFn(SCRIPT, 'Open').text;

  assert.match(open, /url\s*:=\s*"http:\/\/127\.0\.0\.1:/);
  assert.match(open, /Run url/);
  assert.equal(/cmd\s+\/c/i.test(open), false);
});

test('трей содержит управление всем сервисом, а не только интерфейсом', () => {
  const tray = ahkFn(SCRIPT, 'TrayMenuSetup').text;

  for (const label of ['Запустить сервис', 'Перезапустить сервис', 'Остановить сервис', 'Выход']) {
    assert.match(tray, new RegExp(label), `${label}: пункт отсутствует`);
  }
  assert.match(tray, /StartService/);
  assert.match(tray, /RestartService/);
  assert.match(tray, /StopService/);
  assert.match(tray, /ExitWholeApp/);
  assert.match(tray, /FileExist\([^)]*runtime\.json/,
    'меню должно различать запущенный и остановленный сервер');
});

test('запуск из оставшегося трея поднимает весь сервис и закрывает старый мост', () => {
  const start = ahkFn(SCRIPT, 'StartService').text;

  assert.match(start, /bridge[\\/]index\.mjs/);
  assert.match(start, /A_AhkPath|node/i);
  assert.match(start, /ExitApp/);
  assert.equal(start.indexOf('Run ') < start.indexOf('ExitApp'), true,
    'сначала запускается новый сервис, затем закрывается старый мост');
});

test('остановка сервиса снимает хоткеи и прекращает оба фоновых опроса', () => {
  const stop = ahkFn(SCRIPT, 'StopService').text;

  assert.match(stop, /DisableBridge/);
  assert.match(stop, /"action":"stop"/);
  assert.equal(stop.indexOf('Post(') < stop.indexOf('DisableBridge'), true,
    'запрос остановки должен уйти до отключения моста');

  const disable = ahkFn(SCRIPT, 'DisableBridge').text;
  assert.match(disable, /SetTimer\s+WatchClipboard\s*,\s*0/);
  assert.match(disable, /SetTimer\s+PollPaste\s*,\s*0/);
  assert.match(disable, /Hotkey[^\n]+"Off"/);
});

test('выход из трея сначала останавливает сервер и локальный мост', () => {
  const exit = ahkFn(SCRIPT, 'ExitWholeApp').text;

  assert.match(exit, /\/api\/service/);
  assert.match(exit, /"action":"stop"/);
  assert.match(exit, /"confirm":true/);
  assert.match(exit, /DisableBridge/);
  assert.equal(exit.indexOf('Post(') < exit.indexOf('ExitApp'), true);
  assert.equal(exit.indexOf('DisableBridge') < exit.indexOf('ExitApp'), true);
});

// ── файлы состояния ──────────────────────────────────────────────────────────

test('корень проекта берётся от расположения скрипта', () => {
  // Запуск из другого каталога не должен ломать поиск token и settings.json.
  assert.match(SCRIPT, /SetWorkingDir A_ScriptDir/);
  assert.match(SCRIPT, /ROOT := A_WorkingDir/);
});

test('токен и настройки читаются в UTF-8', () => {
  // Русские названия в настройках иначе пришли бы искажёнными.
  assert.match(ahkFn(SCRIPT, 'ReadToken').text, /"UTF-8"/);
  assert.match(ahkFn(SCRIPT, 'ReadSettings').text, /"UTF-8"/);
});

test('отсутствие файлов состояния не роняет мост', () => {
  // Первый запуск: ни token, ни runtime.json ещё нет.
  for (const name of ['ReadToken', 'ReadPort', 'ReadSettings']) {
    assert.match(ahkFn(SCRIPT, name).text, /FileExist/, `${name}: существование файла не проверяется`);
  }
});
