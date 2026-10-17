// tests/e2e/deck.mjs — обвязка E2E: свой сервер и своя библиотека на каждый файл.
//
// Требование: REQ-TEST-E2E (docs/SPEC.md §11).
//
// Playwright умеет поднимать сервер сам (`webServer` в конфиге), но это здесь не
// подходит: у окна выбора, журнала и управления разные фикстуры, и общий сервер
// заставил бы файлы спек делить одну папку промптов. Тесты, делящие данные,
// ломаются по очереди и не говорят, кто именно виноват.
//
// Поэтому каждый файл спек берёт своё: временный корень, своя библиотека, свой
// свободный порт. Настоящие prompts/ и state/ не затрагиваются никогда.
//
// Область фикстуры — `worker`, и это НЕ равно «на файл»: Playwright переиспользует
// процесс-исполнитель для следующего файла спек, а фикстура области worker живёт
// до конца процесса. Значит библиотека и настройки достались бы следующему файлу
// в том виде, в каком их оставил предыдущий — например с тёмной темой и чужими
// промптами. Поэтому есть `reset()`, и каждый файл вызывает его в `beforeAll`:
// сервер поднимается один раз, а состояние у файла своё.

import { test as base } from '@playwright/test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULTS } from '../../contracts/index.mjs';
import { start } from '../../server/index.mjs';

/** Промпт-фикстура. Поля по умолчанию валидны: тест ломает только то, что проверяет. */
export const promptFile = (root, group, id, over = {}) => {
  const meta = {
    id,
    title: over.title ?? `Промпт ${id}`,
    group,
    pin: over.pin ?? null,
    hotkey: over.hotkey ?? null,
    trigger: over.trigger ?? null,
    status: over.status ?? 'active',
    version: over.version ?? 1,
    created: over.created ?? '2026-01-01',
    updated: over.updated ?? '2026-01-01',
    used: over.used ?? 0,
    last_used: over.last_used ?? null,
    score: over.score ?? null,
    tags: over.tags ?? [],
    source: over.source ?? null,
  };

  const lines = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    if (value === null) lines.push(`${key}: null`);
    else if (Array.isArray(value)) lines.push(`${key}: [${value.map((t) => `"${t}"`).join(', ')}]`);
    else if (typeof value === 'number') lines.push(`${key}: ${value}`);
    else lines.push(`${key}: "${value}"`);
  }
  lines.push('---', '', over.body ?? `Тело промпта ${id}.`, '');

  const dir = join(root, group);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), lines.join('\n'), 'utf8');
};

/** Библиотека для окна выбора: закреплённый, частый, редкий, из другой группы. */
export const LIBRARY = [
  { id: 'c-review', group: 'code', title: 'Ревью кода', pin: 1, used: 24, last_used: new Date().toISOString() },
  { id: 'c-bug', group: 'code', title: 'Поиск ошибки', pin: 2, used: 12, last_used: new Date(Date.now() - 3 * 864e5).toISOString() },
  { id: 'c-tests', group: 'code', title: 'Написать тесты', used: 5, last_used: new Date(Date.now() - 20 * 864e5).toISOString() },
  { id: 'r-deep', group: 'research', title: 'Глубокое исследование', used: 0 },
  { id: 'x-plan', group: 'core', title: 'План работ', used: 2, last_used: new Date(Date.now() - 60 * 864e5).toISOString() },
];

/**
 * Фикстура `deck`: поднятый сервер, адрес страницы и путь к библиотеке.
 *
 * Область — `worker`: сервер поднимается один раз на файл, а не на каждый тест.
 * Старт занимает сотни миллисекунд, и на двадцати тестах это разница между
 * прогоном за секунды и за минуту.
 */
export const test = base.extend({
  deck: [async ({}, use, workerInfo) => {
    const root = mkdtempSync(join(tmpdir(), 'deck-e2e-'));
    const libRoot = join(root, 'prompts');

    const settings = workerInfo.project.metadata?.settings ?? null;
    if (settings) {
      mkdirSync(join(root, 'state'), { recursive: true });
      writeFileSync(join(root, 'state', 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
    }

    /**
     * Остановка сервиса без остановки процесса.
     *
     * Настоящий `control.shutdown` завершает процесс (server/index.mjs), и здесь
     * это убило бы сам исполнитель Playwright вместе со всеми остальными тестами.
     * Поэтому вызов записывается: проверяется, что путь «кнопка → подтверждение →
     * запрос → команда процессу» доходит до конца, а само завершение принадлежит
     * запуску из командной строки и здесь не воспроизводится.
     */
    const shutdowns = [];
    const control = { shutdown: (opts = {}) => shutdowns.push(opts) };

    const up = await start({ root, port: 0, control });
    if (!up.ok) throw new Error(up.message ?? 'сервер не поднялся');

    /** Запрос к API с токеном. Ответ разбирается всегда: код нужен тестам. */
    const call = async (path, opts = {}) => {
      const res = await fetch(`http://127.0.0.1:${up.port}${path}`, {
        method: opts.method ?? 'GET',
        headers: {
          'X-Deck-Token': up.token,
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, data: text ? JSON.parse(text) : null };
    };

    const seed = (specs) => {
      for (const s of specs) promptFile(libRoot, s.group ?? 'code', s.id, s);
      // Кэш библиотеки живёт 1500 мс; сброс нужен, чтобы файлы были видны сразу.
      up.deck.invalidate();
    };

    /**
     * Чистое состояние для файла спек: пустая библиотека, пустой журнал,
     * настройки по умолчанию, слежка включена.
     *
     * Настройки возвращаются целиком, а не полем: слияние идёт с ДЕЙСТВУЮЩИМИ
     * значениями (contracts/settings.mjs), поэтому «сбросить тему» одним полем
     * не вернуло бы раскладку и плотность.
     */
    const reset = async () => {
      rmSync(libRoot, { recursive: true, force: true });
      mkdirSync(libRoot, { recursive: true });
      await call('/api/settings', { method: 'PUT', body: DEFAULTS });
      await call('/api/clips/clear', { method: 'POST', body: { keepPromoted: false } });
      await call('/api/watch', { method: 'POST', body: { enabled: true } });
      shutdowns.length = 0;
      up.deck.invalidate();
    };

    await use({
      url: up.url,
      port: up.port,
      token: up.token,
      root,
      libRoot,
      seed,
      reset,
      api: call,
      settings: (patch) => call('/api/settings', { method: 'PUT', body: patch }),
      shutdowns,
    });

    await up.close();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch { /* Windows держит файл базы: остаток уберёт система */ }
  }, { scope: 'worker' }],
});

export { expect } from '@playwright/test';

/** Открытие экрана. Якорь — единственный способ передать намерение из моста. */
export const open = async (page, deck, hash = '') => {
  await page.goto(`${deck.url}${hash}`);
  await page.waitForLoadState('domcontentloaded');
};

/** Ошибки консоли: интерфейс, который ругается в консоль, работает случайно. */
export const watchConsole = (page) => {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
};

/**
 * Замер готовности окна (утверждение U-4).
 *
 * Наблюдатель ставится ДО любого скрипта страницы и запоминает `performance.now()`
 * в момент появления первой строки списка. Отсчёт идёт от начала навигации,
 * поэтому в замер входит всё, что делает страница сама: три файла стилей, модули
 * и запросы к API. Не входит запуск браузера — его время принадлежит ОС, а не нам.
 */
export const measureReady = async (page) => {
  await page.addInitScript(() => {
    window.__rowsAt = null;
    new MutationObserver(() => {
      if (window.__rowsAt === null && document.querySelector('#pickerList .row')) {
        window.__rowsAt = performance.now();
      }
    }).observe(document, { childList: true, subtree: true });
  });
};

/** Сколько прошло до первой строки. `null` — строк не было вовсе. */
export const readyMs = (page) => page.evaluate(() => window.__rowsAt);

/**
 * Мост-заменитель: забирает заявку на вставку так же, как bridge/deck.ahk.
 *
 * Настоящий мост опрашивает `GET /api/paste` каждые 250 мс. Здесь интервал
 * короче — тест не должен ждать дольше, чем нужно, — но принцип тот же: пустой
 * ответ это норма, а не ошибка.
 *
 * @returns {Promise<string|null>} забранный текст или `null`, если заявки не было
 */
export const fakeBridge = (deck, { everyMs = 30, forMs = 3000 } = {}) => {
  const until = Date.now() + forMs;
  return (async () => {
    while (Date.now() < until) {
      const out = await deck.api('/api/paste');
      if (out.status === 200 && out.data?.has === true) {
        // Explicit synthetic native acknowledgement; dequeue alone is not delivery.
        const ack = await deck.api('/api/paste/ack', {
          method: 'POST', body: { id: out.data.id, success: true },
        });
        if (ack.status !== 200) throw new Error('Synthetic bridge acknowledgement rejected');
        return out.data.text;
      }
      await new Promise((r) => setTimeout(r, everyMs));
    }
    return null;
  })();
};

/**
 * Чтение буфера обмена страницы.
 * `bringToFront` обязателен: Chromium отказывает в чтении буфера окну без
 * фокуса, и отказ выглядел бы как «интерфейс не скопировал».
 */
export const readClipboard = async (page) => {
  await page.bringToFront();
  return page.evaluate(() => navigator.clipboard.readText());
};

/** Запись в буфер до действия: так видно, что действие его НЕ тронуло. */
export const seedClipboard = async (page, text) => {
  await page.bringToFront();
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
};

/**
 * Ожидание конца анимаций.
 *
 * Нужно перед любым измерением геометрии: `getBoundingClientRect` учитывает
 * `transform`, а окно появляется через `scale(0.98) → 1` за 150 мс. Замер
 * посреди этой анимации давал 898px вместо 900 — и выглядел как дефект
 * раскладки, хотя раскладка была верной.
 *
 * Бесконечные анимации пропускаются: пульс индикатора сервиса (2 с, цикл)
 * никогда не завершится, и ожидание его `finished` повисло бы до таймаута.
 */
export const waitStill = (page) => page.evaluate(async () => {
  const running = document.getAnimations()
    .filter((a) => a.effect?.getTiming?.().iterations !== Infinity)
    .map((a) => a.finished.catch(() => {}));
  await Promise.all(running);
});

/**
 * Геометрия элемента для проверок раскладки.
 *
 * Размеры берутся из `offsetWidth/offsetHeight`: это целые числа компоновки, не
 * зависящие от `transform`. Положение — из `getBoundingClientRect`, потому что
 * `offsetTop` считается от родителя, а нужен экран.
 */
export const boxOf = async (page, selector) => {
  await waitStill(page);
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      w: el.offsetWidth,
      h: el.offsetHeight,
      x: Math.round(r.x),
      y: Math.round(r.y),
    };
  }, selector);
};
