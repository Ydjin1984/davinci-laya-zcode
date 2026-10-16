# DaVinci × ZCode × Laya

Репозиторий интеграции: локальный decision-engine **Laya** (`127.0.0.1:8095`)
работает в точках контроля **ZCode** — гейт риска перед опасными вызовами,
проверка доказательств завершения, ранжирование контекста и явные
MCP-инструменты типизированных решений.

```
davinci-laya-zcode/
├── marketplace.json                        маркетплейс для ZCode (Settings → Add marketplace)
└── plugins/
    └── davinci-laya-decisions/             сам плагин
        ├── .zcode-plugin/plugin.json       манифест (hooks здесь НЕ дублируются)
        ├── .mcp.json                       stdio MCP-сервер
        ├── hooks/                          pre-tool / post-tool / stop / session-start / user-prompt
        ├── src/                            адаптер, политика, ledger, гейты, MCP, инструменты
        ├── skills/laya-decision-workflow/  навык для модели
        ├── commands/                       7 команд: laya-all, laya-status, laya-mode, laya-triage, laya-search, laya-review, laya-bench
        ├── scripts/                        laya-admin (status/mode/all/bench/review/doctor), laya-eval (калибровка)
        ├── tests/                          наборы: гейты, лаунчер, replay, контракт, MCP
        ├── docs/                           USAGE, ARCHITECTURE, CALIBRATION, ENGINE-API, AB-RESULTS
        └── README.md                       главный документ плагина
```

## Установка

### Со второго компьютера (из GitHub)

1. Добавить маркетплейс: **Settings → Plugin Management → Discover → «+» → GitHub repository**
   → `Ydjin1984/davinci-laya-zcode` (публичный репозиторий-маркетплейс).
2. Включить плагин **«DaVinci × Laya: локальные решения»**.
3. Убедиться, что движок Laya запущен на `127.0.0.1:8095` (без него плагин работает пассивно).
4. Начать **новую сессию** ZCode (команды, навык и MCP подхватываются при старте), при первом
   вызове MCP-инструмента разрешить доступ. Проверка: `/laya-status`.

**Требования:** Node.js ≥ 20; запущенный движок Laya на `127.0.0.1:8095`
(сам движок — репозиторий `{ENGINE}`: Windows / Linux / macOS / Docker,
скрипты установки и автозапуска включены). Лаунчер хуков
(`bin/laya-hook.exe`) в репозитории собран под Windows; на Linux/macOS он
собирается из исходника (`go build ./tools/hook-launcher`) скриптом установки
движка — `scripts/install-plugin.sh` — либо подменяется pass-through обёрткой
(чуть медленнее, поведение то же).

Без движка плагин работает в пассивном режиме (fail-open): ZCode продолжает
работать штатно, активные функции просто не включаются.

### Установка скриптом (Windows / Linux / macOS)

```bash
# из репозитория движка Ydjin1984/Laya-Engine:
./scripts/install-plugin.sh                                   # Linux/macOS
powershell -ExecutionPolicy Bypass -File scripts\windows\install-plugin.ps1   # Windows
```

Скрипт клонирует маркетплейс, раскладывает плагин в локальное рабочее
пространство ZCode (`~/.zcode/plugin-workspace/plugins/`), регистрирует его в
`marketplace.json` (с бэкапом) и печатает шаги включения.

### Локальная разработка (альтернативный маркетплейс)

Можно подключить клон репозитория отдельным локальным маркетплейсом:
Settings → Plugin Management → Add marketplace → путь к каталогу с
`marketplace.json` — плагин появится в списке Discover.

## Документация

| Документ | О чём |
|---|---|
| `plugins/davinci-laya-decisions/README.md` | состав, принципы, режимы, измеренные числа, безопасность |
| `plugins/davinci-laya-decisions/docs/USAGE.md` | как пользоваться: команды, инструменты, сценарии, диагностика |
| `plugins/davinci-laya-decisions/docs/ARCHITECTURE.md` | как устроено: поток решений, слои защиты, fail-open, состояние |
| `plugins/davinci-laya-decisions/docs/CALIBRATION.md` | как измерять: приёмка, FNR/FPR, экономия токенов, A/B, версии |
| `plugins/davinci-laya-decisions/docs/ENGINE-API.md` | изменения движка Laya и полный HTTP-контракт |
| `plugins/davinci-laya-decisions/docs/AB-RESULTS.md` | результаты замеров A/B: токены, время, точность, дисциплина применения |

## Состояние по этапам ТЗ

| Этап | Статус | Доказательство |
|---|---|---|
| 0 — Discovery | выполнен | фактический контракт движка — `/decide` (не Jev), три типа вопросов, чекпоинт `multilingual-fp16-0b095e005a4c` |
| 1 — Плагин + MCP, shadow | выполнен | наборы тестов (гейты, лаунчер, replay, контракт, MCP); RiskGate в shadow не меняет разрешения; при отсутствии Laya ZCode работает штатно |
| 2 — Проверка завершения и рисков | выполнен и в shadow/report | EvidenceLedger, DoneGate с одной блокировкой; режим `ask` готов и откалиброван (24/24 high-risk, FPR 0), включается осознанно |
| 3 — Контекст и экономия | инструменты готовы, замер A/B выполнен | большой лог: −48% токенов и −58% пика контекста против чтения целиком (26/26 ответов верны); правило окупаемости — в `/laya-all` и навыке; числа в `docs/AB-RESULTS.md` |
| 4 — Роутинг | только рекомендация | TaskRouter `log`/`advise`; модель не переключается — эта опция зависит от сборки ZCode |

## Лицензия

MIT (плагин). Модель Laya — Apache-2.0.
