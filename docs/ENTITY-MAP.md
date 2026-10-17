# ENTITY-MAP — карта сущностей, связей и удара

> Статус: **действует с 2026-09-05**. Версия 1.0.
> Границы модулей: [`arch.yaml`](arch.yaml:1). Требования: [`docs/SPEC.md`](docs/SPEC.md:1).
> Назначение: до правки знать, что сломается. Половина провалов — ошибка локализации,
> а не ошибка кода.

## 1. Сущности

Сущность — то, что имеет собственную схему, живёт в конкретном месте и у чего есть
владелец-модуль. Всё остальное — производное представление.

| Сущность | Где живёт | Владелец | Схема | Кто изменяет |
|---|---|---|---|---|
| **Промпт** | `prompts/<group>/<id>.md` | `library` | [`DATA-CONTRACTS §1`](docs/DATA-CONTRACTS.md:1) | человек (текст), программа (`used`, `last_used`) |
| **Группа** | папка внутри `prompts/` | `library` | имя = `^[a-z][a-z0-9-]{1,23}$` | человек |
| **Запись буфера** | таблица `clips` в `state/clipboard.db` | `clipboard` | [`§2`](docs/DATA-CONTRACTS.md:1) | только программа |
| **Настройки** | `state/settings.json` | `contracts` | [`§3`](docs/DATA-CONTRACTS.md:1) | человек через интерфейс |
| **Состояние сервиса** | `state/runtime.json` | `bridge` | [`§4`](docs/DATA-CONTRACTS.md:1) | только программа |
| **Токен** | `state/token` | `server` | 32 hex | программа, один раз |
| **Привязка клавиши** | `settings.hotkeys` + `runtime.hotkeys` | `bridge` | [`§3.1`](docs/DATA-CONTRACTS.md:1), [`§4`](docs/DATA-CONTRACTS.md:1) | человек задаёт, программа проверяет |

### 1.1 Производные представления

Не сущности. Их нельзя править — они пересчитываются:

| Представление | Из чего считается | Модуль |
|---|---|---|
| порядок списка | `pin` + `used` + `last_used` | `rank` |
| температура | `last_used` и `used` | `rank` |
| бейдж счётчика | `used` | `rank` |
| результат поиска | `title` + `group` + `body` | `rank` |
| светофор сервиса | `runtime.json` | `ui` |
| `preview` записи | `text` | `clipboard` |

Правка производного значения — ошибка проектирования. Именно так возник дефект
«`used: 0` у всех 26 промптов»: поле требовало ручного заполнения и не заполнялось.

## 2. Граф модулей

```
                         ┌──────────────┐
                         │  contracts   │  domain, зависимостей нет
                         │  схемы+YAML  │
                         └──┬────┬───┬──┘
              ┌─────────────┘    │   └──────────────┐
              ▼                  ▼                  ▼
        ┌───────────┐     ┌────────────┐      ┌──────────┐
        │  library  │     │ clipboard  │      │  bridge  │  adapters
        │  .md      │     │  SQLite    │      │  AHK+трей│
        └─────┬─────┘     └──────┬─────┘      └────┬─────┘
              └────────┬─────────┘                 │
                       ▼                           │
                 ┌──────────┐                      │
                 │   rank   │  app                 │
                 └────┬─────┘                      │
                      ▼                            │
                 ┌──────────┐                      │
                 │  server  │  adapters            │
                 └────┬─────┘                      │
                      │  HTTP + токен              │  хоткеи, буфер, вставка
                      ▼                            ▼
                 ┌──────────┐                 ┌─────────┐
                 │    ui    │  данных не      │   ОС    │
                 │ 3 макета │  видит напрямую │ Windows │
                 └──────────┘                 └─────────┘

        gates ──► читает contracts и arch.yaml, ничего не изменяет
        tests ──► видит все публичные барьеры
        legacy ─► только чтение, из пайплайна выведен
```

Цикл отсутствует: связи направлены строго вниз-вправо. Проверяет
`gates/arch-check.mjs`.

### 2.1 Почему `ui` не зависит ни от кого

`ui` получает данные только через HTTP от `server`. Это дороже прямого импорта, но
даёт три вещи: интерфейс тестируется Playwright против живого API, макеты меняются без
касания логики, а браузер физически не имеет доступа к файлам.

### 2.2 Почему `bridge` зависит только от `contracts`

`bridge` работает с ОС: клавиши, буфер, трей. Он не знает про промпты и записи — он
дёргает `server` по HTTP. Если бы `bridge` импортировал `library`, вставка промпта
перестала бы работать при остановленном сервере, и причина была бы неочевидна.

## 3. Матрица связок: требование → модуль → файл → тест

| Требование | Модуль | Файл | Тест |
|---|---|---|---|
| REQ-CT-YAML | contracts | `contracts/yaml.mjs` | `tests/unit/yaml.test.mjs` |
| REQ-CT-PROMPT | contracts | `contracts/prompt.mjs` | `tests/unit/prompt-schema.test.mjs` |
| REQ-CT-CLIP | contracts | `contracts/clip.mjs` | `tests/unit/clip-schema.test.mjs` |
| REQ-CT-SETTINGS | contracts | `contracts/settings.mjs` | `tests/unit/settings.test.mjs` |
| REQ-LIB-READ | library | `library/read.mjs` | `tests/unit/library-read.test.mjs` |
| REQ-LIB-WRITE | library | `library/write.mjs` | `tests/unit/library-write.test.mjs` |
| REQ-LIB-GROUP | library | `library/groups.mjs` | `tests/unit/library-groups.test.mjs` |
| REQ-LIB-SAFE | library | `library/write.mjs` | `tests/unit/library-safe.test.mjs` |
| REQ-LIB-CLEAN | library | `library/clean.mjs` | `tests/unit/library-clean.test.mjs` |
| REQ-LIB-ISOLATE | library | `library/read.mjs` | `tests/unit/library-isolate.test.mjs` |
| REQ-CLIP-LOG | clipboard | `clipboard/store.mjs` | `tests/unit/clip-store.test.mjs` |
| REQ-CLIP-CAP | clipboard | `clipboard/store.mjs` | `tests/unit/clip-cap.test.mjs` |
| REQ-CLIP-DEDUP | clipboard | `clipboard/store.mjs` | `tests/unit/clip-dedup.test.mjs` |
| REQ-CLIP-KIND | clipboard | `clipboard/kind.mjs` | `tests/unit/clip-kind.test.mjs` |
| REQ-CLIP-PRIVACY | clipboard | `clipboard/privacy.mjs` | `tests/unit/clip-privacy.test.mjs` |
| REQ-CLIP-PROMOTE | clipboard | `clipboard/promote.mjs` | `tests/integration/promote.test.mjs` |
| REQ-RANK-ORDER | rank | `rank/order.mjs` | `tests/unit/rank-order.test.mjs` |
| REQ-RANK-SEARCH | rank | `rank/search.mjs` | `tests/unit/rank-search.test.mjs` |
| REQ-RANK-USE | rank | `rank/usage.mjs` | `tests/unit/rank-usage.test.mjs` |
| REQ-RANK-TEMP | rank | `rank/temperature.mjs` | `tests/unit/rank-temp.test.mjs` |
| REQ-API-* | server | `server/routes.mjs` | `tests/integration/api.test.mjs` |
| REQ-API-AUTH | server | `server/auth.mjs` | `tests/integration/api-auth.test.mjs` |
| REQ-UI-* | ui | `ui/index.html`, `ui/views/*` | `tests/e2e/*.spec.mjs` |
| REQ-KEY-* | bridge | `bridge/hotkeys.mjs`, `bridge/deck.ahk` | `tests/unit/bridge-keys.test.mjs` |
| REQ-SVC-* | bridge | `bridge/service.mjs` | `tests/unit/bridge-service.test.mjs` |
| REQ-GATE-* | gates | `gates/*.mjs` | `tests/unit/gates.test.mjs` |
| REQ-MIG-* | legacy | `legacy/migrate.mjs` | `tests/unit/migrate.test.mjs` |

Машинно-читаемая версия — [`trace.csv`](trace.csv:1). Расхождение между таблицей и
файлами роняет `gates/trace-check.mjs`.

## 4. Карта удара

Что сломается при изменении каждой сущности. Строится **до** правки.

### 4.1 Изменение схемы промпта

```
contracts/prompt.mjs
   ├─► library/read.mjs      разбор frontmatter
   ├─► library/write.mjs     запись полей
   ├─► rank/order.mjs        читает pin, used
   ├─► rank/temperature.mjs  читает last_used
   ├─► server/routes.mjs     форма ответа API
   ├─► ui/views/list.js      отображение бейджей
   └─► ВСЕ 26 файлов .md     возможна миграция формата

Радиус: 6 модулей + данные пользователя.  Требует: миграция + резервная копия.
```

### 4.2 Изменение схемы SQLite

```
contracts/clip.mjs
   ├─► clipboard/store.mjs   запросы
   ├─► clipboard/promote.mjs чтение полей
   ├─► server/routes.mjs     форма ответа
   ├─► ui/views/clips.js     отображение
   └─► state/clipboard.db    ТРЕБУЕТСЯ МИГРАЦИЯ

Радиус: 4 модуля.  Обязательно: bump schema_version в таблице meta.
```

### 4.3 Изменение раскладки интерфейса

```
ui/views/*.js + ui/styles/*.css
   └─► tests/e2e/*.spec.mjs  DOM-id — контракт

Радиус: только ui + тесты. Логика не затронута.
Это следствие §2.1: интерфейс отделён барьером HTTP.
```

### 4.4 Изменение хоткея

```
settings.hotkeys
   ├─► bridge/hotkeys.mjs    перерегистрация
   ├─► bridge/deck.ahk       перегенерация файла
   ├─► runtime.json          обновление state и reason
   └─► ui/views/settings.js  отображение конфликта

Радиус: 2 модуля.  Побочный эффект: перезапуск AHK-процесса.
```

### 4.5 Изменение arch.yaml

```
arch.yaml
   └─► gates/arch-check.mjs  меняется вердикт гейта

Радиус: гейт. Опасность: подгонка карты под код вместо исправления кода.
Правило из RULES §1: карта НЕ подгоняется под код.
```

## 5. Центр тяжести

Модули, затрагиваемые чаще всего при изменениях. Требуют самых плотных тестов:

| Модуль | Входящих связей | Почему критичен |
|---|---|---|
`contracts` | 6 | от него зависят все; ошибка схемы = ошибка везде |
`library` | 3 | владеет пользовательскими данными; ошибка = потеря текста |
`server` | 2 | единственная дверь для `ui`; ошибка = мёртвый интерфейс |
`clipboard` | 3 | содержит приватные данные; ошибка = утечка |

Отсюда порядок реализации: `contracts` → `library` → `clipboard` → `rank` → `server`
→ `ui` → `bridge`. Это тактика «корень → дерево → листья» из
[`RULES §2`](docs/RULES.md:1), применённая к конкретному графу.

## 6. Границы, которые нельзя пересекать

| Запрещено | Почему | Ловит |
|---|---|---|
`ui` импортирует `library` или `clipboard` | интерфейс получит доступ к файлам, тесты перестанут быть независимыми | `arch-check` |
`bridge` импортирует `library` | вставка сломается при остановленном сервере, причина будет неочевидна | `arch-check` |
`library` импортирует `rank` | инверсия слоёв: данные не должны знать про порядок отображения | `arch-check` |
`contracts` импортирует что-либо | корень графа обязан быть без зависимостей | `arch-check` |
импорт мимо `index.mjs` | барьер перестаёт быть барьером | `arch-check` |
второй парсер YAML | два мнения о формате | ревью + `RULES §1` |
запись в `prompts/` из `clipboard` напрямую | владелец промптов один — `library` | `arch-check` |

## 7. Инварианты графа

1. `contracts.may_depend_on` пуст — иначе появится цикл через любой модуль.
2. `ui.may_depend_on` пуст — интерфейс общается только по HTTP.
3. Путь от `ui` до `library` проходит **только** через `server`.
4. `legacy` не имеет исходящих связей — он выведен из пайплайна и не может влиять.
5. `gates` не изменяет ничего, кроме baseline-файлов.
