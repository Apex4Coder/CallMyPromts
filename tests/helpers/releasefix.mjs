// tests/helpers/releasefix.mjs — фикстура раскладки релизов.
//
// Требования: REQ-REL-LAYOUT, REQ-REL-SWAP (docs/SPEC.md §14).
// Используют: tests/unit/release-layout.test.mjs, release-swap.test.mjs,
// release-state.test.mjs.
//
// Три файла тестов собирают одну и ту же установку: два релиза, связанное состояние,
// файл версии в каждом. Копия в каждом означала бы три представления о раскладке,
// которые разойдутся при первой правке — та же болезнь, от которой лечится сам
// проект (три копии библиотеки промптов).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ensureLayout, linkShared } from '../../release/index.mjs';

/**
 * Имена релизов для тестов.
 *
 * Заданы явно, а не через `makeReleaseId()`: тест обязан быть повторяемым, а
 * случайный хвост в имени сделал бы сообщение о провале разным на каждом прогоне.
 * Порядок по возрастанию — как в настоящей раскладке.
 */
export const REL = {
  first: '20260907-000100-aaaaaa',
  second: '20260907-000200-bbbbbb',
  third: '20260907-000300-cccccc',
};

/**
 * Установка с релизами и связанным состоянием.
 *
 * @param {string} root корень установки
 * @param {string[]} ids какие релизы создать; по умолчанию два
 * @returns {object} пути раскладки
 */
export const setupReleases = (root, ids = [REL.first, REL.second]) => {
  const p = ensureLayout(root);

  ids.forEach((id, i) => {
    const dir = join(p.releases, id);
    mkdirSync(dir, { recursive: true });
    // Версия разная у каждого релиза: по ней видно, какой код фактически работает.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: `1.0.${i}` }), 'utf8');
    writeFileSync(join(dir, '.release-id'), id, 'utf8');
    linkShared(root, dir);
  });

  return p;
};

/**
 * Метка релиза — файл с узнаваемым текстом.
 *
 * По нему проверяется, ОТКУДА фактически идёт чтение. Сравнение путей этого не
 * показывает: путь может выглядеть верно, а данные приходить из другого места.
 */
export const markRelease = (paths, id, text) => {
  const file = join(paths.releases, id, 'метка.txt');
  writeFileSync(file, text, 'utf8');
  return file;
};

/** Много релизов одной строкой: для проверки чистки. */
export const manyReleases = (root, count) => {
  const ids = Array.from({ length: count }, (_, i) => `2026090${i + 1}-000100-aaaaa${i}`);
  return { paths: setupReleases(root, ids), ids };
};
