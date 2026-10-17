// ui/views/service.js — раздел «Сервис»: остановка и перезапуск с последствием.
//
// Требования: REQ-UI-SETTINGS, REQ-API-SERVICE (docs/SPEC.md §6, §7). Сценарий S-08.
// Тест: tests/e2e/service.spec.mjs.
//
// Отдельный файл, потому что это единственное место, где интерфейс выключает сам
// себя, и правила здесь другие, чем у полей настроек: каждое действие сначала
// объясняется, и только потом выполняется (docs/RULES.md §6).
//
// Кнопка «Запустить» недоступна всегда, и это не недоделка. Страницу отдал сам
// сервис: пока окно видно — он работает. Когда он остановлен, окно не открылось
// бы вовсе. Запуск возможен только снаружи, из значка в трее. Причина написана в
// подсказке кнопки, потому что серая кнопка без объяснения выглядит как поломка.
//
// Текст последствия приходит с сервера (server/routes-service.mjs), а не живёт
// здесь: два места для одной формулировки — два мнения о том, что произойдёт
// (docs/RULES.md §1).

import { api, toast, setState } from './state.js';

const $ = (id) => document.getElementById(id);

const BUTTON = { start: 'svcStartBtn', stop: 'svcStopBtn', restart: 'svcRestartBtn' };

export class Service {
  constructor({ onGone } = {}) {
    this.onGone = onGone;
    this.actions = null;
  }

  mount() {
    for (const [action, id] of Object.entries(BUTTON)) {
      $(id)?.addEventListener('click', () => this.run(action));
    }
    return this.load();
  }

  /** Что сервер разрешает. Доступность кнопок — его ответ, не догадка страницы. */
  async load() {
    const out = await api('/api/service');
    if (!out.ok) {
      // Раздел «Сервис» и без этого запроса показывает состояние: молчим, чтобы
      // не выводить два сообщения об одной остановке.
      return;
    }

    this.actions = out.data.actions;
    for (const [action, id] of Object.entries(BUTTON)) {
      const el = $(id);
      const info = this.actions[action];
      if (!el || !info) continue;
      el.disabled = info.allowed !== true;
      if (info.why) el.title = info.why;
      else el.removeAttribute('title');
    }
  }

  /**
   * Действие в два шага: сначала спрашиваем сервер о последствии, показываем его
   * человеку и только после согласия отправляем подтверждение.
   */
  async run(action) {
    const asked = await api('/api/service', { method: 'POST', body: { action } });

    if (!asked.ok) {
      // Отказ по делу: «запустить» из работающего окна невозможно, и причина
      // названа сервером.
      toast(asked.error.message, asked.error.error === 'already_running' ? 'none' : 'bad', 6000);
      return;
    }

    const plan = asked.data.plan;
    if (!window.confirm(`${plan.word}\n\n${plan.effect}`)) {
      toast('Отменено — сервис работает', 'good', 1600);
      return;
    }

    const done = await api('/api/service', { method: 'POST', body: { action, confirm: true } });
    if (!done.ok) {
      toast(done.error.message, 'bad', 6000);
      return;
    }

    this.after(action);
  }

  /**
   * Что показать, когда команда принята.
   *
   * Ответ приходит РАНЬШЕ фактической остановки: сервер отвечает и только потом
   * закрывает сокет. Поэтому «остановлено» здесь — это принятая команда, и текст
   * говорит именно так. Состояние сервиса дальше выяснит следующий опрос
   * /api/system: он не ответит, и раздел покажет «сервис остановлен» с причиной.
   */
  after(action) {
    for (const id of Object.values(BUTTON)) {
      const el = $(id);
      if (el) el.disabled = true;
    }

    if (action === 'restart') {
      setState($('svcState'), 'warn', 'перезапускается', 'подождите несколько секунд и обновите окно');
      toast('Перезапуск. Обновите окно через несколько секунд', 'warn', 8000);
    } else {
      setState($('svcState'), 'none', 'останавливается', 'запустить обратно — значком в трее');
      toast('Сервис остановлен. Запустить — значком в трее', 'none', 10000);
    }

    this.onGone?.(action);
  }
}
