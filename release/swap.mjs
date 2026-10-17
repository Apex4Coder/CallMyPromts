// release/swap.mjs — переключение указателя live и откат в один шаг.
//
// Требование: REQ-REL-SWAP (docs/SPEC.md §14). Концепция: gld/gold.md §3.2, §3.4.
// Тест: tests/unit/release-swap.test.mjs.
//
// Здесь живёт единственная необратимая операция всего слоя релизов: перевод `live`
// с одного каталога на другой. Всё остальное — копирование, связывание, проба —
// делается при живом работающем приложении и отменяется удалением нового каталога.
//
// Три правила, каждое оплачено чужой отладкой (см. разведку в gld/gold.md §1):
//
// 1. ПОВТОРЫ ОБЯЗАТЕЛЬНЫ. Антивирус и индексатор держат файлы открытыми доли
//    секунды, и переименование падает с `EPERM`/`EBUSY` на ровном месте. Один
//    отказ — не отказ; отказ шести попыток подряд — отказ.
//
// 2. ПРЕДЫДУЩИЙ УКАЗАТЕЛЬ СОХРАНЯЕТСЯ. `live.prev` заводится до переключения, а не
//    после: если процесс умрёт между двумя операциями, откат обязан остаться
//    возможным. Обратный порядок оставил бы систему без пути назад.
//
// 3. ОТКАТ — ТА ЖЕ ОПЕРАЦИЯ. Он не «особый режим», а переключение указателя в
//    другую сторону. Отдельный код отката однажды разойдётся с кодом установки, и
//    расхождение обнаружится в худший момент — когда откат понадобился.

import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  NAMES, paths, isJunction, linkTarget, makeJunction, removeJunction, logRelease, KEEP_RELEASES,
} from './layout.mjs';

/** Сколько раз и с какой паузой повторять файловую операцию. */
export const RETRY = { times: 6, pauseMs: 1500 };

/** Пауза без промисов: переключение указателя обязано быть синхронным. */
const waitSync = (ms) => {
  const until = Date.now() + ms;
  // Активное ожидание оправдано ровно здесь: это единственный участок, где нельзя
  // отдать управление, иначе между проверкой и действием влезет чужая операция.
  while (Date.now() < until) { /* ждём */ }
};

/**
 * Повтор операции с паузами.
 *
 * @param {() => {ok: boolean, why: string|null}} fn
 * @returns {{ok: boolean, why: string|null, tries: number}}
 */
export const withRetry = (fn, { times = RETRY.times, pauseMs = RETRY.pauseMs } = {}) => {
  let last = null;

  for (let i = 1; i <= times; i += 1) {
    last = fn();
    if (last.ok) return { ...last, tries: i };
    if (i < times) waitSync(pauseMs);
  }

  return {
    ok: false,
    why: `${times} попыток подряд: ${last?.why ?? 'причина не сообщена'}`,
    tries: times,
  };
};

/** Куда сейчас указывает live. `null` — указателя нет, установок ещё не было. */
export const current = (root) => linkTarget(paths(root).live);

/** Куда указывает live.prev. `null` — откатываться некуда. */
export const previous = (root) => linkTarget(paths(root).prev);

/** Список релизов, новые в конце: имена сортируются как текст по построению. */
export const listReleases = (root) => {
  const dir = paths(root).releases;
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
};

/**
 * Переключение указателя на релиз.
 *
 * Порядок операций:
 *   1. запомнить, куда указывает `live` сейчас;
 *   2. перевести `live.prev` на прежнюю цель — путь назад появляется ДО риска;
 *   3. перевести `live` на новый релиз.
 *
 * Шаг 2 раньше шага 3 не ради красоты: если процесс умрёт между ними, откат
 * останется возможным. При обратном порядке система осталась бы с новым указателем
 * и без пути назад.
 */
export const swapTo = (root, releaseId) => {
  const p = paths(root);
  const target = join(p.releases, releaseId);

  if (!existsSync(target)) {
    return { ok: false, why: `релиза «${releaseId}» нет в ${NAMES.releases}/`, from: null, to: null };
  }

  const was = current(root);
  if (was === target) {
    // Не ошибка и не работа: указатель уже там. Повторная установка того же релиза
    // осмысленна (например, после ручной правки), но сообщить об этом надо.
    return { ok: true, why: 'указатель уже ведёт на этот релиз', from: was, to: target, same: true };
  }

  if (was !== null) {
    const kept = withRetry(() => makeJunction(p.prev, was));
    if (!kept.ok) {
      return { ok: false, why: `не удалось сохранить путь назад: ${kept.why}`, from: was, to: null };
    }
  }

  const moved = withRetry(() => makeJunction(p.live, target));
  if (!moved.ok) {
    return { ok: false, why: `не удалось перевести указатель: ${moved.why}`, from: was, to: null };
  }

  logRelease(root, {
    step: 'swap',
    outcome: 'ok',
    release: { from: was, to: target, id: releaseId },
    tries: moved.tries,
  });

  return { ok: true, why: null, from: was, to: target, tries: moved.tries, same: false };
};

/**
 * Откат: `live` возвращается туда, куда указывает `live.prev`.
 *
 * Та же `makeJunction`, что при установке, — отдельного кода отката нет сознательно.
 * Он бы разошёлся с кодом установки, и расхождение обнаружилось бы в момент, когда
 * откат понадобился, то есть в самый неудачный.
 */
export const rollback = (root) => {
  const p = paths(root);
  const back = previous(root);

  if (back === null) {
    return { ok: false, why: 'откатываться некуда: предыдущего релиза нет', from: null, to: null };
  }

  const was = current(root);
  const moved = withRetry(() => makeJunction(p.live, back));
  if (!moved.ok) {
    return { ok: false, why: `откат не удался: ${moved.why}`, from: was, to: null };
  }

  // `live.prev` после отката указывает на тот релиз, откуда откатились: следующий
  // откат вернёт обратно. Иначе два отката подряд крутились бы на одном месте.
  if (was !== null) withRetry(() => makeJunction(p.prev, was));

  logRelease(root, {
    step: 'rollback',
    outcome: 'ok',
    release: { from: was, to: back },
    tries: moved.tries,
  });

  return { ok: true, why: null, from: was, to: back, tries: moved.tries };
};

/**
 * Удаление старых релизов.
 *
 * Никогда не трогает то, на что указывают `live` и `live.prev`, даже если они старше
 * порога: указатель важнее возраста. Удаление цели живого указателя оставило бы
 * работающий процесс без файлов — а на Windows открытые дескрипторы ещё и не дадут
 * этого сделать, то есть операция провалится посередине.
 */
export const prune = (root, { keep = KEEP_RELEASES } = {}) => {
  const p = paths(root);
  const all = listReleases(root);
  const safe = new Set([current(root), previous(root)].filter(Boolean));

  const removed = [];
  const kept = [];

  // Обход от старых к новым: удаляются первые, пока их больше порога.
  for (const name of all) {
    const dir = join(p.releases, name);
    const isSafe = safe.has(dir);
    const excess = all.length - removed.length > keep;

    if (isSafe || !excess) {
      kept.push({ name, why: isSafe ? 'на него указывает live или live.prev' : 'в пределах порога' });
      continue;
    }

    try {
      // `recursive: true` здесь допустим и безопасен: внутри релиза `state` и
      // `prompts` — junction, а их снятие данных не трогает (проверено пробой и
      // тестом «снятие указателя НЕ удаляет данные цели»). Но снимаются они
      // ЯВНО и до удаления: полагаться на поведение rmSync с junction нельзя.
      for (const link of ['state', 'prompts']) {
        if (isJunction(join(dir, link))) removeJunction(join(dir, link));
      }
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      kept.push({ name, why: `не удалось удалить: ${err.message}` });
    }
  }

  if (removed.length > 0) {
    logRelease(root, { step: 'prune', outcome: 'ok', removed, keep });
  }

  return { removed, kept };
};
