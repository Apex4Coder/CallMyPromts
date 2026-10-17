// tests/unit/library-write.test.mjs — запись промптов без потери данных.
//
// Требование: REQ-LIB-WRITE (docs/SPEC.md §3). Сценарий S-10.
//
// Центральное свойство: запись НЕ теряет то, что записано раньше. Прежняя система
// перезаписывала файл целиком, потому что нашла в тексте слово TODO, — и вместе с
// текстом стирала статистику использований.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

import { tempRoot, cleanup, promptFile } from '../helpers/harness.mjs';
import {
  createPrompt, updatePrompt, markUsed, setPin, promptPath, freeId, readPromptFile, readLibrary,
} from '../../library/index.mjs';

test('создаёт файл в группе, id из заголовка транслитерацией', async () => {
  const root = tempRoot();
  try {
    const out = await createPrompt(root, { title: 'Ревью кода', group: 'code', body: 'Тело промпта.' });

    assert.equal(out.ok, true, JSON.stringify(out.issues));
    assert.equal(out.id, 'revyu-koda');
    assert.equal(out.group, 'code');

    const item = await readPromptFile(root, out.path);
    assert.equal(item.state, 'good');
    assert.equal(item.title, 'Ревью кода');
    assert.equal(item.used, 0);
  } finally {
    cleanup(root);
  }
});

test('имя группы приводится к допустимому виду', async () => {
  const root = tempRoot();
  try {
    const out = await createPrompt(root, { title: 'Тест', group: 'Мои Промпты!', body: 'тело' });
    assert.equal(out.group, 'moi-prompty');
  } finally {
    cleanup(root);
  }
});

test('занятый id получает суффикс: перезаписи без спроса нет', async () => {
  const root = tempRoot();
  try {
    const first = await createPrompt(root, { title: 'Ревью кода', group: 'code', body: 'первый' });
    const second = await createPrompt(root, { title: 'Ревью кода', group: 'code', body: 'второй' });

    assert.equal(first.id, 'revyu-koda');
    assert.equal(second.id, 'revyu-koda-2');
    assert.match(readFileSync(first.path, 'utf8'), /первый/, 'первый файл не тронут');
  } finally {
    cleanup(root);
  }
});

test('freeId ищет свободное имя, не занимая существующее', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x');
    assert.equal(await freeId(root, 'code', 'c-x'), 'c-x-2');
    assert.equal(await freeId(root, 'code', 'c-new'), 'c-new');
  } finally {
    cleanup(root);
  }
});

test('пустое тело не создаёт файл: вставлять пустоту нельзя', async () => {
  const root = tempRoot();
  try {
    const out = await createPrompt(root, { title: 'Пустой', group: 'code', body: '   ' });

    assert.equal(out.ok, false);
    assert.ok(out.issues.some((i) => i.code === 'V-P-8'));
  } finally {
    cleanup(root);
  }
});

test('HTML чистится при создании и это названо', async () => {
  const root = tempRoot();
  try {
    const out = await createPrompt(root, { title: 'Из докса', group: 'code', body: '<p>Текст.</p>' });

    assert.ok(out.cleaned.includes('html'));
    const item = await readPromptFile(root, out.path);
    assert.equal(item.body, 'Текст.');
  } finally {
    cleanup(root);
  }
});

test('обновление сохраняет счётчик использований', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x', { used: 17, last_used: '2026-05-01T10:00:00Z' });

    const out = await updatePrompt(root, 'c-x', 'code', { title: 'Новое имя', body: 'Новое тело.' });
    assert.equal(out.ok, true, JSON.stringify(out.issues));

    const item = await readPromptFile(root, promptPath(root, 'code', 'c-x'));
    assert.equal(item.title, 'Новое имя');
    assert.equal(item.body, 'Новое тело.');
    assert.equal(item.used, 17, 'статистика не должна теряться при правке');
    assert.equal(item.last_used, '2026-05-01T10:00:00Z');
  } finally {
    cleanup(root);
  }
});

test('used из запроса игнорируется: поле пишет только программа', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x', { used: 5 });
    await updatePrompt(root, 'c-x', 'code', { used: 9999, title: 'Имя' });

    const item = await readPromptFile(root, promptPath(root, 'code', 'c-x'));
    assert.equal(item.used, 5, 'подмена счётчика извне запрещена');
  } finally {
    cleanup(root);
  }
});

test('обновление несуществующего промпта — понятный отказ', async () => {
  const root = tempRoot();
  try {
    const out = await updatePrompt(root, 'нет-такого', 'code', { title: 'Имя' });

    assert.equal(out.ok, false);
    assert.equal(out.issues[0].code, 'not_found');
  } finally {
    cleanup(root);
  }
});

test('файл изменён снаружи — перезапись отменяется, а не выполняется молча', async () => {
  const root = tempRoot();
  try {
    const file = promptFile(root, 'code', 'c-x', { body: 'важный текст человека' });
    const out = await updatePrompt(root, 'c-x', 'code', { body: 'текст программы' }, { expectedMtime: 1 });

    assert.equal(out.ok, false);
    assert.equal(out.conflict, true);
    assert.match(readFileSync(file, 'utf8'), /важный текст человека/);
  } finally {
    cleanup(root);
  }
});

test('совпадающий mtime разрешает запись', async () => {
  const root = tempRoot();
  try {
    const file = promptFile(root, 'code', 'c-x');
    const mtime = statSync(file).mtimeMs;

    const out = await updatePrompt(root, 'c-x', 'code', { body: 'новое тело' }, { expectedMtime: mtime });
    assert.equal(out.ok, true, JSON.stringify(out.issues));
  } finally {
    cleanup(root);
  }
});

test('markUsed — единственный способ увеличить счётчик', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x', { used: 0, last_used: null });

    const first = await markUsed(root, 'c-x', 'code');
    assert.equal(first.used, 1);
    assert.ok(first.last_used, 'время последнего использования должно появиться');

    await markUsed(root, 'c-x', 'code');
    const item = await readPromptFile(root, promptPath(root, 'code', 'c-x'));
    assert.equal(item.used, 2);
  } finally {
    cleanup(root);
  }
});

test('markUsed не портит тело промпта', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x', { body: 'Точный текст промпта.' });
    await markUsed(root, 'c-x', 'code');

    const item = await readPromptFile(root, promptPath(root, 'code', 'c-x'));
    assert.equal(item.body, 'Точный текст промпта.');
  } finally {
    cleanup(root);
  }
});

test('закрепление на свободную позицию', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x');
    const lib = await readLibrary(root);

    const out = await setPin(root, lib.items, 'c-x', 4);
    assert.equal(out.ok, true);

    const item = await readPromptFile(root, promptPath(root, 'code', 'c-x'));
    assert.equal(item.pin, 4);
  } finally {
    cleanup(root);
  }
});

test('занятая позиция обменивается, а не перезаписывается', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-old', { pin: 2 });
    promptFile(root, 'code', 'c-new', { pin: 5 });

    const lib = await readLibrary(root);
    const out = await setPin(root, lib.items, 'c-new', 2);

    assert.equal(out.ok, true);
    assert.deepEqual(out.swapped, [{ id: 'c-old', pin: 5 }]);

    const after = await readLibrary(root);
    assert.equal(after.items.find((i) => i.id === 'c-new').pin, 2);
    assert.equal(after.items.find((i) => i.id === 'c-old').pin, 5, 'прежний владелец не потерял закрепление');
  } finally {
    cleanup(root);
  }
});

test('архивный промпт закрепить нельзя, причина названа', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-arch', { status: 'archived' });
    const lib = await readLibrary(root);

    const out = await setPin(root, lib.items, 'c-arch', 1);
    assert.equal(out.ok, false);
    assert.match(out.issues[0].message, /архивн/);
  } finally {
    cleanup(root);
  }
});
