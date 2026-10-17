// ui/views/fields.js — единственное описание полей настроек.
//
// Требование: REQ-UI-SETTINGS (docs/SPEC.md §7). DOM-id: docs/UI-SPEC.md §3.3.
//
// Почему поля описаны здесь, а не в разметке. Раньше каждое поле существовало
// дважды: как `<input>` в index.html и как строка таблицы в settings.js. Два места
// для одного факта — это два мнения о настройке (docs/RULES.md §1): достаточно
// добавить опцию в одном и забыть в другом, чтобы поле молча перестало работать.
//
// Здесь один список. Из него строится и разметка, и чтение-запись значений.
// Идентификаторы те же, что в контракте §3.3, поэтому E2E-тесты не задеты.

export const SECTIONS = {
  'view-hotkeys': [
    { id: 'keyPicker', path: 'hotkeys.open_picker', kind: 'text', label: 'Открыть выбор', hint: '^ Ctrl, ! Alt, + Shift, # Win' },
    { id: 'keySave', path: 'hotkeys.save_clip', kind: 'text', label: 'Сохранить выделенное' },
    { id: 'keyClips', path: 'hotkeys.open_clips', kind: 'text', label: 'Открыть журнал' },
    { id: 'keyWatch', path: 'hotkeys.toggle_watch', kind: 'text', label: 'Пауза слежки', placeholder: 'не назначена' },
  ],

  'view-look': [
    {
      id: 'optLayout',
      path: 'ui.layout',
      kind: 'select',
      label: 'Раскладка',
      options: [
        ['palette', 'Палитра — одна колонка, быстрее всего'],
        ['panels', 'Панели — список и просмотр рядом'],
        ['hybrid', 'Гибрид — палитра, просмотр по Space'],
      ],
    },
    {
      id: 'optTheme',
      path: 'ui.theme',
      kind: 'select',
      label: 'Тема',
      options: [['light', 'Светлая'], ['dark', 'Тёмная'], ['system', 'Как в системе']],
    },
    {
      id: 'optAccent',
      path: 'ui.accent',
      kind: 'select',
      label: 'Акцент',
      hint: 'Красный и зелёный не предлагаются: они заняты статусами.',
      options: [
        ['teal', 'Бирюзовый'], ['indigo', 'Индиго'], ['amber', 'Янтарный'],
        ['rose', 'Розовый'], ['slate', 'Графитовый'],
      ],
    },
    {
      id: 'optMotion',
      path: 'ui.motion',
      kind: 'select',
      label: 'Движение',
      hint: 'При системной настройке «уменьшить движение» уровень понижается принудительно.',
      options: [['full', 'Полное'], ['reduced', 'Сокращённое'], ['off', 'Выключено']],
    },
    {
      id: 'optDensity',
      path: 'ui.density',
      kind: 'select',
      label: 'Плотность',
      options: [['compact', 'Плотно'], ['normal', 'Обычно'], ['comfortable', 'Свободно']],
    },
    { id: 'optFontScale', path: 'ui.font_scale', kind: 'number', label: 'Масштаб текста, %', min: 100, max: 200, step: 10 },
    {
      id: 'optPosition',
      path: 'ui.position',
      kind: 'select',
      label: 'Где открывать',
      options: [['center', 'По центру экрана'], ['cursor', 'У курсора'], ['top', 'Сверху, на 25%']],
    },
    { id: 'optBadges', path: 'ui.show_badges', kind: 'check', label: 'Показывать счётчики' },
    { id: 'optTemperature', path: 'ui.show_temperature', kind: 'check', label: 'Показывать температуру' },
    { id: 'optGroups', path: 'ui.show_groups', kind: 'check', label: 'Показывать группы' },
  ],

  'view-order': [
    {
      id: 'optOrderMode',
      path: 'order.mode',
      kind: 'select',
      label: 'Как сортировать',
      hint: 'Позиции 1–9 не двигаются ни в одном режиме.',
      options: [
        ['pinned-frequency', 'Закреплённые, затем по свежести и частоте'],
        ['manual', 'Только вручную — порядок не меняется'],
      ],
    },
    { id: 'optSuggestAfter', path: 'order.suggest_pin_after', kind: 'number', label: 'Предлагать закрепить после', min: 1, max: 999 },
  ],

  'view-clipboard': [
    { id: 'optClipEnabled', path: 'clipboard.enabled', kind: 'check', label: 'Следить за буфером' },
    { id: 'optClipLimit', path: 'clipboard.limit', kind: 'number', label: 'Сколько записей хранить', min: 20, max: 1000 },
    { id: 'optClipImages', path: 'clipboard.save_images', kind: 'check', label: 'Сохранять картинки', hint: 'Картинки раздувают базу, для промптов бесполезны.' },
    { id: 'optClipClear', path: 'clipboard.clear_on_exit', kind: 'check', label: 'Очищать при выходе' },
    {
      id: 'optBlacklist',
      path: 'clipboard.blacklist',
      kind: 'lines',
      label: 'Не записывать из',
      rows: 4,
      hint: 'Одно имя процесса на строку. Журнал буфера не покидает эту машину.',
    },
  ],

  'view-library': [
    { id: 'libPath', path: 'library.path', kind: 'text', label: 'Папка' },
  ],
};

/** Плоский список для чтения и записи значений. */
export const FIELDS = Object.values(SECTIONS).flat();

const input = (f) => {
  if (f.kind === 'select') {
    const el = document.createElement('select');
    for (const [value, label] of f.options) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      el.append(opt);
    }
    return el;
  }
  if (f.kind === 'lines') {
    const el = document.createElement('textarea');
    el.rows = f.rows ?? 3;
    return el;
  }
  const el = document.createElement('input');
  el.type = f.kind === 'check' ? 'checkbox' : (f.kind === 'number' ? 'number' : 'text');
  if (f.kind === 'number') {
    el.min = String(f.min ?? 0);
    el.max = String(f.max ?? 999);
    if (f.step) el.step = String(f.step);
  }
  if (f.placeholder) el.placeholder = f.placeholder;
  return el;
};

/** Построение строки настройки: подпись связана с полем через for/id (§6). */
export const buildField = (f) => {
  const row = document.createElement('div');
  row.className = 'field';

  const label = document.createElement('label');
  label.setAttribute('for', f.id);
  label.textContent = f.label;

  const el = input(f);
  el.id = f.id;

  row.append(label, el);

  if (f.hint) {
    const why = document.createElement('span');
    why.className = 'why';
    why.id = `${f.id}Why`;
    why.textContent = f.hint;
    el.setAttribute('aria-describedby', why.id);
    row.append(why);
  }

  return row;
};

/** Наполнение всех разделов. Вызывается один раз при запуске окна управления. */
export const buildForms = () => {
  for (const [sectionId, fields] of Object.entries(SECTIONS)) {
    const host = document.querySelector(`#${sectionId} .fields`);
    if (!host) continue;
    host.textContent = '';
    for (const f of fields) host.append(buildField(f));
  }
};
