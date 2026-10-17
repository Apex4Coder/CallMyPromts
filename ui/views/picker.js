// ui/views/picker.js — окно выбора промпта: список, поиск, вставка.
//
// Требования: REQ-UI-SPEED, REQ-UI-KEYS (docs/SPEC.md §7). Сценарии S-01, S-02.
// Тесты: tests/e2e/picker.spec.mjs, tests/e2e/keys.spec.mjs.
//
// Разбор нажатий — в ui/views/keys.js. Модель взята из ClipClip: одно нажатие —
// один смысл. Цифры 1..9 работают только при пустом поиске, иначе «1» было бы
// неоднозначно между «позиция 1» и «символ 1» (docs/UI-SPEC.md §4).
import {
  api, setState, setText, renderParts, showEmpty, hideEmpty, toast, tempChip, usageBadge, latest,
} from './state.js';
import { keyAction } from './keys.js';
const $ = (id) => document.getElementById(id);
/** Задержка перед запросом при наборе: 26 промптов не требуют запроса на букву. */
const DEBOUNCE = 90;
export class Picker {
  constructor({ onInsert, settings = {} }) {
    this.onInsert = onInsert;
    this.settings = settings;
    this.items = [];
    this.index = 0;
    this.query = '';
    this.timer = null;
    this.expanded = false;
    // Счётчики очерёдности: ответ старого запроса не имеет права заменить новый.
    this.loads = latest();
    this.previews = latest();
  }
  mount() {
    this.el = {
      picker: $('picker'),
      search: $('pickerSearch'),
      list: $('pickerList'),
      empty: $('pickerEmpty'),
      emptyText: $('pickerEmptyText'),
      preview: $('pickerPreview'),
      title: $('previewTitle'),
      meta: $('previewMeta'),
      body: $('previewBody'),
      head: $('headState'),
    };
    this.el.search.addEventListener('input', () => this.onType());
    document.addEventListener('keydown', (e) => this.onKey(e));
    this.el.list.addEventListener('click', (e) => this.onClick(e));
    this.el.list.addEventListener('dblclick', () => {
      const item = this.items[this.index];
      if (item) window.location.hash = `edit-${encodeURIComponent(item.id)}`;
    });
    this.el.search.focus();
    return this.load();
  }
  onType() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.query = this.el.search.value;
      this.load();
    }, DEBOUNCE);
  }
  /**
   * Загрузка списка.
   *
   * Каждый ответ проверяется на актуальность. Причина не теоретическая: окно
   * всплывает и человек сразу печатает, первый запрос читает библиотеку с диска,
   * второй попадает в кэш и отвечает раньше. Ответ на пустой поиск приходил
   * последним и возвращал полный список поверх найденного — на экране был один
   * набор строк, а Enter вставлял из другого.
   */
  async load() {
    const mine = this.loads.next();
    const q = encodeURIComponent(this.query);
    const pinsOnly = window.location.hash.startsWith('#pins');
    document.documentElement.dataset.quick = String(pinsOnly);
    const out = await api(`/api/prompts?q=${q}${pinsOnly ? '&pinned=1' : ''}`);
    if (!this.loads.fresh(mine)) return;
    if (!out.ok) {
      // Сервис остановлен — это состояние «нет данных» с причиной, не пустой список.
      setState(this.el.head, 'none', 'сервис остановлен', out.error.message);
      showEmpty(this.el.list, this.el.empty, this.el.emptyText, out.error.message);
      return;
    }
    setState(this.el.head, 'good', 'работает');
    this.items = out.data.items;
    this.pins = out.data.pins ?? [];
    if (this.items.length === 0) {
      this.index = -1; this.previews.next();
      setText(this.el.title, 'Нет выбранного промпта');
      this.el.meta.textContent = ''; this.el.body.textContent = '';
      showEmpty(this.el.list, this.el.empty, this.el.emptyText, out.data.empty?.message ?? 'Пусто');
      return;
    }
    hideEmpty(this.el.list, this.el.empty);
    this.index = 0;
    this.render();
  }
  render() {
    const list = this.el.list;
    list.textContent = '';
    let pinnedShown = false;
    this.items.forEach((item, i) => {
      // Разделитель между закреплёнными и остальными: показывает, где кончаются
      // позиции 1..9 и начинается сортировка по частоте.
      if (item.pin === null && pinnedShown) {
        const hr = document.createElement('hr');
        hr.id = 'pickerSplit';
        list.append(hr);
        pinnedShown = false;
      }
      if (item.pin !== null) pinnedShown = true;
      list.append(this.row(item, i));
    });
    this.select(this.index);
  }
  row(item, i) {
    const li = document.createElement('li');
    li.id = `prompt-${item.id}`;
    li.className = `row${item.state === 'bad' ? ' is-broken' : ''}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.dataset.index = String(i);
    li.dataset.id = item.id;
    li.dataset.group = item.group;
    const digit = document.createElement('span');
    digit.className = 'digit';
    digit.textContent = item.pin === null ? '' : String(item.pin);
    const name = document.createElement('span');
    name.className = 'name wrap';
    if (item.match?.parts?.length) renderParts(name, item.match.parts, item.title);
    else setText(name, item.title);
    const group = document.createElement('span');
    group.className = 'group';
    group.textContent = this.settings.show_groups === false ? '' : (item.group ?? '');
    li.append(digit, name, group);
    if (this.settings.show_badges !== false) {
      const badge = usageBadge(item.usage);
      if (badge) li.append(badge);
    }
    if (this.settings.show_temperature !== false) li.append(tempChip(item.usage));
    if (item.state !== 'good') {
      const chip = document.createElement('span');
      setState(chip, item.state, item.state === 'bad' ? 'сломано' : 'внимание',
        item.issues.map((x) => x.message).join('; '));
      li.append(chip);
    }
    return li;
  }
  select(i) {
    const rows = [...this.el.list.querySelectorAll('.row')];
    if (rows.length === 0) return;
    this.index = Math.max(0, Math.min(i, rows.length - 1));
    rows.forEach((r, n) => r.setAttribute('aria-selected', n === this.index ? 'true' : 'false'));
    rows[this.index].scrollIntoView({ block: 'nearest' });
    this.el.list.setAttribute('aria-activedescendant', rows[this.index].id);
    this.preview(this.items[this.index]);
  }
  async preview(item) {
    if (!item) return;
    const mine = this.previews.next();
    setText(this.el.title, item.title);
    this.el.meta.textContent = '';
    const bits = [
      item.group,
      `⌗${item.usage?.used ?? 0}`,
      item.usage?.lastUsedHuman ?? '—',
      item.usage?.temperatureLabel ?? '',
    ].filter(Boolean);
    for (const b of bits) {
      const s = document.createElement('span');
      s.className = 'muted';
      s.textContent = b;
      this.el.meta.append(s);
    }
    if (item.state !== 'good') {
      for (const issue of item.issues) {
        const chip = document.createElement('span');
        setState(chip, issue.level, issue.message);
        this.el.meta.append(chip);
      }
    }
    // Тело подгружается отдельным запросом: в списке его нет намеренно.
    const out = await api(`/api/prompt/${encodeURIComponent(item.id)}`);
    // Быстрое движение по списку ↑↓ рождает несколько запросов; текст под
    // заголовком обязан принадлежать последней выбранной строке, а не той,
    // чей ответ пришёл позже.
    if (!this.previews.fresh(mine)) return;
    setText(this.el.body, out.ok ? out.data.item.body : out.error.message);
  }
  onClick(e) {
    const li = e.target.closest('.row');
    if (!li) return;
    const i = Number(li.dataset.index);
    this.select(i);
  }
  onKey(e) {
    const a = keyAction(e, { emptyQuery: this.el.search.value === '' });
    if (a.prevent) e.preventDefault();
    if (a.act === 'close') this.close();
    else if (a.act === 'move') this.select(this.index + a.step);
    else if (a.act === 'insert') this.insert({ copyOnly: a.copyOnly, trim: a.trim });
    else if (a.act === 'expand') this.toggleExpand();
    else if (a.act === 'edit') window.location.hash = `#edit-${this.items[this.index]?.id ?? ''}`;
    else if (a.act === 'pin') this.byPin(a.pin);
  }
  /** Выбор по закреплённой позиции. Свободная позиция — не ошибка, а факт. */
  byPin(pin) {
    const at = this.items.findIndex((x) => x.pin === pin);
    if (at < 0) {
      toast(`Позиция ${pin} свободна`, 'none');
      return;
    }
    this.select(at);
    this.insert();
  }
  toggleExpand() {
    this.expanded = !this.expanded;
    this.el.picker.dataset.expanded = String(this.expanded);
    this.el.preview.hidden = !this.expanded && document.documentElement.dataset.layout !== 'panels';
  }
  /**
   * Вставка. Битый промпт не вставляется: пустое тело или сломанный frontmatter
   * означают, что в чат уйдёт мусор (S-01, плохой путь 3).
   */
  async insert({ copyOnly = false, trim = false } = {}) {
    const item = this.items[this.index];
    if (!item) return;
    if (item.state === 'bad') {
      toast(`Не вставлено: ${item.issues[0]?.message ?? 'промпт сломан'}`, 'bad');
      return;
    }
    const got = await api(`/api/prompt/${encodeURIComponent(item.id)}`);
    if (!got.ok) {
      toast(got.error.message, 'bad');
      return;
    }
    const text = trim ? got.data.item.body.trimEnd() : got.data.item.body;
    const done = await this.onInsert?.({ item, text, copyOnly });
    const out = done === undefined ? { ok: true, pasted: !copyOnly, why: null } : done;
    if (out.ok === false) {
      toast(out.why ?? 'не удалось доставить текст', 'bad', 6000);
      return;
    }
    // Счётчик растёт только при вставке, которая действительно состоялась.
    // Считать «в буфере, вставьте вручную» за использование значило бы врать
    // статистике: температура и порядок строятся на этом счётчике.
    if (out.pasted) {
      await api(`/api/prompt/${encodeURIComponent(item.id)}/used?group=${encodeURIComponent(item.group)}`, { method: 'POST' });
    }
    const row = this.el.list.querySelector(`#prompt-${CSS.escape(item.id)}`);
    row?.classList.add('is-flash');
    if (out.pasted) toast('Команда вставки выполнена', 'good', 1400);
    else if (copyOnly) toast('Скопировано в буфер', 'good', 1400);
    else toast(out.why ?? 'Текст в буфере — вставьте вручную', 'warn', 6000);
  }
  close() {
    this.el.picker.classList.add('is-leaving');
    setTimeout(() => window.close?.(), 120);
  }
}
