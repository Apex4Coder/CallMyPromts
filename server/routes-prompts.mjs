// server/routes-prompts.mjs — маршруты библиотеки промптов.
//
// Требование: REQ-API-PROMPTS (docs/SPEC.md §6). Сценарии S-01, S-02, S-06, S-10.
// Тесты: tests/integration/api.test.mjs, tests/e2e/picker.spec.mjs.
//
// Выделено из server/routes.mjs: вместе с системой, настройками и вставкой файл
// вышел за 300 строк. Лимит чанка (docs/RULES.md §3) не обходится, а соблюдается —
// раскладка по смыслу: здесь всё, что читает и пишет prompts/.

import { createPrompt, updatePrompt, setPin, createGroup } from '../library/index.mjs';
import { planPin, pinSlots, emptyMessage } from '../rank/index.mjs';

import { sendJson, sendError, readJsonBody } from './http.mjs';
import { forList, forOne, firstBad } from './present.mjs';

/**
 * Маршруты промптов.
 * Порядок внутри списка значим только для шаблонов равной длины: конкретные
 * пути обязаны стоять раньше параметризованных, иначе `/api/prompt/:id`
 * перехватит `/api/prompt`.
 */
export const PROMPT_ROUTES = [
  ['GET', '/api/prompts'],
  ['POST', '/api/prompt'],
  ['POST', '/api/group'],
  ['GET', '/api/prompt/:id'],
  ['PUT', '/api/prompt/:id'],
  ['POST', '/api/prompt/:id/used'],
  ['POST', '/api/prompt/:id/pin'],
];

const findItem = (items, id) => items.find((i) => i.id === id) ?? null;

export const PROMPT_HANDLERS = {
  /**
   * Список для окна выбора.
   * Пустота бывает двух видов, и они чинятся по-разному: библиотеки нет вовсе
   * (создать первый промпт) либо поиск ничего не нашёл (изменить запрос). Одно
   * сообщение на два случая соврало бы про один из них (docs/SCENARIOS.md S-02).
   */
  'GET /api/prompts': async ({ res, deck, params }) => {
    const query = params.get('q') ?? '';
    const group = params.get('group') || null;
    const view = await deck.view({ query, group });
    if (params.get('pinned') === '1') {
      view.items = view.items.filter(item => item.pin !== null && item.pin !== undefined)
        .sort((a, b) => a.pin - b.pin);
    }

    let empty = null;
    if (view.items.length === 0) {
      empty = query.trim() === ''
        ? { reason: 'no_prompts', message: 'Промптов нет — создайте первый через Ctrl+Shift+S' }
        : { reason: 'no_match', message: emptyMessage(query) };
    }

    sendJson(res, 200, {
      items: view.items.map(forList),
      groups: view.groups,
      stats: view.stats,
      pins: pinSlots(view.items),
      order: deck.settings.order.mode,
      empty,
    });
  },

  'GET /api/prompt/:id': async ({ res, deck, args }) => {
    const lib = await deck.library();
    const item = findItem(lib.items, args.id);
    if (!item) return sendError(res, 404, 'not_found', `промпт «${args.id}» не найден`);
    return sendJson(res, 200, { item: forOne(item) });
  },

  'POST /api/prompt': async ({ req, res, deck }) => {
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(res, 400, 'bad_json', body.message);

    const out = await createPrompt(deck.libraryRoot, body.data);
    if (!out.ok) {
      const bad = firstBad(out.issues);
      return sendError(res, 400, bad.code, bad.message, { field: bad.field, expected: bad.expected });
    }
    deck.invalidate();
    return sendJson(res, 201, {
      id: out.id, group: out.group, cleaned: out.cleaned, issues: out.issues,
    });
  },

  'PUT /api/prompt/:id': async ({ req, res, deck, args }) => {
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(res, 400, 'bad_json', body.message);

    const { group, expectedMtime = null, ...patch } = body.data;
    if (!group) return sendError(res, 400, 'no_group', 'не указана группа промпта', { field: 'group' });

    const out = await updatePrompt(deck.libraryRoot, args.id, group, patch, { expectedMtime });
    if (!out.ok) {
      const bad = firstBad(out.issues);
      // 409, а не 400: файл изменён снаружи — это конфликт, и он решается человеком.
      return sendError(res, out.conflict ? 409 : 400, bad.code, bad.message, { file: bad.file ?? null });
    }
    deck.invalidate();
    return sendJson(res, 200, { id: out.id, group: out.group, issues: out.issues });
  },

  'POST /api/prompt/:id/used': async ({ res, deck, args, params }) => {
    const group = params.get('group');
    if (!group) return sendError(res, 400, 'no_group', 'не указана группа промпта', { field: 'group' });

    const out = await deck.usage.count(args.id, group);
    if (!out.ok) return sendError(res, 400, 'not_counted', out.reason);

    deck.invalidate();
    return sendJson(res, 200, out);
  },

  /**
   * Закрепление в два шага. Первый запрос возвращает последствие («позиция 3
   * занята — он потеряет закрепление»), второй с `confirm: true` выполняет.
   * Причина: молчаливый обмен позициями — это изменение, которого человек не
   * просил (docs/RULES.md §5, S-06).
   */
  'POST /api/prompt/:id/pin': async ({ req, res, deck, args }) => {
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(res, 400, 'bad_json', body.message);

    if (body.data.unpin === true) {
      const off = await updatePrompt(deck.libraryRoot, args.id, body.data.group, { pin: null });
      if (!off.ok) return sendError(res, 400, firstBad(off.issues).code, firstBad(off.issues).message);
      deck.invalidate();
      return sendJson(res, 200, { unpinned: true });
    }

    const lib = await deck.library();
    const wanted = body.data.pin === null || body.data.pin === undefined ? null : Number(body.data.pin);
    const plan = planPin(lib.items, args.id, wanted);

    if (!plan.ok) return sendError(res, 409, 'pin_blocked', plan.reason, { occupied: plan.occupied ?? null });
    if (body.data.confirm !== true) return sendJson(res, 200, { plan });

    const out = await setPin(deck.libraryRoot, lib.items, args.id, plan.pin);
    if (!out.ok) return sendError(res, 400, firstBad(out.issues).code, firstBad(out.issues).message);

    deck.invalidate();
    return sendJson(res, 200, { pin: plan.pin, swapped: out.swapped ?? [] });
  },

  'POST /api/group': async ({ req, res, deck }) => {
    const body = await readJsonBody(req);
    if (!body.ok) return sendError(res, 400, 'bad_json', body.message);

    const out = await createGroup(deck.libraryRoot, body.data.name);
    if (!out.ok) {
      const bad = firstBad(out.issues);
      return sendError(res, 400, bad.code, bad.message, { expected: bad.expected });
    }
    deck.invalidate();
    return sendJson(res, 201, out);
  },
};
