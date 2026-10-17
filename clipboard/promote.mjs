// clipboard/promote.mjs — превращение записи журнала в промпт (сценарий S-05).
//
// Требование: REQ-CLIP-PROMOTE (docs/SPEC.md §4). Тест: tests/integration/promote.test.mjs.
//
// ГРАНИЦА. `clipboard` зависит только от `contracts` (arch.yaml), а единственный
// владелец папки `prompts/` — модуль `library` (docs/ENTITY-MAP.md §1, §6).
// Поэтому здесь нет ни одной записи в файлы: файл только ГОТОВИТ решение
// (что сохранить, под каким именем, в какую группу) и принимает исполнителя
// снаружи. Собирает связку `server`, которому разрешены оба модуля.
//
// Так граница остаётся целой, а логика «как правильно сохранить клип»
// не расползается по вызывающим местам.

import { bad, warn, makePreview } from '../contracts/index.mjs';

import { describeKind } from './kind.mjs';
import { findSecretMarks } from './privacy.mjs';

/** Пункты подменю «Сохранить как промпт ▸». Новая группа — всегда последним. */
export const groupChoices = (groups = []) => {
  const items = groups
    .filter((g) => g && g.id)
    .map((g) => ({ id: g.id, label: g.label ?? g.id, count: Number(g.count ?? 0) }));
  return [...items, { id: '__new__', label: '+ Новая группа', count: null }];
};

/**
 * Инструменты подготовки текста приходят снаружи (`library/clean.mjs`): импорт
 * `library` из `clipboard` запрещён границей (arch.yaml, docs/ENTITY-MAP.md §6).
 *
 * Запасных реализаций здесь нет намеренно. Упрощённая замена не чистит HTML и
 * не транслитерирует кириллицу — русский заголовок превратился бы в «p-p», и
 * файл лёг бы в библиотеку с нечитаемым именем. Отсутствие инструментов — это
 * ошибка сборки, а не режим работы, поэтому она возвращается как P-0.
 */
const REQUIRED_TOOLS = ['cleanBody', 'titleFromText', 'slugify'];

/**
 * Подготовка сохранения. Ничего не пишет.
 *
 * @param {object} clip запись журнала (нужны text, id, kind, promoted_to)
 * @param {object} opts.group целевая группа
 * @param {string|null} opts.title имя от человека; пусто → берём из текста
 * @param {object[]} opts.existing уже существующие промпты для поиска повтора
 * @param {object} opts.tools { cleanBody, titleFromText, slugify }
 * @returns {{ ok: boolean, issues: object[], plan: object|null }}
 */
export const planPromotion = (clip, {
  group,
  title = null,
  existing = [],
  tools = null,
} = {}) => {
  const issues = [];

  const missing = REQUIRED_TOOLS.filter((k) => typeof tools?.[k] !== 'function');
  if (missing.length > 0) {
    issues.push(bad('P-0', `не переданы инструменты library: ${missing.join(', ')}`, { field: 'tools', expected: REQUIRED_TOOLS.join(', ') }));
    return { ok: false, issues, plan: null };
  }
  const t = tools;

  if (!clip || typeof clip.text !== 'string' || clip.text.trim() === '') {
    issues.push(bad('P-1', 'запись пуста — сохранять нечего', { field: 'clip.text' }));
    return { ok: false, issues, plan: null };
  }
  if (!group || typeof group !== 'string') {
    issues.push(bad('P-2', 'не выбрана группа', { field: 'group', expected: 'имя группы' }));
    return { ok: false, issues, plan: null };
  }

  const { text, changed } = t.cleanBody(clip.text);
  if (text.trim() === '') {
    issues.push(bad('P-3', 'после очистки не осталось текста', { field: 'clip.text' }));
    return { ok: false, issues, plan: null };
  }

  const finalTitle = (title && String(title).trim() !== '') ? String(title).trim() : t.titleFromText(text);
  const id = t.slugify(finalTitle);

  // Повтор: та же запись уже сохранялась (S-05, плохой путь 2).
  const already = clip.promoted_to
    ? { promptId: clip.promoted_to, reason: 'этой записи уже соответствует промпт' }
    : null;
  if (already) {
    issues.push(warn('P-4', `уже сохранена как «${already.promptId}»`, { field: 'promoted_to' }));
  }

  // Совпадение по тексту с существующим промптом — тоже предупреждение, не запрет:
  // человек имеет право на две похожие заготовки.
  const twin = existing.find((p) => typeof p?.body === 'string' && p.body.trim() === text.trim());
  if (twin) {
    issues.push(warn('P-5', `текст совпадает с промптом «${twin.id ?? '?'}»`, { field: 'body' }));
  }

  const marks = findSecretMarks(text);
  if (marks.length > 0) {
    issues.push(warn('P-6', `в тексте похоже на секрет: ${marks.join(', ')} — библиотека синхронизируется`, { field: 'body' }));
  }

  const kind = describeKind(text, { kind: clip.kind });

  return {
    ok: true,
    issues,
    plan: {
      clipId: clip.id ?? null,
      group,
      id,
      title: finalTitle,
      body: text,
      preview: makePreview(text),
      cleaned: changed,
      kind: kind.kind,
      language: kind.language,
      source: clip.source_app ? `clipboard:${clip.source_app}` : 'clipboard',
      alreadyPromoted: already,
      duplicate: twin ? (twin.id ?? null) : null,
      sensitive: marks.length > 0,
    },
  };
};

/**
 * Исполнение подготовленного плана.
 * `create` — функция записи из `library` (`createPrompt`), передаётся снаружи.
 * `store` — журнал: после успешной записи ставим `promoted_to`, чтобы запись
 * перестала вытесняться лимитом (V-C-3).
 *
 * Порядок важен: сначала файл, потом отметка. Если отметка не удалась,
 * промпт уже существует и человек его видит; обратный порядок дал бы отметку
 * на несуществующий файл.
 */
export const applyPromotion = async (plan, { create, store }) => {
  if (!plan) return { ok: false, issues: [bad('P-7', 'нет плана сохранения')] };
  if (typeof create !== 'function') return { ok: false, issues: [bad('P-8', 'не передан исполнитель записи')] };

  const res = await create({
    group: plan.group,
    id: plan.id,
    title: plan.title,
    body: plan.body,
    source: plan.source,
    tags: plan.language ? [plan.language] : [],
  });

  if (!res || res.ok === false) {
    return { ok: false, issues: res?.issues ?? [bad('P-9', 'запись промпта не удалась')], created: null };
  }

  let marked = false;
  if (store && plan.clipId != null) {
    try {
      marked = store.markPromoted(plan.clipId, res.id ?? plan.id);
    } catch {
      marked = false; // Файл создан; отсутствие отметки — не причина откатывать промпт.
    }
  }

  return {
    ok: true,
    issues: marked ? [] : [warn('P-10', 'промпт создан, но отметка в журнале не поставлена')],
    created: { id: res.id ?? plan.id, group: plan.group, path: res.path ?? null },
    marked,
  };
};

/** Человеческое описание результата для всплывающего сообщения. */
export const describeResult = (out) => {
  if (!out?.ok) return { state: 'bad', text: out?.issues?.[0]?.message ?? 'не сохранено' };
  if (out.issues.length > 0) return { state: 'warn', text: `Сохранён «${out.created.id}», но: ${out.issues[0].message}` };
  return { state: 'good', text: `Сохранён как «${out.created.id}» в «${out.created.group}»` };
};
