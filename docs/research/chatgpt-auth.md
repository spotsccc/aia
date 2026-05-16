# Research: ChatGPT subscription auth + inference

> Внутренний документ. Описывает, как Codex CLI (openai/codex), opencode и
> openclaw авторизуются через подписку ChatGPT и ходят в endpoint
> `chatgpt.com/backend-api/codex/responses` за инференсом, биллингуемым против
> подписки, а не против API-ключа.
>
> Источники — публичные репозитории и публикации. Никакого reverse-engineering
> по живым ответам OpenAI здесь нет, только сводка того, что эти проекты уже
> раскрыли в коде.

**Дата сбора:** 2026-05.
**Цель:** дать конкретику для реализации `@aia/provider-chatgpt`
(см. `docs/arch.md` §5.8).

---

## 1. Сводка

| Параметр | Значение | Источник |
|---|---|---|
| OAuth issuer | `https://auth.openai.com` | `openai/codex` `codex-rs/login/src/server.rs` |
| Authorization URL | `https://auth.openai.com/oauth/authorize` | то же |
| Token URL | `https://auth.openai.com/oauth/token` | то же |
| `client_id` | `app_EMoamEEZ73f0CkXaXp7hrann` | `openai/codex` `codex-rs/login/src/auth/manager.rs`; подтверждено `EvanZhouDev/openai-oauth` |
| Scopes | `openid profile email offline_access api.connectors.read api.connectors.invoke` | `openai/codex` `codex-rs/login/src/server.rs` |
| Redirect URI | `http://localhost:1455/auth/callback` (fallback `1457`) | то же |
| PKCE | S256; verifier — 64 байта rand → base64url no padding (86 chars) | `openai/codex` `codex-rs/login/src/pkce.rs` |
| Inference base URL | `https://chatgpt.com/backend-api/codex` | `openai/codex` `codex-rs/core/src/client.rs`; `EvanZhouDev/openai-oauth` `transport.ts` |
| Inference path | `/responses` (Responses API) | то же; подтверждено write-up Simon Willison |
| Required headers | `Authorization: Bearer <access_token>`, `chatgpt-account-id: <account_id>`, `OpenAI-Beta: responses=experimental` | `EvanZhouDev/openai-oauth` `transport.ts` |
| Token storage | `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`), chmod `0o600`; либо OS keychain (service `Codex Auth`) | `openai/codex` `codex-rs/login/src/auth/storage.rs` |
| Refresh trigger | access expired OR `last_refresh > 8 days ago` | `openai/codex` `codex-rs/login/src/auth/manager.rs` |
| Refresh rotation | RT может ротироваться (response.refresh_token optional, заменяет если пришёл) | то же |

---

## 2. OAuth-флоу — точные параметры

### 2.1 Запрос на `/oauth/authorize`

```
GET https://auth.openai.com/oauth/authorize?
    response_type=code
    &client_id=app_EMoamEEZ73f0CkXaXp7hrann
    &redirect_uri=http://localhost:1455/auth/callback
    &scope=openid profile email offline_access api.connectors.read api.connectors.invoke
    &code_challenge=<base64url(SHA256(verifier))>
    &code_challenge_method=S256
    &id_token_add_organizations=true
    &codex_cli_simplified_flow=true
    &state=<random>
    &originator=<client_originator_value>
```

Источник: `openai/codex` `codex-rs/login/src/server.rs`, цитата:

```rust
vec![
    ("response_type", "code"),
    ("client_id", client_id),
    ("redirect_uri", "http://localhost:{port}/auth/callback"),
    ("scope", "openid profile email offline_access api.connectors.read api.connectors.invoke"),
    ("code_challenge", pkce.code_challenge),
    ("code_challenge_method", "S256"),
    ("id_token_add_organizations", "true"),
    ("codex_cli_simplified_flow", "true"),
    ("state", state),
    ("originator", originator().value),
]
```

Константы портов: `DEFAULT_PORT = 1455`, `FALLBACK_PORT = 1457`.

### 2.2 PKCE

```rust
// codex-rs/login/src/pkce.rs
let mut bytes = [0u8; 64];
rand::rng().fill_bytes(&mut bytes);
let code_verifier = URL_SAFE_NO_PAD.encode(&bytes);     // 86 chars
let digest = Sha256::digest(code_verifier.as_bytes());
let code_challenge = URL_SAFE_NO_PAD.encode(digest);
```

### 2.3 Обмен code → token

```
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<authorization_code>
&redirect_uri=http://localhost:<port>/auth/callback
&client_id=app_EMoamEEZ73f0CkXaXp7hrann
&code_verifier=<verifier>
```

Ответ — JSON с `id_token` (JWT), `access_token`, `refresh_token`.
ID-token подписан на `https://api.openai.com/auth`; в claims под
namespaced ключами `https://api.openai.com/profile` и
`https://api.openai.com/auth` лежат email, plan_type, account_id.

### 2.4 Refresh

```
POST https://auth.openai.com/oauth/token
Content-Type: application/json

{
  "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
  "grant_type": "refresh_token",
  "refresh_token": "<current_refresh>"
}
```

Ответ:

```rust
struct RefreshResponse {
    id_token:      Option<String>,
    access_token:  Option<String>,
    refresh_token: Option<String>,
}
```

Семантика: новый `refresh_token` опционален; если пришёл — заменяет
старый, иначе старый продолжает работать. Триггеры refresh:

- `access_token` истёк (по `exp` JWT-claim);
- ИЛИ `last_refresh < now - 8 дней` (проактивно, даже если access ещё валиден).

Конкурентность — `Semaphore` в `AuthManager.refresh_lock`.

### 2.5 Headless / device-code flow

Альтернативный поток (`codex-rs/login/src/device_code_auth.rs`):
браузер на любой машине, OpenAI-hosted страница, показывает короткий код,
привязанный к `state`. CLI обменивает код + `code_verifier` на токены
без локального callback-сервера. Полезно для SSH/Docker. Для нашего
MVP — `[v2]`.

---

## 3. Inference: endpoint и заголовки

### 3.1 Endpoint

```
POST https://chatgpt.com/backend-api/codex/responses
```

Это OpenAI **Responses API** (новее, чем `/v1/chat/completions`), но
проксируемый через ChatGPT backend, чтобы оплата шла со счёта подписки.

Транспорт: HTTP/2 + Server-Sent Events для стрима. Codex CLI пробует
WebSocket по флагу `OpenAI-Beta: responses_websockets=2026-02-06`, но
в MVP можно ограничиться SSE.

### 3.2 Обязательные HTTP-заголовки

Из `EvanZhouDev/openai-oauth` `packages/openai-oauth-core/src/transport.ts`:

```typescript
headers["Authorization"]      = `Bearer ${auth.accessToken}`;
headers["chatgpt-account-id"] = auth.accountId;
headers["OpenAI-Beta"]        = "responses=experimental";
```

`auth.accountId` берётся из JWT-claims `id_token` (под ключом
`https://api.openai.com/auth`, поле `chatgpt_account_id`/`account_id`).
Структура клейма зафиксирована в `codex-rs/login/src/token_data.rs`
как `IdTokenInfo`.

### 3.3 Опциональные заголовки Codex

`openai/codex` `codex-rs/core/src/client.rs` ставит ещё:

- `x-codex-installation-id` — UUID, генерируется при первом логине.
- `x-codex-turn-state` — sticky-routing токен (приходит в первом ответе,
  возвращается в следующих запросах в той же сессии).
- `x-codex-turn-metadata`, `x-codex-window-id`, `x-codex-parent-thread-id`,
  `x-openai-subagent`, `x-openai-memgen-request`,
  `x-responsesapi-include-timing-metrics`.

**Что важно для MVP `@aia/provider-chatgpt`**: первые три (auth, account-id,
beta) обязательны. `installation-id` и `turn-state` стоит реализовать
сразу, чтобы выглядеть для backend-а как обычный Codex-клиент и не
ловить нестандартные блокировки. Остальные — опционально, добавляем по
необходимости.

### 3.4 Тело запроса

Формат — стандартный Responses API:

```json
{
  "model": "gpt-5-codex",
  "instructions": "<system prompt>",
  "input": [
    { "role": "user", "content": [{ "type": "input_text", "text": "..." }] }
  ],
  "tools": [
    {
      "type": "function",
      "name": "...",
      "description": "...",
      "parameters": { "type": "object", "properties": {...}, "required": [...] }
    }
  ],
  "parallel_tool_calls": true,
  "reasoning": { "effort": "medium", "summary": "auto" },
  "stream": true,
  "store": false
}
```

Особенности подписочного endpoint:
- `instructions` валидируется строго; пустая строка вызывает ошибку
  `"Instructions are not valid"`.
- Поле `max_output_tokens` запрещено — `EvanZhouDev/openai-oauth`
  явно удаляет его перед отправкой.
- `store: false` — типичный default, потому что на подписочном endpoint
  логирование чувствительно (Codex по умолчанию не хранит).

### 3.5 Стриминг

SSE-события, маршрутизируемые в `ResponseEvent` (имена из
`codex-rs/core/src/client.rs`):

- `response.created` — старт turn-а;
- `response.output_text.delta` — кусок ответа;
- `response.output_item.added` / `response.output_item.done` — start/finish
  одного output-item (текст, function_call, и т.п.);
- `response.function_call.arguments.delta` — streaming аргументов tool-call;
- `response.completed` — финал, в payload `response_id` + token usage.

### 3.6 Tool-use (function calling)

В ответе модели tool call приходит как output item:

```json
{
  "type": "function_call",
  "id": "fc_abc...",
  "call_id": "call_abc...",
  "name": "create_note",
  "arguments": "{\"title\":\"...\",\"body\":\"...\"}",
  "status": "completed"
}
```

Результат tool-а возвращается следующим turn-ом в `input` как:

```json
{
  "type": "function_call_output",
  "call_id": "call_abc...",
  "output": "<json string OR plain text>"
}
```

Это формат Responses API один-в-один — никаких подписочно-специфичных
расширений.

---

## 4. Хранение credentials

### 4.1 `auth.json`

Путь по умолчанию: `~/.codex/auth.json`. `$CODEX_HOME` — env override
этого каталога. Разрешения файла: `0o600` (Unix), создаётся через
`OpenOptionsExt::mode(0o600)`.

Структура (`codex-rs/login/src/auth/storage.rs`):

```rust
struct AuthDotJson {
    auth_mode: Option<AuthMode>,         // "ChatGPT" | "ApiKey" | ...
    OPENAI_API_KEY: Option<String>,      // только в ApiKey-режиме
    tokens: Option<TokenData>,
    last_refresh: Option<DateTime<Utc>>, // UTC timestamp
    agent_identity: Option<String>,
}

struct TokenData {
    id_token:     IdTokenInfo,           // парсенный JWT
    access_token: String,
    refresh_token: String,
    account_id:   Option<String>,
}
```

### 4.2 OS keyring (опционально)

Codex по умолчанию (`auto` mode) сначала пробует OS keyring:

- Service name: `"Codex Auth"`.
- Key: `cli|<sha256(canonical(codex_home))[..16]>`.
- Если keyring fails — fallback на `auth.json`.

Режимы:
- `auto` — keyring → file fallback;
- `keyring` — keyring only, файл `auth.json` удаляется при save;
- `file` — только файл;
- `ephemeral` — только в памяти (для тестов).

### 4.3 Решение для AIA

Для MVP `@aia/provider-chatgpt`:

- **Не** переиспользуем `~/.codex/auth.json` — это нарушит изоляцию
  и Codex может перезаписать наши токены своими.
- Свой файл: `~/.local/share/aia/auth.json`, chmod 600, своя структура
  (см. `arch.md` §5.8.2).
- Keyring — `[v2]`. В MVP только файл.
- При логине пользователь может уже быть залогинен в Codex CLI;
  предложим импорт `aia auth import-codex` — прочитаем `~/.codex/auth.json`
  и скопируем `tokens` в наш формат. Это удобно для пользователя и не
  требует второго прохода OAuth.

---

## 5. Rate limits / квоты

Здесь данных меньше всего.

- Стандартные `X-RateLimit-*` заголовки (как у `api.openai.com`) на
  `chatgpt.com/backend-api` **не приходят** — это управляемый endpoint
  с подписочной квотой.
- `chatgpt.com/backend-api/wham/usage` — endpoint, к которому Codex CLI
  ходит для отображения «осталось X запросов до сброса» (см. issue
  `openai/codex#10869`). Формат ответа в исходниках не описан, нужно
  поднять при первой реализации эмпирически.
- 429 ожидаем с `Retry-After` header-ом и JSON-body вида
  `{ "error": { "message": "...", "code": "rate_limit_exceeded" } }`.
  Дополнительно: ошибки превышения дневной квоты могут возвращать
  отдельный `code` (например, `usage_limit_reached`).

**Стратегия для MVP**: уважать `Retry-After` (если есть) либо exponential
backoff 1s→4s→16s максимум 3 раза, после — пробрасывать ошибку наверх
с понятным сообщением «лимит подписки исчерпан, попробуйте позже».
Опционально парсить `wham/usage` для status-команды (`aia auth status`).

---

## 6. Совместимость и риски

### 6.1 Юридическое / ToS

Использование подписки ChatGPT через `backend-api/codex/responses` из
**неофициального** клиента находится в серой зоне OpenAI ToS. Текущая
позиция в коммьюнити (на основе того, что opencode/openclaw публично
живут на GitHub):

- OpenAI явно поощряет использование Codex subscription из **Codex CLI**.
- Сторонние клиенты, имитирующие Codex (как `EvanZhouDev/openai-oauth`),
  существуют, но «по правилам» — пограничны.
- Возможные риски: ban аккаунта, изменение endpoint-а, требование
  новых заголовков.

Митигации:
1. Делать запросы максимально похожими на Codex CLI (User-Agent,
   `originator`, `installation-id`, beta-flag).
2. Не делать массовых/abusive запросов; уважать квоты.
3. В UI чётко сообщать пользователю, что он использует свою подписку
   на свой риск.
4. Параллельно иметь API-key fallback (`[v2]`) — если ChatGPT-канал
   ломается, пользователь может переключиться на `OPENAI_API_KEY`.

### 6.2 Технические

| Риск | Митигация |
|---|---|
| Endpoint URL меняется | Конфигурируется через env `AIA_CHATGPT_BASE_URL`; CI-тест бьющий по реальному endpoint раз в неделю |
| `client_id` ротируется | Лежит в коде как константа; обновим вручную, как только заметим |
| Формат Responses API эволюционирует | Изолируем парсинг SSE-событий в один модуль; добавим version negotiation через `OpenAI-Beta` |
| Refresh-token инвалидируется silently | Логировать каждый refresh; при 401 на refresh — переводить в state `re_login_required` и просить юзера `aia auth login chatgpt` |
| Keyring/file mode коллизия с Codex CLI | Свой каталог `~/.local/share/aia/`; не пишем в `~/.codex/` |

### 6.3 Открытые вопросы (для имплементации)

1. **`originator` value** — `codex-rs/login/src/server.rs` использует
   `originator().value`, но точное значение по умолчанию (вероятно,
   что-то вроде `"codex_cli"`) пока не нашли. Поведение на стороне
   OpenAI к нему чувствительно — нужно посмотреть в `originator.rs`.
2. **`installation-id`** — где генерится, persistent или нет? Скорее
   всего, в `~/.codex/installation-id` или внутри `auth.json`.
   Уточнить.
3. **WebSocket-транспорт** — стоит ли в MVP, или SSE достаточно?
   Рекомендация: SSE; WebSocket — `[v2]`.
4. **Reasoning summary в стриме** — Responses API стримит `reasoning`
   отдельно (`response.reasoning_summary.delta`). Нужно, чтобы Vercel
   AI SDK `LanguageModelV2` его пропускал в дельты, а не в основное
   текстовое поле.
5. **AI SDK adapter** — `LanguageModelV2` ожидает определённый формат;
   нужен mapping слой между нашим SSE-парсером и AI SDK
   stream-protocol. Возможно, проще взять `@ai-sdk/openai-compatible`
   (если он работает с Responses API) и просто подменить fetch.

---

## 7. План имплементации `@aia/provider-chatgpt`

Разбивка на инкременты (каждый — отдельный PR / коммит):

1. **OAuth flow + auth.json** — `aia auth login chatgpt`,
   `aia auth status`, `aia auth logout chatgpt`. Без инференса. Тесты:
   успешный login против моков `auth.openai.com`.
2. **Refresh loop** — фоновая задача в daemon-е, дёргает refresh за
   5 минут до expiry. Тесты: моки 401 на access → автоматический
   refresh → ретрай.
3. **Inference client (без tools)** — POST в `/responses`, SSE-парсер,
   маппинг в AI SDK `LanguageModelV2`. Тесты: моки SSE-стрима,
   проверка получения текста.
4. **Tools** — добавить tool definitions в request, парсить
   `function_call` items, отправлять `function_call_output` обратно.
5. **Reasoning + usage** — пробрасывать в стрим как метаданные.
6. **Error handling** — 401/429/500 пути, понятные сообщения.
7. **`aia auth import-codex`** — UX-фича, копирует токены из
   `~/.codex/auth.json` в наш формат.

Каждый инкремент можно мерджить независимо — provider регистрируется
в registry, но в config-е `agent.model` пользователь не сможет
выбрать `chatgpt/...` пока шаги 1-3 не готовы.

---

## 8. Источники

- **openai/codex** (Rust, official): https://github.com/openai/codex
  - `codex-rs/login/src/server.rs` — authorize URL, scopes, redirect.
  - `codex-rs/login/src/pkce.rs` — PKCE generation.
  - `codex-rs/login/src/token_data.rs` — token struct.
  - `codex-rs/login/src/auth/storage.rs` — auth.json path, keyring.
  - `codex-rs/login/src/auth/manager.rs` — refresh logic.
  - `codex-rs/core/src/client.rs` — inference client, headers, SSE events.
- **EvanZhouDev/openai-oauth**: https://github.com/EvanZhouDev/openai-oauth
  - `packages/openai-oauth-core/src/transport.ts` — точные значения
    Authorization / chatgpt-account-id / OpenAI-Beta headers.
- **openclaw/openclaw**: https://github.com/openclaw/openclaw
  - `docs/concepts/oauth.md` — концептуальное описание флоу, profile
    storage shape `{ access, refresh, expires, accountId }`.
- **opencode-openai-codex-auth (numman-ali)**:
  https://github.com/numman-ali/opencode-openai-codex-auth — пример
  плагин-обёртки для opencode (CLI-агент SST).
- **Simon Willison, "Reverse-engineering Codex CLI"** (2025-11):
  https://simonwillison.net/2025/Nov/9/gpt-5-codex-mini/ — debug-вывод
  тела запроса, подтверждает Responses API формат.
- **OpenAI Codex docs**: https://developers.openai.com/codex/auth и
  https://developers.openai.com/codex/cli — официальные параметры
  storage (`cli_auth_credentials_store`), упоминание `chatgptAccountId`.
- **OpenAI Codex issue #10869**: https://github.com/openai/codex/issues/10869
  — упоминание endpoint-а `chatgpt.com/backend-api/wham/usage` для
  отображения квот.
