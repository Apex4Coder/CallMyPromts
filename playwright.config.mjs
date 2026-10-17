// playwright.config.mjs — конфигурация E2E-прогона.
//
// Требование: REQ-TEST-E2E (docs/SPEC.md §11). Утверждения: docs/UI-SPEC.md §7.
//
// E2E запускаются скриптами, а не через MCP: прогон должен воспроизводиться
// одной командой и падать в CI, а не зависеть от того, что кто-то откроет
// браузер руками.
//
// Сервер поднимает не Playwright, а каждый файл спек: у окна выбора, журнала и
// управления разные фикстуры библиотеки, и общий `webServer` заставил бы их
// делить одну папку промптов. Тесты, делящие данные, ломаются по очереди и не
// говорят, кто именно виноват.
//
// Отсюда `webServer` не используется намеренно. Вместо него tests/e2e/deck.mjs
// стартует сервер на свободном порту во временном корне и отдаёт адрес.

import { defineConfig, devices } from '@playwright/test';

/** Один браузер: интерфейс локальный, кросс-браузерность не требование. */
const CHROME = {
  ...devices['Desktop Chrome'],
  // Буфер обмена в Chromium требует разрешения. Без него `navigator.clipboard`
  // бросает, и запасной путь через скрытое поле проверялся бы вместо основного.
  permissions: ['clipboard-read', 'clipboard-write'],
};

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.mjs',

  // Полностью параллельно нельзя: каждый файл держит свой сервер и свою папку
  // состояния, но внутри файла порядок важен — окно выбора помнит выделение.
  fullyParallel: false,
  workers: 2,

  // Повторов нет: тест, который проходит со второй попытки, скрывает гонку.
  // Гонку надо чинить, а не пересдавать (docs/RULES.md §4).
  retries: 0,
  forbidOnly: true,

  timeout: 15000,
  expect: {
    // REQ-UI-SPEED требует ≤200 мс до появления окна; ожидание в 4 секунды
    // оставляет запас на старт сервера, но не прячет медленный интерфейс.
    timeout: 4000,
  },

  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/e2e.json' }],
  ],

  // baseURL не задан намеренно: адрес даёт tests/e2e/deck.mjs, порт у каждого
  // файла свой. Поле именно ОТСУТСТВУЕТ, а не равно null — Playwright проверяет
  // тип и на `null` отвечает «expected string, got object», потому что в
  // JavaScript `typeof null === 'object'».
  use: {
    ...CHROME,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },

  projects: [{ name: 'deck', use: CHROME }],
});
