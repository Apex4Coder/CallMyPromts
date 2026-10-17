// tests/unit/gates-release.test.mjs — G23: раскладка релизов не ломается тихо.
//
// Требование: REQ-GATE-RELEASE (docs/SPEC.md §9). Концепция: gld/gold.md §3.3, §9.
// Проверяемый файл: gates/release-gate.mjs.
//
// Приёмка та же, что у G24: «гейт зелёный И доказано, что умеет краснеть». Второе
// важнее. Прошлый урок проекта — `CONTRACT_VIOLATIONS = 0` при нулевом покрытии:
// гейт был зелёным, потому что ничего не проверял. Поэтому каждая проверка сначала
// подкладывает нарушение и требует, чтобы гейт его назвал, и только потом
// убеждается, что на чистом проекте он молчит.
//
// Гейт закрывает три тихих способа сломать раскладку: запись внутрь неизменяемого
// релиза, обращение к пути live из рантайма, rmSync recursive на указателе. Плюс
// четвёртая проверка — пин корня на месте, иначе INV-13 не выполняется.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkRelease, selfTestRelease, hasLiveRef, isLivePath, stripComments,
  POINTERS, STATE_DIRS, LIVE_OK,
} from '../../gates/verify.mjs';
import { NAMES } from '../../release/index.mjs';
import { tempRoot, cleanup } from '../helpers/harness.mjs';
import { put } from '../helpers/project.mjs';

const said = (res) => res.items.map((i) => `${i.path}:${i.line ?? '-'} ${i.message}`).join('\n');

/**
 * Минимальный проект с пином корня. Гейт читает `server/index.mjs` и ищет в нём
 * `realpathSync`: без пина он справедливо краснеет, и проверить что-то другое было
 * бы нельзя. Всё нарушение подкладывается отдельным файлом поверх этой основы.
 */
const withPin = (root, extra = {}) => {
  put(root, 'server/index.mjs', 'import { realpathSync } from "node:fs";\nexport const pin = (r) => realpathSync(r);\n');
  for (const [path, text] of Object.entries(extra)) put(root, path, text);
};

// ── самопроверка гейта ───────────────────────────────────────────────────────

test('гейт умеет краснеть: самопроверка проходит на живом коде', () => {
  // Встроенная проверка подкладывает нарушения всех видов и требует, чтобы гейт их
  // нашёл. Красный selfTest делает гейт красным целиком, даже если проект чист.
  const out = selfTestRelease();

  assert.equal(out.ok, true, out.why ?? '');
});

// ── эталон имён указателей ───────────────────────────────────────────────────

test('локальный эталон указателей совпадает с NAMES из release/', () => {
  // Гейт держит имена live/live.prev локально, а не импортом: импорт release/
  // сделал бы проверяющего частью проверяемого и был бы нарушением границы. Но
  // тогда эталон может разойтись с настоящим — эта проверка ловит расхождение.
  assert.equal(POINTERS.live, NAMES.live, 'имя live разошлось с release/layout.mjs');
  assert.equal(POINTERS.prev, NAMES.prev, 'имя live.prev разошлось с release/layout.mjs');
});

test('каталоги состояния и список исключений названы явно', () => {
  // Молчаливое исключение однажды разрастётся. Список — данные, его видно.
  assert.deepEqual(STATE_DIRS, ['state', 'prompts']);
  for (const dir of ['release', 'gates', 'tests']) {
    assert.equal(LIVE_OK.includes(dir), true, `${dir} обязан знать про live`);
  }
  assert.equal(LIVE_OK.includes('server'), false, 'боевой путь не должен знать про live');
});

// ── распознавание пути live ──────────────────────────────────────────────────

test('live распознаётся любым сегментом пути', () => {
  // Три формы, каждая — след промаха: первым сегментом без разделителя впереди,
  // в середине через join, поле раскладки.
  assert.equal(isLivePath('live/state/token'), true);
  assert.equal(isLivePath('app/live/x'), true);
  assert.equal(isLivePath('live.prev'), true);
});

test('aria-live путём к указателю не считается', () => {
  // Сегмент равен `aria-live`, а не `live`. Иначе гейт краснел бы на разметке
  // тостов, где aria-live — законный атрибут доступности.
  assert.equal(isLivePath('aria-live'), false);
  assert.equal(hasLiveRef('<div role="status" aria-live="polite"></div>'), false);
});

test('обращение к live через NAMES.live тоже ловится', () => {
  assert.equal(hasLiveRef('const dir = NAMES.live;'), true);
  assert.equal(hasLiveRef('const dir = NAMES.prev;'), true);
});

// ── проверка 1: запись вне состояния ─────────────────────────────────────────

test('запись вне каталога состояния поймана с местом', () => {
  // Файл, записанный внутрь релиза, исчезнет при следующей установке.
  const root = tempRoot();
  try {
    withPin(root, {
      'server/loud.mjs': 'export const f = (t) => {\n  writeFileSync("отчёт.txt", t);\n};\n',
    });

    const res = checkRelease(root);
    assert.match(said(res), /server\/loud\.mjs:2/);
    assert.match(said(res), /исчезнет при обновлении/);
  } finally { cleanup(root); }
});

test('запись в state/ и prompts/ нарушением не считается', () => {
  // Это и есть единственное разрешённое место записи: оно приходит в релиз через
  // junction из shared/ и переживает установку.
  const root = tempRoot();
  try {
    withPin(root, {
      'server/save.mjs': [
        'export const a = (t) => writeFileSync("state/settings.json", t);',
        'export const b = (t) => writeFileSync("prompts/x.md", t);',
        '',
      ].join('\n'),
    });

    assert.equal(checkRelease(root).count, 0, said(checkRelease(root)));
  } finally { cleanup(root); }
});

test('запись по полю объекта состояния разрешена', () => {
  // Путь, собранный от this.settingsFile или deck.libraryRoot, ведёт в состояние.
  const root = tempRoot();
  try {
    withPin(root, {
      'server/save.mjs': 'export const f = (t) => writeFileSync(this.settingsFile, t);\n',
    });

    assert.equal(checkRelease(root).count, 0, said(checkRelease(root)));
  } finally { cleanup(root); }
});

// ── проверка 2: обращение к live из рантайма ─────────────────────────────────

test('обращение к live из боевого пути поймано', () => {
  // live меняется под ногами при деплое. Код обязан работать от APP_ROOT (INV-13).
  const root = tempRoot();
  try {
    withPin(root, {
      'server/read.mjs': 'export const f = () => readFileSync("live/state/token");\n',
    });

    const res = checkRelease(root);
    assert.match(said(res), /server\/read\.mjs/);
    assert.match(said(res), /INV-13/);
  } finally { cleanup(root); }
});

test('live в release, gates и tests нарушением не считается', () => {
  // release сам управляет указателем, gates проверяет раскладку, tests проверяет
  // всё. Запрет на упоминание live у них сделал бы работу невозможной.
  const root = tempRoot();
  try {
    withPin(root, {
      'release/swap.mjs': 'export const f = (root) => join(root, "live");\n',
    });

    assert.equal(checkRelease(root).count, 0, said(checkRelease(root)));
  } finally { cleanup(root); }
});

test('упоминание live в комментарии не краснеет', () => {
  // Иначе объяснять INV-13 пришлось бы загадками. Первый прогон гейта покраснел
  // ровно на своём комментарии про пин корня.
  const root = tempRoot();
  try {
    withPin(root, {
      'server/ok.mjs': '// путь live меняется при деплое, работаем от APP_ROOT\nexport const f = () => 1;\n',
    });

    assert.equal(checkRelease(root).count, 0, said(checkRelease(root)));
  } finally { cleanup(root); }
});

// ── проверка 3: rmSync recursive на указателе ────────────────────────────────

test('rmSync recursive в release без снятия указателей поймана', () => {
  // В некоторых версиях Node это удаляло содержимое цели — то есть все промпты.
  const root = tempRoot();
  try {
    withPin(root, {
      'release/danger.mjs': 'export const f = (dir) => rmSync(dir, { recursive: true, force: true });\n',
    });

    const res = checkRelease(root);
    assert.match(said(res), /release\/danger\.mjs/);
    assert.match(said(res), /может удалить содержимое цели/);
  } finally { cleanup(root); }
});

test('rmSync recursive рядом с removeJunction разрешён', () => {
  // Удаление каталога релиза целиком законно, но только после явного снятия
  // указателей. Признак снятия — вызов removeJunction в том же файле.
  const root = tempRoot();
  try {
    withPin(root, {
      'release/prune.mjs': [
        'export const f = (dir) => {',
        '  removeJunction(join(dir, "prompts"));',
        '  rmSync(dir, { recursive: true, force: true });',
        '};',
        '',
      ].join('\n'),
    });

    assert.equal(checkRelease(root).count, 0, said(checkRelease(root)));
  } finally { cleanup(root); }
});

// ── проверка 4: пин корня ────────────────────────────────────────────────────

test('отсутствие пина корня поймано', () => {
  // Без realpath при старте процесс читает через указатель, и гейт раскладки был
  // бы зелёным на сломанном INV-13.
  const root = tempRoot();
  try {
    put(root, 'server/index.mjs', 'export const start = (r) => r;\n');

    assert.match(said(checkRelease(root)), /нет пина корня/);
  } finally { cleanup(root); }
});

test('отсутствие server/index.mjs пином не считается', () => {
  // На проекте без сервера проверять пин нечего, и красный гейт здесь означал бы
  // «сделай всё сразу».
  const root = tempRoot();
  try {
    put(root, 'release/index.mjs', 'export const x = 1;\n');

    assert.equal(checkRelease(root).count, 0, said(checkRelease(root)));
  } finally { cleanup(root); }
});

// ── снятие комментариев ──────────────────────────────────────────────────────

test('stripComments сохраняет число строк', () => {
  // Номера строк в сообщениях гейта обязаны совпадать с исходником, иначе отладка
  // превращается в угадывание.
  const text = 'const a = 1;\n// комментарий\nconst b = 2;\n';
  const lines = stripComments(text);

  assert.equal(lines.length, text.split('\n').length);
  assert.equal(lines[1].includes('комментарий'), false);
});

test('блочный комментарий в несколько строк снят целиком', () => {
  const text = ['/*', ' * live тут не код', ' */', 'const x = 1;'].join('\n');
  const lines = stripComments(text);

  assert.equal(lines.some((l, i) => i < 3 && l.includes('live')), false);
  assert.equal(lines[3].includes('const'), true);
});

// ── чистый проект ────────────────────────────────────────────────────────────

test('на настоящем проекте гейт зелёный', () => {
  // Последняя проверка, а не первая: зелёный на чистом проекте ничего не значит,
  // пока не доказано, что гейт умеет краснеть.
  const res = checkRelease(process.cwd());

  assert.equal(res.count, 0, said(res));
  assert.equal(res.selfTested, true, 'гейт не прошёл самопроверку');
});
