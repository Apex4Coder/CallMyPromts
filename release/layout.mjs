// release/layout.mjs — раскладка релизов: неизменяемый код, состояние снаружи.
//
// Требование: REQ-REL-LAYOUT (docs/SPEC.md §14). Концепция: gld/gold.md §3.
// Тест: tests/unit/release-layout.test.mjs.
//
// Раскладка:
//
//   releases/<id>/     неизменяемый снимок кода
//   shared/            состояние: state/, prompts/. Живёт вечно
//   live       ->      junction на releases/<current>
//   live.prev  ->      junction на releases/<previous>
//   releases.log       NDJSON: кто, когда, откуда, куда, итог
//
// Главная мысль, ради которой это делается: **состояние не движется, движется
// указатель**. Прежняя схема обновления переносила `state/` и `prompts/` при каждой
// установке, и каждый перенос — шанс потерять то, что человек писал руками. Здесь
// состояние физически не участвует в обновлении: оно лежит в `shared/`, а релиз
// видит его через junction.
//
// Следствие для откката: он становится переустановкой указателя. Ничего не
// копируется обратно, вопрос «а где мои промпты?» не может возникнуть.
//
// Почему junction, а не symlink: junction не требует прав администратора и
// Developer Mode, работает на всех поддерживаемых версиях Windows и понимается
// всеми API как обычный каталог. Symlink на каталог без прав не создать.

import {
  mkdirSync, existsSync, lstatSync, realpathSync, rmSync, rmdirSync, readdirSync, appendFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Имена, которые раскладка обещает. Одно место на весь проект. */
export const NAMES = {
  releases: 'releases',
  shared: 'shared',
  live: 'live',
  prev: 'live.prev',
  log: 'releases.log',
  releaseId: '.release-id',
};

/**
 * Что переезжает в `shared/` и связывается junction внутрь релиза.
 *
 * Список получен обходом кода, а не догадкой: см. docs/BLAST.md §1. Оба каталога
 * содержат данные, которые человек не восстановит — настройки, токен, журнал
 * буфера с паролями и, главное, сами промпты.
 *
 * `node_modules` в списке нет сознательно: в рантайме проекта ноль внешних
 * зависимостей, и связывать нечего. Обычно это самая тяжёлая часть установки —
 * здесь её просто не существует.
 */
export const LINKED_DIRS = ['state', 'prompts'];

/** Сколько релизов держать. Старые нужны для откката, но не бесконечно. */
export const KEEP_RELEASES = 5;

/**
 * Идентификатор релиза: время плюс короткий случайный хвост.
 *
 * Время впереди, чтобы каталоги сортировались по порядку установки как текст.
 * Хвост — потому что две установки в одну секунду возможны, и совпадение имён
 * означало бы запись в уже существующий релиз, объявленный неизменяемым.
 */
export const makeReleaseId = (now = new Date(), tail = null) => {
  // Срез ровно 14 знаков — дата и время без миллисекунд.
  //
  // Первая версия брала 15 и прихватывала точку из «...000Z»: получалось
  // «20260907-001000.-aaaaaa». Тест на форму имени поймал это сразу; без него
  // точка в имени каталога дожила бы до первой установки.
  const digits = now.toISOString().replace(/[^\d]/g, '').slice(0, 14);
  const stamp = `${digits.slice(0, 8)}-${digits.slice(8, 14)}`;
  const rnd = tail ?? Math.random().toString(16).slice(2, 8).padStart(6, '0');
  return `${stamp}-${rnd}`;
};

/** Пути раскладки от корня установки. */
export const paths = (root) => ({
  root: resolve(root),
  releases: join(root, NAMES.releases),
  shared: join(root, NAMES.shared),
  live: join(root, NAMES.live),
  prev: join(root, NAMES.prev),
  log: join(root, NAMES.log),
});

/** Создание каталогов раскладки. Идемпотентно: повторный вызов ничего не портит. */
export const ensureLayout = (root) => {
  const p = paths(root);
  mkdirSync(p.releases, { recursive: true });
  for (const dir of LINKED_DIRS) mkdirSync(join(p.shared, dir), { recursive: true });
  return p;
};

/** Junction ли это. Отличается от каталога полем `isSymbolicLink` у lstat. */
export const isJunction = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Куда указывает junction. `null`, если это не указатель.
 *
 * `realpath`, а не `readlink`: junction на Windows хранит путь в формате
 * `\??\C:\...`, и `readlink` отдаёт его как есть — сравнивать такое с обычным путём
 * нельзя, а `realpath` разворачивает в нормальный вид.
 */
export const linkTarget = (path) => {
  if (!isJunction(path)) return null;
  try {
    return realpathSync(path);
  } catch {
    // Указатель есть, цели нет: релиз удалён руками. Это факт, а не сбой.
    return null;
  }
};

/**
 * Создание junction через `mklink /J`.
 *
 * Через `cmd`, потому что в Node нет API для junction: `symlinkSync` с типом
 * `'junction'` существует, но на некоторых конфигурациях требует прав, а `mklink /J`
 * работает всегда. Проверено тем же способом, что и остальное — прогоном.
 *
 * @returns {{ok: boolean, why: string|null}}
 */
export const makeJunction = (link, target) => {
  if (!existsSync(target)) {
    return { ok: false, why: `цель не существует: ${target}` };
  }

  // Существующий указатель убирается, а не перезаписывается: `mklink` на
  // существующем пути отказывается работать, и молчаливое «уже есть» скрыло бы
  // указатель на прежний релиз.
  if (existsSync(link) || isJunction(link)) {
    const gone = removeJunction(link);
    if (!gone.ok) return gone;
  }

  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe', windowsHide: true });
    return { ok: true, why: null };
  } catch (err) {
    const text = String(err.stderr ?? err.stdout ?? err.message).trim();
    return { ok: false, why: `mklink не сработал: ${text || err.message}` };
  }
};

/**
 * Удаление junction БЕЗ удаления цели.
 *
 * Самое опасное место файла. `rmSync(recursive)` на junction в старых версиях Node
 * удалял содержимое цели — то есть снёс бы `shared/prompts`. Поэтому `recursive`
 * здесь запрещён: junction удаляется как ссылка, одним вызовом.
 */
export const removeJunction = (link) => {
  try {
    if (isJunction(link)) {
      rmSync(link, { recursive: false, force: true });
      return { ok: true, why: null };
    }
    if (existsSync(link)) {
      return { ok: false, why: `${link} — не junction, а настоящий каталог; удалять его отказываюсь` };
    }
    return { ok: true, why: null };
  } catch (err) {
    return { ok: false, why: `не удалось убрать указатель: ${err.message}` };
  }
};

/**
 * Связывание состояния внутрь релиза.
 *
 * Внутри каталога релиза появляются `state` и `prompts` как junction на `shared/`.
 * Код продолжает работать с относительными путями и ничего не знает про раскладку —
 * это и есть смысл: слой L1 не знает про слои выше (gld/gold.md §2).
 */
export const linkShared = (root, releaseDir) => {
  const p = paths(root);
  const out = [];

  for (const dir of LINKED_DIRS) {
    const target = join(p.shared, dir);
    mkdirSync(target, { recursive: true });

    const link = join(releaseDir, dir);
    // Каталог, принесённый сборкой, мешает связыванию. Удаляется только ПУСТОЙ:
    // непустой означает, что в поставку попало состояние, и это отдельная ошибка,
    // о которой надо сказать, а не молча затереть.
    //
    // Пустота проверяется чтением, а не попыткой удалить. Первая версия полагалась
    // на исключение от `rmSync(recursive: false)` — но он отказывается удалять
    // любой каталог, и пустой тоже, поэтому связывание падало там, где сборка
    // просто создала пустую папку. `recursive: true` тут запрещён навсегда: на
    // junction он однажды удалит содержимое цели, то есть промпты.
    if (existsSync(link) && !isJunction(link)) {
      const inside = readdirSync(link);
      if (inside.length > 0) {
        out.push({
          dir,
          ok: false,
          why: `в поставке есть непустой ${dir}/ — состояние не должно лежать внутри релиза`,
        });
        continue;
      }
      try {
        rmdirSync(link);
      } catch (err) {
        out.push({ dir, ok: false, why: `не удалось убрать пустой ${dir}/: ${err.message}` });
        continue;
      }
    }

    const made = makeJunction(link, target);
    out.push({ dir, ok: made.ok, why: made.why, link, target });
  }

  return { ok: out.every((x) => x.ok), links: out };
};

/** Запись в журнал установок. NDJSON: одна строка — одно событие. */
export const logRelease = (root, event) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  appendFileSync(paths(root).log, `${line}\n`, 'utf8');
  return line;
};
