// tests/integration/api-release.test.mjs — критерий обновления: версия и релиз.
//
// Требование: REQ-API-READY (docs/SPEC.md §6). Концепция: gld/gold.md §1.1.
// Проверяемый файл: server/ready.mjs.
// Сами эндпоинты и их поведение — в tests/integration/api-ready.test.mjs.
//
// Выделено из api-ready.test.mjs по лимиту 300 строк, и разделение вышло по смыслу:
// там — «что отвечают три адреса», здесь — «чем обновление отличает новый код от
// старого».
//
// Это единственный честный критерий успеха обновления. «Порт занят» и «процесс
// ответил» им быть не могут: старый процесс, который не умер, удовлетворяет обоим —
// и обновление рапортует успех при работающем прежнем коде.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { UNKNOWN, readReleaseId, readCodeVersion, Readiness } from '../../server/index.mjs';
import { tempRoot, cleanup, startServer } from '../helpers/harness.mjs';

const withServer = async (fn) => {
  const root = tempRoot();
  const up = await startServer(root);
  try {
    await fn(up, root);
  } finally {
    await up.close();
    cleanup(root);
  }
};

const bare = (up, path) => fetch(`${up.url}${path.replace(/^\//, '')}`);

// ── номер релиза ─────────────────────────────────────────────────────────────

test('release_id при отсутствии файла — «unknown», а не пустая строка', async () => {
  // Типизированное незнание. Пустая строка читалась бы как «релиз без имени»,
  // null — как «поля нет». Это тот же дефект, что «score: -» → NaN в прежней
  // системе: отсутствие данных выглядело как данные.
  await withServer(async (up) => {
    const data = await (await bare(up, '/readyz')).json();

    assert.equal(data.release_id, UNKNOWN);
    assert.notEqual(data.release_id, '');
    assert.notEqual(data.release_id, null);
  });
});

test('release_id читается из .release-id, когда файл есть', () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, '.release-id'), '20260907-001500-a3f1c2\n', 'utf8');
    assert.equal(readReleaseId(root), '20260907-001500-a3f1c2');
  } finally { cleanup(root); }
});

test('пустой .release-id — это тоже «unknown»', () => {
  // Файл есть, значения нет. Принять пустоту за имя релиза значило бы сравнить
  // «» с «» при проверке обновления и получить ложное совпадение.
  const root = tempRoot();
  try {
    writeFileSync(join(root, '.release-id'), '   \n', 'utf8');
    assert.equal(readReleaseId(root), UNKNOWN);
  } finally { cleanup(root); }
});

// ── версия кода ──────────────────────────────────────────────────────────────

test('code_version берётся из package.json', () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '2.4.0' }), 'utf8');
    assert.equal(readCodeVersion(root), '2.4.0');
  } finally { cleanup(root); }
});

test('битый package.json даёт «unknown», а не падение', () => {
  // Отказ отвечать здесь означал бы, что сервис не поднимается из-за опечатки в
  // одном поле. «unknown» честнее: версия неизвестна, работа продолжается.
  const root = tempRoot();
  try {
    writeFileSync(join(root, 'package.json'), '{ это не json', 'utf8');
    assert.equal(readCodeVersion(root), UNKNOWN);
  } finally { cleanup(root); }
});

test('package.json без поля version даёт «unknown»', () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8');
    assert.equal(readCodeVersion(root), UNKNOWN);
  } finally { cleanup(root); }
});

/**
 * Версия описывает КОД, а не данные — различение поймал провалившийся тест.
 *
 * Первая версия читала `package.json` от корня ДАННЫХ (временная папка теста), где
 * его нет, и отдавала `"unknown"`. Ошибка была бы тихой и дорогой: обновление
 * сверяет `code_version`, и постоянное `"unknown" === "unknown"` дало бы ложное
 * совпадение на любом релизе — ровно тот гейт, который не может покраснеть.
 *
 * В целевой раскладке это два разных места: `releases/<id>/` — код,
 * `shared/` — состояние (gld/gold.md §3.1).
 */
test('версия в ответе совпадает с версией проекта, а не с корнем данных', async () => {
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8'));

  await withServer(async (up) => {
    const data = await (await bare(up, '/readyz')).json();

    assert.equal(data.code_version, pkg.version);
    assert.notEqual(data.code_version, UNKNOWN, 'версия читается не оттуда, где лежит код');
  });
});

test('корень кода и корень данных — разные поля ответа', async () => {
  // Пара к предыдущему тесту. Слив их в одно поле однажды вернёт ту же ошибку, и
  // тогда её опять не будет видно: оба значения выглядят как путь.
  await withServer(async (up, root) => {
    const data = await (await bare(up, '/readyz')).json();

    assert.equal(typeof data.code_root, 'string');
    const { realpathSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const expectedCodeRoot = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
    assert.equal(data.code_root, expectedCodeRoot, 'code root must match this physical source checkout');
    assert.notEqual(data.code_root, data.app_root, 'корни кода и данных совпали');
    assert.equal(data.app_root.includes('deck-test-'), true, `данные не из ${root}`);
  });
});

test('версию и релиз можно задать явно: обновление проверяет свои значения', () => {
  // Скрипту обновления нужно поднять релиз с известными значениями и сверить их.
  // Без этой возможности проверку пришлось бы делать чтением файлов со стороны.
  const r = new Readiness({ root: '/данные', codeVersion: '9.9.9', releaseId: 'rel-1' });

  assert.equal(r.codeVersion, '9.9.9');
  assert.equal(r.releaseId, 'rel-1');
  assert.equal(r.body().code_version, '9.9.9');
  assert.equal(r.body().release_id, 'rel-1');
});

// ── пин корня ────────────────────────────────────────────────────────────────

test('APP_ROOT в ответе — физический путь, а не путь запуска', async () => {
  // INV-13: `realpath` разворачивает указатель один раз при старте. Без этого
  // переустановка указателя на ходу заставила бы процесс читать два релиза сразу.
  await withServer(async (up, root) => {
    const data = await (await bare(up, '/readyz')).json();

    assert.equal(typeof data.app_root, 'string');
    assert.equal(data.app_root.includes('~'), false, 'путь не развёрнут');
    assert.equal(up.appRoot.length >= root.length - 12, true, 'корень потерян');
  });
});

test('порт в ответе — настоящий, а не запрошенный', async () => {
  // Тесты поднимают сервер на порту 0. Если бы в теле стоял 0, критерий обновления
  // сверял бы неверное значение.
  await withServer(async (up) => {
    const data = await (await bare(up, '/readyz')).json();

    assert.equal(data.port, up.port);
    assert.notEqual(data.port, 0);
  });
});

test('до старта порт неизвестен и равен null, а не нулю', () => {
  // Ноль здесь означал бы «порт 0», то есть «любой свободный», — и это неправда:
  // порт ещё не выбран. Незнание типизировано.
  const r = new Readiness({ root: '/данные' });

  assert.equal(r.port, null);
});
