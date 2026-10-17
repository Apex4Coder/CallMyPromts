// ui/views/clips.js — журнал буфера: список, фильтры, выбор записи.
//
// Требование: REQ-UI-CLIPS (docs/SPEC.md §7). Сценарий S-04.
// Тест: tests/e2e/clips.spec.mjs.
//
// Владелец описал журнал прямо: «это буфер, работает как логирование, все записи
// идут друг за другом, моя задача только вытащить эту запись». Отсюда решения:
// плоский список без группировки, новое сверху, никаких деталей в строке кроме
// типа, текста и времени.
//
// Контекстное меню и сохранение как промпт — в ui/views/clipmenu.js.

import { api, setState, setText, showEmpty, hideEmpty, toast, ago, dash } from './state.js';
import { ClipMenu } from './clipmenu.js';

const $ = (id) => document.getElementById(id);

const FILTERS = [
  ['all', 'все'], ['text', 'текст'], ['code', 'код'],
  ['link', 'ссылки'], ['path', 'пути'], ['image', 'картинки'],
];

export class Clips {
  constructor({ onCopy } = {}) {
    this.onCopy = onCopy;
    this.items = [];
    this.filter = 'all';
    this.query = '';
    this.index = 0;
    this.knownTop = null;
  }

  mount() {
    this.el = {
      root: $('clips'),
      list: $('clipsList'),
      empty: $('clipsEmpty'),
      emptyText: $('clipsEmptyText'),
      search: $('clipsSearch'),
      count: $('clipsCount'),
      watch: $('clipsWatch'),
      pause: $('clipsPauseBtn'),
      filters: $('clipsFilters'),
    };

    this.menu = new ClipMenu({
      onCopy: this.onCopy,
      onChanged: () => this.load(),
      current: () => this.items[this.index] ?? null,
    });
    this.menu.mount();

    this.el.search.addEventListener('input', () => {
      this.query = this.el.search.value;
      this.load();
    });
    this.el.pause.addEventListener('click', () => this.togglePause());
    this.el.list.addEventListener('contextmenu', (e) => this.onContext(e));
    this.el.list.addEventListener('click', (e) => this.onClick(e));

    this.renderFilters({});
    return this.load();
  }

  async load() {
    const q = encodeURIComponent(this.query);
    const out = await api(`/api/clips?filter=${this.filter}&q=${q}`);

    if (!out.ok) {
      setState(this.el.watch, 'none', 'сервис остановлен', out.error.message);
      showEmpty(this.el.list, this.el.empty, this.el.emptyText, out.error.message);
      return;
    }

    const { items, stats, counts, paused, enabled, empty } = out.data;
    this.items = items;

    setText(this.el.count, `${dash(stats.total)}/${dash(stats.limit)}`);
    this.el.pause.setAttribute('aria-pressed', String(paused));
    this.el.pause.textContent = paused ? 'Продолжить' : 'Пауза';

    if (!enabled) setState(this.el.watch, 'none', 'слежка отключена', 'включается в настройках');
    else if (paused) setState(this.el.watch, 'warn', 'слежка на паузе');
    else setState(this.el.watch, 'good', 'слежка идёт');

    this.renderFilters(counts);

    if (items.length === 0) {
      showEmpty(this.el.list, this.el.empty, this.el.emptyText, empty?.message ?? 'Пусто');
      return;
    }

    hideEmpty(this.el.list, this.el.empty);
    this.render();
  }

  renderFilters(counts = {}) {
    const box = this.el.filters;
    box.textContent = '';
    for (const [id, label] of FILTERS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${label} ${counts[id] ?? 0}`;
      b.setAttribute('aria-pressed', String(this.filter === id));
      b.addEventListener('click', () => {
        this.filter = id;
        this.load();
      });
      box.append(b);
    }
  }

  render() {
    const list = this.el.list;
    list.textContent = '';

    // Приезд новой записи анимируется только когда она действительно новая:
    // иначе анимация играла бы на каждом обновлении по таймеру.
    const newTop = this.items[0]?.id ?? null;
    const arrived = this.knownTop !== null && newTop !== this.knownTop;
    this.knownTop = newTop;

    this.items.forEach((clip, i) => list.append(this.row(clip, i, arrived && i === 0)));
  }

  row(clip, i, isNew) {
    const li = document.createElement('li');
    li.id = `clip-${clip.id}`;
    li.className = `clip${clip.privacy?.hidden ? ' is-hidden' : ''}${isNew ? ' is-new' : ''}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === this.index));
    li.dataset.index = String(i);
    li.dataset.id = String(clip.id);

    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = clip.view?.glyph ?? '¶';
    glyph.title = clip.view?.label ?? clip.kind;

    const text = document.createElement('span');
    text.className = 'text wrap';
    // Секрет скрыт до явного нажатия: в буфер попадают пароли (RULES §6).
    setText(text, clip.privacy?.hidden ? clip.privacy.hint : clip.preview);

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = ago(clip.createdAt);
    when.title = clip.createdAt ?? '';

    li.append(glyph, text, when);

    if (clip.promotedTo) {
      const chip = document.createElement('span');
      setState(chip, 'good', `сохранён: ${clip.promotedTo}`);
      li.append(chip);
    }

    return li;
  }

  onClick(e) {
    const li = e.target.closest('.clip');
    if (!li) return;

    this.index = Number(li.dataset.index);
    for (const [n, x] of [...this.el.list.querySelectorAll('.clip')].entries()) {
      x.setAttribute('aria-selected', String(n === this.index));
    }

    const clip = this.items[this.index];
    if (clip?.privacy?.hidden) this.reveal(li, clip);
  }

  /** Показ скрытой записи. Только по прямому действию человека. */
  async reveal(li, clip) {
    const out = await api(`/api/clip/${clip.id}`);
    if (!out.ok) {
      toast(out.error.message, 'bad');
      return;
    }
    li.classList.remove('is-hidden');
    setText(li.querySelector('.text'), out.data.item.preview);
  }

  onContext(e) {
    const li = e.target.closest('.clip');
    if (!li) return;
    this.index = Number(li.dataset.index);
    this.menu.open(e, this.items[this.index]);
  }

  async togglePause() {
    const paused = this.el.pause.getAttribute('aria-pressed') === 'true';
    const out = await api('/api/watch', { method: 'POST', body: { enabled: paused } });
    if (!out.ok) {
      toast(out.error.message, 'bad');
      return;
    }
    await this.load();
  }
}
