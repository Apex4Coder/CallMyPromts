// tests/e2e/contrast.mjs — измерение контраста в браузере.
//
// Требование: REQ-UI-THEME (docs/SPEC.md §7). Утверждение U-2.
//
// Контраст считается по WCAG 2.1: относительная яркость с гамма-коррекцией,
// отношение (L1 + 0.05) / (L2 + 0.05). Порог 4.5:1 для текста и 3:1 для границ
// и элементов управления — те же числа, что в docs/UI-SPEC.md §6.
//
// Считается в браузере, а не по значениям из CSS-файла. Причина: реальный цвет
// зависит от темы, акцента и `color-mix`, и правильный ответ даёт только
// `getComputedStyle` на живой странице. Проверка «в файле написано #059669»
// доказывала бы, что файл написан так, как написан.
//
// Полупрозрачный фон складывается с родительским: плашки статусов сделаны через
// `color-mix(... 12%, transparent)`, и без наложения яркость считалась бы по
// прозрачному цвету, то есть по числу, которого человек не видит.

/** Функции, работающие внутри страницы. Вставляются как текст. */
const IN_PAGE = `
const parse = (css) => {
  const m = String(css).match(/-?[\\d.]+/g) ?? [];
  const [r, g, b] = m.map(Number);
  const a = m.length > 3 ? Number(m[3]) : 1;
  return { r: r ?? 0, g: g ?? 0, b: b ?? 0, a: Number.isFinite(a) ? a : 1 };
};

const over = (top, bottom) => ({
  r: top.r * top.a + bottom.r * (1 - top.a),
  g: top.g * top.a + bottom.g * (1 - top.a),
  b: top.b * top.a + bottom.b * (1 - top.a),
  a: 1,
});

const lum = ({ r, g, b }) => {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Фактический фон элемента: первый непрозрачный вверх по дереву. */
const backdrop = (el) => {
  let node = el.parentElement;
  const stack = [];
  while (node) {
    const bg = parse(getComputedStyle(node).backgroundColor);
    if (bg.a > 0) stack.push(bg);
    if (bg.a === 1) break;
    node = node.parentElement;
  }
  let base = stack.pop() ?? { r: 255, g: 255, b: 255, a: 1 };
  while (stack.length > 0) base = over(stack.pop(), base);
  return base;
};
`;

/**
 * Контраст текста, границы и фона плашки для каждого элемента по селектору.
 *
 * @returns {Promise<Array<{sel: string, text: number, border: number, fill: number,
 *   glyph: string, word: string}>>}
 */
export const measureContrast = (page, selectors) => page.evaluate(
  // eslint-disable-next-line no-new-func
  new Function('sels', `${IN_PAGE}
  const out = [];
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (!el) { out.push({ sel, missing: true }); continue; }
    const st = getComputedStyle(el);
    const base = backdrop(el);
    const fill = over(parse(st.backgroundColor), base);
    out.push({
      sel,
      text: Math.round(ratio(over(parse(st.color), fill), fill) * 100) / 100,
      border: Math.round(ratio(over(parse(st.borderTopColor), base), base) * 100) / 100,
      fill: Math.round(ratio(fill, base) * 100) / 100,
      glyph: el.querySelector('.glyph')?.textContent ?? '',
      word: el.querySelector('.word')?.textContent ?? '',
    });
  }
  return out;`),
  selectors,
);

/** Контраст цвета текста элемента к его фактическому фону. */
export const textContrast = (page, selector) => page.evaluate(
  // eslint-disable-next-line no-new-func
  new Function('sel', `${IN_PAGE}
  const el = document.querySelector(sel);
  if (!el) return null;
  const st = getComputedStyle(el);
  const base = backdrop(el);
  const fill = over(parse(st.backgroundColor), base);
  return Math.round(ratio(over(parse(st.color), fill), fill) * 100) / 100;`),
  selector,
);

/** Контраст границы элемента к фону под ним: рамка поля, кнопки, окна. */
export const borderContrast = (page, selector) => page.evaluate(
  // eslint-disable-next-line no-new-func
  new Function('sel', `${IN_PAGE}
  const el = document.querySelector(sel);
  if (!el) return null;
  const base = backdrop(el);
  return Math.round(ratio(over(parse(getComputedStyle(el).borderTopColor), base), base) * 100) / 100;`),
  selector,
);
