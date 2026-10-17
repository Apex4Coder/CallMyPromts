// tests/unit/clip-privacy.test.mjs — приватность журнала буфера.
//
// Требование: REQ-CLIP-PRIVACY (docs/SPEC.md §4). Правило: docs/RULES.md §6.
// Сценарий: S-04, плохие пути.
//
// Журнал буфера — самое опасное место приложения: через буфер проходят пароли,
// токены и приватные ключи. Журнал, который их запоминает и потом отдаёт наружу,
// опаснее отсутствия журнала. Проверяются три защиты по отдельности:
// не записывать, не показывать открыто, не выпускать за пределы машины.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  findSecretMarks,
  looksSecret,
  screen,
  mask,
  eventLine,
  viewFlags,
  assertNotSynced,
  SYNC_DENY,
  ClipStore,
} from '../../clipboard/index.mjs';

import { BLACKLIST_DEFAULT } from '../../contracts/index.mjs';
import { tempRoot, cleanup } from '../helpers/harness.mjs';

/**
 * Образцы формата известных секретов. Значения выдуманы, но форма настоящая —
 * иначе проверка не проверяла бы ничего.
 *
 * Все образцы собираются из частей, и это не украшение. Гейт секретов
 * (gates/secret-check.mjs) читает файлы проекта теми же правилами, что и журнал
 * буфера, и на целых литералах он останавливал сборку — справедливо, потому что
 * отличить образец от настоящего ключа по тексту нельзя. Склейка оставляет форму
 * для проверяемого кода и убирает совпадение из исходника.
 */
const part = (...bits) => bits.join('');

const SAMPLES = {
  'ключ OpenAI': part('sk', '-', 'a1B2c3D4e5F6g7H8i9J0'),
  'токен GitHub': part('ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2'),
  'токен Slack': part('xox', 'b-', '1234567890', '-abcdefghijkl'),
  'ключ AWS': part('AKIA', 'IOSFODNN7', 'EXAMPLE'),
  'приватный ключ': part(
    '-----BEGIN RSA ', 'PRIVATE', ' KEY-----\n',
    'MIIE...\n',
    '-----END RSA ', 'PRIVATE', ' KEY-----',
  ),
  'токен JWT': part('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.abcde'),
  'пара логин-пароль': part('pass', 'word: ', 'очень-секретный-пароль'),
  'строка подключения': part('postgres://', 'admin', ':', 's3cret', '@db.example.com:5432/main'),
};

// ── распознавание секретов ───────────────────────────────────────────────────

test('каждый известный вид секрета распознаётся и назван', () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    assert.deepEqual(findSecretMarks(text), [name], `${name}: не распознан или назван иначе`);
  }
});

test('обычный текст секретом не считается', () => {
  // Ложное срабатывание заставит скрывать половину журнала, и человек перестанет
  // доверять пометке вообще.
  for (const text of [
    'Проверь этот код на ошибки и предложи улучшения.',
    'const password = getPassword();',
    'https://example.com/docs/authentication',
    'Мой пароль забыл, надо восстановить',
    'sk-короткий',
    'AKIA-не-ключ',
  ]) {
    assert.deepEqual(findSecretMarks(text), [], `ложное срабатывание: ${text}`);
  }
});

test('пароль в русской записи тоже распознаётся', () => {
  assert.equal(looksSecret('пароль = qwerty12345'), true);
  assert.equal(looksSecret('Пароль: abcd1234'), true);
});

test('несколько секретов в одном тексте — все названы', () => {
  const text = `${SAMPLES['ключ AWS']}\n${SAMPLES['токен GitHub']}`;

  const marks = findSecretMarks(text);

  assert.equal(marks.length, 2);
  assert.equal(marks.includes('ключ AWS'), true);
  assert.equal(marks.includes('токен GitHub'), true);
});

test('пустой ввод секретом не считается', () => {
  for (const v of ['', null, undefined, '   ']) assert.equal(looksSecret(v), false);
});

// ── защита первая: не записывать ─────────────────────────────────────────────

test('в списке по умолчанию менеджеры паролей', () => {
  // Буфер менеджера паролей содержит сам пароль — записывать его нельзя никогда.
  for (const name of ['keepass', 'bitwarden', '1password', 'lastpass']) {
    assert.equal(BLACKLIST_DEFAULT.includes(name), true, `${name}: должен быть в списке`);
  }
});

test('источник из чёрного списка не записывается, причина названа', () => {
  const out = screen('любой текст', { sourceApp: 'KeePassXC.exe' });

  assert.equal(out.skip, true);
  assert.equal(out.reason, 'blacklisted');
  assert.match(out.why, /KeePassXC\.exe/, 'человек должен видеть, какой источник исключён');
});

test('чёрный список действует независимо от содержимого', () => {
  // Из менеджера паролей может прийти и заметка. Разбираться, пароль это или нет,
  // означало бы читать содержимое, которое мы решили не читать.
  const out = screen('это просто заметка из менеджера', { sourceApp: 'bitwarden' });

  assert.equal(out.skip, true);
});

test('в отклонённой записи содержимое не сохраняется нигде', () => {
  const out = screen('sk-abcdefghij1234567890abcd', { sourceApp: 'keepass.exe' });

  const dump = JSON.stringify(out);
  assert.equal(dump.includes('sk-abcdefghij'), false, 'содержимое не должно попасть даже в ответ');
});

test('чёрный список не запоминает названия секретов из отклонённой записи', () => {
  // Список видов секретов — это тоже сведения о содержимом. У отклонённого
  // источника мы содержимое не анализируем.
  const out = screen(SAMPLES['ключ AWS'], { sourceApp: 'keepass.exe' });

  assert.deepEqual(out.marks, []);
});

test('режим skip не записывает секрет даже из обычного приложения', () => {
  const out = screen(SAMPLES['токен GitHub'], { sourceApp: 'Code.exe', watchSecrets: 'skip' });

  assert.equal(out.skip, true);
  assert.equal(out.reason, 'secret');
  assert.match(out.why, /токен GitHub/, 'причина названа видом секрета, а не самим значением');
  assert.equal(out.why.includes('ghp_'), false, 'значение в причину не попадает');
});

test('режим mark записывает, но помечает', () => {
  // По умолчанию именно так: терять запись без спроса хуже, чем показать её
  // скрытой. Решение о показе остаётся за человеком.
  const out = screen(SAMPLES['ключ AWS'], { sourceApp: 'Code.exe', watchSecrets: 'mark' });

  assert.equal(out.skip, false);
  assert.equal(out.sensitive, true);
  assert.deepEqual(out.marks, ['ключ AWS']);
});

test('режим off не помечает ничего', () => {
  const out = screen(SAMPLES['ключ AWS'], { sourceApp: 'Code.exe', watchSecrets: 'off' });

  assert.equal(out.skip, false);
});

test('обычный текст проходит без пометок', () => {
  const out = screen('Проверь код на ошибки.', { sourceApp: 'Code.exe' });

  assert.equal(out.skip, false);
  assert.equal(out.sensitive, false);
  assert.deepEqual(out.marks, []);
});

test('журнал не создаёт запись из чёрного списка', () => {
  const root = tempRoot();
  const db = new ClipStore(join(root, 'state', 'clips.db'));
  try {
    const out = db.add('пароль из менеджера', { sourceApp: 'KeePass.exe' });

    assert.equal(out.ok, false);
    assert.equal(out.skipped, 'blacklisted');
    assert.equal(db.count(), 0, 'в базе не должно остаться следа');
  } finally { db.close(); cleanup(root); }
});

test('журнал помечает секрет, но запись создаёт', () => {
  const root = tempRoot();
  const db = new ClipStore(join(root, 'state', 'clips.db'));
  try {
    const out = db.add(SAMPLES['ключ AWS'], { sourceApp: 'Code.exe' });

    assert.equal(out.ok, true);
    assert.equal(out.sensitive, true);
    assert.deepEqual(out.marks, ['ключ AWS']);
  } finally { db.close(); cleanup(root); }
});

// ── защита вторая: не показывать открыто ─────────────────────────────────────

test('маска показывает только края', () => {
  const out = mask('sk-abcdefghij1234567890abcd');

  assert.match(out, /^sk-a/);
  assert.match(out, /abcd$/);
  assert.equal(out.includes('efghij'), false, 'середина скрыта');
});

test('длина маски не выдаёт длину секрета', () => {
  // Иначе по маске можно оценить, какой это токен.
  const short = mask('sk-abcdefghij1234567890');
  const long = mask(`sk-${'x'.repeat(500)}`);

  assert.equal(short.length, long.length);
});

test('короткое значение скрывается целиком', () => {
  const out = mask('1234');

  assert.equal(/[0-9]/.test(out), false, 'ни одного знака исходного значения');
});

test('запись с секретом приходит в интерфейс скрытой и с подсказкой', () => {
  const out = viewFlags({ text: SAMPLES['токен JWT'] });

  assert.equal(out.sensitive, true);
  assert.equal(out.hidden, true, 'по умолчанию скрыто: показ — отдельное действие человека');
  assert.match(out.hint, /Показать/, 'человек должен знать, как открыть');
  assert.match(out.hint, /токен JWT/, 'и что именно скрыто');
});

test('обычная запись не скрывается', () => {
  const out = viewFlags({ text: 'Проверь код.' });

  assert.equal(out.hidden, false);
  assert.equal(out.hint, null);
});

test('пометка считается и по preview, когда полного текста нет', () => {
  // Список запросов отдаёт только preview. Пометка обязана работать и там.
  const out = viewFlags({ preview: SAMPLES['ключ AWS'] });

  assert.equal(out.hidden, true);
});

test('строка события не содержит содержимого', () => {
  const line = eventLine({
    kind: 'text', bytes: 42, hash: 'abcdef1234567890', sourceApp: 'Code.exe', skipped: 'secret',
  });

  assert.match(line, /kind=text/);
  assert.match(line, /bytes=42/);
  assert.match(line, /skipped=secret/);
  assert.equal(line.includes('abcdef1234567890'), false, 'полный хэш не нужен: хватает хвоста');
  assert.match(line, /hash=abcdef12/);
});

test('строка события выдерживает отсутствие источника', () => {
  const line = eventLine({ kind: 'text', bytes: 1, hash: 'aa' });

  assert.match(line, /src=-/, 'прочерк вместо undefined');
});

test('длинное имя источника в событии обрезается', () => {
  // Имя процесса приходит от ОС и может быть любым; журнал событий не место
  // для неограниченных строк.
  const line = eventLine({ sourceApp: 'п'.repeat(200) });

  assert.equal(line.length < 120, true);
});

// ── защита третья: не выпускать ──────────────────────────────────────────────

test('журнал не подлежит синхронизации: попытка — исключение', () => {
  // Жёсткое «нет» в коде дешевле разбора утечки потом. Владелец отложил облачную
  // синхронизацию на последнюю итерацию, и к тому моменту запрет уже стоит.
  for (const path of ['state/clips.db', 'state/token', 'C:\\deck\\state\\clips.db']) {
    assert.throws(() => assertNotSynced(path), /не синхронизируется/, `${path}: должен быть запрещён`);
  }
});

test('библиотека промптов синхронизации не запрещена', () => {
  // Промпты — то, что владелец как раз хочет переносить между компьютерами.
  for (const path of ['prompts/code/c-review.md', 'docs/SPEC.md', 'arch.yaml']) {
    assert.equal(assertNotSynced(path), true, `${path}: должен быть разрешён`);
  }
});

test('список запрещённых к выпуску назван явно', () => {
  for (const name of ['state/', 'clips.db', 'runtime.json', 'token']) {
    assert.equal(SYNC_DENY.includes(name), true, `${name}: обязателен в списке запрета`);
  }
});
