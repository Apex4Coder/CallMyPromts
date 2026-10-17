// server/state.mjs — состояние приложения: настройки, библиотека, журнал, счётчик.
//
// Требования: REQ-API-SETTINGS, REQ-SVC-GUARD (docs/SPEC.md §6, §8).
// Файлы состояния: docs/DATA-CONTRACTS.md §3, §4, §5.
//
// Один объект `Deck` держит всё, что нужно обработчикам запросов, и он один
// решает, когда перечитывать библиотеку с диска. Иначе каждый обработчик читал бы
// папку сам, и на каждое нажатие клавиши в поиске уходило бы 26 обращений к диску.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { mergeSettings, DEFAULTS } from '../contracts/index.mjs';
import { readLibrary, listGroups, groupLabel } from '../library/index.mjs';
import { ClipStore } from '../clipboard/index.mjs';
import { UsageTracker, order, search } from '../rank/index.mjs';

import { PasteQueue } from './paste.mjs';

/** Сколько библиотека считается свежей без повторного чтения диска, мс. */
export const CACHE_MS = 1500;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

export class Deck {
  #library = null;

  #libraryAt = 0;

  // Версия кэша защищает от гонки: старое асинхронное чтение, начатое до
  // invalidate(), не имеет права вернуть удалённые файлы обратно в кэш.
  #libraryGeneration = 0;

  constructor(root) {
    this.root = resolve(root);
    this.stateDir = join(this.root, 'state');
    this.settingsFile = join(this.stateDir, 'settings.json');
    this.runtimeFile = join(this.stateDir, 'runtime.json');
    this.tokenFile = join(this.stateDir, 'token');

    mkdirSync(this.stateDir, { recursive: true });

    this.settingsIssues = [];
    this.settings = this.loadSettings();
    this.libraryRoot = resolve(this.root, this.settings.library.path);

    this.clips = new ClipStore(join(this.stateDir, 'clips.db'));
    this.usage = new UsageTracker(this.libraryRoot);
    // Очередь вставки живёт в состоянии, потому что заявку кладёт один запрос,
    // а забирает другой: между ними нужна общая память процесса.
    this.paste = new PasteQueue();
    this.startedAt = new Date().toISOString();
  }

  /**
   * Чтение настроек. Битый файл не мешает старту: он отводится в сторону и
   * применяются значения по умолчанию (V-S-4). Причина сохраняется в issues,
   * чтобы интерфейс объяснил, почему настройки сбросились.
   */
  loadSettings() {
    if (!existsSync(this.settingsFile)) {
      this.settingsIssues = [];
      return structuredClone(DEFAULTS);
    }
    try {
      const { settings, issues } = mergeSettings(readJson(this.settingsFile));
      this.settingsIssues = issues;
      return settings;
    } catch (err) {
      const broken = join(this.stateDir, 'settings.broken.json');
      try {
        renameSync(this.settingsFile, broken);
      } catch { /* уже переименован или занят */ }
      this.settingsIssues = [{
        level: 'warn',
        code: 'V-S-4',
        message: `настройки не читались (${err.message}) — применены значения по умолчанию`,
        file: 'state/settings.json',
      }];
      return structuredClone(DEFAULTS);
    }
  }

  /**
   * Запись настроек. Возвращает issues валидации, ничего не выбрасывает.
   *
   * Основа слияния — ДЕЙСТВУЮЩИЕ настройки, а не умолчания: запрос из панели
   * присылает только изменённый раздел, и слияние с умолчаниями обнуляло бы всё
   * остальное. Смена темы стирала настроенные горячие клавиши.
   */
  saveSettings(raw) {
    const { settings, issues } = mergeSettings(raw, { base: this.settings });
    if (issues.some((i) => i.level === 'bad')) return { ok: false, issues, settings: this.settings };

    const file = `${this.settingsFile}.${process.pid}.tmp`;
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(file, this.settingsFile);
    this.settings = settings;
    this.settingsIssues = issues;

    const nextRoot = resolve(this.root, settings.library.path);
    if (nextRoot !== this.libraryRoot) {
      this.libraryRoot = nextRoot;
      this.usage = new UsageTracker(nextRoot);
      this.invalidate();
    }
    return { ok: true, issues, settings };
  }

  invalidate() {
    this.#libraryGeneration += 1;
    this.#library = null;
    this.#libraryAt = 0;
  }

  /** Библиотека с коротким кэшем. `force` нужен после записи файла. */
  async library({ force = false } = {}) {
    const fresh = Date.now() - this.#libraryAt < CACHE_MS;
    if (this.#library && fresh && !force) return this.#library;

    const generation = this.#libraryGeneration;
    const lib = await readLibrary(this.libraryRoot);
    const names = await listGroups(this.libraryRoot);
    const counts = new Map(lib.groups.map((g) => [g.name, g.count]));
    const loaded = {
      ...lib,
      groups: names.map((name) => ({
        id: name,
        label: groupLabel(name),
        count: counts.get(name) ?? 0,
      })),
    };

    // reset()/seed() могут изменить каталог, пока readLibrary() ждёт диск.
    // Такой снимок допустим для уже начатого запроса, но не для новых запросов.
    if (generation === this.#libraryGeneration) {
      this.#library = loaded;
      this.#libraryAt = Date.now();
    }
    return loaded;
  }

  /** Список для окна выбора: поиск, затем порядок. Порядок задан настройками. */
  async view({ query = '', group = null } = {}) {
    const lib = await this.library();
    let items = lib.items;
    if (group) items = items.filter((i) => i.group === group);

    const found = search(items, query);
    const ordered = query.trim() === ''
      ? order(found, { mode: this.settings.order.mode })
      : found.map((i, idx) => ({ ...i, _pos: idx + 1, _pin: i.pin ?? null }));

    return { items: ordered, groups: lib.groups, stats: lib.stats };
  }

  /** Запись runtime.json: по нему определяется «уже запущен» и светофор в трее. */
  writeRuntime({ port, hotkeys = {} }) {
    const data = {
      pid: process.pid,
      port,
      started_at: this.startedAt,
      library_path: this.libraryRoot,
      hotkeys,
    };
    writeFileSync(this.runtimeFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return data;
  }

  readRuntime() {
    try {
      return readJson(this.runtimeFile);
    } catch {
      return null;
    }
  }

  clearRuntime() {
    try {
      renameSync(this.runtimeFile, `${this.runtimeFile}.stopped`);
    } catch { /* файла нет — сервис и так остановлен */ }
  }

  close() {
    this.closeCloud?.();
    try {
      if (this.settings.clipboard.clear_on_exit) this.clips.clear({ keepPromoted: true });
    } catch { /* журнал уже закрыт */ }
    this.clips.close();
    // Незакрытое обещание вставки удержало бы процесс: сервер не завершился бы
    // по Ctrl+C, а тест повис бы на закрытии.
    this.paste.close();
    this.clearRuntime();
  }
}

/**
 * Проверка «уже запущен» (REQ-SVC-GUARD).
 * Живость процесса проверяется сигналом 0: файл может остаться после падения,
 * и тогда запуск блокировать нельзя.
 */
export const runningInstance = (deck) => {
  const rt = deck.readRuntime();
  if (!rt?.pid) return null;
  try {
    process.kill(rt.pid, 0);
    return rt;
  } catch {
    return null;
  }
};
