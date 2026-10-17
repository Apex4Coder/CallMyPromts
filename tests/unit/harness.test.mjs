// tests/unit/harness.test.mjs — проверка самой обвязки и корня проекта.
//
// Требования: REQ-TEST-UNIT, REQ-CFG-ROOT (docs/SPEC.md §11, §14). Сценарий S-13.
//
// Обвязка тестируется первой: если фикстуры лгут, все остальные тесты проверяют
// не то, что думают. Например, промпт-фикстура обязана быть валидной по схеме —
// иначе тест «битый файл помечен ✕» проходил бы всегда, включая случай поломки.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { tempRoot, cleanup, promptFile, library, rawFile, daysAgo, settingsFile } from '../helpers/harness.mjs';
import { readPromptFile, readLibrary } from '../../library/index.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

test('фикстура промпта валидна по схеме', async () => {
  const root = tempRoot();
  try {
    const file = promptFile(root, 'code', 'c-test');
    const item = await readPromptFile(root, file);

    assert.equal(item.state, 'good', `фикстура не должна давать замечаний: ${JSON.stringify(item.issues)}`);
    assert.equal(item.id, 'c-test');
    assert.equal(item.group, 'code');
    assert.equal(item.used, 0);
  } finally {
    cleanup(root);
  }
});

test('переданные поля попадают в файл', async () => {
  const root = tempRoot();
  try {
    const file = promptFile(root, 'core', 'x-plan', {
      title: 'План перед действием',
      pin: 3,
      used: 12,
      last_used: daysAgo(2),
      tags: ['plan', 'core'],
    });
    const item = await readPromptFile(root, file);

    assert.equal(item.title, 'План перед действием');
    assert.equal(item.pin, 3);
    assert.equal(item.used, 12);
    assert.deepEqual(item.tags, ['plan', 'core']);
    assert.equal(item.state, 'good');
  } finally {
    cleanup(root);
  }
});

test('library создаёт несколько промптов в разных группах', async () => {
  const root = tempRoot();
  try {
    library(root, [
      { group: 'code', id: 'c-one' },
      { group: 'code', id: 'c-two' },
      { group: 'core', id: 'x-one' },
    ]);

    const lib = await readLibrary(root);
    assert.equal(lib.stats.total, 3);
    assert.equal(lib.stats.bad, 0);
    assert.equal(lib.groups.length, 2);
  } finally {
    cleanup(root);
  }
});

test('rawFile пишет содержимое дословно — нужен для битых случаев', async () => {
  const root = tempRoot();
  try {
    const file = rawFile(root, 'code', 'broken.md', 'без frontmatter вовсе');
    assert.equal(readFileSync(file, 'utf8'), 'без frontmatter вовсе');

    const item = await readPromptFile(root, file);
    assert.equal(item.state, 'bad');
    assert.ok(item.issues.some((i) => i.code === 'V-P-1'), 'должен сработать V-P-1');
  } finally {
    cleanup(root);
  }
});

test('settingsFile пишет настройки в state/', () => {
  const root = tempRoot();
  try {
    const file = settingsFile(root, { ui: { theme: 'dark' } });
    assert.ok(existsSync(file));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).ui.theme, 'dark');
  } finally {
    cleanup(root);
  }
});

test('временная папка удаляется за собой', () => {
  const root = tempRoot();
  promptFile(root, 'code', 'c-temp');
  cleanup(root);
  assert.equal(existsSync(root), false, 'тест не должен оставлять мусор в temp');
});

test('корень проекта настроен: package.json, ноль рантайм-зависимостей', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dependencies, undefined, 'рантайм-зависимостей быть не должно (docs/RULES.md §3)');
  assert.equal(pkg.scripts.start, 'node bridge/index.mjs',
    'npm start обязан поднимать полное приложение: сервер, трей и хоткеи');
  assert.equal(pkg.scripts.server, 'node server/index.mjs',
    'отладочный запуск одного HTTP-сервера должен называться явно');
  assert.ok(pkg.scripts.gate, 'должна быть команда прогона гейтов');
  assert.ok(pkg.scripts['test:unit'], 'должна быть команда unit-тестов');
});

test('обязательные документы правды на месте', () => {
  for (const f of ['arch.yaml', 'trace.csv', 'docs/RULES.md', 'docs/SPEC.md',
    'docs/DATA-CONTRACTS.md', 'docs/ENTITY-MAP.md', 'docs/UI-SPEC.md', 'docs/SCENARIOS.md']) {
    assert.ok(existsSync(join(ROOT, f)), `нет файла ${f}`);
  }
});

test('state/ исключён из Git: в журнале буфера пароли', () => {
  const text = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  assert.ok(text.split('\n').some((l) => l.trim() === 'state/'), 'нет строки state/ в .gitignore');
});
