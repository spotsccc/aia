# AIA - instructions for coding agents

This file is the short operational guide for Codex and other coding agents working in this
repository. It intentionally mirrors the project notes in `CLAUDE.md`; if these files diverge,
prefer `docs/arch.md` for architecture decisions and then update both short guides.

## Project shape

AIA is a personal AI assistant built around a long-running local daemon (`aiad`), a future TUI
client (`aia`), and pluggable channels such as Telegram.

Current workspace layout:

```text
aia/
  apps/
    daemon/           # @aia/daemon, bin: aiad
    cli/              # @aia/cli, future bin: aia
  packages/           # shared packages, created as needed
  docs/
    arch.md           # architecture source of truth
    research/
      chatgpt-auth.md # ChatGPT OAuth research notes
```

The current repository uses `apps/` and `packages/`, even if older architecture drafts mention a
different package-only layout. Create new libraries under `packages/<name>/`; create executable
apps under `apps/<name>/`. Use `apps/daemon/` as the nearest package template.

## Stack

- TypeScript, Node >= 22, ESM, `"type": "module"`, `module: "NodeNext"`.
- Package manager: `pnpm@10` workspaces. Task runner: Turborepo.
- Lint: `oxlint`. Format: `oxfmt`. Tests: `vitest`.
- Agent runtime: Vercel AI SDK (`ai`) plus Zod.
- IPC: JSON-RPC 2.0 over Unix domain socket or stdio with LSP-style framing:
  `Content-Length: N\r\n\r\n<json>`.
- Storage: SQLite via `better-sqlite3`, sync API, WAL.
- TUI: Ink. Telegram: grammY.

## Commands

Run these from the repository root unless a package-specific filter is more appropriate:

```sh
pnpm build
pnpm dev
pnpm test
pnpm typecheck
pnpm lint
pnpm lint:fix
pnpm format
pnpm format:check
pnpm check
pnpm clean
```

For one package, use the same scripts through filters, for example:

```sh
pnpm --filter @aia/daemon test
```

## TypeScript conventions

- Keep the strict base config intact: do not weaken `strict`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `noImplicitOverride`, or unused checks without a specific reason.
- With ESM and NodeNext, relative imports inside packages must use `.js` in source files:
  `import { x } from './info.js';`.
- Use `import type { ... }` for type-only imports.
- Package builds use `tsconfig.build.json` with `rootDir: src` and `outDir: dist`; tests are
  colocated as `src/**/*.test.ts` and excluded from build output.
- `tsconfig.json` is for editor and typecheck usage with `noEmit: true`.
- Formatting conventions: 100-column width, single quotes, trailing commas.

## Architecture invariants

Read `docs/arch.md` before changing architecture-sensitive code. These points are easy to break:

- Sessions are identified internally only by `id` (ULID). Do not put `channelId` or `chatKey` in
  `sessions`, `messages`, `tool_calls`, agent runtime, or registry.
- External chat bindings belong only in `external_channel_bindings`; the channel plugin host
  resolves bindings and passes `sessionId` onward.
- Public and private config are different files. Agents may write only `public.toml` through
  `config.write_public`; `private.toml` and `auth.json` values are not readable by agents.
- ChatGPT OAuth tokens live in `~/.local/share/aia/auth.json`, not in `private.toml`.
- Per-session async mutexes are required. Serialize turns within one session while keeping
  different sessions parallel.
- Do not cache SQLite conversation history in memory. Each turn reads history fresh from storage.
- Tools require Zod parameter schemas. Capability tags exist for logs/admin UI; MVP does not
  implement confirmation prompts before tool calls.
- LSP framing is shared between client-daemon and daemon-plugin communication in `@aia/rpc`.
  Do not duplicate framing implementations.
- Provider registry model IDs are strings shaped like `"<providerId>/<modelId>"`, for example
  `"chatgpt/gpt-5-codex"`. Do not hardcode one provider into agent runtime.

## MVP boundaries

Items marked `[v2]` in `docs/arch.md` stay out of the MVP unless the user explicitly changes scope:

- MCP client/server support.
- Tool-call confirmation by capability tag.
- Multi-user support, ACLs, or shared sessions.
- Web UI or remote access.
- RAG, vector stores, or long-term semantic memory.
- Providers beyond the ChatGPT subscription OAuth flow.
- Telegram webhooks; use long polling for MVP.
- Sub-agents or parallel tool calls within one session.

## Working rules

- Prefer existing local patterns and package boundaries over new abstractions.
- Keep edits scoped to the requested behavior. Do not refactor unrelated code while passing by.
- Do not revert or overwrite existing user changes in a dirty worktree.
- When changing OAuth/auth flow, read `docs/research/chatgpt-auth.md`.
- Respect the single-owner threat model: Unix socket permissions (`0600`) are authentication.
- If an `[ASSUMPTION]` in `docs/arch.md` applies to the code being implemented, re-check it before
  encoding it.
