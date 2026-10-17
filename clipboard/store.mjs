// clipboard/store.mjs — журнал буфера обмена в SQLite.
//
// Требования: REQ-CLIP-LOG, REQ-CLIP-CAP, REQ-CLIP-DEDUP (docs/SPEC.md §4).
// Схема и правила V-C-1..V-C-8: docs/DATA-CONTRACTS.md §2.
//
// Используется встроенный node:sqlite (Node 22+): внешняя зависимость ради журнала
// на сто записей была бы лишним риском в проекте с нулём рантайм-зависимостей.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  detectKind,
  makePreview,
  countLines,
  clampLimit,
  validateClipInput,
  MAX_LEN,
} from '../contracts/index.mjs';

import { screen } from './privacy.mjs';

const SCHEMA_VERSION = '1';

const DDL = `
CREATE TABLE IF NOT EXISTS clips (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  hash        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  text        TEXT    NOT NULL,
  preview     TEXT    NOT NULL,
  bytes       INTEGER NOT NULL,
  lines       INTEGER NOT NULL,
  source_app  TEXT,
  created_at  TEXT    NOT NULL,
  promoted_to TEXT
);
CREATE INDEX IF NOT EXISTS idx_clips_created ON clips(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clips_hash    ON clips(hash);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
const nowIso = () => new Date().toISOString();

/**
 * Журнал буфера. Хранит только локально и никогда не синхронизируется:
 * в буфер попадают пароли и токены (docs/RULES.md §6).
 */
export class ClipStore {
  #db;

  #paused = false;

  constructor(file) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    this.#db = this.#open(file);
  }

  /**
   * Открытие файла и подготовка схемы.
   * При сбое дескриптор закрывается здесь же: SQLite сообщает «file is not a
   * database» не на открытии, а на первом обращении, и брошенный открытым
   * дескриптор не даёт переименовать файл на Windows. Из-за этого первая версия
   * восстановления не работала: renameSync падал молча, а следующая попытка
   * открыть тот же битый файл давала ту же ошибку уже наружу.
   */
  #prepare(file) {
    const db = new DatabaseSync(file);
    try {
      db.exec(DDL);
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
      return db;
    } catch (err) {
      try {
        db.close();
      } catch { /* уже закрыт самим драйвером */ }
      throw err;
    }
  }

  /**
   * Открытие базы с восстановлением после порчи: битый файл отводится в сторону,
   * создаётся новая база. Приложение, которое не стартует из-за повреждённого
   * журнала, хуже приложения с пустым журналом (сценарий S-04).
   *
   * Битый файл сохраняется рядом, а не удаляется: это данные пользователя, и
   * из них можно что-то извлечь вручную.
   */
  #open(file) {
    try {
      return this.#prepare(file);
    } catch (err) {
      const aside = `${file}.broken-${Date.now()}`;
      try {
        renameSync(file, aside);
      } catch (moveErr) {
        // Отвести не удалось — повторная попытка дала бы ту же ошибку без
        // объяснения, поэтому причина называется сразу и целиком.
        throw new Error(`журнал буфера повреждён (${err.message}), `
          + `и файл не удалось отвести в сторону: ${file} — ${moveErr.code ?? moveErr.message}`);
      }
      this.recovered = { from: file, movedTo: aside, reason: err.message };
      return this.#prepare(file);
    }
  }

  close() {
    this.#db.close();
  }

  get paused() {
    return this.#paused;
  }

  /** Пауза слежки. Пока на паузе, add() не создаёт записей (REQ-CLIP-PAUSE). */
  pause() {
    this.#paused = true;
    return this.#paused;
  }

  resume() {
    this.#paused = false;
    return this.#paused;
  }

  #top() {
    return this.#db.prepare('SELECT id, hash FROM clips ORDER BY id DESC LIMIT 1').get();
  }

  /**
   * Добавление записи.
   * @returns {{ ok: boolean, id?: number, skipped?: string, issues: object[] }}
   */
  add(text, {
    sourceApp = null, isImage = false, blacklist = undefined, limit = 100, watchSecrets = 'mark',
  } = {}) {
    if (this.#paused) return { ok: false, skipped: 'paused', issues: [] };

    // Приватность решается до любой записи: содержимое отклонённой записи
    // не попадает ни в базу, ни в журнал событий (docs/RULES.md §6).
    const guard = screen(text, { sourceApp, blacklist, watchSecrets });
    if (guard.skip) return { ok: false, skipped: guard.reason, why: guard.why, issues: [] };

    const issues = validateClipInput(text, { isImage });
    if (issues.some((i) => i.level === 'bad')) return { ok: false, skipped: 'too_short', issues };

    let body = String(text ?? '');
    let truncated = false;
    if (Buffer.byteLength(body, 'utf8') > MAX_LEN) {
      body = Buffer.from(body, 'utf8').subarray(0, MAX_LEN).toString('utf8');
      truncated = true;
    }

    const hash = sha256(body);
    const top = this.#top();
    if (top && top.hash === hash) return { ok: false, skipped: 'duplicate', id: top.id, issues };

    const info = this.#db.prepare(`
      INSERT INTO clips (hash, kind, text, preview, bytes, lines, source_app, created_at, promoted_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      hash,
      detectKind(body, { isImage }),
      body,
      makePreview(body),
      Buffer.byteLength(body, 'utf8'),
      countLines(body),
      sourceApp,
      nowIso(),
    );

    const evicted = this.trim(limit);
    return {
      ok: true,
      id: Number(info.lastInsertRowid),
      truncated,
      evicted,
      sensitive: guard.sensitive,
      marks: guard.marks,
      issues,
    };
  }

  /**
   * Вытеснение старых записей. Сохранённые как промпт не вытесняются (V-C-3):
   * то, что уже стало частью библиотеки, не должно исчезать молча.
   *
   * Правило выражено через окно, а не через количество к удалению: последние
   * `max` записей неприкосновенны, а из более старых удаляются незащищённые.
   *
   * Прежняя версия считала «сколько лишних» и удаляла столько же самых старых
   * незащищённых. На журнале, заполненном защищёнными записями, единственной
   * незащищённой оказывалась та, которую только что вставили, — и она удалялась
   * прямо в add(), до того как вызывающий успевал её отметить. Со стороны это
   * выглядело как «скопировал, а запись не появилась».
   *
   * Следствие правила: журнал из одних защищённых записей превышает `max`.
   * Это верно — число записей настройка, содержимое пользователя нет.
   */
  trim(limit) {
    const max = clampLimit(limit);
    if (this.count() <= max) return 0;

    const info = this.#db.prepare(`
      DELETE FROM clips
      WHERE promoted_to IS NULL
        AND id NOT IN (SELECT id FROM clips ORDER BY id DESC LIMIT ?)
    `).run(max);

    return Number(info.changes ?? 0);
  }

  count() {
    return Number(this.#db.prepare('SELECT COUNT(*) AS n FROM clips').get().n);
  }

  /** Список без полного текста: в списке нужен preview, а не мегабайты. */
  list({ limit = 100, offset = 0, kind = null, query = null } = {}) {
    const where = [];
    const args = [];
    if (kind) {
      where.push('kind = ?');
      args.push(kind);
    }
    if (query) {
      where.push('text LIKE ?');
      args.push(`%${String(query)}%`);
    }
    const sql = `
      SELECT id, kind, preview, bytes, lines, source_app, created_at, promoted_to
      FROM clips
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC LIMIT ? OFFSET ?
    `;
    return this.#db.prepare(sql).all(...args, limit, offset);
  }

  get(id) {
    return this.#db.prepare('SELECT * FROM clips WHERE id = ?').get(Number(id)) ?? null;
  }

  remove(id) {
    const info = this.#db.prepare('DELETE FROM clips WHERE id = ?').run(Number(id));
    return Number(info.changes ?? 0) > 0;
  }

  /** Отметка «сохранено как промпт». Защищает запись от вытеснения. */
  markPromoted(id, promptId) {
    const info = this.#db.prepare('UPDATE clips SET promoted_to = ? WHERE id = ?').run(String(promptId), Number(id));
    return Number(info.changes ?? 0) > 0;
  }

  clear({ keepPromoted = true } = {}) {
    const sql = keepPromoted ? 'DELETE FROM clips WHERE promoted_to IS NULL' : 'DELETE FROM clips';
    return Number(this.#db.prepare(sql).run().changes ?? 0);
  }

  stats(limit = 100) {
    const rows = this.#db.prepare('SELECT kind, COUNT(*) AS n FROM clips GROUP BY kind').all();
    return {
      total: this.count(),
      limit: clampLimit(limit),
      promoted: Number(this.#db.prepare('SELECT COUNT(*) AS n FROM clips WHERE promoted_to IS NOT NULL').get().n),
      byKind: Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)])),
      paused: this.#paused,
      recovered: this.recovered ?? null,
    };
  }
}
