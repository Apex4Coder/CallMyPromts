// tests/helpers/ahk.mjs — чтение скрипта AutoHotkey как текста для проверок.
//
// Требование: REQ-KEY-PASTE (docs/SPEC.md §8).
// Используют: tests/unit/bridge-paste.test.mjs, tests/unit/bridge-post.test.mjs.
//
// Скрипт AHK нельзя выполнить из Node: он живёт в процессе AutoHotkey и работает с
// настоящими окнами Windows. Поэтому его решения проверяются по тексту. Такая
// проверка честна только если читает текст правильно, а первая версия читала
// неправильно дважды:
//
//   1. `SCRIPT.indexOf('Post(')` находил ВЫЗОВ, а не определение: первое вхождение
//      `Post(` — это строка `Post("/api/hotkeys", body)` внутри Report(). Дальше
//      искалась ближайшая `{`, и в проверку уходило тело СЛЕДУЮЩЕЙ функции файла.
//      Пять проверок судили чужой код.
//   2. Запрет `OnClipboardChange` срабатывал на комментарии, который объясняет,
//      почему эта подписка не используется.
//
// Отсюда два правила этого файла: определение ищется от начала строки, а
// комментарии и содержимое строковых литералов в структурных проверках не
// участвуют.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export const readScript = (root = process.cwd(), name = 'deck.ahk') => {
  const text = readFileSync(join(root, 'bridge', name), 'utf8');
  return name === 'deck.ahk' ? text + '\n' + readFileSync(join(root, 'bridge', 'window.ahk'), 'utf8') : text;
};


/**
 * Маска исходника: комментарии и содержимое строк заменены пробелами.
 *
 * Длина сохраняется, поэтому позиции в маске совпадают с позициями в исходнике —
 * и по маске можно считать фигурные скобки. Без маски строка
 * `return '{"combo":"","state":"good"}'` открывала бы блок, и границы функции
 * определялись бы неверно.
 *
 * Блочные комментарии `/* ... *\/` обязательны наравне со строчными: решения в
 * этом скрипте объясняются именно блоками перед функциями, и запрет вида «слова
 * OnClipboardChange в коде быть не должно» падал бы на комментарии, который этот
 * запрет обосновывает.
 *
 * Границы применимости названы прямо: обратная кавычка AHK как экран внутри
 * строки здесь не разбирается. В bridge/deck.ahk такого нет, а появление поймает
 * проверка «тело не закрыто».
 */
export const maskAhk = (src) => {
  const out = src.split('');
  let quote = null;
  let line = false;
  let block = false;

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];

    if (block) {
      out[i] = c === '\n' ? c : ' ';
      if (c === '/' && src[i - 1] === '*') block = false;
      continue;
    }
    if (line) {
      if (c === '\n') line = false;
      else out[i] = ' ';
      continue;
    }
    if (quote) {
      if (c === '\n') quote = null;
      else out[i] = ' ';
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      block = true;
      out[i] = ' ';
      continue;
    }
    if (c === ';') {
      line = true;
      out[i] = ' ';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out[i] = ' ';
    }
  }
  return out.join('');
};

/**
 * Тело функции по имени.
 *
 * Определение ищется от начала строки: в этом скрипте все функции объявлены в
 * первой колонке, а любой вызов записан с отступом внутри другого тела. Это и
 * отличает определение от вызова без разбора языка.
 *
 * @returns {{text: string, code: string}} text — как в файле, code — по маске.
 *   Утверждения «должно быть» смотрят в text, «не должно быть» — в code, иначе
 *   собственный комментарий функции может как подтвердить, так и опровергнуть.
 */
export const ahkFn = (src, name) => {
  const masked = maskAhk(src);
  const def = new RegExp(`^${name}\\([^)]*\\)\\s*\\{`, 'm').exec(masked);
  if (!def) throw new Error(`определение ${name}() не найдено в скрипте`);

  const open = masked.indexOf('{', def.index);
  let depth = 0;

  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') depth -= 1;
    if (depth === 0) return { text: src.slice(open, i + 1), code: masked.slice(open, i + 1) };
  }
  throw new Error(`тело ${name}() не закрыто`);
};

/** Позиция подстроки в теле функции: порядок строк тоже бывает решением. */
export const orderIn = (body, first, second) => {
  const a = body.indexOf(first);
  const b = body.indexOf(second);
  return { a, b, ordered: a !== -1 && b !== -1 && a < b };
};
