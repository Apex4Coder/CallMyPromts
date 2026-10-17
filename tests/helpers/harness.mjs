// tests/helpers/harness.mjs — общая обвязка тестов: фикстуры и временные папки.
//
// Требование: REQ-TEST-UNIT (docs/SPEC.md §11). Тест самой обвязки:
// tests/unit/harness.test.mjs.
//
// Правило: тест не трогает настоящую библиотеку и настоящий журнал. Каждый тест
// получает свою папку в системном temp и удаляет её за собой. Тест, который
// пишет в prompts/, однажды сотрёт рабочий промпт — и это будет обнаружено поздно.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Отдельная папка на каждый тест. Префикс общий — легко найти забытые. */
export const tempRoot = () => mkdtempSync(join(tmpdir(), 'deck-test-'));

export const cleanup = (root) => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch { /* Windows иногда держит файл базы: остаток уберёт система */ }
};

/**
 * Промпт-фикстура. Поля по умолчанию валидны, чтобы тест ломал ровно то,
 * что проверяет, а не спотыкался о недостающий title.
 */
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

  const body = over.body ?? `Тело промпта ${id}.`;
  const lines = ['---'];

  for (const [key, value] of Object.entries(meta)) {
    if (value === null) lines.push(`${key}: null`);
    else if (Array.isArray(value)) lines.push(`${key}: [${value.map((t) => `"${t}"`).join(', ')}]`);
    else if (typeof value === 'number') lines.push(`${key}: ${value}`);
    else lines.push(`${key}: "${value}"`);
  }

  lines.push('---', '', body, '');

  const dir = join(root, group);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.md`);
  writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
};

/** Файл с произвольным содержимым: для битых случаев (нет frontmatter, пустое тело). */
export const rawFile = (root, group, name, text) => {
  const dir = join(root, group);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, text, 'utf8');
  return file;
};

/** Библиотека из нескольких промптов одной строкой. */
export const library = (root, specs) => {
  const out = [];
  for (const s of specs) out.push(promptFile(root, s.group ?? 'code', s.id, s));
  return out;
};

/** Настройки в state/settings.json целевого корня. */
export const settingsFile = (root, settings) => {
  const dir = join(root, 'state');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return file;
};

export const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

/**
 * Запуск сервера на свободном порту с временным корнем.
 * Порт 0 обязателен: тесты не должны занимать 8791 и мешать работающему сервису.
 */
export const startServer = async (root) => {
  const { start } = await import('../../server/index.mjs');
  const up = await start({ root, port: 0 });
  if (!up.ok) throw new Error(up.message);

  const call = async (path, { method = 'GET', body = null, token = up.token } = {}) => {
    const res = await fetch(`http://127.0.0.1:${up.port}${path}`, {
      method,
      headers: {
        ...(token ? { 'X-Deck-Token': token } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data, headers: res.headers };
  };

  return { ...up, call };
};

/** Есть ли путь. Нужен проверкам «файл создан» без импорта fs в каждом тесте. */
export const exists = (p) => existsSync(p);
