// One-shot native delivery. Taking is NOT acknowledgement; no automatic replay.
import { randomUUID } from 'node:crypto';
export const PASTE_WAIT_MS = 1000;
export const PASTE_TTL_MS = 10000;
export class PasteQueue {
  #pending = null;
  constructor({ waitMs = PASTE_WAIT_MS, ttlMs = PASTE_TTL_MS } = {}) {
    this.waitMs = waitMs; this.ttlMs = ttlMs; this.served = 0; this.missed = 0;
  }
  request(text, { waitMs = this.waitMs, now = Date.now() } = {}) {
    this.#pending?.settle(false);
    return new Promise(resolve => {
      const id = randomUUID(); let done = false;
      const settle = success => {
        if (done) return; done = true; clearTimeout(timer);
        if (this.#pending?.id === id) this.#pending = null;
        if (success) this.served++; else this.missed++;
        resolve(success);
      };
      const timer = setTimeout(() => settle(false), waitMs);
      this.#pending = { id, text, at: now, taken: false, settle };
    });
  }
  take({ now = Date.now() } = {}) {
    const p = this.#pending;
    if (!p || p.taken) return null;
    if (now - p.at > this.ttlMs) { p.settle(false); return null; }
    p.taken = true; return p.text;
  }
  get deliveryId() { return this.#pending?.taken ? this.#pending.id : null; }
  acknowledge(id, success) {
    const p = this.#pending;
    if (!p || !p.taken || p.id !== id || typeof success !== 'boolean') return false;
    p.settle(success); return true;
  }
  get waiting() { return this.#pending !== null; }
  close() { this.#pending?.settle(false); }
  stats() { return { served: this.served, missed: this.missed, waiting: this.waiting }; }
}
