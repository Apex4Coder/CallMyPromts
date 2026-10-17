// tests/unit/bridge-conflict.test.mjs — конфликты горячих клавиш.
//
// Требование: REQ-KEY-CONFLICT (docs/SPEC.md §8). Сценарий: S-07, плохие пути.
//
// Принцип взят у ClipClip и усилен: красная строка вместо тихого отказа. Разведка
// показала, что на машине уже заняты `^q` и `^+v` (ClipClip), а `^!v` бывает
// занят Punto Switcher. Человек не обязан это помнить — программа обязана сказать.
//
// Три вида конфликта различаются по последствиям, поэтому и по уровню:
//   формат       → bad, регистрация невозможна;
//   свой дубль   → bad, одна из двух клавиш точно не сработает;
//   чужое занято → warn, вероятно не сработает, но проверить можно только опытом.

import test from 'node:test';
import assert from 'node:assert/strict';

import { KNOWN_TAKEN, checkHotkeys, worstState, suggestFree } from '../../bridge/index.mjs';

/** Полный набор действий, как в настройках. */
const KEYS = {
  picker: '^!p',
  clips: '^!c',
  save: '^!s',
  settings: '^!d',
};

// ── известные занятые ────────────────────────────────────────────────────────

test('занятые на этой машине комбинации перечислены с виновником', () => {
  // Без имени приложения человек не поймёт, что закрыть или перенастроить.
  for (const [combo, who] of Object.entries(KNOWN_TAKEN)) {
    assert.equal(who.trim() !== '', true, `${combo}: не назван виновник`);
  }
  assert.match(KNOWN_TAKEN['^q'], /ClipClip/);
  assert.match(KNOWN_TAKEN['^!v'], /Punto/);
});

test('занятая чужим приложением — warn с названием приложения', () => {
  const out = checkHotkeys({ picker: '^q' });

  assert.equal(out.picker.state, 'warn');
  assert.match(out.picker.reason, /ClipClip/);
});

test('warn, а не bad: проверить занятость наверняка можно только регистрацией', () => {
  // ClipClip могли удалить или перенастроить. Блокировать выбор из-за догадки —
  // значит решать за человека (docs/RULES.md §5).
  const out = checkHotkeys({ picker: '^q' });

  assert.notEqual(out.picker.state, 'bad');
});

// ── свои дубли ───────────────────────────────────────────────────────────────

test('одна комбинация на два действия — bad у второго', () => {
  const out = checkHotkeys({ picker: '^!p', clips: '^!p' });

  assert.equal(out.picker.state, 'good', 'первое назначение остаётся в силе');
  assert.equal(out.clips.state, 'bad');
  assert.match(out.clips.reason, /уже назначена/);
  assert.match(out.clips.reason, /picker/, 'названо действие, с которым конфликт');
});

test('дубль виден до попытки регистрации', () => {
  // Смысл проверки: конфликт обнаруживается в настройках, а не после перезапуска
  // моста, когда одна из клавиш просто перестанет работать (S-07, путь 2).
  const out = checkHotkeys({ picker: '^!p', clips: '^!P' });

  assert.equal(out.clips.state, 'bad', 'регистр записи не скрывает дубль');
});

test('три действия на одну комбинацию: конфликт назван у каждого лишнего', () => {
  const out = checkHotkeys({ a: '^!x', b: '^!x', c: '^!x' });

  assert.equal(out.a.state, 'good');
  assert.equal(out.b.state, 'bad');
  assert.equal(out.c.state, 'bad');
  assert.match(out.c.reason, /^та же комбинация/);
});

// ── формат ───────────────────────────────────────────────────────────────────

test('неверный формат — bad с причиной от разбора', () => {
  const out = checkHotkeys({ picker: 'p', clips: '^нажми', settings: '^^d' });

  assert.equal(out.picker.state, 'bad');
  assert.match(out.picker.reason, /модификатор/);
  assert.equal(out.clips.state, 'bad');
  assert.equal(out.settings.state, 'bad');
});

test('битая комбинация не занимает место в проверке дублей', () => {
  // Иначе неверная запись «съедала» бы комбинацию, и корректное назначение той же
  // клавиши другому действию выглядело бы дублем.
  const out = checkHotkeys({ picker: 'p', clips: '^!p' });

  assert.equal(out.picker.state, 'bad');
  assert.equal(out.clips.state, 'good');
});

// ── неназначенные ────────────────────────────────────────────────────────────

test('пустая комбинация — состояние none, а не ошибка', () => {
  const out = checkHotkeys({ picker: '^!p', clips: '' });

  assert.equal(out.clips.state, 'none');
  assert.equal(out.clips.reason, 'не назначена');
  assert.equal(out.clips.human, 'не назначена', 'в интерфейсе видно словами');
});

test('несколько пустых не конфликтуют между собой', () => {
  // Пустота — не значение, и два «не назначено» не дубль.
  const out = checkHotkeys({ a: '', b: '', c: '' });

  for (const k of ['a', 'b', 'c']) assert.equal(out[k].state, 'none', `${k}: ожидалось none`);
});

// ── полный набор ─────────────────────────────────────────────────────────────

test('рабочий набор проходит без замечаний', () => {
  const out = checkHotkeys(KEYS);

  for (const [action, info] of Object.entries(out)) {
    assert.equal(info.state, 'good', `${action}: ${info.reason}`);
    assert.equal(info.reason, null);
  }
});

test('каждое действие получает подпись для показа', () => {
  const out = checkHotkeys(KEYS);

  for (const [action, info] of Object.entries(out)) {
    assert.equal(info.human.includes('+'), true, `${action}: подпись должна читаться человеком`);
  }
});

test('пустой набор не роняет проверку', () => {
  assert.deepEqual(checkHotkeys({}), {});
  assert.deepEqual(checkHotkeys(), {});
});

// ── сводное состояние ────────────────────────────────────────────────────────

test('сводное состояние — худшее из частей', () => {
  // Зелёный значок при незарегистрированном хоткее — это ложь, из-за которой
  // человек будет думать, что клавиша работает (docs/RULES.md §4).
  assert.equal(worstState(checkHotkeys({ a: '^!p', b: '^!c' })), 'good');
  assert.equal(worstState(checkHotkeys({ a: '^!p', b: '^q' })), 'warn');
  assert.equal(worstState(checkHotkeys({ a: '^!p', b: 'мусор' })), 'bad');
  assert.equal(worstState(checkHotkeys({ a: '^q', b: 'мусор' })), 'bad', 'bad побеждает warn');
});

test('все неназначенные дают none: назначать нечего', () => {
  assert.equal(worstState(checkHotkeys({ a: '', b: '' })), 'none');
});

test('пустой набор — none, а не good', () => {
  // «Всё хорошо» при отсутствии клавиш было бы обещанием того, чего нет.
  assert.equal(worstState({}), 'none');
});

test('одна назначенная среди пустых даёт её состояние', () => {
  assert.equal(worstState(checkHotkeys({ a: '', b: '^!p' })), 'good');
});

// ── выход из конфликта ───────────────────────────────────────────────────────

test('после конфликта есть чем его заменить', () => {
  // Отказ без выхода бесполезен: человек должен получить готовые варианты.
  const busy = ['^q', '^+v'];
  const suggestions = suggestFree(busy, 3);

  assert.equal(suggestions.length, 3);

  const applied = checkHotkeys({ picker: suggestions[0].combo });
  assert.equal(applied.picker.state, 'good', 'предложенное обязано проходить проверку');
});

test('предложенное не конфликтует с уже назначенным набором', () => {
  const taken = Object.values(KEYS);

  for (const s of suggestFree(taken, 4)) {
    const out = checkHotkeys({ ...KEYS, extra: s.combo });
    assert.equal(out.extra.state, 'good', `${s.combo}: ${out.extra.reason}`);
  }
});
