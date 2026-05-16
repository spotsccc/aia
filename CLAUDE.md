# AIA — заметки для Claude

Personal AI assistant: долгоживущий локальный daemon (`aiad`), TUI-клиент (`aia`),
плагинные каналы (Telegram, …). Полная архитектура — в [`docs/arch.md`](docs/arch.md);
этот файл — короткая шпаргалка, не замена. При расхождении приоритет у `arch.md`.

## Стек

- TypeScript, Node ≥ 22 (ESM, `"type": "module"`, `module: "NodeNext"`).
- Менеджер пакетов: **pnpm@10** workspaces. Оркестратор: **turbo**.
- Линтер: **oxlint** (не eslint). Форматтер: **oxfmt** (не prettier). Тесты: **vitest**.
- Agent runtime: Vercel AI SDK (`ai`) + Zod. LLM в MVP — ChatGPT subscription через OAuth.
- IPC: JSON-RPC 2.0 поверх Unix domain socket / stdio, LSP-style framing
  (`Content-Length: N\r\n\r\n<json>`).
- Хранилище: SQLite через `better-sqlite3` (sync API, WAL).
- TUI: Ink. Telegram: grammY.

## Раскладка репозитория

Текущее состояние — **отличается** от черновика в `arch.md §10`: используется
`apps/` + `packages/`, а не только `packages/`.

```
aia/
  apps/
    daemon/           # @aia/daemon (bin: aiad)  — пока только index + info
    cli/              # @aia/cli (bin: aia)      — ещё не создан
  packages/           # @aia/rpc, @aia/types, @aia/channel-sdk,
                      # @aia/channel-telegram, @aia/provider-chatgpt — ещё не созданы
  docs/
    arch.md           # источник правды по архитектуре
    research/
      chatgpt-auth.md # детали OAuth-флоу против chatgpt.com
```

Новый пакет — это `packages/<name>/` (либо `apps/<name>/` для исполняемых) с
собственными `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`.
Шаблон — `apps/daemon/`.

## Команды

С корня (через turbo, обходит весь workspace):

```
pnpm build          # tsc per-package
pnpm dev            # watch-режимы
pnpm test           # vitest run
pnpm typecheck      # tsc --noEmit
pnpm lint           # oxlint
pnpm lint:fix       # oxlint --fix
pnpm format         # oxfmt
pnpm format:check   # oxfmt --check
pnpm check          # typecheck + test + lint + format:check
pnpm clean
```

В отдельном пакете — те же скрипты без turbo (`pnpm --filter @aia/daemon test`).

## TS-конвенции

- `tsconfig.base.json` уже строгий: `strict`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `noImplicitOverride`, `noUnusedLocals/Parameters`.
  Не ослабляй без причины.
- ESM + NodeNext ⇒ **импорты внутри пакета пишутся с `.js`**:
  `import { x } from './info.js';` — даже когда исходник `.ts`. Не забывай.
- `verbatimModuleSyntax` ⇒ типы импортируем явным `import type { ... }`.
- Сборка: `tsconfig.build.json` с `rootDir: src` / `outDir: dist`, исключает
  `*.test.ts`. `tsconfig.json` — `noEmit: true` для редактора/typecheck.
- Тесты колоцированы: `src/**/*.test.ts`.
- Ширина строки 100 (`.editorconfig`, `oxfmt`), single quotes, trailing commas.

## Архитектурные инварианты (легко сломать случайно)

Подробности — в `arch.md`; здесь только то, что должно срабатывать на уровне рефлекса.

- **Anti-corruption layer для сессий.** Внутри системы сессия — это только `id`
  (ULID). Никаких `channelId`/`chatKey` в `sessions`, `messages`, `tool_calls`,
  agent runtime или registry. Привязка к внешнему чату живёт **только** в таблице
  `external_channel_bindings`. Channel plugin host резолвит binding → отдаёт
  `sessionId` дальше. (§5.3, §5.7)
- **Public vs private config — разные файлы**, не флаг в одном. Агент пишет
  только в `public.toml` через `config.write_public`. `private.toml` и
  `auth.json` агенту недоступны даже на чтение значений; видны только имена
  ключей. (§5.6, §8)
- **OAuth-токены ChatGPT — в `~/.local/share/aia/auth.json`**, не в
  `private.toml`. Refresh — фоновая задача daemon-а. (§5.8.2)
- **Per-session async mutex обязателен.** Два сообщения подряд в один чат
  ⇒ два turn-а параллельно ⇒ гонка в истории и стримах. Сериализуй turn-ы
  внутри сессии; между сессиями параллелизм сохраняется. (§5.3)
- **История из SQLite не кэшируется.** Каждый turn читает заново —
  это устраняет рассинхрон. Не добавляй "оптимизационный" in-memory кэш. (§5.3)
- **Tools — Zod-схема параметров обязательна** (AI SDK требует). Capability-теги
  (`mutating`, `network`, `config_write`) хранятся для логов/admin TUI;
  **подтверждения перед вызовом tool в MVP не реализуем** — это сознательное
  упрощение. RPC-hook под него зарезервирован, но не имплементирован. (§5.5, §12)
- **LSP-framing шарится** между client↔daemon и daemon↔plugin — это один пакет
  `@aia/rpc`. Не дублируй.
- **Provider Registry — модель = строка `"<providerId>/<modelId>"`** (например
  `"chatgpt/gpt-5-codex"`). Не хардкодь провайдер в agent runtime. (§5.8.1)

## Скоуп MVP — чего НЕ делаем

Помечено `[v2]` в `arch.md`. Не тащи это вперёд:

- MCP (клиент или сервер).
- Подтверждение tool calls по capability-тегам.
- Multi-user, ACL, шеринг сессий.
- Веб-UI, удалённый доступ.
- RAG, векторные хранилища, долгосрочная семантическая память.
- Дополнительные провайдеры (Anthropic, OpenAI API key, Ollama).
- Webhook для Telegram (только long polling).
- Sub-agents и параллельные tool calls в одной сессии.

## Прочее

- `[ASSUMPTION]` в `arch.md` — допущения, которые **нужно** пересмотреть при
  первой имплементации соответствующего куска (pnpm, grammY, vitest, 30m TTL,
  layout, миграции, plugin discovery, Windows).
- При работе над auth/OAuth-флоу читай [`docs/research/chatgpt-auth.md`](docs/research/chatgpt-auth.md)
  — там зафиксированы конкретные endpoints, заголовки, `client_id`, callback-порт.
- Single-owner threat model: сокет `0600`, права на файл = аутентификация.
  Не добавляй псевдо-multi-user обвязку.
- Репозиторий ещё пустой по коммитам — большинство пакетов из `arch.md §10` пока
  не созданы. Это нормально; создавай по мере необходимости от текущей задачи.
