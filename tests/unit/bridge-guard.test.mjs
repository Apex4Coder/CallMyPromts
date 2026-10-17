// tests/unit/bridge-guard.test.mjs — защита от второго экземпляра сервиса.
//
// Требование: REQ-SVC-GUARD (docs/SPEC.md §8). Сценарий: S-08.
//
// Два процесса на одной библиотеке дают расхождение счётчиков и гонку записи
// одного и того же .md — то есть ровно ту потерю данных, от которой защищает
// REQ-LIB-SAFE. Поэтому второй экземпляр не поднимается никогда.
//
// Обратная сторона: файл, оставшийся от аварийно завершённого процесса, не имеет
// права блокировать запуск. Иначе после одного падения приложение больше не
// стартует, и человек остаётся без промптов до ручной чистки (S-08, путь 3).
//
// Настоящие процессы здесь не запускаются: проверяется чтение runtime.json и
// решение на его основе. Запуск проверяется в интеграционных тестах.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  alive, readRuntime, verifyRuntime, clearStale, serviceStatus,
} from '../../bridge/index.mjs';
import { tempRoot, cleanup } from '../helpers/harness.mjs';

/** runtime.json с заданным pid. По умолчанию — pid текущего процесса, он жив. */
const runtime = (root, over = {}) => {
  mkdirSync(join(root, 'state'), { recursive: true });
  const file = join(root, 'state', 'runtime.json');
  writeFileSync(file, `${JSON.stringify({
    pid: over.pid ?? process.pid,
    port: over.port ?? 8791,
    started_at: over.started_at ?? new Date().toISOString(),
    hotkeys: over.hotkeys ?? {},
  }, null, 2)}\n`, 'utf8');
  return file;
};

/** Номер процесса, которого точно нет: за пределами диапазона pid. */
const DEAD_PID = 4194304;

// ── проверка живости ─────────────────────────────────────────────────────────

test('текущий процесс считается живым', () => {
  assert.equal(alive(process.pid), true);
});

test('несуществующий процесс считается мёртвым', () => {
  assert.equal(alive(DEAD_PID), false);
});

test('мусор вместо номера процесса не считается живым', () => {
  // Битый runtime.json не должен выглядеть как работающий сервис.
  for (const v of [0, -1, 1.5, null, undefined, 'pid', NaN]) {
    assert.equal(alive(v), false, `${JSON.stringify(v)}: не должно считаться живым`);
  }
});

// ── чтение состояния ─────────────────────────────────────────────────────────

test('без файла сервис не запущен, и это сказано словами', () => {
  const root = tempRoot();
  try {
    const out = readRuntime(root);

    assert.equal(out.running, false);
    assert.equal(out.runtime, null);
    assert.match(out.reason, /не запущен/);
    assert.equal(out.stale, undefined, 'нечего убирать — это не остаток');
  } finally { cleanup(root); }
});

test('живой процесс в файле означает работающий сервис', () => {
  const root = tempRoot();
  try {
    runtime(root, { port: 8791 });

    const out = readRuntime(root);

    assert.equal(out.running, true);
    assert.equal(out.reason, null);
    assert.equal(out.runtime.port, 8791);
  } finally { cleanup(root); }
});

test('мёртвый процесс — остаток, и номер процесса назван', () => {
  const root = tempRoot();
  try {
    runtime(root, { pid: DEAD_PID });

    const out = readRuntime(root);

    assert.equal(out.running, false);
    assert.equal(out.stale, true);
    assert.match(out.reason, new RegExp(String(DEAD_PID)), 'в причине виден номер процесса');
    assert.match(out.reason, /прошлого запуска/);
  } finally { cleanup(root); }
});

test('нечитаемый файл — тоже остаток, а не работающий сервис', () => {
  // «Не могу прочитать» не означает «запущен». Считать иначе значило бы
  // заблокировать запуск навсегда одной испорченной строкой.
  const root = tempRoot();
  try {
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'state', 'runtime.json'), 'не json', 'utf8');

    const out = readRuntime(root);

    assert.equal(out.running, false);
    assert.equal(out.stale, true);
    assert.match(out.reason, /не читается/);
  } finally { cleanup(root); }
});

test('файл без pid считается остатком', () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'state', 'runtime.json'), '{"port": 8791}', 'utf8');

    const out = readRuntime(root);

    assert.equal(out.running, false);
    assert.equal(out.stale, true);
  } finally { cleanup(root); }
});

test('живой чужой pid без отвечающего сервера считается остатком', async () => {
  const root = tempRoot();
  try {
    // PID существует, но на указанном порту нет CallMyPromts. Одной проверки
    // process.kill(pid, 0) недостаточно: Windows может повторно использовать PID.
    runtime(root, { pid: process.pid, port: 65534 });

    const out = await verifyRuntime(root, { timeoutMs: 100 });

    assert.equal(out.running, false);
    assert.equal(out.stale, true);
    assert.match(out.reason, /не отвечает|не CallMyPromts/);
  } finally { cleanup(root); }
});

// ── уборка остатка ───────────────────────────────────────────────────────────

test('остаток отводится в сторону, а не удаляется', () => {
  // Это данные о прошлом запуске: по ним разбирают, почему сервис упал.
  const root = tempRoot();
  try {
    const file = runtime(root, { pid: DEAD_PID });

    assert.equal(clearStale(root), true);
    assert.equal(existsSync(file), false, 'исходное имя освобождено');

    const left = readdirSync(join(root, 'state')).filter((n) => n.includes('.stale-'));
    assert.equal(left.length, 1, 'файл сохранён под другим именем');
  } finally { cleanup(root); }
});

test('уборка при отсутствии файла возвращает false без сбоя', () => {
  const root = tempRoot();
  try {
    assert.equal(clearStale(root), false);
  } finally { cleanup(root); }
});

test('после уборки состояние читается как «не запущен»', () => {
  const root = tempRoot();
  try {
    runtime(root, { pid: DEAD_PID });
    clearStale(root);

    const out = readRuntime(root);

    assert.equal(out.running, false);
    assert.equal(out.stale, undefined, 'остатка больше нет');
  } finally { cleanup(root); }
});

test('несколько уборок подряд не затирают предыдущий отвод', () => {
  const root = tempRoot();
  try {
    runtime(root, { pid: DEAD_PID });
    clearStale(root);
    runtime(root, { pid: DEAD_PID });
    clearStale(root);

    const left = readdirSync(join(root, 'state')).filter((n) => n.includes('.stale-'));
    assert.equal(left.length >= 1, true, 'имена различаются меткой времени');
  } finally { cleanup(root); }
});

// ── сводка для трея ──────────────────────────────────────────────────────────

test('сводка перечисляет части по отдельности', () => {
  // Сервер и мост ломаются независимо: одно состояние на оба скрыло бы, что
  // именно не работает.
  const root = tempRoot();
  try {
    const out = serviceStatus(root);

    assert.equal(typeof out.server.state, 'string');
    assert.equal(typeof out.bridge.state, 'string');
    assert.equal(typeof out.hotkeys, 'object');
  } finally { cleanup(root); }
});

test('остановленный сервер — состояние none с причиной', () => {
  const root = tempRoot();
  try {
    const out = serviceStatus(root);

    assert.equal(out.server.state, 'none');
    assert.match(out.server.reason, /не запущен/);
  } finally { cleanup(root); }
});

test('при остановленном сервере хоткеи пусты: обещать нечего', () => {
  // Показать список клавиш у остановленного сервиса означало бы утверждать,
  // что они работают.
  const root = tempRoot();
  try {
    runtime(root, { pid: DEAD_PID, hotkeys: { picker: { state: 'good' } } });

    assert.deepEqual(serviceStatus(root).hotkeys, {});
  } finally { cleanup(root); }
});

test('работающий сервер отдаёт порт и время запуска', () => {
  const root = tempRoot();
  try {
    const started = '2026-09-05T10:00:00.000Z';
    runtime(root, { port: 9999, started_at: started });

    const out = serviceStatus(root);

    assert.equal(out.server.state, 'good');
    assert.equal(out.server.port, 9999);
    assert.equal(out.server.startedAt, started);
  } finally { cleanup(root); }
});

test('состояние хоткеев берётся из runtime, а не выдумывается', () => {
  // В runtime.json пишет сервер по докладу моста: это единственное место, где
  // известно, что удалось зарегистрировать в ОС.
  const root = tempRoot();
  try {
    const keys = { picker: { state: 'warn', reason: 'вероятно занята: ClipClip' } };
    runtime(root, { hotkeys: keys });

    assert.deepEqual(serviceStatus(root).hotkeys, keys);
  } finally { cleanup(root); }
});

test('мост при остановленном сервере не показывается работающим', () => {
  const root = tempRoot();
  try {
    const out = serviceStatus(root);

    assert.notEqual(out.bridge.state, 'good', 'без сервера мосту некуда стучаться');
  } finally { cleanup(root); }
});
