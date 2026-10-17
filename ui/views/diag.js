// ui/views/diag.js — светофоры, конфликты хоткеев, раздел «Диагностика».
//
// Требования: REQ-UI-STATE, REQ-UI-SETTINGS (docs/SPEC.md §7). Сценарии S-07, S-12.
// Тест: tests/e2e/state.spec.mjs.
//
// Отдельный файл, потому что это единственное место, где приложение отвечает на
// вопрос «всё ли в порядке». Правило одно и жёсткое: каждое «не в порядке» несёт
// причину. Статус без причины бесполезен (docs/RULES.md §4).

import { setState, setText, dash } from './state.js';

const $ = (id) => document.getElementById(id);

/** Поле ввода хоткея по имени действия — для подсветки занятых. */
const KEY_INPUT = {
  open_picker: 'keyPicker',
  save_clip: 'keySave',
  open_clips: 'keyClips',
  toggle_watch: 'keyWatch',
};

const uptime = (iso) => {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return null;
  const sec = Math.floor((Date.now() - t) / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин ${sec % 60} с`;
};

/** Строка «название — плашка — объяснение». Основной кирпич диагностики. */
const line = (name, level, why) => {
  const row = document.createElement('div');
  row.className = 'field';

  const label = document.createElement('span');
  label.textContent = name;

  const value = document.createElement('span');
  const chip = document.createElement('span');
  setState(chip, level);
  const text = document.createElement('span');
  text.className = 'muted wrap';
  text.textContent = ` ${why}`;
  value.append(chip, text);

  row.append(label, value);
  return row;
};

/**
 * Конфликты хоткеев. Приём взят у ClipClip: занятая комбинация подсвечена,
 * назван перехватчик, предложена замена. Тихого отказа нет (S-07).
 */
export const renderHotkeys = (hotkeys = {}) => {
  const box = $('keyConflicts');
  if (!box) return;
  box.textContent = '';

  let problems = 0;

  for (const [action, info] of Object.entries(hotkeys)) {
    const input = $(KEY_INPUT[action]);
    if (input) {
      if (info.state === 'bad') input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
    if (info.state === 'good' || info.state === 'none') continue;

    problems += 1;
    box.append(line(info.human ?? info.combo ?? action, info.state, info.reason ?? 'причина не сообщена'));
  }

  if (Object.keys(hotkeys).length === 0) {
    box.append(line('Хоткеи', 'none', 'мост не отчитался — сервис остановлен или AutoHotkey не найден'));
    return;
  }
  if (problems === 0) {
    box.append(line('Хоткеи', 'good', 'конфликтов нет'));
  }
};

/** Список битых и подозрительных промптов с причинами. */
export const renderIssues = (problems = []) => {
  const box = $('libIssues');
  if (!box) return;
  box.textContent = '';

  if (problems.length === 0) {
    box.append(line('Библиотека', 'good', 'все промпты в норме'));
    return;
  }

  for (const p of problems.slice(0, 40)) {
    box.append(line(`${p.group}/${p.id}`, p.state, p.issues.join('; ')));
  }

  if (problems.length > 40) {
    const more = document.createElement('p');
    more.className = 'muted';
    more.textContent = `…и ещё ${problems.length - 40}`;
    box.append(more);
  }
};

/**
 * Раздел «Диагностика» и раздел «Сервис».
 * @param {object|null} d ответ /api/system
 * @param {object|null} error причина, если ответа нет
 */
export const renderSystem = (d, error = null) => {
  if (!d) {
    setState($('svcState'), 'none', 'сервис остановлен', error?.message ?? '');
    setText($('svcUptime'), null);
    setText($('libCount'), null);
    renderHotkeys({});

    const box = $('diagList');
    if (box) {
      box.textContent = '';
      box.append(line('Сервис', 'none', error?.message ?? 'нет связи'));
    }
    return;
  }

  setState($('svcState'), d.service.state, 'работает', `pid ${d.service.pid}, порт ${d.service.port}`);
  setText($('svcUptime'), uptime(d.service.startedAt));
  setText($('libCount'), `${dash(d.library.total)} (${dash(d.library.good)} в норме, ${dash(d.library.warn)} внимание, ${dash(d.library.bad)} сломано)`);

  renderIssues(d.problems);

  const box = $('diagList');
  if (!box) return;
  box.textContent = '';

  const rows = [
    ['Библиотека', d.library.total > 0 ? 'good' : 'none',
      d.library.total > 0
        ? `${dash(d.library.total)} промптов в ${dash(d.library.groups.length)} группах`
        : 'промптов нет — создайте первый или запустите миграцию'],

    ['Битые промпты', d.library.bad === 0 ? 'good' : 'bad',
      d.library.bad === 0 ? 'нет' : `${dash(d.library.bad)} — причины в разделе «Библиотека»`],

    ['Журнал буфера', d.clips.paused ? 'warn' : 'good',
      `${dash(d.clips.total)} из ${dash(d.clips.limit)}${d.clips.paused ? ', слежка на паузе' : ''}`],

    ['Использование', d.usage.everUsed > 0 ? 'good' : 'none',
      `${dash(d.usage.everUsed)} из ${dash(d.usage.total)} хотя бы раз (${dash(d.usage.share)}%)`],

    ['Настройки', (d.settingsIssues ?? []).length === 0 ? 'good' : 'warn',
      (d.settingsIssues ?? []).map((i) => i.message).join('; ') || 'без замечаний'],
  ];

  if (d.clips.recovered) {
    rows.push(['Журнал восстановлен', 'warn', `база была повреждена: ${d.clips.recovered.reason}`]);
  }

  for (const [name, level, why] of rows) box.append(line(name, level, why));

  if (d.suggestion) {
    box.append(line('Подсказка', 'warn', d.suggestion.text));
  }
};
