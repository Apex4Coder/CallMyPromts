// tests/unit/release-swap.test.mjs — переключение указателя, откат, чистка.
//
// Требование: REQ-REL-SWAP (docs/SPEC.md §14). Концепция: gld/gold.md §3.2, §3.4.
// Проверяемый файл: release/swap.mjs.
// Сохранность состояния и INV-13 — в tests/unit/release-state.test.mjs,
// раскладка и junction — в tests/unit/release-layout.test.mjs.
//
// Здесь единственная необратимая операция слоя релизов. Два свойства важнее прочих:
//
//   1. ПУТЬ НАЗАД ПОЯВЛЯЕТСЯ ДО РИСКА. `live.prev` заводится раньше перевода `live`.
//      Если процесс умрёт между двумя операциями, откат обязан остаться возможным.
//   2. ОТКАТ — ТА ЖЕ ОПЕРАЦИЯ. Не особый режим. Отдельный код отката однажды
//      разойдётся с кодом установки, и это обнаружится в самый неудачный момент —
//      когда откат понадобился.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  NAMES, paths, ensureLayout, RETRY, withRetry,
  current, previous, listReleases, swapTo, rollback, prune,
} from '../../release/index.mjs';
import { tempRoot, cleanup } from '../helpers/harness.mjs';
import { REL, setupReleases, manyReleases } from '../helpers/releasefix.mjs';

// ── повторы ──────────────────────────────────────────────────────────────────

test('повтор возвращает успех с номером попытки', () => {
  // Антивирус держит файл доли секунды. Один отказ — не отказ.
  let calls = 0;
  const out = withRetry(() => {
    calls += 1;
    return calls < 3 ? { ok: false, why: 'файл занят' } : { ok: true, why: null };
  }, { times: 5, pauseMs: 1 });

  assert.equal(out.ok, true);
  assert.equal(out.tries, 3);
});

test('исчерпанные попытки называют причину и их число', () => {
  const out = withRetry(() => ({ ok: false, why: 'доступ запрещён' }), { times: 3, pauseMs: 1 });

  assert.equal(out.ok, false);
  assert.match(out.why, /3 попыток подряд/);
  assert.match(out.why, /доступ запрещён/, 'исходная причина потеряна');
});

test('число попыток и пауза названы числами', () => {
  // «Немного подождать» непроверяемо. Числа видно, и их можно обсуждать.
  assert.equal(RETRY.times, 6);
  assert.equal(RETRY.pauseMs, 1500);
});

// ── первая установка ─────────────────────────────────────────────────────────

test('до первой установки указателя нет, и это не ошибка', () => {
  const root = tempRoot();
  try {
    ensureLayout(root);

    assert.equal(current(root), null);
    assert.equal(previous(root), null);
  } finally { cleanup(root); }
});

test('первая установка переводит live и не создаёт live.prev', () => {
  // Откатываться некуда: прежнего релиза не было. Существование `live.prev`
  // означало бы «откат возможен», а это была бы неправда.
  const root = tempRoot();
  try {
    const p = setupReleases(root, [REL.first]);

    const out = swapTo(root, REL.first);

    assert.equal(out.ok, true, out.why ?? '');
    assert.equal(current(root), join(p.releases, REL.first));
    assert.equal(existsSync(p.prev), false, 'создан путь назад в никуда');
  } finally { cleanup(root); }
});

test('установка несуществующего релиза отказывает, не тронув указатель', () => {
  const root = tempRoot();
  try {
    setupReleases(root, [REL.first]);
    swapTo(root, REL.first);
    const before = current(root);

    const out = swapTo(root, 'нет-такого');

    assert.equal(out.ok, false);
    assert.match(out.why, /нет в releases/);
    assert.equal(current(root), before, 'указатель сдвинулся при отказе');
  } finally { cleanup(root); }
});

// ── путь назад появляется до риска ───────────────────────────────────────────

test('вторая установка сохраняет прежний релиз в live.prev', () => {
  const root = tempRoot();
  try {
    const p = setupReleases(root);
    swapTo(root, REL.first);

    const out = swapTo(root, REL.second);

    assert.equal(out.ok, true, out.why ?? '');
    assert.equal(current(root), join(p.releases, REL.second));
    assert.equal(previous(root), join(p.releases, REL.first), 'путь назад потерян');
  } finally { cleanup(root); }
});

test('повторная установка того же релиза сообщает об этом, а не молчит', () => {
  // Не ошибка и не работа. Молчаливое «сделано» скрыло бы, что ничего не менялось.
  const root = tempRoot();
  try {
    setupReleases(root, [REL.first]);
    swapTo(root, REL.first);

    const out = swapTo(root, REL.first);

    assert.equal(out.ok, true);
    assert.equal(out.same, true);
    assert.match(out.why, /уже ведёт на этот релиз/);
  } finally { cleanup(root); }
});

// ── откат ────────────────────────────────────────────────────────────────────

test('откат возвращает live на предыдущий релиз', () => {
  const root = tempRoot();
  try {
    const p = setupReleases(root);
    swapTo(root, REL.first);
    swapTo(root, REL.second);

    const out = rollback(root);

    assert.equal(out.ok, true, out.why ?? '');
    assert.equal(current(root), join(p.releases, REL.first));
  } finally { cleanup(root); }
});

test('два отката подряд не крутятся на месте', () => {
  // После отката `live.prev` указывает туда, откуда откатились. Иначе второй откат
  // вернул бы на тот же релиз, и человек решил бы, что откат не работает.
  const root = tempRoot();
  try {
    const p = setupReleases(root);
    swapTo(root, REL.first);
    swapTo(root, REL.second);

    rollback(root);
    assert.equal(current(root), join(p.releases, REL.first));

    rollback(root);
    assert.equal(current(root), join(p.releases, REL.second), 'второй откат не сработал');
  } finally { cleanup(root); }
});

test('откат без предыдущего релиза отказывает с объяснением', () => {
  const root = tempRoot();
  try {
    setupReleases(root, [REL.first]);
    swapTo(root, REL.first);

    const out = rollback(root);

    assert.equal(out.ok, false);
    assert.match(out.why, /откатываться некуда/);
  } finally { cleanup(root); }
});

// ── журнал установок ─────────────────────────────────────────────────────────

test('установка и откат пишутся в releases.log', () => {
  const root = tempRoot();
  try {
    setupReleases(root);
    swapTo(root, REL.first);
    swapTo(root, REL.second);
    rollback(root);

    const lines = readFileSync(join(root, NAMES.log), 'utf8').trim().split('\n').map(JSON.parse);
    const steps = lines.map((l) => l.step);

    assert.deepEqual(steps, ['swap', 'swap', 'rollback']);
    assert.equal(typeof lines[2].release.from, 'string', 'откат не записал, откуда ушли');
    assert.equal(typeof lines[2].release.to, 'string');
  } finally { cleanup(root); }
});

test('каждое событие журнала несёт время', () => {
  // Событие без времени бесполезно: вопрос «это до или после сбоя?» останется без
  // ответа, а ради ответа на него журнал и ведётся.
  const root = tempRoot();
  try {
    setupReleases(root, [REL.first]);
    swapTo(root, REL.first);

    const line = JSON.parse(readFileSync(join(root, NAMES.log), 'utf8').trim());
    assert.equal(Number.isFinite(Date.parse(line.ts)), true, `время не разобрано: ${line.ts}`);
  } finally { cleanup(root); }
});

// ── чистка ───────────────────────────────────────────────────────────────────

test('релизы перечисляются от старых к новым', () => {
  const root = tempRoot();
  try {
    setupReleases(root, [REL.third, REL.first, REL.second]);

    assert.deepEqual(listReleases(root), [REL.first, REL.second, REL.third]);
  } finally { cleanup(root); }
});

test('чистка удаляет лишние старые релизы', () => {
  const root = tempRoot();
  try {
    const { ids } = manyReleases(root, 5);
    swapTo(root, ids[4]);

    const out = prune(root, { keep: 2 });

    assert.equal(out.removed.length, 3);
    assert.deepEqual(out.removed, ids.slice(0, 3));
    assert.equal(listReleases(root).length, 2);
  } finally { cleanup(root); }
});

test('чистка никогда не удаляет цель live и live.prev', () => {
  // Даже если они старше порога: указатель важнее возраста. Удаление цели живого
  // указателя оставило бы работающий процесс без файлов.
  const root = tempRoot();
  try {
    const { ids } = manyReleases(root, 4);
    swapTo(root, ids[0]);
    swapTo(root, ids[1]);

    const out = prune(root, { keep: 1 });

    assert.equal(out.removed.includes(ids[0]), false, 'удалён live.prev');
    assert.equal(out.removed.includes(ids[1]), false, 'удалён live');
    assert.equal(existsSync(join(paths(root).releases, ids[1])), true);
  } finally { cleanup(root); }
});

test('чистка объясняет, почему релиз оставлен', () => {
  const root = tempRoot();
  try {
    setupReleases(root);
    swapTo(root, REL.second);

    const out = prune(root, { keep: 1 });
    const kept = out.kept.find((k) => k.name === REL.second);

    assert.match(kept.why, /указывает live/);
  } finally { cleanup(root); }
});

test('чистка на пустой раскладке ничего не делает и не падает', () => {
  const root = tempRoot();
  try {
    ensureLayout(root);
    const out = prune(root, { keep: 5 });

    assert.deepEqual(out.removed, []);
    assert.deepEqual(out.kept, []);
  } finally { cleanup(root); }
});
