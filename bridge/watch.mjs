// bridge/watch.mjs — слежка за буфером обмена со стороны Node.
//
// Требование: REQ-KEY-WATCH (docs/SPEC.md §8). Сценарий S-04.
// Тест: tests/unit/bridge-watch.test.mjs.
//
// Основную слежку ведёт AHK (bridge/deck.ahk): он видит и активное окно, и
// смену буфера без задержек. Этот файл — запасной путь для случая, когда AHK нет:
// опрос буфера через PowerShell.
//
// Честно о цене: запуск PowerShell стоит ~200 мс, поэтому интервал здесь 1500 мс,
// а не 700 как у AHK. Быстрые последовательные копирования этот путь пропустит.
// Об этом сказано в состоянии (`state: 'warn'`), а не скрыто.

import { readClipboard, activeProcess, findAhk } from './capture.mjs';

export const POLL_MS = 1500;

export class ClipboardWatcher {
  #timer = null;

  #last = null;

  #busy = false;

  /**
   * @param {(payload: {text: string, sourceApp: string}) => Promise<any>} onClip
   */
  constructor(onClip, { intervalMs = POLL_MS } = {}) {
    this.onClip = onClip;
    this.intervalMs = intervalMs;
    this.errors = 0;
    this.lastError = null;
    this.seen = 0;
  }

  /** Состояние для диагностики: почему слежка такая, какая есть. */
  status() {
    const ahk = findAhk();
    if (ahk.found) {
      return {
        state: 'good',
        mode: 'ahk',
        reason: null,
        note: 'слежку ведёт мост AutoHotkey: видит смену буфера и имя окна',
      };
    }
    return {
      state: this.#timer ? 'warn' : 'none',
      mode: 'poll',
      reason: ahk.reason,
      note: `опрос каждые ${this.intervalMs} мс через PowerShell: быстрые повторы могут быть пропущены`,
      errors: this.errors,
      lastError: this.lastError,
      seen: this.seen,
    };
  }

  start() {
    if (this.#timer) return { ok: true, already: true };
    this.#timer = setInterval(() => this.tick(), this.intervalMs);
    this.#timer.unref?.();
    return { ok: true, already: false, intervalMs: this.intervalMs };
  }

  stop() {
    if (!this.#timer) return false;
    clearInterval(this.#timer);
    this.#timer = null;
    return true;
  }

  get running() {
    return this.#timer !== null;
  }

  /**
   * Один цикл опроса. Защита от наложения: пока предыдущий опрос не завершён,
   * новый не запускается — иначе на медленной машине процессы PowerShell
   * накапливались бы.
   */
  async tick() {
    if (this.#busy) return { skipped: 'busy' };
    this.#busy = true;

    try {
      const got = await readClipboard();
      if (!got.ok) {
        this.errors += 1;
        this.lastError = got.reason;
        return { skipped: 'unreadable', reason: got.reason };
      }

      const text = got.text;
      if (text === '' || text === this.#last) return { skipped: 'same' };

      this.#last = text;
      this.seen += 1;

      const sourceApp = await activeProcess();
      const out = await this.onClip?.({ text, sourceApp });
      return { ok: true, sent: true, result: out ?? null };
    } catch (err) {
      this.errors += 1;
      this.lastError = err.message;
      return { skipped: 'error', reason: err.message };
    } finally {
      this.#busy = false;
    }
  }

  /** Сброс памяти о последнем значении: нужен тестам и после очистки журнала. */
  reset() {
    this.#last = null;
  }
}

/**
 * Отправка записи в API. Отдельная функция, потому что мост и запасной путь
 * отправляют одинаково, а адрес и токен берутся из одного места.
 */
export const sendClip = async ({ port, token }, { text, sourceApp }) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/clips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Deck-Token': token },
      body: JSON.stringify({ text, sourceApp }),
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    // Сервис остановлен — не ошибка слежки, а ожидаемое состояние.
    return { ok: false, status: 0, reason: `сервис не отвечает: ${err.message}` };
  }
};
