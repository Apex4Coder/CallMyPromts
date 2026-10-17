// tests/unit/release-state.test.mjs — состояние переживает установку и откат.
//
// Требования: REQ-REL-SWAP, инвариант docs/SPEC.md §14.1 и INV-13 (gld/gold.md §3.3).
// Проверяемые файлы: release/swap.mjs, server/index.mjs (pinRoot).
// Переключение указателя и чистка — в tests/unit/release-swap.test.mjs.
//
// Здесь два свойства, и оба про потерю данных — самый дорогой класс дефекта в этом
// проекте:
//
//   1. СОСТОЯНИЕ НЕ ДВИЖЕТСЯ. Промпты, настройки и токен лежат в `shared/` и не
//      участвуют в установке. Проверяется по факту: файл кладётся до, ищется после.
//
//   2. INV-13 — ПИН КОРНЯ. Работающий процесс продолжает читать свой релиз, даже
//      если указатель уже переведён. Иначе он читал бы файлы из двух релизов
//      одновременно — дефект, который проявляется случайно и ловится месяцами.
//
// Оба проверены пробой на живой системе до написания тестов: junction работает без
// прав администратора, `realpath` разворачивает его один раз, снятие указателя не
// трогает цель.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { isJunction } from '../../release/index.mjs';
import { swapTo, rollback, prune } from '../../release/index.mjs';
import { pinRoot } from '../../server/index.mjs';
import { tempRoot, cleanup } from '../helpers/harness.mjs';
import { REL, setupReleases, markRelease } from '../helpers/releasefix.mjs';

// ── состояние не движется ────────────────────────────────────────────────────

/**
 * Инвариант docs/SPEC.md §14.1 в самой прямой форме.
 *
 * Промпт кладётся до установки и ищется после. Проверяется наличие ТЕКСТА на диске,
 * а не код возврата: отчёт об успехе от функции, которая переключала указатель, —
 * её собственное мнение о себе.
 */
test('промпты целы после установки нового релиза', () => {
  const root = tempRoot();
  try {
    const p = setupReleases(root);
    writeFileSync(join(p.shared, 'prompts', 'c-review.md'), 'текст промпта', 'utf8');
    swapTo(root, REL.first);

    swapTo(root, REL.second);

    assert.equal(readFileSync(join(p.shared, 'prompts', 'c-review.md'), 'utf8'), 'текст промпта');
    assert.equal(existsSync(join(p.live, 'prompts', 'c-review.md')), true, 'новый релиз не видит промпты');
  } finally { cleanup(root); }
});

test('промпты целы после отката', () => {
  const root = tempRoot();
  try {
    const p = setupReleases(root);
    swapTo(root, REL.first);
    swapTo(root, REL.second);
    // Промпт создан УЖЕ на новом релизе: откат не должен его потерять.
    writeFileSync(join(p.live, 'prompts', 'создан-после.md'), 'новый текст', 'utf8');

    rollback(root);

    assert.equal(readFileSync(join(p.shared, 'prompts', 'создан-после.md'), 'utf8'), 'новый текст');
    assert.equal(existsSync(join(p.live, 'prompts', 'создан-после.md')), true,
      'старый релиз не видит промпт, созданный на новом');
  } finally { cleanup(root); }
});

test('настройки и токен переживают установку', () => {
  const root = tempRoot();
  try {
    const p = setupReleases(root);
    writeFileSync(join(p.shared, 'state', 'token'), 'a'.repeat(32), 'utf8');
    writeFileSync(join(p.shared, 'state', 'settings.json'), '{"ui":{"theme":"dark"}}', 'utf8');
    swapTo(root, REL.first);

    swapTo(root, REL.second);

    assert.equal(readFileSync(join(p.live, 'state', 'token'), 'utf8'), 'a'.repeat(32), 'токен сменился');
    assert.match(readFileSync(join(p.live, 'state', 'settings.json'), 'utf8'), /dark/, 'настройки сброшены');
  } finally { cleanup(root); }
});

test('журнал буфера не копируется, а остаётся один', () => {
  // Копия базы означала бы, что записи, сделанные после установки, попали в один
  // файл, а читаются из другого. Журнал — лог, и он обязан быть единственным.
  const root = tempRoot();
  try {
    const p = setupReleases(root);
    writeFileSync(join(p.shared, 'state', 'clips.db'), 'подставная база', 'utf8');
    swapTo(root, REL.first);
    swapTo(root, REL.second);

    assert.equal(isJunction(join(p.live, 'state')), true, 'состояние скопировано внутрь релиза');
    assert.equal(readFileSync(join(p.live, 'state', 'clips.db'), 'utf8'), 'подставная база');
  } finally { cleanup(root); }
});

test('удаление старого релиза не трогает shared', () => {
  // Внутри релиза `state` и `prompts` — junction. Удаление каталога рекурсивно без
  // снятия указателей могло бы унести содержимое цели, то есть промпты.
  const root = tempRoot();
  try {
    const p = setupReleases(root);
    writeFileSync(join(p.shared, 'prompts', 'важный.md'), 'нельзя потерять', 'utf8');
    swapTo(root, REL.second);

    const out = prune(root, { keep: 1 });

    assert.equal(out.removed.includes(REL.first), true, 'старый релиз не удалён — проверка бессмысленна');
    assert.equal(readFileSync(join(p.shared, 'prompts', 'важный.md'), 'utf8'), 'нельзя потерять');
    assert.equal(isJunction(join(p.live, 'prompts')), true, 'живой релиз потерял связь с состоянием');
  } finally { cleanup(root); }
});

// ── INV-13: пин корня ────────────────────────────────────────────────────────

/**
 * INV-13 в самой прямой форме, какая возможна без второго процесса.
 *
 * Метка в файле отличает релизы: по ней видно, откуда фактически идёт чтение.
 * Сравнение путей этого не показывает — путь может выглядеть верно, а данные
 * приходить из другого места.
 */
test('INV-13 · переустановка указателя не меняет релиз работающего процесса', () => {
  const root = tempRoot();
  try {
    const p = setupReleases(root);
    markRelease(p, REL.first, 'СТАРЫЙ');
    markRelease(p, REL.second, 'НОВЫЙ');
    swapTo(root, REL.first);

    // Так делает start(): пин один раз, при старте, от пути live.
    const pinned = pinRoot(p.live);
    assert.equal(pinned.includes('releases'), true, 'пин не развернул указатель');

    swapTo(root, REL.second);

    assert.equal(readFileSync(join(pinned, 'метка.txt'), 'utf8'), 'СТАРЫЙ',
      'работающий процесс начал читать новый релиз — смешанное чтение');
  } finally { cleanup(root); }
});

test('INV-13 · процесс, запущенный после установки, видит новый релиз', () => {
  // Обратная сторона: пин не должен «залипать» так, чтобы обновление вообще не
  // вступало в силу. Новый процесс обязан прийти в новый релиз.
  const root = tempRoot();
  try {
    const p = setupReleases(root);
    markRelease(p, REL.first, 'СТАРЫЙ');
    markRelease(p, REL.second, 'НОВЫЙ');

    swapTo(root, REL.first);
    pinRoot(p.live);
    swapTo(root, REL.second);

    const fresh = pinRoot(p.live);
    assert.equal(readFileSync(join(fresh, 'метка.txt'), 'utf8'), 'НОВЫЙ', 'обновление не вступило в силу');
  } finally { cleanup(root); }
});

test('INV-13 · состояние общее для старого и нового релиза', () => {
  // Пока старый процесс доигрывает начатое, новый уже поднят. Оба обязаны видеть
  // одни промпты и один журнал, иначе запись одного пропадёт для другого.
  const root = tempRoot();
  try {
    const p = setupReleases(root);
    swapTo(root, REL.first);
    const old = pinRoot(p.live);
    swapTo(root, REL.second);
    const fresh = pinRoot(p.live);

    writeFileSync(join(old, 'prompts', 'от-старого.md'), 'текст', 'utf8');

    assert.equal(existsSync(join(fresh, 'prompts', 'от-старого.md')), true,
      'новый релиз не видит запись старого — состояние расщепилось');
  } finally { cleanup(root); }
});

test('INV-13 · откат тоже не сдвигает работающий процесс', () => {
  // Откат — такая же переустановка указателя. Процесс, поднятый на новом релизе,
  // обязан продолжать читать новый, пока его не остановят.
  const root = tempRoot();
  try {
    const p = setupReleases(root);
    markRelease(p, REL.first, 'СТАРЫЙ');
    markRelease(p, REL.second, 'НОВЫЙ');
    swapTo(root, REL.first);
    swapTo(root, REL.second);

    const pinned = pinRoot(p.live);
    rollback(root);

    assert.equal(readFileSync(join(pinned, 'метка.txt'), 'utf8'), 'НОВЫЙ',
      'откат переключил файлы под работающим процессом');
  } finally { cleanup(root); }
});

test('пин несуществующего пути не роняет запуск', () => {
  // Первый запуск в пустом каталоге: папки ещё нет, её создаст Deck. Исключение
  // здесь означало бы, что приложение не стартует на чистой машине.
  const root = tempRoot();
  try {
    const out = pinRoot(join(root, 'ещё-нет'));

    assert.equal(typeof out, 'string');
    assert.equal(out.includes('ещё-нет'), true);
  } finally { cleanup(root); }
});
