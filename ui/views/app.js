// ui/views/app.js — точка сборки интерфейса: какой экран показать и чем вставлять.
//
// Требование: REQ-UI-LAYOUT (docs/SPEC.md §7). Тест: tests/e2e/picker.spec.mjs.
//
// Одна страница, три экрана: выбор промпта, журнал буфера, управление.
// Экран задаётся якорем в адресе (`#clips`, `#deck`), потому что мост открывает
// окно ссылкой и другого способа передать намерение у него нет.
//
// Вставка в чужое окно из браузера невозможна — это делает мост (bridge/deck.ahk).
// Страница отдаёт текст серверу (`POST /api/paste`), мост забирает его опросом и
// нажимает Ctrl+V. Такое разделение оставляет интерфейс обычной веб-страницей,
// которую можно открыть и проверить.
//
// В обычном пути страница НЕ пишет в буфер обмена сама. Причина: требование
// REQ-KEY-PASTE обязывает вернуть в буфер прежнее содержимое, а браузер его не
// знает — `writeText` затирает буфер, не прочитав. Прежнее содержимое умеет
// сохранить и вернуть только мост. Буфер используется как запасной путь, когда
// мост не ответил: тогда терять уже нечего, а текст нужен человеку.

import { api, toast } from './state.js';
import { Picker } from './picker.js';
import { Clips } from './clips.js';
import { Settings } from './settings.js';
import { CRM } from './crm.js';

const screenFromHash = () => {
  const h = window.location.hash.replace('#', '');
  if (h.startsWith('crm') || h.startsWith('edit-')) return 'crm';
  if (h.startsWith('clips')) return 'clips';
  if (h.startsWith('deck') || h.startsWith('view-')) return 'deck';
  return 'picker';
};

/**
 * Копирование в буфер. Асинхронный API доступен только в защищённом контексте
 * или на localhost — у нас как раз localhost. Запасной путь через скрытое поле
 * нужен для случая, когда разрешение на буфер не выдано.
 */
const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.append(box);
    box.select();
    const ok = document.execCommand?.('copy') ?? false;
    box.remove();
    if (!ok) toast('Не удалось получить буфер обмена', 'bad');
    return ok;
  }
};

/** Применение варианта оформления до первого запроса: страница не мигает. */
const applyLook = (settings) => {
  const html = document.documentElement;
  const ui = settings?.ui ?? {};
  if (ui.layout) html.dataset.layout = ui.layout;
  if (ui.theme) html.dataset.theme = ui.theme;
  if (ui.motion) html.dataset.motion = ui.motion;
  if (ui.accent) html.dataset.accent = ui.accent;
  if (ui.density) html.dataset.density = ui.density;
  if (ui.position) html.dataset.position = ui.position;
  html.style.setProperty('--font-scale', String((ui.font_scale ?? 100) / 100));
  return ui;
};

/**
 * Доставка текста человеку. Возвращает, что произошло на самом деле, а не
 * «получилось»: интерфейс обязан различать «вставлено в окно» и «лежит в буфере,
 * вставьте сами» (S-01, плохой путь 5).
 *
 * @returns {Promise<{ok: boolean, pasted: boolean, why: string|null}>}
 */
const deliver = async ({ text, copyOnly }) => {
  if (copyOnly) {
    const ok = await copyToClipboard(text);
    return { ok, pasted: false, why: ok ? null : 'буфер обмена недоступен' };
  }

  const out = await api('/api/paste', { method: 'POST', body: { text } });
  if (out.ok && out.data.pasted === true) return { ok: true, pasted: true, why: null };

  const why = out.ok
    ? (out.data.why ?? 'мост не ответил')
    : out.error.message;

  // No automatic second paste after timeout: native outcome can be unknown.
  const copied = await copyToClipboard(text);
  return {
    ok: copied,
    pasted: false,
    why: copied ? `${why} — текст в буфере, вставьте вручную` : `${why}; буфер обмена тоже недоступен`,
  };
};

const show = (screen) => {
  document.documentElement.dataset.screen = screen;
  document.getElementById('crm').hidden = screen !== 'crm';
  document.getElementById('stagePicker').hidden = screen !== 'picker';
  document.getElementById('clips').hidden = screen !== 'clips';
  document.getElementById('deck').hidden = screen !== 'deck';
};

const boot = async () => {
  const screen = screenFromHash();
  show(screen);

  // Настройки читаются до отрисовки: иначе человек увидит сначала тему по
  // умолчанию, а потом свою — это выглядит как сбой.
  const got = await api('/api/settings');
  const ui = applyLook(got.ok ? got.data.settings : null);

  if (screen === 'crm') { const crm = new CRM(); await crm.mount(); return; }
  const label = screen === 'picker' ? 'Закреплённые' : screen === 'clips' ? 'Журнал' : 'Управление';
  document.title = `CallMyPromts · ${label} [${window.location.port}]`;
  if (screen === 'picker') {
    const picker = new Picker({ settings: ui, onInsert: deliver });
    await picker.mount();

    // panels показывает превью всегда: раскрывать нечего.
    if (ui.layout === 'panels') document.getElementById('pickerPreview').hidden = false;
    return;
  }

  if (screen === 'clips') {
    const clips = new Clips({ onCopy: copyToClipboard });
    await clips.mount();
    // Журнал — это лог: он пополняется сам, поэтому список обновляется по таймеру.
    setInterval(() => clips.load(), 2000);
    return;
  }

  const settings = new Settings();
  await settings.mount();
  // Опрос заводит сам объект: он же его и останавливает, когда сервис получил
  // команду выключиться (ui/views/service.js).
  settings.startPolling(5000);
};

window.addEventListener('hashchange', () => {
  // Смена экрана перезагружает страницу: три экрана не должны делить состояние,
  // иначе таймеры одного продолжают работать поверх другого.
  window.location.reload();
});

boot().catch((err) => {
  toast(`Интерфейс не запустился: ${err.message}`, 'bad', 8000);
});
