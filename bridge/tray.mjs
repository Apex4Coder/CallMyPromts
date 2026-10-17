// bridge/tray.mjs — значок в трее и его меню.
//
// Требование: REQ-SVC-TRAY (docs/SPEC.md §8). Сценарий S-08.
// Тест: tests/unit/bridge-tray.test.mjs.
//
// Значок рисует AHK: у Node на Windows нет доступа к области уведомлений без
// нативного модуля, а зависимостей в проекте ноль (docs/RULES.md §3). Здесь —
// описание меню и состояния, которое AHK показывает в подсказке.
//
// Владелец просил именно эту модель: «внизу значок открывается, всплывающая штука
// появляется в центре». Отсюда: левый клик открывает выбор промпта сразу, без
// промежуточного окна; всё остальное — правым кликом.

import { serviceStatus } from './service.mjs';
import { worstState } from './hotkeys.mjs';

/**
 * Пункты меню. Порядок продуман: сверху то, что нужно каждый день,
 * снизу то, что нужно раз в месяц. Выход — последним и отделён.
 */
export const MENU = [
  { id: 'crm', label: 'Мини-CRM', hash: '#crm', default: true },
  { id: 'picker', label: 'Открыть выбор', hash: '#pins' },
  { id: 'clips', label: 'Журнал буфера', hash: '#clips' },
  { id: 'settings', label: 'Настройки', hash: '#deck' },
  { id: 'sep1', separator: true },
  { id: 'watch', label: 'Пауза слежки', toggle: true },
  { id: 'reload', label: 'Перечитать настройки' },
  { id: 'sep2', separator: true },
  { id: 'restart', label: 'Перезапустить сервис' },
  { id: 'stop', label: 'Остановить сервис' },
  { id: 'sep3', separator: true },
  { id: 'exit', label: 'Выход' },
];

/** Подписи состояний для подсказки значка. Слово, а не только цвет. */
const WORD = { good: 'работает', warn: 'работает с замечаниями', bad: 'сломано', none: 'остановлен' };

/**
 * Сводное состояние приложения для значка.
 * Правило: значок показывает ХУДШЕЕ из состояний частей. Зелёный значок при
 * незарегистрированном хоткее — это ложь, из-за которой человек будет думать,
 * что клавиша работает (docs/RULES.md §4).
 */
export const trayState = (root) => {
  const s = serviceStatus(root);

  if (s.server.state === 'none') {
    return { state: 'none', word: WORD.none, reason: s.server.reason, parts: s };
  }

  const keys = worstState(s.hotkeys);
  const levels = [s.server.state, s.bridge.state, keys];
  const state = levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : 'good';

  const reasons = [];
  if (s.bridge.state === 'bad') reasons.push(s.bridge.reason);
  for (const [action, info] of Object.entries(s.hotkeys)) {
    if (info.state === 'bad' || info.state === 'warn') {
      reasons.push(`${action}: ${info.reason ?? 'причина не сообщена'}`);
    }
  }

  return {
    state,
    word: WORD[state],
    reason: reasons.length > 0 ? reasons.join('; ') : null,
    parts: s,
  };
};

/** Текст подсказки значка: одна строка, которая объясняет состояние целиком. */
export const tooltip = (root) => {
  const t = trayState(root);
  const port = t.parts.server.port ? `, порт ${t.parts.server.port}` : '';
  const tail = t.reason ? ` — ${t.reason}` : '';
  return `CallMyPromts: ${t.word}${port}${tail}`;
};

/**
 * Меню с учётом состояния: пункты, которые сейчас ничего не сделают,
 * помечаются недоступными вместо того, чтобы молча не срабатывать.
 */
export const menuFor = (root, { paused = false } = {}) => {
  const t = trayState(root);
  const running = t.parts.server.state !== 'none';

  return MENU.map((item) => {
    if (item.separator) return item;
    const disabled = !running && ['crm', 'picker', 'clips', 'settings', 'watch', 'restart', 'stop'].includes(item.id);
    const label = item.id === 'watch' ? (paused ? 'Продолжить слежку' : 'Пауза слежки') : item.label;
    return { ...item, label, disabled, why: disabled ? 'сервис остановлен' : null };
  });
};

/** Строка для передачи в AHK: одна пара «действие → подпись» на строку. */
export const menuScript = (root, opts = {}) => menuFor(root, opts)
  .map((i) => (i.separator ? '---' : `${i.id}\t${i.label}\t${i.disabled ? '0' : '1'}`))
  .join('\n');
