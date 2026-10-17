// ui/views/settings.js — окно управления: чтение, запись, применение настроек.
//
// Требование: REQ-UI-SETTINGS (docs/SPEC.md §7). Сценарии S-07, S-08, S-09.
// Тест: tests/e2e/settings.spec.mjs.
//
// Все варианты оформления доступны здесь: три раскладки, обе темы, пять акцентов,
// три уровня движения, три плотности. Владелец отказался выбирать один вариант,
// поэтому выбор остался за ним в рантайме (docs/UI-SPEC.md §0).
//
// Применение мгновенное: атрибут на <html> меняется до отправки на сервер, и
// человек видит результат раньше, чем настройка сохранится (U-20). При отказе
// сервера вид возвращается к сохранённому — иначе экран врал бы о состоянии.
//
// Диагностика и светофоры — в ui/views/diag.js.

import { api, toast } from './state.js';
import { FIELDS, buildForms } from './fields.js';
import { renderSystem, renderHotkeys } from './diag.js';
import { Service } from './service.js';
import { mountCloud } from './cloud.js';

const $ = (id) => document.getElementById(id);

/** Что из настроек отражается атрибутом на <html>. */
const ATTRS = {
  'ui.layout': 'layout',
  'ui.theme': 'theme',
  'ui.motion': 'motion',
  'ui.accent': 'accent',
  'ui.density': 'density',
  'ui.position': 'position',
};
const DEFAULT_HOTKEYS = { open_picker: '^+q', save_clip: '^+s', open_clips: '^!v', toggle_watch: '' };


const get = (obj, path) => path.split('.').reduce((o, k) => (o ?? {})[k], obj);

const set = (obj, path, value) => {
  const keys = path.split('.');
  const last = keys.pop();
  const box = keys.reduce((o, k) => {
    o[k] = o[k] ?? {};
    return o[k];
  }, obj);
  box[last] = value;
  return obj;
};

export class Settings {
  constructor() {
    this.settings = null;
    // Управление сервисом — отдельный объект: у него другое правило (каждое
    // действие сначала объясняется) и своя связь с сервером.
    this.service = new Service({ onGone: () => this.stopPolling() });
    this.timer = null;
  }

  /** Первый раздел окна управления, когда якорь не называет раздел. */
  static FIRST = 'view-service';

  async mount() {
    buildForms();

    this.nav = $('deckNav');
    this.nav?.addEventListener('click', (e) => this.onNav(e));

    for (const f of FIELDS) {
      const el = $(f.id);
      if (!el) continue;
      const event = f.kind === 'check' || f.kind === 'select' ? 'change' : 'input';
      el.addEventListener(event, () => this.onChange(f, el));
    }

    $('keyResetBtn')?.addEventListener('click', () => this.resetHotkeys());
    $('diagRunBtn')?.addEventListener('click', () => this.loadSystem());

    await this.load();
    await this.loadSystem();
    await this.service.mount();
    this.show(this.fromHash());
    await mountCloud();
  }

  /**
   * Опрос состояния. Останавливается, когда сервис получил команду остановиться:
   * иначе окно каждые пять секунд писало бы «нет связи с сервисом» вместо того,
   * что человек только что сделал сам.
   */
  startPolling(ms = 5000) {
    this.stopPolling();
    this.timer = setInterval(() => this.loadSystem(), ms);
  }

  stopPolling() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Какой раздел открыть по адресу.
   *
   * Мост открывает окно управления ссылкой `#deck` — другого способа передать
   * намерение у него нет (ui/views/app.js). Прежняя версия подставляла `deck` в
   * `show()` как имя раздела, и не совпадал ни один: окно открывалось с пустой
   * правой частью, только навигация слева. Работало лишь после клика по ссылке.
   *
   * Поэтому якорь используется, только если он называет существующий раздел.
   */
  fromHash() {
    const asked = window.location.hash.replace('#', '');
    return asked && document.querySelector(`#deckMain section#${asked}`)
      ? asked
      : Settings.FIRST;
  }

  onNav(e) {
    const a = e.target.closest('a');
    if (!a) return;
    if (a.getAttribute('href') === '#crm') return;
    e.preventDefault();
    this.show(a.getAttribute('href').replace('#', ''));
  }

  show(id) {
    for (const s of document.querySelectorAll('#deckMain section')) s.hidden = s.id !== id;
    for (const a of this.nav?.querySelectorAll('a') ?? []) {
      if (a.getAttribute('href') === `#${id}`) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  async load() {
    const out = await api('/api/settings');
    if (!out.ok) {
      toast(out.error.message, 'bad');
      return;
    }

    this.settings = out.data.settings;
    this.fill();
    this.apply(this.settings);

    // Сброс настроек из-за битого файла объясняется, а не скрывается (V-S-4).
    for (const issue of out.data.issues ?? []) {
      if (issue.level !== 'good') toast(issue.message, issue.level);
    }
  }

  fill() {
    for (const f of FIELDS) {
      const el = $(f.id);
      if (!el) continue;
      const value = get(this.settings, f.path);
      if (f.kind === 'check') el.checked = value === true;
      else if (f.kind === 'lines') el.value = Array.isArray(value) ? value.join('\n') : '';
      else el.value = value ?? '';
    }
  }

  /** Атрибуты на <html>: изменение вида не требует перезагрузки страницы. */
  apply(settings) {
    const html = document.documentElement;
    for (const [path, attr] of Object.entries(ATTRS)) {
      const v = get(settings, path);
      if (v) html.dataset[attr] = v;
    }
    html.style.setProperty('--font-scale', String((get(settings, 'ui.font_scale') ?? 100) / 100));
  }

  readField(f, el) {
    if (f.kind === 'check') return el.checked;
    if (f.kind === 'number') return Number(el.value);
    if (f.kind === 'lines') return el.value.split('\n').map((s) => s.trim()).filter(Boolean);
    return el.value;
  }

  async onChange(f, el) {
    const next = structuredClone(this.settings ?? {});
    set(next, f.path, this.readField(f, el));

    // Вид применяется сразу: ждать ответа сервера, чтобы увидеть тему, незачем.
    if (ATTRS[f.path] || f.path === 'ui.font_scale') this.apply(next);

    const out = await api('/api/settings', { method: 'PUT', body: next });

    if (!out.ok) {
      el.setAttribute('aria-invalid', 'true');
      const why = out.error.expected ? ` (ожидалось: ${out.error.expected})` : '';
      toast(`${out.error.message}${why}`, 'bad');
      this.apply(this.settings);
      return;
    }

    el.removeAttribute('aria-invalid');
    this.settings = out.data.settings;
    this.apply(this.settings);

    // Хоткеи вступают в силу только после перечитывания мостом — говорим об этом.
    if (f.path.startsWith('hotkeys.')) {
      toast('Сохранено. Мост подхватит клавишу после «Перезапустить сервис».', 'warn', 4000);
    }
  }

  async resetHotkeys() {
    const next = structuredClone(this.settings ?? {});
    next.hotkeys = { ...DEFAULT_HOTKEYS };

    const out = await api('/api/settings', { method: 'PUT', body: next });
    if (!out.ok) {
      toast(out.error.message, 'bad');
      return;
    }

    this.settings = out.data.settings;
    this.fill();
    toast('Горячие клавиши сброшены', 'good');
  }

  async loadSystem() {
    const out = await api('/api/system');
    if (!out.ok) {
      renderSystem(null, out.error);
      return;
    }
    renderSystem(out.data, null);
    renderHotkeys(out.data.hotkeys);
  }
}
