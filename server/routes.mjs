// server/routes.mjs — таблица маршрутов и обработчики системы, настроек, вставки.
//
// Требования: REQ-API-SYSTEM, REQ-API-SETTINGS, REQ-API-PASTE.
// Тест: tests/integration/api.test.mjs.
//
// Обработчики раскладываются по смыслу, каждый в своём файле:
//   routes-prompts.mjs — библиотека промптов (REQ-API-PROMPTS);
//   routes-clips.mjs   — журнал буфера (REQ-API-CLIPS);
//   routes-service.mjs — остановка и перезапуск (REQ-API-SERVICE).
// Причина не в красоте: одним файлом это выходило за 300 строк, а лимит чанка
// (docs/RULES.md §3) не обходится, а соблюдается.

import { usageStats, suggestPin } from '../rank/index.mjs';
import { checkHotkeys, suggestFree } from '../bridge/index.mjs';

import { sendJson, sendError, readJsonBody, matchPath } from './http.mjs';
import { firstBad } from './present.mjs';
import { PROMPT_ROUTES, PROMPT_HANDLERS } from './routes-prompts.mjs';
import { CLIP_ROUTES, CLIP_HANDLERS } from './routes-clips.mjs';
import { SERVICE_ROUTES, SERVICE_HANDLERS } from './routes-service.mjs';
import { CLOUD_ROUTES, CLOUD_HANDLERS } from './routes-cloud.mjs';

/**
 * Таблица маршрутов. Сопоставление идёт по числу сегментов, поэтому порядок
 * важен только для шаблонов одинаковой длины: конкретные пути раньше
 * параметризованных.
 */
export const ROUTES = [
  ['GET', '/api/system'],
  ['GET', '/api/window'],
  ['POST', '/api/window'],
  ['GET', '/api/settings'],
  ['PUT', '/api/settings'],
  ['POST', '/api/hotkeys'],
  ['GET', '/api/paste'],
  ['POST', '/api/paste'],
  ['POST', '/api/paste/ack'],
  ...PROMPT_ROUTES,
  ...CLIP_ROUTES,
  ...SERVICE_ROUTES,
  ...CLOUD_ROUTES,
];

const HANDLERS = {
  /* ---------- система ---------- */
  'POST /api/window': ({ res, deck }) => {
    deck.windowRequest = 'crm'; sendJson(res, 202, { queued: true, shown: false });
  },
  'GET /api/window': ({ res, deck }) => {
    const window = deck.windowRequest ?? null; deck.windowRequest = null;
    sendJson(res, 200, { window });
  },

  'GET /api/system': async ({ res, deck, runtime }) => {
    const lib = await deck.library();
    sendJson(res, 200, {
      service: {
        state: 'good',
        pid: process.pid,
        port: runtime.port,
        startedAt: deck.startedAt,
      },
      library: { path: deck.libraryRoot, ...lib.stats, groups: lib.groups },
      clips: deck.clips.stats(deck.settings.clipboard.limit),
      usage: usageStats(lib.items),
      hotkeys: runtime.hotkeys ?? {},
      settingsIssues: deck.settingsIssues,
      suggestion: suggestPin(lib.items, { after: deck.settings.order.suggest_pin_after }),
      problems: lib.items
        .filter((i) => i.state !== 'good')
        .map((i) => ({
          id: i.id,
          group: i.group,
          state: i.state,
          issues: i.issues.map((x) => x.message),
        })),
    });
  },

  /* ---------- настройки ---------- */

  'GET /api/settings': ({ res, deck }) => {
    sendJson(res, 200, { settings: deck.settings, issues: deck.settingsIssues });
  },

  'PUT /api/settings': async ({ req, res, deck }) => {
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(res, 400, 'bad_json', body.message);

    const out = deck.saveSettings(body.data);
    if (!out.ok) {
      const bad = firstBad(out.issues);
      return sendError(res, 400, bad.code, bad.message, { field: bad.field, expected: bad.expected });
    }
    return sendJson(res, 200, { settings: out.settings, issues: out.issues });
  },

  /**
   * Отчёт моста о регистрации хоткеев.
   * Мост знает, что удалось зарегистрировать в ОС; сервер знает, что человек
   * просил в настройках. Состояние в `runtime.json` — пересечение обоих:
   * зелёный светофор при незарегистрированной клавише был бы ложью (RULES §4).
   */
  'POST /api/hotkeys': async ({ req, res, deck, runtime }) => {
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(res, 400, 'bad_json', body.message);

    const fromBridge = body.data.hotkeys ?? {};
    const checked = checkHotkeys(deck.settings.hotkeys);

    const merged = {};
    for (const [action, own] of Object.entries(checked)) {
      const said = fromBridge[action];
      // Мост главнее в одном: если ОС отказала, состояние bad независимо от схемы.
      merged[action] = said && said.state === 'bad'
        ? { ...own, state: 'bad', reason: said.reason ?? 'не зарегистрирована в системе' }
        : { ...own, state: said?.state === 'good' ? own.state : (said?.state ?? own.state) };
    }

    runtime.hotkeys = merged;
    deck.writeRuntime({ port: runtime.port, hotkeys: merged });

    const busy = Object.values(merged).filter((h) => h.state === 'bad').map((h) => h.combo);
    return sendJson(res, 200, {
      hotkeys: merged,
      suggestions: busy.length > 0 ? suggestFree(Object.values(merged).map((h) => h.combo)) : [],
    });
  },

  /* ---------- вставка ---------- */

  /**
   * Заявка на вставку от интерфейса.
   * Ответ ждёт мост: `pasted: false` означает, что текст остался в буфере и
   * человеку надо сказать «вставьте вручную» (S-01, плохой путь 5). Рисовать
   * «Вставлено» без подтверждения от моста — это ложь о результате (RULES §4).
   */
  'POST /api/paste': async ({ req, res, deck }) => {
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(res, 400, 'bad_json', body.message);

    const text = typeof body.data?.text === 'string' ? body.data.text : '';
    if (text === '') {
      return sendError(res, 400, 'empty_text', 'нечего вставлять: текст пуст', { field: 'text' });
    }

    const taken = await deck.paste.request(text);
    return sendJson(res, 200, {
      pasted: taken,
      why: taken ? null : 'нет подтверждения нативной вставки; проверьте целевое окно перед ручной вставкой',
    });
  },

  /** Опрос мостом. Заявка одноразовая: второй опрос вернёт `text: null`. */
  'GET /api/paste': ({ res, deck }) => {
    const text = deck.paste.take();
    sendJson(res, 200, { text, has: text !== null, id: text !== null ? deck.paste.deliveryId : null });
  },

  'POST /api/paste/ack': async ({ req, res, deck }) => {
    const body = await readJsonBody(req);
    if (!body.ok || typeof body.data?.id !== 'string' || typeof body.data?.success !== 'boolean') {
      return sendError(res, 400, 'bad_ack', 'нужны id и success:boolean');
    }
    const accepted = deck.paste.acknowledge(body.data.id, body.data.success);
    return sendJson(res, accepted ? 200 : 409, { accepted });
  },

  ...PROMPT_HANDLERS,
  ...CLIP_HANDLERS,
  ...SERVICE_HANDLERS,
  ...CLOUD_HANDLERS,
};

const dispatch = async (pattern, ctx) => {
  const fn = HANDLERS[pattern];
  if (!fn) return sendError(ctx.res, 500, 'no_handler', `для «${pattern}» нет обработчика`);
  try {
    return await fn(ctx);
  } catch (err) {
    // Причина всегда называется: «внутренняя ошибка» без текста бесполезна.
    return sendError(ctx.res, 500, 'internal', err.message, { where: pattern });
  }
};

/**
 * Обработка запроса API.
 *
 * `control` — управление самим процессом (остановка, перезапуск). Приходит от
 * server/index.mjs, а не берётся из bridge: остановить себя может только тот, кто
 * держит слушающий сокет, и обработчику нужен именно этот процесс, а не поиск
 * чужого pid в runtime.json.
 *
 * @returns {Promise<boolean>} обработан ли путь; false → 404 решает вызывающий
 */
export const handleApi = async (req, res, { deck, path, params, runtime, control = null }) => {
  const method = req.method.toUpperCase();

  for (const [m, pattern] of ROUTES) {
    if (m !== method) continue;
    const args = matchPath(pattern, path);
    if (!args) continue;
    await dispatch(`${m} ${pattern}`, { req, res, deck, args, params, runtime, control });
    return true;
  }
  return false;
};
