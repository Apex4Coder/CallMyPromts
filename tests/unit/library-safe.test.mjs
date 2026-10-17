// tests/unit/library-safe.test.mjs — сохранность пользовательских данных при записи.
//
// Требование: REQ-LIB-SAFE (docs/SPEC.md §3). Сценарий: S-10 (правка промпта).
//
// Это тест про главный дефект прежней системы: скрипт перезаписывал файл целиком,
// потому что нашёл в тексте слово TODO, и вместе с телом уходила вся статистика —
// used, last_used, закрепление, теги, дата создания. Здесь проверяется, что запись
// не теряет ничего, кроме того, что человек просил изменить.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  writeAtomic,
  promptPath,
  createPrompt,
  updatePrompt,
  markUsed,
  readPromptFile,
} from '../../library/index.mjs';

import { tempRoot, cleanup, promptFile } from '../helpers/harness.mjs';

// ── writeAtomic ──────────────────────────────────────────────────────────────

test('атомарная запись не оставляет временных файлов', async () => {
  const root = tempRoot();
  try {
    const file = join(root, 'code', 'a.md');
    await writeAtomic(file, 'текст\n');

    const left = readdirSync(join(root, 'code')).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(left, [], 'временный файл обязан быть переименован, а не брошен');
    assert.equal(readFileSync(file, 'utf8'), 'текст\n');
  } finally { cleanup(root); }
});

test('атомарная запись создаёт отсутствующую папку', async () => {
  const root = tempRoot();
  try {
    const file = join(root, 'новая', 'вложенная', 'a.md');
    await writeAtomic(file, 'ок\n');

    assert.equal(readFileSync(file, 'utf8'), 'ок\n');
  } finally { cleanup(root); }
});

test('повторная запись заменяет содержимое целиком, без склейки', async () => {
  const root = tempRoot();
  try {
    const file = join(root, 'code', 'a.md');
    await writeAtomic(file, 'очень длинный первый текст\n');
    await writeAtomic(file, 'кратко\n');

    assert.equal(readFileSync(file, 'utf8'), 'кратко\n', 'хвост прежнего текста не должен оставаться');
  } finally { cleanup(root); }
});

test('файл всегда в UTF-8 без BOM: иначе frontmatter не читается', async () => {
  const root = tempRoot();
  try {
    const file = join(root, 'code', 'a.md');
    await writeAtomic(file, '---\nid: "тест"\n---\n\nтело\n');

    const buf = readFileSync(file);
    assert.notEqual(buf[0], 0xEF, 'BOM ломает разбор первой строки ---');
    assert.equal(buf.toString('utf8').startsWith('---'), true);
  } finally { cleanup(root); }
});

// ── слияние метаданных ───────────────────────────────────────────────────────

test('правка тела сохраняет всю служебную статистику', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x', {
      used: 42,
      last_used: '2026-08-01T12:00:00Z',
      score: 5,
      created: '2025-03-14',
      pin: 3,
      tags: ['ревью', 'код'],
      source: 'anthropic',
    });

    const out = await updatePrompt(root, 'c-x', 'code', { body: 'Совсем новое тело.' });
    assert.equal(out.ok, true, JSON.stringify(out.issues));

    const item = await readPromptFile(root, promptPath(root, 'code', 'c-x'));
    assert.equal(item.body, 'Совсем новое тело.');
    assert.equal(item.used, 42, 'счётчик использований');
    assert.equal(item.last_used, '2026-08-01T12:00:00Z', 'дата последнего использования');
    assert.equal(item.score, 5, 'оценка');
    assert.equal(item.created, '2025-03-14', 'дата создания не подменяется датой правки');
    assert.equal(item.pin, 3, 'закрепление');
    assert.deepEqual(item.tags, ['ревью', 'код'], 'теги');
    assert.equal(item.source, 'anthropic', 'источник');
  } finally { cleanup(root); }
});

test('правка заголовка сохраняет тело', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x', { body: 'Тело, которое нельзя потерять.' });

    await updatePrompt(root, 'c-x', 'code', { title: 'Другое имя' });

    const item = await readPromptFile(root, promptPath(root, 'code', 'c-x'));
    assert.equal(item.title, 'Другое имя');
    assert.equal(item.body, 'Тело, которое нельзя потерять.');
  } finally { cleanup(root); }
});

test('поле updated обновляется — это единственная дата, которую пишет правка', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x', { created: '2025-01-01', updated: '2025-01-01' });

    await updatePrompt(root, 'c-x', 'code', { body: 'Новое.' });

    const item = await readPromptFile(root, promptPath(root, 'code', 'c-x'));
    assert.equal(item.created, '2025-01-01');
    assert.equal(item.updated, new Date().toISOString().slice(0, 10));
  } finally { cleanup(root); }
});

test('слово TODO в теле не является поводом стереть файл', async () => {
  // Прежний скрипт считал TODO признаком заглушки и перезаписывал файл шаблоном.
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x', { used: 9, body: 'Рабочий промпт. TODO: добавить пример.' });

    const item = await readPromptFile(root, promptPath(root, 'code', 'c-x'));
    assert.equal(item.used, 9);
    assert.match(item.body, /Рабочий промпт/);
  } finally { cleanup(root); }
});

test('markUsed не сбрасывает остальные поля', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x', { used: 4, pin: 2, tags: ['а'], source: 'ручной', score: 3 });

    await markUsed(root, 'c-x', 'code');

    const item = await readPromptFile(root, promptPath(root, 'code', 'c-x'));
    assert.equal(item.used, 5);
    assert.equal(item.pin, 2);
    assert.deepEqual(item.tags, ['а']);
    assert.equal(item.source, 'ручной');
    assert.equal(item.score, 3);
  } finally { cleanup(root); }
});

test('десять отметок подряд дают ровно десять', async () => {
  // Потеря инкремента на конкурентных записях выглядела бы как «счётчик врёт».
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x', { used: 0 });

    for (let i = 0; i < 10; i += 1) await markUsed(root, 'c-x', 'code');

    const item = await readPromptFile(root, promptPath(root, 'code', 'c-x'));
    assert.equal(item.used, 10);
  } finally { cleanup(root); }
});

// ── защита от перезаписи чужой правки ────────────────────────────────────────

test('изменение файла в редакторе отменяет перезапись', async () => {
  const root = tempRoot();
  try {
    const file = promptFile(root, 'code', 'c-x', { body: 'Исходное.' });
    const mtime = statSync(file).mtimeMs;

    // Человек правит файл в VS Code, пока окно приложения открыто.
    await new Promise((r) => { setTimeout(r, 20); });
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nДописано вручную.\n`, 'utf8');

    const out = await updatePrompt(root, 'c-x', 'code', { body: 'Из приложения.' }, { expectedMtime: mtime });

    assert.equal(out.ok, false);
    assert.equal(out.conflict, true);
    assert.equal(out.issues[0].code, 'changed_outside');
    assert.match(readFileSync(file, 'utf8'), /Дописано вручную/, 'ручная правка обязана остаться');
  } finally { cleanup(root); }
});

test('без expectedMtime запись идёт: проверка не навязывается', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x');

    const out = await updatePrompt(root, 'c-x', 'code', { body: 'Новое.' });

    assert.equal(out.ok, true, JSON.stringify(out.issues));
  } finally { cleanup(root); }
});

// ── отказ вместо порчи ───────────────────────────────────────────────────────

test('пустое тело отклоняется, файл остаётся прежним', async () => {
  const root = tempRoot();
  try {
    const file = promptFile(root, 'code', 'c-x', { body: 'Ценное тело.' });

    const out = await updatePrompt(root, 'c-x', 'code', { body: '   \n\n  ' });

    assert.equal(out.ok, false);
    assert.equal(out.issues.some((i) => i.level === 'bad'), true);
    assert.match(readFileSync(file, 'utf8'), /Ценное тело/, 'отказ не должен обнулять файл');
  } finally { cleanup(root); }
});

// Плохие пути с испорченным frontmatter вынесены в
// tests/unit/library-broken.test.mjs — там их восемь, и вместе файлы вышли бы
// за предел 300 строк (docs/RULES.md §3).

test('создание не перезаписывает существующий файл', async () => {
  const root = tempRoot();
  try {
    const file = promptFile(root, 'code', 'obzor-koda', { used: 15, body: 'Старый обзор.' });

    const out = await createPrompt(root, { title: 'Обзор кода', group: 'code', body: 'Новый обзор.' });

    assert.equal(out.ok, true);
    assert.equal(out.id, 'obzor-koda-2', 'занятый id получает суффикс');
    assert.match(readFileSync(file, 'utf8'), /Старый обзор/, 'исходный файл не тронут');
  } finally { cleanup(root); }
});

test('файл после записи читается обратно без потерь', async () => {
  // Круговая проверка: запись → чтение → сравнение. Любое расхождение схемы
  // между писателем и читателем всплывает здесь, а не у пользователя.
  const root = tempRoot();
  try {
    const out = await createPrompt(root, {
      title: 'Проверка круга',
      group: 'code',
      body: 'Первая строка.\n\nВторая строка.',
      // Метки русские намеренно: их читает человек, а не файловая система.
      // Триггер обязан быть латиницей — он набирается с клавиатуры.
      tags: ['круг', 'проверка'],
      source: 'тест',
      trigger: ':krug',
    });
    assert.equal(out.ok, true, JSON.stringify(out.issues));

    const item = await readPromptFile(root, out.path);
    assert.equal(item.title, 'Проверка круга');
    assert.equal(item.group, 'code');
    assert.equal(item.body, 'Первая строка.\n\nВторая строка.', 'пустая строка между абзацами сохраняется');
    assert.deepEqual(item.tags, ['круг', 'проверка']);
    assert.equal(item.source, 'тест');
    assert.equal(item.trigger, ':krug');
    assert.equal(item.state, 'good', JSON.stringify(item.issues));
  } finally { cleanup(root); }
});

test('русский триггер отклоняется: его набирают с клавиатуры', async () => {
  const root = tempRoot();
  try {
    const out = await createPrompt(root, {
      title: 'Русский триггер', group: 'code', body: 'Тело.', trigger: ':круг',
    });

    assert.equal(out.issues.some((i) => i.code === 'V-P-6'), true, 'формат триггера обязан быть назван');
  } finally { cleanup(root); }
});
